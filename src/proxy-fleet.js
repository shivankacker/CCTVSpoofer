import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { environmentCredentials } from './cameras.js';
import { authenticatedUri, selectStream } from './proxy-media.js';
import { startProxy, settingsStore } from './proxy.js';
import { createReplayController } from './proxy-replay.js';
import { createWebServer } from './proxy-web.js';

export function configureCameraEnvironment(config, environment = process.env) {
  return { ...config, cameras: config.cameras.map((camera, index) => {
    const prefix = `CAMERA_${index + 1}_`;
    return { ...camera,
      host: environment[`${prefix}HOST`] ?? camera.host,
      rtspHost: environment[`${prefix}RTSP_HOST`] ?? camera.rtspHost,
      rtspSourcePort: environment[`${prefix}RTSP_PORT`] === undefined ? camera.rtspSourcePort : Number(environment[`${prefix}RTSP_PORT`]),
    };
  }) };
}

export function cameraSource(inventory, camera, settings, credentials) {
  const uri = new URL(selectStream(inventory, camera.host, settings));
  if (camera.rtspHost !== undefined) uri.hostname = camera.rtspHost;
  if (camera.rtspSourcePort !== undefined) uri.port = String(camera.rtspSourcePort);
  return authenticatedUri(uri.href, credentials);
}

export function validateCameraConfig(document, webPort = 3000) {
  if (!Array.isArray(document?.cameras) || document.cameras.length < 1 || document.cameras.length > 4) {
    throw new Error('Configure between one and four cameras.');
  }
  const ports = new Set([webPort]);
  const ids = new Set();
  const hosts = new Set();
  return document.cameras.map((camera, index) => {
    if (!camera || !/^[a-z][a-z0-9-]{0,31}$/.test(camera.id)
      || typeof camera.name !== 'string' || !camera.name.trim() || camera.name.length > 80
      || isIP(camera.host) !== 4 || ids.has(camera.id) || hosts.has(camera.host)) {
      throw new Error('Camera IDs and IPv4 hosts must be unique; each camera needs a name.');
    }
    ids.add(camera.id);
    hosts.add(camera.host);
    if ((camera.rtspHost !== undefined && !(isIP(camera.rtspHost) === 4 || ['localhost', 'host.docker.internal'].includes(camera.rtspHost)))
      || (camera.rtspSourcePort !== undefined && (!Number.isInteger(camera.rtspSourcePort) || camera.rtspSourcePort < 1 || camera.rtspSourcePort > 65535))) {
      throw new Error('Invalid camera RTSP connection host or port.');
    }
    const entry = { ...camera, hlsPort: 8888 + index };
    for (const port of [entry.onvifPort, entry.rtspPort, entry.hlsPort]) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || ports.has(port)) {
        throw new Error('Camera service ports must be unique integers from 1024 to 65535.');
      }
      ports.add(port);
    }
    return entry;
  });
}

export async function startFleet({ config, inventory, cameraCredentials, credentials,
  hostname = '127.0.0.1', listen = '127.0.0.1', webListen = '127.0.0.1', webPort = 3000,
  settingsFile = 'stream-settings.local.json', log = console.log }) {
  if (isIP(hostname) !== 4 || hostname === '0.0.0.0'
    || !['0.0.0.0', '127.0.0.1'].includes(listen) || !['0.0.0.0', '127.0.0.1'].includes(webListen)
    || (listen === '127.0.0.1' && hostname !== '127.0.0.1')
    || !Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
    throw new Error('Invalid bind address, advertised IPv4 or web port.');
  }
  const store = await settingsStore(settingsFile);
  const cameras = validateCameraConfig(config, webPort).map((camera) => {
    const getSource = (settings) => cameraSource(inventory, camera, settings, cameraCredentials);
    return { ...camera, initialSettings: store.get(camera.id), getSource,
      source: getSource(store.get(camera.id)),
      passthroughSource: getSource({ width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER }),
      saveSettings: (value) => store.set(camera.id, value),
    };
  });
  const running = [];
  let web;
  let replayController;
  let stopping;
  let finish;
  const done = new Promise((resolveDone) => { finish = resolveDone; });
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (web?.listening) {
        const closed = new Promise((resolveClose) => web.close(resolveClose));
        web.closeAllConnections();
        await closed;
      }
      await replayController?.close();
      await Promise.all(running.map((camera) => camera.stop()));
      finish();
    })();
    return stopping;
  };
  try {
    for (const camera of cameras) {
      const proxy = await startProxy({ ...camera, credentials, hostname, listen,
        enableHls: true, log: (message) => log(`[${camera.id}] ${message}`) });
      running.push({ ...proxy, id: camera.id, hlsPort: camera.hlsPort, credentials });
    }
    replayController = createReplayController({ cameras: running });
    web = createWebServer({ hostname, cameras: running, replayController });
    await new Promise((resolveListen, reject) => {
      web.once('error', reject);
      web.listen(webPort, webListen, () => { web.removeListener('error', reject); resolveListen(); });
    });
    web.on('error', () => { log('Web server failed; stopping camera services.'); void stop(); });
    for (const camera of running) {
      void camera.done.then(() => {
        if (!stopping) { log(`${camera.id}: service stopped; shutting down for supervisor restart.`); void stop(); }
      });
    }
    log(`Live dashboard: http://localhost:${webPort} (${running.length} cameras)`);
    return { stop, done, cameras: running };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function main() {
  const configFile = process.env.CAMERA_CONFIG_FILE || 'proxy-config.json';
  const inventoryFile = process.env.INVENTORY_FILE || 'camera-inventory.json';
  const cameraCredentials = environmentCredentials(process.env, 'CAMERA');
  const credentials = environmentCredentials(process.env, 'PROXY');
  const config = configureCameraEnvironment(JSON.parse(await readFile(configFile, 'utf8')));
  const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
  const fleet = await startFleet({ config, inventory, cameraCredentials, credentials,
    hostname: process.env.ADVERTISE_HOST || '127.0.0.1',
    listen: process.env.LISTEN_ADDRESS || '127.0.0.1',
    webListen: process.env.WEB_LISTEN_ADDRESS || '127.0.0.1',
    settingsFile: process.env.STREAM_SETTINGS_FILE || 'stream-settings.local.json',
  });
  let requested = false;
  const shutdown = () => { requested = true; void fleet.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await fleet.done;
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);
  if (!requested) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Camera services failed to start. Check configuration, environment credentials, recording storage, inventory and free ports.');
    process.exitCode = 1;
  });
}