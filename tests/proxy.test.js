import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedUri, previewArguments, originalVideo, fitFilter, osdFilter, selectStream, video, videoSettings } from '../src/proxy-media.js';
import { createOnvifServer } from '../src/proxy-onvif.js';
import { call, environmentCredentials } from '../src/cameras.js';
import onvif from 'onvif';
import { createHash, randomBytes } from 'node:crypto';
import { relayConfig, main, startProxy, settingsStore } from '../src/proxy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebServer as authenticatedWebServer } from '../src/proxy-web.js';
import { createResourceMonitor } from '../src/proxy-monitor.js';
import { get as httpGet, request as httpRequest } from 'node:http';
import { validateCameraConfig, configureCameraEnvironment, cameraSource } from '../src/proxy-fleet.js';
import { bridgeArguments, renderEnvironment } from '../scripts/bridge.mjs';
import { phoneWebAccessArguments } from '../scripts/phone-web-access.mjs';
import { parseEnv } from 'node:util';
import { processedArguments, recordingArguments, sourceRecordingArguments } from '../src/proxy-media.js';
import { createReplayController } from '../src/proxy-replay.js';
import { createRecordingLibrary, finalizeRecording } from '../src/proxy-recordings.js';

const execute = promisify(execFile);
const createWebServer = (options) => authenticatedWebServer({ dashboardPassword: null, ...options });

test('dashboard password protects assets, APIs and media; sessions expire on logout and login is throttled', async (context) => {
  assert.throws(() => createWebServer({ dashboardPassword: '' }), /DASHBOARD_PASSWORD/);
  const server = createWebServer({ hostname: '127.0.0.1', dashboardPassword: 'test-password-1234', getStatus: () => ({ streaming: true }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/login')).headers.get('referrer-policy'), 'same-origin');
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  assert.equal((await fetch(origin, { redirect: 'manual' })).headers.get('location'), '/login');
  for (const path of ['/api/state', '/api/metrics', '/api/recordings', '/app.js', '/recordings.js', '/live/camera-1/original/index.m3u8']) {
    assert.equal((await fetch(origin + path)).status, 401);
  }
  assert.equal((await fetch(origin + '/recordings', { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await fetch(origin + '/api/replay/start', { method: 'POST' })).status, 401);
  const login = (password, extra = {}) => fetch(origin + '/login', { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ password }) });
  assert.equal((await login('test-password-1234', { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await login('wrong')).headers.get('set-cookie'), null);
  const response = await login('test-password-1234');
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=43200/);
  assert.ok(!cookie.includes('test-password'));
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await fetch(origin + '/api/state', { headers })).status, 200);
  assert.equal((await fetch(origin + '/api/state', { headers: { Cookie: 'dashboard=forged' } })).status, 401);
  assert.equal((await fetch(origin + '/logout', { method: 'POST', redirect: 'manual',
    headers: { ...headers, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 303);
  assert.equal((await fetch(origin + '/api/state', { headers })).status, 401);
  for (let attempt = 0; attempt < 8; attempt++) await login('wrong');
  assert.equal((await login('test-password-1234')).status, 429);
});

test('separate web hosts permit LAN and Tailscale login without allowing arbitrary hosts or cross-origin requests', async (context) => {
  const server = createWebServer({ hostname: '127.0.0.1', webHosts: ['192.168.1.7', '100.64.0.10'],
    dashboardPassword: 'test-password-1234', getStatus: () => ({ streaming: true }) });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = `100.64.0.10:${server.address().port}`;
  const send = (path, options = {}) => new Promise((resolveResponse, reject) => {
    const request = httpRequest(base + path, { method: options.method, headers: options.headers }, (response) => {
      response.resume();
      response.once('end', () => resolveResponse(response));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end(options.body);
  });
  assert.equal((await send('/healthz', { headers: { Host: host } })).statusCode, 200);
  assert.equal((await send('/healthz', { headers: { Host: '192.168.1.7' } })).statusCode, 200);
  assert.equal((await send('/healthz', { headers: { Host: 'evil.example' } })).statusCode, 403);
  assert.equal((await send('/api/state', { headers: { Host: host } })).statusCode, 401);
  const login = (origin) => send('/login', { method: 'POST',
    headers: { Host: host, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-password-1234' }).toString() });
  assert.equal((await login('http://evil.example')).statusCode, 403);
  const response = await login(`http://${host}`);
  assert.equal(response.statusCode, 303);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  assert.equal((await send('/api/state', { headers: { Host: host, Cookie: cookie } })).statusCode, 200);
  const lanHost = `192.168.1.7:${server.address().port}`;
  assert.equal((await send('/login', { method: 'POST',
    headers: { Host: lanHost, Origin: `http://${lanHost}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-password-1234' }).toString() })).statusCode, 303);
});

test('replay API requires same-origin empty JSON and locks quality while a recording session is active', async (context) => {
  let phase = 'live';
  const replayController = { getStatus: () => ({ phase }), start() { if (phase !== 'live') throw new Error(); phase = 'recording'; },
    async stop() { phase = 'live'; } };
  const server = createWebServer({ hostname: '127.0.0.1', replayController,
    cameras: [{ id: 'camera-1', getStatus: () => ({ streaming: true }), setQuality: async () => {} }] });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, requestOrigin = origin) => fetch(origin + path, { method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/replay/start', {}, 'http://other.example')).status, 403);
  assert.equal((await post('/api/replay/start', { duration: 1 })).status, 400);
  assert.equal((await post('/api/replay/start')).status, 200);
  assert.equal((await post('/api/replay/start')).status, 409);
  assert.equal((await post('/api/cameras/camera-1/quality', { quality: '360p', fps: 5 })).status, 409);
  assert.equal((await (await fetch(origin + '/api/state')).json()).replay.phase, 'recording');
  assert.equal((await post('/api/replay/stop')).status, 200);
  assert.equal(phase, 'live');
});

test('replay waits for every camera, rejects duplicate starts, and stop restores all live feeds', async (context) => {
  let finishFirst;
  let finishSecond;
  const calls = [];
  const camera = (id, record) => ({ getStatus: () => ({ streaming: true }), record,
    playRecording: async () => { calls.push(`play${id}`); }, cancelRecording: async () => {},
    resumeLive: async () => { calls.push(`live${id}`); }, deleteRecording: async () => { calls.push(`delete${id}`); } });
  const controller = createReplayController({ cameras: [camera(1, () => new Promise((resolve) => { finishFirst = resolve; })),
    camera(2, () => new Promise((resolve) => { finishSecond = resolve; }))] });
  context.after(() => controller.close());
  assert.equal(controller.start().phase, 'recording');
  assert.throws(() => controller.start());
  finishFirst();
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  finishSecond();
  await new Promise(setImmediate);
  assert.equal(controller.getStatus().phase, 'replay');
  await controller.stop();
  assert.equal(controller.getStatus().phase, 'live');
  assert.deepEqual(calls.sort(), ['delete1', 'delete2', 'live1', 'live2', 'play1', 'play2']);
});

test('stop cancels pending recordings without entering replay and failed recordings return to live', async (context) => {
  let rejectCapture;
  let played = false;
  const camera = { getStatus: () => ({ streaming: true }), record: () => new Promise((resolve, reject) => { rejectCapture = reject; }),
    cancelRecording: async () => { rejectCapture?.(new Error('cancelled')); }, resumeLive: async () => {},
    deleteRecording: async () => {}, playRecording: async () => { played = true; } };
  const controller = createReplayController({ cameras: [camera] });
  context.after(() => controller.close());
  controller.start();
  await controller.stop();
  assert.equal(played, false);
  assert.equal(controller.getStatus().phase, 'live');
  controller.start();
  rejectCapture(new Error('camera lost'));
  await new Promise(setImmediate);
  assert.equal(controller.getStatus().phase, 'live');
  assert.match(controller.getStatus().error, /failed/);
  assert.equal(played, false);
});

const settle = async (check) => { for (let turn = 0; turn < 100 && !check(); turn++) await new Promise(setImmediate); };

test('source recording starts before the loop, stops with replay and is saved even when playback fails', async () => {
  const events = [];
  const camera = (id, playRecording = async () => {}) => ({ getStatus: () => ({ id, name: `Camera ${id}`, streaming: true }),
    record: async () => {}, cancelRecording: async () => {}, deleteRecording: async () => {},
    resumeLive: async () => { events.push(`live${id}`); },
    playRecording: async () => { events.push(`play${id}`); await playRecording(); },
    recordSource: (directory) => { events.push(`source${id}:${directory}`); return { stop: async () => { events.push(`saved${id}`); } }; } });
  const finished = [];
  const library = { create: async (cameras) => ({ id: cameras.map((entry) => entry.id).join('+'), directory: '/archive' }),
    finish: async (id, finalize) => { await finalize(); finished.push(id); } };
  const controller = createReplayController({ cameras: [camera('a'), camera('b')], library });
  controller.start();
  await settle(() => controller.getStatus().phase === 'replay');
  assert.equal(controller.getStatus().phase, 'replay');
  assert.equal(controller.getStatus().sourceRecording, 'a+b');
  assert.ok(events.indexOf('sourcea:/archive') < events.indexOf('playa'));
  assert.ok(!events.includes('saveda'));
  await controller.close();
  assert.equal(controller.getStatus().sourceRecording, null);
  assert.deepEqual(finished, ['a+b']);
  assert.ok(events.includes('saveda') && events.includes('savedb') && events.includes('livea'));

  const failing = createReplayController({ cameras: [camera('c', async () => { throw new Error('no replay'); })], library });
  failing.start();
  await settle(() => finished.length === 2);
  await failing.close();
  assert.deepEqual(finished, ['a+b', 'c']);
  assert.match(failing.getStatus().error, /failed/);

  const args = sourceRecordingArguments({ source: 'rtsp://proxy/original', destination: '/archive/a.part1.mp4' });
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.ok(args.includes('0:a:0?'));
  assert.match(args[args.indexOf('-movflags') + 1], /frag_keyframe/);
  assert.ok(!args.includes('-t') && !args.includes('-vf'));
  assert.ok(!args.includes('-nostdin'), 'The recorder must accept "q" on stdin for a clean stop');
});

test('recording library lists sessions, protects active ones, rejects unsafe names and recovers interrupted saves', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'recording-library-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = 1760000000000;
  const library = await createRecordingLibrary(root, () => now);
  const session = await library.create([{ id: 'camera-1', name: 'Lobby' }]);
  await writeFile(join(session.directory, 'camera-1.part1.mp4'), 'partial');
  let [listed] = await library.list();
  assert.equal(listed.status, 'recording');
  assert.equal(listed.files[0].cameraName, 'Lobby');
  assert.equal(await library.remove(session.id), 'active');
  now += 90000;
  await library.finish(session.id, async () => {
    assert.equal((await library.list())[0].status, 'saving');
    await rename(join(session.directory, 'camera-1.part1.mp4'), join(session.directory, 'camera-1.mp4'));
  });
  [listed] = await library.list();
  assert.equal(listed.status, 'complete');
  assert.equal(Date.parse(listed.endedAt) - Date.parse(listed.startedAt), 90000);
  assert.deepEqual(listed.files.map((file) => file.url), [`/recordings/${session.id}/camera-1.mp4`]);
  assert.equal(library.file(session.id, 'session.json'), null);
  assert.equal(library.file('..', 'camera-1.mp4'), null);
  assert.equal(library.file(session.id, '../camera-1.mp4'), null);
  now += 1000;
  const empty = await library.create([{ id: 'camera-1', name: 'Lobby' }]);
  await library.finish(empty.id, async () => {});
  assert.equal((await library.list()).length, 1);
  for (const name of ['camera-1.part2.mp4', 'camera-1.mp4.tmp', 'camera-1.concat.txt']) await writeFile(join(session.directory, name), 'x');
  const reopened = await createRecordingLibrary(root);
  assert.deepEqual((await readdir(session.directory)).sort(), ['camera-1.mp4', 'session.json']);
  assert.equal(await reopened.remove(session.id), 'deleted');
  assert.equal(await reopened.remove(session.id), 'missing');
  assert.deepEqual(await reopened.list(), []);
});

test('recordings API lists sessions, serves byte ranges and deletes only finished sessions from the same origin', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'recording-web-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let now = 1760000000000;
  const library = await createRecordingLibrary(root, () => now++);
  const done = await library.create([{ id: 'camera-1', name: 'Lobby' }]);
  await library.finish(done.id, () => writeFile(join(done.directory, 'camera-1.mp4'), '0123456789'));
  const active = await library.create([{ id: 'camera-1', name: 'Lobby' }]);
  const server = createWebServer({ hostname: '127.0.0.1', library, cameras: [{ id: 'camera-1', getStatus: () => ({ streaming: true }) }] });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { recordings } = await (await fetch(origin + '/api/recordings')).json();
  assert.deepEqual(recordings.map((session) => [session.id, session.status]), [[active.id, 'recording'], [done.id, 'complete']]);
  assert.equal((await fetch(origin + '/recordings')).headers.get('content-type'), 'text/html; charset=utf-8');
  const file = `${origin}/recordings/${done.id}/camera-1.mp4`;
  const full = await fetch(file);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(await full.text(), '0123456789');
  const partial = await fetch(file, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  assert.equal(await (await fetch(file, { headers: { Range: 'bytes=-3' } })).text(), '789');
  assert.equal((await fetch(file, { headers: { Range: 'bytes=20-' } })).status, 416);
  for (const path of [`/recordings/${done.id}/session.json`, '/recordings/..%2F/camera-1.mp4', `/recordings/${done.id}/..%2Fsession.json`]) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  const remove = (id, requestOrigin = origin) => fetch(`${origin}/api/recordings/${id}`, { method: 'DELETE', headers: { Origin: requestOrigin } });
  assert.equal((await remove(done.id, 'http://evil.example')).status, 403);
  assert.equal((await remove(active.id)).status, 409);
  assert.equal((await remove(done.id)).status, 200);
  assert.equal((await remove(done.id)).status, 404);
  assert.equal((await fetch(file)).status, 404);
});

test('source recording parts are joined into one seekable MP4 and unreadable parts are discarded', {
  skip: !process.env.PROXY_MEDIA_TEST, timeout: 30000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'source-recording-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.mkv');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-threads', '2',
    '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', source]);
  const args = sourceRecordingArguments({ source, destination: 'unused' });
  const parts = ['camera-1.part1.mp4', 'camera-1.part2.mp4', 'camera-1.part3.mp4'];
  for (const part of parts.slice(0, 2)) {
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args.slice(args.indexOf('-i'), -1), join(directory, part)]);
  }
  await writeFile(join(directory, parts[2]), '');
  await finalizeRecording(directory, 'camera-1', parts);
  assert.deepEqual((await readdir(directory)).sort(), ['camera-1.mp4', 'source.mkv']);
  const output = join(directory, 'camera-1.mp4');
  const info = JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration',
    '-of', 'json', output])).stdout);
  assert.deepEqual(info.streams.map((stream) => stream.codec_name), ['h264', 'aac']);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.3);
  const bytes = await readFile(output);
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'Index must precede media so browsers can seek immediately');
});

test('recording copies clean camera video and replay applies fresh OSD after a paced looping input', () => {
  const capture = recordingArguments({ source: 'rtsp://camera/live', destination: '/tmp/clip.mkv' });
  assert.equal(capture[capture.indexOf('-t') + 1], '120');
  assert.equal(capture[capture.indexOf('-c:v') + 1], 'copy');
  assert.equal(capture[capture.indexOf('-c:a') + 1], 'copy');
  assert.ok(capture.includes('0:a:0?'));
  assert.ok(!capture.includes('-vf'));
  assert.ok(capture.includes('-fs'));
  assert.throws(() => recordingArguments({ duration: 121 }));
  const args = processedArguments({ source: '/tmp/clip.mkv', destination: 'rtsp://proxy/processed',
    recording: true, settings: videoSettings('360p', 5), osd: { title: 'Channel1' } });
  assert.ok(args.includes('-re'));
  assert.equal(args[args.indexOf('-stream_loop') + 1], '-1');
  assert.match(args[args.indexOf('-vf') + 1], /localtime/);
  assert.ok(!args.includes('-filter_complex'));
  for (const [output, codec] of [[args, 'pcm_alaw'], [previewArguments({ source: 'rtsp://camera/live', destination: 'rtsp://proxy/original' }), 'aac']]) {
    assert.ok(output.includes('0:a:0?'));
    assert.ok(!output.includes('-an'));
    assert.equal(output[output.indexOf('-c:a') + 1], codec);
    assert.match(output[output.indexOf('-af') + 1], /asetpts=PTS-STARTPTS,aresample/);
  }
  assert.equal(args[args.indexOf('-ar') + 1], '8000', 'NVRs expect camera-style 8 kHz G.711 on the processed stream');
  assert.equal(args[args.indexOf('-x264-params') + 1], 'sliced-threads=0', 'NVR web players need one slice per frame');
  assert.ok(!processedArguments({ source: 'rtsp://camera/live', destination: 'rtsp://proxy/out' }).includes('-re'));
});

test('audio survives capture and stays aligned across replay loops; silent cameras still encode', {
  skip: !process.env.PROXY_MEDIA_TEST, timeout: 30000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-audio-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.mkv');
  const clip = join(directory, 'capture.mkv');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10',
    '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,2)\\,0.5)\\,0.3*sin(2*PI*440*t)\\,0):s=48000',
    '-t', '2', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-g', '10', '-c:a', 'pcm_s16le', source]);
  const capture = recordingArguments({ source, destination: clip, duration: 2 });
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...capture.slice(capture.indexOf('-i'))]);
  const inspect = async (file) => JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_packets',
    '-show_entries', 'stream=codec_type,codec_name:packet=stream_index,pts_time', '-of', 'json', file],
  { maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.ok((await inspect(clip)).streams.some((stream) => stream.codec_name === 'pcm_s16le'));
  const replay = join(directory, 'replay.mkv');
  const args = processedArguments({ source: clip, destination: 'unused', recording: true, settings: videoSettings('360p', 10) });
  await execute('ffmpeg', [...args.slice(0, args.lastIndexOf('-f')), '-t', '6', '-f', 'matroska', replay], { timeout: 15000 });
  const info = await inspect(replay);
  assert.deepEqual(info.streams.map((stream) => stream.codec_name), ['h264', 'pcm_alaw']);
  const timelines = info.streams.map((stream, index) => info.packets.filter((packet) => packet.stream_index === index).map((packet) => Number(packet.pts_time)));
  for (const timeline of timelines) {
    assert.ok(timeline.at(-1) > 5.8);
    for (let index = 1; index < timeline.length; index++) assert.ok(timeline[index] > timeline[index - 1]);
  }
  assert.ok(Math.abs(timelines[0].at(-1) - timelines[1].at(-1)) < 0.15);
  const { stdout } = await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', replay, '-vn', '-ac', '1',
    '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
  const energy = (start, end) => {
    let sum = 0;
    for (let sample = Math.round(start * 48000); sample < Math.round(end * 48000); sample++) sum += stdout.readFloatLE(sample * 4) ** 2;
    return sum / ((end - start) * 48000);
  };
  for (const start of [0, 2, 4]) {
    assert.ok(energy(start + 0.1, start + 0.4) > 0.02, 'Tone must repeat at the same point in every video loop');
    assert.ok(energy(start + 0.8, start + 1.5) < 0.0001, 'Quiet part must stay aligned with each loop');
  }
  const silent = join(directory, 'silent.mkv');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-c', 'copy', silent]);
  const silentArgs = processedArguments({ source: silent, destination: 'unused', recording: true, settings: videoSettings('360p', 10) });
  const silentOutput = join(directory, 'silent-output.mkv');
  await execute('ffmpeg', [...silentArgs.slice(0, silentArgs.lastIndexOf('-f')), '-t', '1', '-f', 'matroska', silentOutput]);
  assert.deepEqual((await inspect(silentOutput)).streams.map((stream) => stream.codec_type), ['video']);
});

test('phone web access uses the saved addresses and rejects values that could reach the remote shell', () => {
  const environment = { BRIDGE_SSH_HOST: 'phone', PHONE_LAN_IP: '192.168.1.9', PHONE_TAILSCALE_IP: '100.94.82.112' };
  const args = phoneWebAccessArguments(environment);
  assert.equal(args.at(-2), 'phone');
  assert.match(args.at(-1), / web-access 100\.94\.82\.112 192\.168\.1\.9"$/);
  for (const change of [{ PHONE_LAN_IP: '' }, { PHONE_LAN_IP: '1.2.3.4; reboot' }, { PHONE_TAILSCALE_IP: '$(id)' }, { BRIDGE_SSH_HOST: '-oProxyCommand=x' }]) {
    assert.throws(() => phoneWebAccessArguments({ ...environment, ...change }));
  }
});

test('bridge forwards are local-only, use configured endpoints and reject invalid or duplicate ports', () => {
  const config = { cameras: [1, 2].map((number) => ({ id: `camera-${number}`, name: `Camera ${number}`,
    host: `192.168.1.${11 + number}`, onvifPort: 8079 + number, rtspPort: 8553 + number })) };
  const environment = { CONNECTION_MODE: 'bridge', BRIDGE_SSH_HOST: 'phone',
    CAMERA_1_RTSP_HOST: 'host.docker.internal', CAMERA_1_RTSP_PORT: '15554',
    CAMERA_2_RTSP_HOST: 'host.docker.internal', CAMERA_2_RTSP_PORT: '15555' };
  const args = bridgeArguments(config, environment);
  assert.ok(args.includes('127.0.0.1:15554:192.168.1.12:554'));
  assert.ok(args.includes('127.0.0.1:15555:192.168.1.13:554'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.equal(args.at(-1), 'phone');
  for (const overrides of [{ CONNECTION_MODE: 'office' }, { BRIDGE_SSH_HOST: '-bad' },
    { CAMERA_2_RTSP_PORT: '15554' }, { CAMERA_1_RTSP_HOST: '0.0.0.0' }, { CAMERA_1_RTSP_PORT: '80' }]) {
    assert.throws(() => bridgeArguments(config, { ...environment, ...overrides }));
  }
});

test('environment initialization generates independent passwords without changing camera values or connection mode', async (context) => {
  const template = 'CAMERA_USERNAME=\nCAMERA_PASSWORD=\nPROXY_USERNAME=\nPROXY_PASSWORD=\nDASHBOARD_PASSWORD=\n# CONNECTION_MODE=office\nCONNECTION_MODE=bridge\n';
  const result = parseEnv(renderEnvironment(template));
  assert.equal(result.CAMERA_PASSWORD, '');
  assert.equal(result.PROXY_USERNAME, 'proxyview');
  assert.match(result.PROXY_PASSWORD, /^[a-f0-9]{48}$/);
  assert.match(result.DASHBOARD_PASSWORD, /^[a-f0-9]{48}$/);
  assert.notEqual(result.DASHBOARD_PASSWORD, result.PROXY_PASSWORD);
  assert.notEqual(result.PROXY_PASSWORD, parseEnv(renderEnvironment(template)).PROXY_PASSWORD);
  assert.equal(result.CONNECTION_MODE, 'bridge');
  const directory = await mkdtemp(join(tmpdir(), 'environment-init-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [script, '--init-env'], { cwd: directory });
  const filename = join(directory, '.env');
  const contents = await readFile(filename, 'utf8');
  const initialized = parseEnv(contents);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(initialized.CAMERA_PASSWORD, '');
  assert.match(initialized.PROXY_PASSWORD, /^[a-f0-9]{48}$/);
  assert.match(initialized.DASHBOARD_PASSWORD, /^[a-f0-9]{48}$/);
  assert.ok(!stdout.includes(initialized.PROXY_PASSWORD) && !stdout.includes(initialized.DASHBOARD_PASSWORD));
  await assert.rejects(execute(process.execPath, [script, '--init-env'], { cwd: directory }));
  assert.equal(await readFile(filename, 'utf8'), contents);
});

test('office and bridge environment blocks select the intended camera endpoints', async () => {
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const config = { cameras: [1, 2, 3, 4].map((number) => ({ id: `camera-${number}`, name: `Camera ${number}`,
    host: `192.168.1.${11 + number}`, onvifPort: 8079 + number, rtspPort: 8553 + number })) };
  const bridge = parseEnv(template.split('# DIRECT LAN:')[0]
    + '# BRIDGE:' + template.split('# BRIDGE:')[1].replace(/^# (CONNECTION_MODE|CAMERA_\d_RTSP_(?:HOST|PORT))=/gm, '$1='));
  assert.equal(bridge.CONNECTION_MODE, 'bridge');
  assert.equal(bridgeArguments(config, bridge).filter((value) => value === '-L').length, 4);
  const office = parseEnv(template);
  assert.equal(office.CONNECTION_MODE, 'office');
  for (const camera of validateCameraConfig(configureCameraEnvironment(config, office))) {
    assert.equal(camera.rtspHost, camera.host);
    assert.equal(camera.rtspSourcePort, 554);
  }
});

test('environment routing preserves inventory identity and stream paths while changing only the connection endpoint', () => {
  const config = { cameras: [{ id: 'camera-1', name: 'Camera', host: '192.168.1.12', onvifPort: 8080, rtspPort: 8554 }] };
  const bridged = configureCameraEnvironment(config, { CAMERA_1_RTSP_HOST: 'host.docker.internal', CAMERA_1_RTSP_PORT: '15554' });
  const [camera] = validateCameraConfig(bridged);
  assert.equal(camera.host, '192.168.1.12');
  assert.equal(camera.rtspHost, 'host.docker.internal');
  assert.equal(camera.rtspSourcePort, 15554);
  assert.equal(config.cameras[0].rtspHost, undefined);
  assert.throws(() => validateCameraConfig(configureCameraEnvironment(config, { CAMERA_1_RTSP_PORT: 'NaN' })));
  assert.throws(() => validateCameraConfig(configureCameraEnvironment(config, { CAMERA_1_RTSP_HOST: 'bad/host' })));
  assert.throws(() => environmentCredentials({}, 'CAMERA'));
  assert.throws(() => environmentCredentials({ CAMERA_USERNAME: 'viewer' }, 'CAMERA'));
  assert.deepEqual(environmentCredentials({ CAMERA_USERNAME: 'viewer', CAMERA_PASSWORD: 'secret' }, 'CAMERA'),
    { username: 'viewer', password: 'secret' });
  const inventory = { cameras: [{ hostname: camera.host, streams: [{ uri: 'rtsp://192.168.1.12:554/video/live?channel=1&subtype=1',
    resolution: { width: 1280, height: 720 } }] }] };
  const credentials = { username: 'viewer', password: 'a@b:c' };
  const uri = new URL(cameraSource(inventory, camera, videoSettings('360p', 5), credentials));
  assert.equal(uri.hostname, 'host.docker.internal');
  assert.equal(uri.port, '15554');
  assert.equal(uri.pathname, '/video/live');
  assert.equal(uri.searchParams.get('subtype'), '1');
  assert.equal(decodeURIComponent(uri.password), credentials.password);
  assert.equal(new URL(cameraSource(inventory, config.cameras[0], videoSettings('360p', 5), credentials)).hostname, camera.host);
});

test('container metrics include all child workloads, CPU quota and memory limits without confusing host totals', async () => {
  let time = 0;
  const files = { 'cpu.stat': 'usage_usec 1000000\nnr_periods 100\nnr_throttled 2',
    'cpu.max': '200000 100000', 'cpuset.cpus.effective': '0-3,6-7',
    'memory.current': '536870912', 'memory.max': '1073741824', 'memory.events': 'oom_kill 1' };
  const monitor = createResourceMonitor({ system: 'linux', processors: 8, memoryTotal: 8 * 1024 ** 3,
    clock: () => time, read: async (filename) => files[filename.split('/').at(-1)] });
  const first = await monitor.sample();
  assert.equal(first.scope, 'container');
  assert.equal(first.cpu.percent, null);
  assert.equal(first.cpu.capacity, 2);
  files['cpu.stat'] = 'usage_usec 4000000\nnr_periods 120\nnr_throttled 7';
  assert.equal(await monitor.sample(), first);
  time = 2000;
  const next = await monitor.sample();
  assert.equal(next.cpu.coresUsed, 1.5);
  assert.equal(next.cpu.percent, 75);
  assert.equal(next.cpu.throttledPercent, 25);
  assert.equal(next.memory.used, 512 * 1024 ** 2);
  assert.equal(next.memory.capacity, 1024 ** 3);
  assert.equal(next.memory.capacityKind, 'Container limit');
  assert.equal(next.memory.oomKills, 1);
  files['memory.max'] = 'max';
  time = 4000;
  assert.equal((await monitor.sample()).memory.capacityKind, 'VM/host RAM');
});

test('resource monitoring labels unavailable cgroups and native host metrics honestly', async () => {
  const unavailable = createResourceMonitor({ system: 'linux', read: async () => { throw new Error('Missing'); } });
  assert.equal((await unavailable.sample()).available, false);
  const host = createResourceMonitor({ system: 'darwin', processors: 8, memoryTotal: 1000, hostFree: () => 400 });
  const snapshot = await host.sample();
  assert.equal(snapshot.scope, 'host');
  assert.equal(snapshot.memory.used, 600);
  assert.equal(snapshot.memory.capacityKind, 'Host RAM');
});

test('resource endpoint exposes the service sample without camera credentials', async (context) => {
  const snapshot = { available: true, scope: 'container', cpu: { percent: 25 }, memory: { used: 1024 } };
  const server = createWebServer({ hostname: '127.0.0.1', credentials: { username: 'secret-user', password: 'secret-password' },
    getStatus: () => ({ streaming: true }), monitor: { sample: async () => snapshot } });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/metrics`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
});

test('camera quality settings survive reload and concurrent updates do not lose other cameras', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'settings.json');
  const store = await settingsStore(filename);
  await Promise.all([store.set('camera-1', { quality: '360p', fps: 5 }), store.set('camera-2', { quality: '720p', fps: 20 })]);
  const reloaded = await settingsStore(filename);
  assert.deepEqual(reloaded.get('camera-1'), videoSettings('360p', 5));
  assert.deepEqual(reloaded.get('camera-2'), videoSettings('720p', 20));
  assert.throws(() => store.set('camera-1', { quality: 'bad', fps: 5 }));
  assert.deepEqual(store.get('camera-1'), videoSettings('360p', 5));
  const broken = await settingsStore(join(directory, 'missing', 'settings.json'));
  await assert.rejects(broken.set('camera-1', { quality: '360p', fps: 5 }));
  assert.deepEqual(broken.get('camera-1'), video);
});

test('quality API validates input, blocks cross-origin changes and isolates camera settings', async (context) => {
  const states = [1, 2].map((number) => ({ id: `camera-${number}`, quality: '480p', fps: 10, streaming: true }));
  const cameras = states.map((state) => ({ id: state.id, getStatus: () => state,
    setQuality: async (value) => Object.assign(state, value) }));
  const server = createWebServer({ hostname: '127.0.0.1', cameras });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, requestOrigin = origin) => fetch(`${origin}/api/cameras/camera-1/quality`, {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post({ quality: '360p', fps: 5 }, 'http://bad.example')).status, 403);
  for (const value of [{ quality: '4k', fps: 5 }, { quality: '480p', fps: '10' }, { quality: '480p', fps: 10, extra: true }]) {
    assert.equal((await post(value)).status, 400);
  }
  assert.equal((await post({ quality: '360p', fps: 5 })).status, 200);
  assert.equal(states[0].quality, '360p');
  assert.equal(states[0].fps, 5);
  assert.equal(states[1].quality, '480p');
  assert.equal(states[1].fps, 10);
});

test('passthrough relays the camera only on demand and cannot be published by viewers', () => {
  const config = relayConfig({ listen: '127.0.0.1', rtspPort: 8554,
    credentials: { username: 'viewer', password: 'secret' }, publisher: { username: 'publisher', password: 'secret' },
    passthroughSource: 'rtsp://camera/main' });
  assert.equal(config.paths.passthrough.source, 'rtsp://camera/main');
  assert.equal(config.paths.passthrough.sourceOnDemand, true);
  assert.equal(config.paths.passthrough.rtspTransport, 'tcp');
  assert.ok(config.authInternalUsers[0].permissions.some((permission) => permission.path === 'passthrough' && permission.action === 'read'));
  assert.ok(!config.authInternalUsers[1].permissions.some((permission) => permission.path === 'passthrough'));
});

test('output settings are validated and drive resolution, rate, bitrate and source choice', () => {
  const settings = videoSettings('480p', 10);
  const args = processedArguments({ source: 'rtsp://camera/main', destination: 'rtsp://proxy/output', settings });
  assert.match(args[args.indexOf('-vf') + 1], /pad=854:480/);
  assert.match(args[args.indexOf('-vf') + 1], /fps=10/);
  assert.equal(args[args.indexOf('-g') + 1], '10');
  assert.equal(args[args.indexOf('-b:v') + 1], '1000k');
  assert.throws(() => videoSettings('4k', 10));
  assert.throws(() => videoSettings('720p', '10'));
  assert.throws(() => videoSettings('720p', 0));
  assert.equal(selectStream({ cameras: [{ hostname: '192.168.1.12', streams: [
    { uri: 'rtsp://192.168.1.12/main', resolution: { width: 1920, height: 1080 } },
    { uri: 'rtsp://192.168.1.12/sub', resolution: { width: 1280, height: 720 } },
  ] }] }, '192.168.1.12', settings), 'rtsp://192.168.1.12/sub');
});

test('camera configuration supports four cameras and rejects duplicate identities or service ports', () => {
  const config = { cameras: Array.from({ length: 4 }, (unused, index) => ({ id: `camera-${index + 1}`,
    name: `Camera ${index + 1}`, host: `192.168.1.${12 + index}`, onvifPort: 8080 + index, rtspPort: 8554 + index })) };
  const cameras = validateCameraConfig(config);
  assert.equal(cameras.length, 4);
  assert.equal(new Set(cameras.flatMap((entry) => [entry.onvifPort, entry.rtspPort, entry.hlsPort])).size, 12);
  assert.throws(() => validateCameraConfig({ cameras: [] }));
  assert.throws(() => validateCameraConfig({ cameras: [...config.cameras, config.cameras[0]] }));
  assert.throws(() => validateCameraConfig({ cameras: [config.cameras[0], config.cameras[0]] }));
  for (const port of [3000, 8888, 8080, 70000]) {
    assert.throws(() => validateCameraConfig({ cameras: [{ ...config.cameras[0], rtspPort: port }] }));
  }
});

test('web controls are independent for each configured camera', async (context) => {
  const qualities = ['480p', '480p', '480p', '480p'];
  const cameras = qualities.map((value, index) => ({ id: `camera-${index + 1}`, hlsPort: 18888 + index,
    credentials: { username: 'test', password: 'secret' },
    getStatus: () => ({ id: `camera-${index + 1}`, quality: qualities[index], streaming: true }),
    setQuality: async (next) => { qualities[index] = next.quality; },
  }));
  const server = createWebServer({ hostname: '127.0.0.1', cameras });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/cameras/camera-2/quality`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"quality":"360p","fps":5}' });
  assert.equal(response.status, 200);
  assert.deepEqual(qualities, ['480p', '360p', '480p', '480p']);
  assert.equal((await (await fetch(`${origin}/api/state`)).json()).cameras.length, 4);
  assert.equal((await fetch(`${origin}/api/cameras/camera-5/quality`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${origin}/live/camera-5/original/index.m3u8`)).status, 404);
});

test('web serves local assets and restricts quality changes to valid same-origin requests', async (context) => {
  let quality = '480p';
  let available = true;
  const server = createWebServer({ hostname: '127.0.0.1', hlsPort: 18888,
    credentials: { username: 'test', password: 'secret' },
    getStatus: () => ({ quality, streaming: available }),
    setQuality: async (value) => { if (!available) throw new Error('Offline'); quality = value.quality; },
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => { server.close(resolveClose); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, requestOrigin = origin) => fetch(`${origin}/api/cameras/camera-1/quality`, {
    method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body,
  });
  for (const path of ['/', '/app.js', '/vendor/hls.js', '/vendor/lucide.js', '/font.woff2']) {
    assert.equal((await fetch(origin + path)).status, 200, path);
  }
  assert.equal((await post('{"quality":"360p","fps":5}', 'http://untrusted.example')).status, 403);
  assert.equal((await post('{"quality":"360p","fps":"5"}')).status, 400);
  assert.equal((await post('{"quality":"360p","fps":5,"command":"anything"}')).status, 400);
  assert.equal((await post('invalid')).status, 400);
  assert.equal((await post('x'.repeat(1025))).status, 413);
  const badHostStatus = await new Promise((resolveStatus, reject) => {
    httpGet(origin + '/api/state', { headers: { Host: 'untrusted.example' } }, (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post('{"quality":"360p","fps":5}')).status, 200);
  assert.equal(quality, '360p');
  available = false;
  assert.equal((await post('{"quality":"720p","fps":10}')).status, 503);
  assert.equal(quality, '360p');
  assert.equal((await fetch(origin + '/healthz')).status, 503);
});

async function serve(context) {
  const credentials = { username: 'proxyview', password: 'V9!testpassword' };
  const server = createOnvifServer({ hostname: '127.0.0.1', port: 0, rtspPort: 8554, credentials });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { port: server.address().port, credentials };
}

function soap(action, credentials, created = new Date().toISOString()) {
  const nonce = randomBytes(16);
  const digest = createHash('sha1').update(nonce).update(created).update(credentials.password).digest('base64');
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
    xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
    xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
    <s:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${credentials.username}</wsse:Username>
    <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
    <wsse:Nonce>${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created>
    </wsse:UsernameToken></wsse:Security></s:Header><s:Body><tds:${action}/></s:Body></s:Envelope>`;
}

test('existing ONVIF client discovers main and sub proxy profiles, both serving only the processed stream', async (context) => {
  const { port, credentials } = await serve(context);
  const camera = await new Promise((resolve, reject) => {
    const client = new onvif.Cam({ hostname: '127.0.0.1', port, ...credentials, timeout: 3000 },
      (error) => error ? reject(error) : resolve(client));
  });
  const profiles = await call(camera, 'getProfiles');
  assert.deepEqual(profiles.map((profile) => profile.$.token), ['processed', 'processed-sub']);
  assert.deepEqual(profiles.map((profile) => profile.videoEncoderConfiguration.$.token), ['encoder', 'encoder-sub']);
  for (const profile of profiles) assert.equal(profile.videoEncoderConfiguration.encoding, 'H264');
  assert.equal(camera.videoSources.length, 1);
  for (const profileToken of ['processed', 'processed-sub']) {
    const stream = await call(camera, 'getStreamUri', { protocol: 'RTSP', stream: 'RTP-Unicast', profileToken });
    assert.equal(stream.uri, 'rtsp://127.0.0.1:8554/processed');
  }
  await assert.rejects(call(camera, 'getStreamUri', { protocol: 'RTSP', stream: 'RTP-Unicast', profileToken: 'original' }));
});

test('SOAP rejects bad credentials, stale/replayed tokens, writes and entity declarations', async (context) => {
  const { port, credentials } = await serve(context);
  const post = (body) => fetch(`http://127.0.0.1:${port}/onvif/device_service`, { method: 'POST', body });
  const body = soap('GetDeviceInformation', credentials);
  assert.equal((await post(body)).status, 200);
  assert.match(await (await post(body)).text(), /NotAuthorized/);
  assert.match(await (await post(soap('GetDeviceInformation', { ...credentials, password: 'incorrect' }))).text(), /NotAuthorized/);
  assert.match(await (await post(soap('GetDeviceInformation', credentials, '2020-01-01T00:00:00Z'))).text(), /NotAuthorized/);
  assert.match(await (await post(soap('SystemReboot', credentials))).text(), /ActionNotSupported/);
  assert.equal((await post('<!DOCTYPE test [<!ENTITY x "test">]>' + body)).status, 400);
  assert.equal((await post('x'.repeat(65537))).status, 413);
});

test('proxy only selects a discovered full HD stream on the requested camera', () => {
  const inventory = { cameras: [{ hostname: '192.168.1.12', streams: [
    { uri: 'rtsp://192.168.1.12/main', resolution: { width: 1920, height: 1080 } },
  ] }] };
  assert.equal(selectStream(inventory, '192.168.1.12'), 'rtsp://192.168.1.12/main');
  assert.throws(() => selectStream(inventory, '192.168.1.13'), /No discovered/);
  assert.equal(selectStream({ cameras: [{ hostname: '192.168.1.13', streams: [
    { uri: 'rtsp://192.168.1.13/main', resolution: { width: 2560, height: 1440 } },
    { uri: 'rtsp://192.168.1.13/sub', resolution: { width: 1280, height: 720 } },
  ] }] }, '192.168.1.13'), `rtsp://192.168.1.13/${video.height <= 720 ? 'sub' : 'main'}`);
  inventory.cameras[0].streams[0].uri = 'rtsp://192.168.1.111/main';
  assert.throws(() => selectStream(inventory, '192.168.1.12'), /unexpected/);
});

test('360p keeps the widescreen camera profile instead of selecting the narrower SD profile', () => {
  const inventory = { cameras: [{ hostname: '192.168.1.12', streams: [
    { uri: 'rtsp://192.168.1.12/sd', resolution: { width: 704, height: 576 } },
    { uri: 'rtsp://192.168.1.12/sub', resolution: { width: 1280, height: 720 } },
    { uri: 'rtsp://192.168.1.12/main', resolution: { width: 1920, height: 1080 } },
  ] }] };
  assert.equal(selectStream(inventory, '192.168.1.12', videoSettings('360p', 5)), 'rtsp://192.168.1.12/sub');
  assert.equal(selectStream(inventory, '192.168.1.12', videoSettings('736p', 10)), 'rtsp://192.168.1.12/sub');
  const nvr = videoSettings('736p', 10);
  assert.ok(nvr.width * nvr.height > 921600 && nvr.width % 16 === 0 && nvr.height % 16 === 0,
    'NVR preset must exceed the CP Plus web player native-decode threshold with macroblock-aligned size');
  assert.equal(selectStream(inventory, '192.168.1.12', videoSettings('1080p', 15)), 'rtsp://192.168.1.12/main');
  assert.equal(selectStream(inventory, '192.168.1.12', { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }), 'rtsp://192.168.1.12/main');
});

test('original preview settings and encoder are independent of processed output', () => {
  const args = processedArguments({ source: 'rtsp://camera/main',
    destination: 'rtsp://proxy/processed', settings: videoSettings('360p', 5) });
  const filter = args[args.indexOf('-vf') + 1];
  assert.match(filter, /fps=5/);
  assert.match(filter, /pad=640:360/);
  assert.deepEqual(args.flatMap((arg, index) => arg === '-map' ? [args[index + 1]] : []), ['0:v:0', '0:a:0?']);
  const preview = previewArguments({ source: 'rtsp://camera/sub', destination: 'rtsp://proxy/original' });
  assert.equal(preview[preview.indexOf('-vf') + 1], `${fitFilter(originalVideo)},format=yuv420p`);
  assert.equal(preview[preview.indexOf('-g') + 1], '10');
  assert.equal(preview.at(-1), 'rtsp://proxy/original');
});

test('processed live video is encoded while recorded input loops in real time', () => {
  const args = processedArguments({ source: 'rtsp://camera/main', destination: 'rtsp://proxy/processed' });
  assert.equal(args[args.indexOf('-map') + 1], '0:v:0');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.ok(!args.includes('-an'));
  assert.ok(!args.includes('copy'));
  assert.ok(!args.includes('-stream_loop'));
  assert.ok(!args.includes('-re'));
  assert.equal(args.at(-1), 'rtsp://proxy/processed');
  const replay = processedArguments({ source: '/tmp/capture.mkv', recording: true, destination: 'unused' });
  assert.equal(replay[replay.indexOf('-stream_loop') + 1], '-1');
  assert.ok(replay.includes('-re'));
});

test('RTSP authentication encodes credentials without changing the original URI', () => {
  const uri = 'rtsp://127.0.0.1:8554/processed';
  const result = new URL(authenticatedUri(uri, { username: 'viewer', password: 'a@b:c!123' }));
  assert.equal(decodeURIComponent(result.password), 'a@b:c!123');
  assert.equal(result.pathname, '/processed');
  assert.equal(uri, 'rtsp://127.0.0.1:8554/processed');
});

test('relay grants viewers read-only access and only a loopback publisher can publish', () => {
  const config = relayConfig({ listen: '127.0.0.1', rtspPort: 8554,
    credentials: { username: 'proxyview', password: 'viewer-password' },
    publisher: { username: 'proxypublish', password: 'publisher-password' } });
  assert.deepEqual(config.authInternalUsers[0].permissions, ['processed', 'original'].map((path) => ({ action: 'read', path })));
  assert.deepEqual(config.authInternalUsers[1].ips, ['127.0.0.1']);
  assert.deepEqual(config.authInternalUsers[1].permissions, ['processed', 'original'].map((path) => ({ action: 'publish', path })));
  assert.deepEqual(config.rtspTransports, ['tcp']);
  assert.deepEqual(Object.keys(config.paths), ['processed', 'original']);
  assert.equal(config.paths.processed.overridePublisher, false);
  for (const protocol of ['rtmp', 'hls', 'webrtc', 'srt', 'moq', 'api', 'playback']) assert.equal(config[protocol], false);
});

test('CLI rejects unsafe advertised addresses, colliding ports and obsolete credential flags', async () => {
  await assert.rejects(main(['--advertise', '0.0.0.0']), /MAC_LAN_IPV4/);
  await assert.rejects(main(['--host', '192.0.2.10', '--onvif-port', '8554']), /different/);
  await assert.rejects(main(['--credentials', 'credentials.local.json',
    '--proxy-credentials', 'credentials.local.json']), /Unknown option/);
});

test('recorded picture repeats across loop boundaries while the playback timestamp advances', {
  skip: !process.env.PROXY_MEDIA_TEST, timeout: 15000,
}, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-pixels-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const clip = join(directory, 'clip.mkv');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=5',
    '-t', '2', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', clip], { timeout: 5000 });
  const args = processedArguments({ source: clip, recording: true, settings: videoSettings('360p', 5), osd: { title: 'Channel1' }, destination: 'unused' });
  const { stdout, stderr } = await execute('ffmpeg', [...args.slice(0, args.indexOf('-map')),
    '-frames:v', '21', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 10000 });
  assert.equal(stderr.length, 0, stderr.toString());
  const frameSize = 640 * 360 * 3;
  assert.equal(stdout.length, frameSize * 21);
  const region = (frame, left, top, width, height) => {
    const hash = createHash('sha256');
    for (let row = top; row < top + height; row++) {
      const offset = frame * frameSize + (row * 640 + left) * 3;
      hash.update(stdout.subarray(offset, offset + width * 3));
    }
    return hash.digest('hex');
  };
  assert.equal(region(0, 100, 120, 400, 150), region(10, 100, 120, 400, 150));
  assert.equal(region(0, 100, 120, 400, 150), region(20, 100, 120, 400, 150));
  assert.notEqual(region(0, 100, 120, 400, 150), region(1, 100, 120, 400, 150));
  assert.notEqual(region(0, 416, 16, 220, 30), region(20, 416, 16, 220, 30));
});

test('proxy OSD is opt-in, scales with output, and rejects filter injection or invalid timezones', () => {
  assert.equal(osdFilter(undefined, video), '');
  assert.match(osdFilter({ title: 'Channel1' }, videoSettings('360p', 5)), /fontsize=14/);
  assert.match(osdFilter({ title: 'Channel1' }, videoSettings('720p', 5)), /fontsize=29/);
  for (const osd of [{}, { title: "bad':text=other" }, { title: 'Camera', fontSize: -1 },
    { title: 'Camera', fontFile: '/tmp/bad:font' }, { title: 'Camera', timezone: 'Not/AZone' }]) {
    assert.throws(() => osdFilter(osd, video));
  }
  const args = processedArguments({ source: 'unused', destination: 'unused', osd: { title: 'Camera' } });
  const graph = args[args.indexOf('-vf') + 1];
  assert.ok(graph.indexOf('drawtext') > graph.indexOf('pad='));
});

test('proxy OSD remains visible at different output resolutions', {
  skip: !process.env.PROXY_MEDIA_TEST, timeout: 30000,
}, async () => {
  for (const quality of ['360p', '720p']) {
    const settings = videoSettings(quality, 5);
    const osd = { title: 'Channel1', fontFile: process.platform === 'darwin'
      ? '/System/Library/Fonts/Supplemental/Arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' };
      const { stdout, stderr } = await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=red:s=${settings.width}x${settings.height}:r=5`,
        '-vf', `${fitFilter(settings)}${osdFilter(osd, settings)},format=yuv420p`,
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 10000, env: { ...process.env, TZ: 'Asia/Kolkata' } });
      assert.equal(stderr.length, 0, stderr.toString());
      for (const [left, top, right, bottom] of [[0.64, 0.04, 1, 0.11], [0.01, 0.91, 0.3, 0.99]]) {
        let white = 0;
        for (let row = Math.floor(top * settings.height); row < bottom * settings.height; row++) {
          for (let column = Math.floor(left * settings.width); column < right * settings.width; column++) {
            const offset = (row * settings.width + column) * 3;
            if ([...stdout.subarray(offset, offset + 3)].every((value) => value > 210)) white++;
          }
        }
        assert.ok(white > 20, `${quality}: OSD missing at ${left},${top}`);
      }
      const [red, green, blue] = stdout.subarray((Math.floor(settings.height / 2) * settings.width + Math.floor(settings.width / 2)) * 3);
      assert.ok(red > 220 && blue < 20 && green < 20);
  }
});

test('360p fitting preserves widescreen display aspect for square and anamorphic pixels', {
  skip: !process.env.PROXY_MEDIA_TEST, timeout: 30000,
}, async () => {
  for (const input of ['color=c=red:s=1280x720:r=5', 'color=c=red:s=704x576:r=5,setsar=16/11']) {
    const { stdout } = await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', input,
      '-vf', fitFilter(videoSettings('360p', 5)), '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024, timeout: 10000 });
    assert.equal(stdout.length, 640 * 360 * 3);
    for (const offset of [0, (180 * 640 + 320) * 3, stdout.length - 3]) {
      const [red, green, blue] = stdout.subarray(offset, offset + 3);
      assert.ok(red > 220 && green < 20 && blue < 20, `${input}: unexpected bars or distortion at ${offset}`);
    }
  }
});

test('live camera can be processed, relayed and decoded over authenticated RTSP', {
  skip: !process.env.PROXY_LIVE_TEST, timeout: 60000,
}, async (context) => {
  assert.ok(process.env.DASHBOARD_PASSWORD, 'Load the private environment before running the live integration test.');
  const cameraCredentials = environmentCredentials(process.env, 'CAMERA');
  const inventory = JSON.parse(await readFile('camera-inventory.json', 'utf8'));
  const host = process.env.CAMERA_HOST || process.env.CAMERA_1_HOST;
  assert.ok(host, 'Set CAMERA_HOST or CAMERA_1_HOST for the live integration test.');
  const source = authenticatedUri(selectStream(inventory, host), cameraCredentials);
  const credentials = { username: 'proxytest', password: 'V9!testpassword' };
  let ready;
  const publishing = new Promise((resolveReady) => { ready = resolveReady; });
  const proxy = await startProxy({ source, listen: '127.0.0.1', hostname: '127.0.0.1',
    onvifPort: 18080, rtspPort: 18554, webPort: 18081, hlsPort: 18888, credentials,
    log: (message) => { if (message.startsWith('Processed video')) ready(); } });
  try {
    let timer;
    try {
      await Promise.race([publishing, new Promise((resolveUnused, reject) => {
        timer = setTimeout(() => reject(new Error('No processed frames published within 30 seconds.')), 30000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    const uri = authenticatedUri('rtsp://127.0.0.1:18554/processed', credentials);
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp',
      '-i', uri, '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json'], { timeout: 15000 });
    const stream = JSON.parse(stdout).streams[0];
    assert.equal(stream.codec_name, 'h264');
    assert.equal(stream.width, video.width);
    assert.equal(stream.height, video.height);
    const origin = 'http://127.0.0.1:18081';
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: process.env.DASHBOARD_PASSWORD }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const changed = await fetch(`${origin}/api/replay/start`, { method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).replay.phase, 'recording');
    await fetch(`${origin}/api/replay/stop`, { method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    const playlist = await fetch(`${origin}/live/processed/index.m3u8`, { headers: { Cookie: cookie } });
    assert.equal(playlist.status, 200);
    assert.match(await playlist.text(), /#EXTM3U/);
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
      '-i', uri, '-frames:v', '3', '-f', 'null', '-'], { timeout: 15000 });
    await assert.rejects(execute('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp',
      '-i', 'rtsp://127.0.0.1:18554/processed'], { timeout: 10000 }));
  } finally {
    await proxy.stop();
  }
});