import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { CookieJar } from 'tough-cookie';
import { videoSettings } from './proxy-media.js';
import { createResourceMonitor } from './proxy-monitor.js';
import { createDashboardAuth } from './proxy-auth.js';

const assets = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/recordings', ['web/recordings.html', 'text/html; charset=utf-8']],
  ['/recordings.js', ['web/recordings.js', 'text/javascript; charset=utf-8']],
  ['/vendor/hls.js', ['node_modules/hls.js/dist/hls.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/lucide.js', ['node_modules/lucide/dist/umd/lucide.js', 'text/javascript; charset=utf-8']],
  ['/font.woff2', ['node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2', 'font/woff2']],
]);

export function createWebServer({ hostname, webHosts = process.env.WEB_HOSTS?.split(',').map(value => value.trim()).filter(Boolean) || [hostname],
  hlsPort, credentials, getStatus, setQuality, cameras,
  monitor = createResourceMonitor(), replayController, library, dashboardPassword = process.env.DASHBOARD_PASSWORD }) {
  const authenticate = createDashboardAuth(dashboardPassword);
  const allowedHosts = new Set(['localhost', '127.0.0.1', ...webHosts]);
  const entries = cameras || [{ id: 'camera-1', hlsPort, credentials, getStatus, setQuality }];
  const routes = new Map(entries.map((entry) => [entry.id, { ...entry, cookies: new CookieJar() }]));
  const changing = new Set();
  const state = () => ({ ...(cameras ? { cameras: entries.map((entry) => entry.getStatus()) } : getStatus()),
    ...(replayController ? { replay: replayController.getStatus() } : {}) });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    try {
      const origin = `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
      const url = new URL(request.url, origin);
      if (!allowedHosts.has(new URL(origin).hostname)) {
        json(403, { error: 'Host not allowed.' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        const streaming = entries.every((entry) => entry.getStatus().streaming);
        json(streaming ? 200 : 503, { streaming });
        return;
      }
      if (await authenticate(request, response, url, origin)) return;
      if (request.method === 'GET' && url.pathname === '/login') {
        const html = await readFile(new URL('../web/login.html', import.meta.url), 'utf8');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html.replace('<!--LOGIN_ERROR-->', url.searchParams.has('error') ? '<p class="error" role="alert">Incorrect password.</p>' : ''));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(200, state());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/metrics') {
        json(200, await monitor.sample());
        return;
      }
      if (library && request.method === 'GET' && url.pathname === '/api/recordings') {
        json(200, { recordings: await library.list() });
        return;
      }
      const deleteMatch = /^\/api\/recordings\/([0-9a-f-]+)$/.exec(url.pathname);
      if (library && request.method === 'DELETE' && deleteMatch) {
        if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
          json(403, { error: 'Same-origin requests are required.' }); return;
        }
        const result = await library.remove(deleteMatch[1]);
        if (result === 'active') json(409, { error: 'This recording is still in progress. Stop the replay first.' });
        else if (result === 'missing') json(404, { error: 'Recording not found.' });
        else json(200, { deleted: deleteMatch[1] });
        return;
      }
      const fileMatch = /^\/recordings\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (library && request.method === 'GET' && fileMatch) {
        const path = library.file(fileMatch[1], fileMatch[2]);
        const info = path && await stat(path).catch(() => null);
        if (!info?.isFile() || !info.size) { json(404, { error: 'Recording not found.' }); return; }
        const { size } = info;
        let start = 0;
        let end = size - 1;
        if (request.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          if (range?.[1]) {
            start = Number(range[1]);
            if (range[2]) end = Math.min(Number(range[2]), size - 1);
          } else if (range?.[2]) start = Math.max(0, size - Number(range[2]));
          if (!range || (!range[1] && !range[2]) || start > end) {
            response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return;
          }
        }
        response.writeHead(request.headers.range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1, ...(request.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
        const stream = createReadStream(path, { start, end });
        stream.on('error', () => response.destroy());
        stream.pipe(response);
        return;
      }
      const controlMatch = /^\/api\/cameras\/([a-z0-9-]+)\/quality$/.exec(url.pathname);
      const replayAction = /^\/api\/replay\/(start|stop)$/.exec(url.pathname)?.[1];
      if (request.method === 'POST' && (replayAction || controlMatch)) {
        const entry = routes.get(controlMatch?.[1] || entries[0].id);
        if (!entry) { json(404, { error: 'Unknown camera.' }); return; }
        if (request.headers.origin !== origin || request.headers['content-type']?.split(';')[0] !== 'application/json'
          || request.headers['sec-fetch-site'] === 'cross-site') {
          json(403, { error: 'Same-origin JSON requests are required.' });
          return;
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024) { json(413, { error: 'Request too large.' }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {
          json(400, { error: 'Invalid JSON.' }); return;
        }
        if (replayAction) {
          if (!replayController) { json(404, { error: 'Recording unavailable.' }); return; }
          if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
            json(400, { error: 'Send an empty JSON object.' }); return;
          }
          if (replayAction === 'start' && changing.size) { json(409, { error: 'Wait for camera changes to finish.' }); return; }
          try {
            if (replayAction === 'start') replayController.start();
            else void replayController.stop();
            json(200, state());
          } catch { json(409, { error: 'All cameras must be live and idle before recording.' }); }
          return;
        }
        if (replayController && replayController.getStatus().phase !== 'live') {
          json(409, { error: 'Stop recording or replay before changing quality.' }); return;
        }
        try {
          if (!body || Object.keys(body).length !== 2) throw new Error('Invalid settings.');
          videoSettings(body.quality, body.fps);
        } catch {
          json(400, { error: 'Choose a supported quality and FPS.' }); return;
        }
        if (!entry.setQuality) { json(404, { error: 'Quality controls unavailable.' }); return; }
        if (changing.has(entry.id)) { json(409, { error: 'A camera change is already in progress.' }); return; }
        changing.add(entry.id);
        try {
          await entry.setQuality(body);
          json(200, entry.getStatus());
        } catch {
          json(503, { error: 'Could not save or apply output settings. Retry when the service is ready.' });
        } finally {
          changing.delete(entry.id);
        }
        return;
      }
      const mediaMatch = /^\/live\/(?:([a-z0-9-]+)\/)?(processed|original)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && mediaMatch) {
        const entry = routes.get(mediaMatch[1] || (!cameras ? entries[0].id : ''));
        if (!entry) { json(404, { error: 'Unknown camera.' }); return; }
        const { cookies, credentials: viewer } = entry;
        const upstreamOrigin = `http://127.0.0.1:${entry.hlsPort}`;
        const streamPath = `/${mediaMatch[2]}/`;
        let target = new URL(streamPath + mediaMatch[3] + url.search, upstreamOrigin);
        const abort = new AbortController();
        response.on('close', () => abort.abort());
        try {
          for (let redirects = 0; redirects < 4; redirects += 1) {
            const incoming = await fetch(target, { redirect: 'manual',
              signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
              headers: { Authorization: `Basic ${Buffer.from(`${viewer.username}:${viewer.password}`).toString('base64')}`,
                Cookie: await cookies.getCookieString(target.href) },
            });
            for (const cookie of incoming.headers.getSetCookie()) await cookies.setCookie(cookie, target.href);
            if ([301, 302, 303, 307, 308].includes(incoming.status)) {
              const location = incoming.headers.get('location');
              await incoming.body?.cancel();
              if (!location) throw new Error('Missing redirect.');
              target = new URL(location, target);
              if (target.origin !== upstreamOrigin || !target.pathname.startsWith(streamPath)
                || !/^\/(processed|original)\/[A-Za-z0-9_.-]+$/.test(target.pathname)) {
                throw new Error('Unexpected upstream redirect.');
              }
              continue;
            }
            if (!incoming.ok) {
              await incoming.body?.cancel();
              json(503, { error: 'Live video is starting or reconnecting.' });
              return;
            }
            response.writeHead(200, { 'Content-Type': incoming.headers.get('content-type') || 'application/octet-stream' });
            const stream = Readable.fromWeb(incoming.body);
            stream.on('error', () => response.destroy());
            stream.pipe(response);
            return;
          }
          throw new Error('Too many redirects.');
        } catch {
          if (!response.headersSent) json(503, { error: 'Live video is starting or reconnecting.' });
          else response.destroy();
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        const content = await readFile(new URL(`../${filename}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': type });
        response.end(content);
        return;
      }
      json(404, { error: 'Not found.' });
    } catch {
      if (!response.headersSent) json(500, { error: 'Request failed.' });
      else response.destroy();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 20000;
  return server;
}