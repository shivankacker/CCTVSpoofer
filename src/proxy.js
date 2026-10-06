import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, rename, mkdir } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { once } from 'node:events';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { environmentCredentials } from './cameras.js';
import { authenticatedUri, processedArguments, recordingArguments, previewArguments, originalVideo, selectStream, video, videoSettings } from './proxy-media.js';
import { createReplayController } from './proxy-replay.js';
import { createOnvifServer } from './proxy-onvif.js';
import { createWebServer } from './proxy-web.js';

const execute = promisify(execFile);

export async function settingsStore(filename) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(filename, 'utf8'));
    if (!saved || Array.isArray(saved) || typeof saved !== 'object') throw new Error('Invalid saved settings.');
    for (const [id, value] of Object.entries(saved)) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('Invalid saved camera ID.');
      videoSettings(value.quality, value.fps);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let queue = Promise.resolve();
  return {
    get: (id) => Object.hasOwn(saved, id) ? videoSettings(saved[id].quality, saved[id].fps) : video,
    set(id, value) {
      videoSettings(value.quality, value.fps);
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('Invalid camera ID.');
      const task = queue.then(async () => {
        const next = { ...saved, [id]: { quality: value.quality, fps: value.fps } };
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
          await rename(temporary, filename);
          saved = next;
        } finally {
          await rm(temporary, { force: true });
        }
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

export function relayConfig({ listen, rtspPort, credentials, publisher, hlsPort, passthroughSource }) {
  const paths = ['processed', 'original'];
  return {
    logLevel: 'info', logDestinations: ['stdout'],
    rtspAddress: `${listen}:${rtspPort}`, rtspTransports: ['tcp'], rtspAuthMethods: ['digest'],
    rtmp: false, hls: Boolean(hlsPort), webrtc: false, srt: false, moq: false,
    ...(hlsPort ? { hlsAddress: `127.0.0.1:${hlsPort}`, hlsVariant: 'fmp4', hlsAlwaysRemux: false,
      hlsSegmentDuration: '1s', hlsSegmentCount: 7, hlsAllowOrigins: [] } : {}),
    api: false, metrics: false, pprof: false, playback: false,
    authMethod: 'internal',
    authInternalUsers: [
      { user: credentials.username, pass: credentials.password, ips: [],
        permissions: [...paths, ...(passthroughSource ? ['passthrough'] : [])].map((path) => ({ action: 'read', path })) },
      { user: publisher.username, pass: publisher.password, ips: ['127.0.0.1'],
        permissions: paths.map((path) => ({ action: 'publish', path })) },
    ],
    paths: { ...Object.fromEntries(paths.map((path) => [path, { source: 'publisher', overridePublisher: false }])),
      ...(passthroughSource ? { passthrough: { source: passthroughSource, sourceOnDemand: true,
        rtspTransport: 'tcp' } } : {}) },
  };
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const closed = once(child, 'close').catch(() => {});
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed;
  clearTimeout(timer);
}

export async function startProxy(options) {
  const { source, listen, hostname, onvifPort, rtspPort, credentials,
    webPort, webListen = '127.0.0.1', hlsPort = 8888,
    enableHls = Boolean(webPort), id = 'camera-1', name = 'Camera 1',
    initialSettings = video, getSource = () => source, passthroughSource, osd,
    saveSettings = async () => {},
    log = console.log } = options;
  const directory = await mkdtemp(join(tmpdir(), 'cctvspoofer-'));
  const clipDirectory = join(options.recordingDirectory || process.env.RECORDING_DIRECTORY || '/tmp/onvif-recordings', id);
  await mkdir(clipDirectory, { recursive: true, mode: 0o700 });
  const clipFile = join(clipDirectory, 'capture.mkv');
  await rm(clipFile, { force: true });
  const publisher = { username: 'proxypublish', password: randomBytes(24).toString('hex') };
  const filename = join(directory, 'mediamtx.json');
  let settings = videoSettings(initialSettings.quality, initialSettings.fps);
  const server = createOnvifServer({ hostname, port: onvifPort, rtspPort, credentials, id, getVideo: () => settings });
  let relay;
  let transcoder;
  let preview;
  let previewRetry;
  let previewLastFrameAt = 0;
  let retry;
  let stopping = false;
  let restarting = false;
  let publish;
  let replayFile = null;
  let recorder;
  let recordingLocked = false;
  let switchQueue = Promise.resolve();
  let lastFrameAt = 0;
  let encodeFps = 0;
  let encodeSpeed = 0;
  let stopPromise;
  let resolveDone;
  const done = new Promise((resolveDonePromise) => { resolveDone = resolveDonePromise; });
  const getStatus = () => ({ id, name, mode: replayFile ? 'replay' : 'live', recordingLocked, encodeFps, encodeSpeed,
    width: settings.width, height: settings.height, fps: settings.fps, quality: settings.quality,
    originalWidth: originalVideo.width, originalHeight: originalVideo.height, originalFps: originalVideo.fps,
    originalStreaming: !stopping && Date.now() - previewLastFrameAt < 8000,
    restarting, streaming: !stopping && !restarting && Date.now() - lastFrameAt < 8000,
    camera: new URL(source).hostname,
    originalPreview: `/live/${id}/original/index.m3u8`,
    processedPreview: `/live/${id}/processed/index.m3u8`,
    rtsp: `rtsp://${hostname}:${rtspPort}/processed`,
    passthrough: passthroughSource ? `rtsp://${hostname}:${rtspPort}/passthrough` : null,
    onvif: `http://${hostname}:${onvifPort}/onvif/device_service` });
  const switchInput = (next) => {
    const task = switchQueue.then(async () => {
      if (stopping) return;
      restarting = true;
      clearTimeout(retry);
      try {
        await terminate(transcoder);
        replayFile = next;
        publish();
      } finally { restarting = false; }
    });
    switchQueue = task.catch(() => {});
    return task;
  };
  const cancelRecording = async () => { await terminate(recorder); };
  const deleteRecording = async () => { await rm(clipFile, { force: true }); recordingLocked = false; };
  const record = async (duration) => {
    if (stopping || restarting || recordingLocked || !getStatus().streaming) throw new Error('Camera is busy.');
    recordingLocked = true;
    const active = spawn('ffmpeg', recordingArguments({ source: getSource(settings), destination: clipFile, duration }),
      { stdio: ['ignore', 'ignore', 'ignore'] });
    recorder = active;
    const timeout = setTimeout(() => active.kill('SIGKILL'), (duration + 20) * 1000);
    try {
      const [code] = await once(active, 'close');
      if (code !== 0) throw new Error('Camera recording failed.');
      const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', clipFile], { timeout: 10000 });
      const recorded = Number(JSON.parse(stdout).format?.duration);
      if (!Number.isFinite(recorded) || recorded < duration - 1 || recorded > duration + 3) throw new Error('Incomplete camera recording.');
    } finally { clearTimeout(timeout); if (recorder === active) recorder = null; }
  };
  const playRecording = async () => {
    await switchInput(clipFile);
    await new Promise((resolveReady, reject) => {
      const timer = setInterval(() => {
        if (stopping || getStatus().streaming) {
          clearInterval(timer); clearTimeout(deadline);
          if (stopping) reject(new Error('Service stopped.')); else resolveReady();
        }
      }, 100);
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Replay did not start.')); }, 15000);
    });
  };
  const resumeLive = async () => { if (replayFile) await switchInput(null); };
  const setQuality = async ({ quality, fps }) => {
    const next = videoSettings(quality, fps);
    if (stopping || restarting || recordingLocked) throw new Error('Camera is busy.');
    getSource(next);
    restarting = true;
    try {
      await saveSettings({ quality, fps });
      clearTimeout(retry);
      await terminate(transcoder);
      settings = next;
      lastFrameAt = 0;
    } finally {
      restarting = false;
    }
    publish();
  };
  const replayCamera = { getStatus, record, cancelRecording, deleteRecording, playRecording, resumeLive };
  const replayController = webPort ? createReplayController({ cameras: [replayCamera] }) : null;
  const webServer = webPort ? createWebServer({ hostname, hlsPort, credentials, getStatus, setQuality, replayController }) : null;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(retry);
    clearTimeout(previewRetry);
    stopPromise = (async () => {
      await replayController?.close();
      await cancelRecording();
      await switchQueue;
      for (const listener of [server, webServer]) {
        if (listener?.listening) {
          const closed = new Promise((resolveClose) => listener.close(resolveClose));
          listener.closeAllConnections();
          await closed;
        }
      }
      await terminate(transcoder);
      await terminate(preview);
      await terminate(relay);
      await deleteRecording();
      await rm(directory, { recursive: true, force: true });
      resolveDone();
    })();
    return stopPromise;
  };
  try {
    await writeFile(filename, JSON.stringify(relayConfig({ listen, rtspPort, credentials, publisher,
      hlsPort: enableHls ? hlsPort : undefined, passthroughSource })), { mode: 0o600 });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(onvifPort, listen, () => { server.removeListener('error', reject); resolveListen(); });
    });
    server.on('error', () => { log('ONVIF server failed; stopping proxy.'); void stop(); });
    if (webServer) {
      await new Promise((resolveListen, reject) => {
        webServer.once('error', reject);
        webServer.listen(webPort, webListen, () => { webServer.removeListener('error', reject); resolveListen(); });
      });
      webServer.on('error', () => { log('Web server failed; stopping proxy.'); void stop(); });
    }
    relay = spawn('mediamtx', [filename], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('MediaMTX startup timed out.')), 10000);
      let tail = '';
      relay.stdout.on('data', (chunk) => {
        tail = (tail + chunk.toString()).slice(-4096);
        if (/\[RTSP\] (listener opened|started with listeners)/.test(tail)) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      relay.once('error', () => { clearTimeout(timer); reject(new Error('Cannot start MediaMTX; install it with brew install mediamtx.')); });
      relay.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('MediaMTX exited; check whether the RTSP port is already in use.'));
        if (!stopping) { log('MediaMTX stopped; shutting down proxy.'); void stop(); }
      });
    });
    publish = () => {
      if (stopping) return;
      const destination = authenticatedUri(`rtsp://127.0.0.1:${rtspPort}/processed`, publisher);
      lastFrameAt = 0;
      encodeFps = 0;
      encodeSpeed = 0;
      transcoder = spawn('ffmpeg', ['-progress', 'pipe:1', '-stats_period', '1',
        ...processedArguments({ source: replayFile || getSource(settings), recording: Boolean(replayFile), destination, settings, osd })],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: osd?.timezone || 'Asia/Kolkata' } });
      let announced = false;
      let progress = '';
      let lastFrame = 0;
      transcoder.stdout.on('data', (chunk) => {
        progress += chunk.toString();
        const lines = progress.split('\n');
        progress = lines.pop();
        for (const line of lines) {
          if (line.startsWith('fps=')) encodeFps = Number.parseFloat(line.slice(4)) || 0;
          if (line.startsWith('speed=')) encodeSpeed = Number.parseFloat(line.slice(6)) || 0;
          const match = /^frame=(\d+)/.exec(line);
          if (match && Number(match[1]) > lastFrame) {
            lastFrame = Number(match[1]);
            lastFrameAt = Date.now();
          }
        }
        if (!announced && lastFrame > 0) {
          announced = true;
          log(`Processed video is publishing (${settings.width}x${settings.height} H.264, ${settings.fps} fps, no audio).`);
        }
      });
      transcoder.once('error', () => {
        log('Cannot start FFmpeg; stopping proxy.');
        void stop();
      });
      transcoder.once('close', () => {
        lastFrameAt = 0;
        if (!stopping && !restarting) {
          log('Transcoder stopped; retrying in 5 seconds. Check camera connectivity.');
          retry = setTimeout(publish, 5000);
        }
      });
    };
    const publishPreview = () => {
      if (stopping) return;
      previewLastFrameAt = 0;
      preview = spawn('ffmpeg', ['-progress', 'pipe:1', '-stats_period', '1',
        ...previewArguments({ source: getSource(originalVideo),
          destination: authenticatedUri(`rtsp://127.0.0.1:${rtspPort}/original`, publisher) })],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      let pending = '';
      let lastFrame = 0;
      preview.stdout.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          const match = /^frame=(\d+)/.exec(line);
          if (match && Number(match[1]) > lastFrame) {
            lastFrame = Number(match[1]);
            previewLastFrameAt = Date.now();
          }
        }
      });
      preview.once('error', () => { log('Cannot start original preview; stopping proxy.'); void stop(); });
      preview.once('close', () => {
        previewLastFrameAt = 0;
        if (!stopping) previewRetry = setTimeout(publishPreview, 5000);
      });
    };
    publishPreview();
    publish();
    log(`ONVIF: http://${hostname}:${onvifPort}/onvif/device_service`);
    log(`RTSP: rtsp://${hostname}:${rtspPort}/processed`);
    if (webPort) log(`Web: http://localhost:${webPort} (keep this control port restricted to localhost).`);
    return { stop, done, getStatus, setQuality, ...replayCamera };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    host: { type: 'string', default: process.env.CAMERA_HOST || process.env.CAMERA_1_HOST || '' },
    listen: { type: 'string', default: process.env.LISTEN_ADDRESS || '127.0.0.1' },
    advertise: { type: 'string', default: process.env.ADVERTISE_HOST || '127.0.0.1' },
    'web-listen': { type: 'string', default: process.env.WEB_LISTEN_ADDRESS || '127.0.0.1' },
    'web-port': { type: 'string', default: '3000' },
    'hls-port': { type: 'string', default: '8888' },
    'onvif-port': { type: 'string', default: '8080' },
    'rtsp-port': { type: 'string', default: '8554' },
    inventory: { type: 'string', default: process.env.INVENTORY_FILE || 'camera-inventory.json' },
    settings: { type: 'string', default: process.env.STREAM_SETTINGS_FILE || 'stream-settings.local.json' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node --env-file=.env src/proxy.js --host CAMERA_IPV4\n'
      + 'LAN: --listen 0.0.0.0 --advertise MAC_LAN_IPV4\n'
      + 'Web: --web-port 3000 --web-listen 127.0.0.1; all-camera recording/replay controls\n'
      + 'Saved output: --settings stream-settings.local.json\n'
      + 'Optional: --onvif-port 8080 --rtsp-port 8554 --inventory FILE\n'
      + 'Credentials: CAMERA_USERNAME/PASSWORD, PROXY_USERNAME/PASSWORD, DASHBOARD_PASSWORD in the environment.\n'
      + 'Defaults to localhost only. Manual ONVIF registration; WS-Security PasswordDigest and RTSP/TCP required.');
    return;
  }
  if (!['127.0.0.1', '0.0.0.0'].includes(values.listen) || isIP(values.advertise) !== 4
    || values.advertise === '0.0.0.0' || isIP(values.host) !== 4
    || !['127.0.0.1', '0.0.0.0'].includes(values['web-listen'])
    || (values.listen === '127.0.0.1' && values.advertise !== '127.0.0.1')) {
    throw new Error('Use localhost defaults, or --listen 0.0.0.0 --advertise MAC_LAN_IPV4. Camera host must be IPv4.');
  }
  const onvifPort = Number(values['onvif-port']);
  const rtspPort = Number(values['rtsp-port']);
  const webPort = Number(values['web-port']);
  const hlsPort = Number(values['hls-port']);
  const ports = [onvifPort, rtspPort, webPort, hlsPort];
  if (!ports.every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)
    || new Set(ports).size !== ports.length) throw new Error('Choose different service ports from 1024 to 65535.');
  const cameraCredentials = environmentCredentials(process.env, 'CAMERA');
  const credentials = environmentCredentials(process.env, 'PROXY');
  const inventory = JSON.parse(await readFile(values.inventory, 'utf8'));
  const source = authenticatedUri(selectStream(inventory, values.host), cameraCredentials);
  const store = await settingsStore(values.settings);
  const getSource = (settings) => authenticatedUri(selectStream(inventory, values.host, settings), cameraCredentials);
  const proxy = await startProxy({ source, listen: values.listen,
    hostname: values.advertise, onvifPort, rtspPort, credentials, webPort, webListen: values['web-listen'],
    hlsPort,
    initialSettings: store.get('camera-1'), getSource,
    passthroughSource: getSource({ width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }),
    saveSettings: (settings) => store.set('camera-1', settings) });
  const shutdown = () => { void proxy.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await proxy.done;
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Proxy startup failed. Check credentials, inventory, installed tools and available ports. Run node src/proxy.js --help.');
    process.exitCode = 1;
  });
}