import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.PROXY_WEB_URL || 'http://127.0.0.1:3000';
const output = await mkdtemp(join(tmpdir(), 'camera-browser-check-'));
const browser = await chromium.launch();
let sessionCookie = '';
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options,
  headers: { ...options.headers, Cookie: sessionCookie } });
let initial;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  if (new URL(page.url()).pathname === '/login') {
    assert.ok(process.env.DASHBOARD_PASSWORD, 'DASHBOARD_PASSWORD is required for browser tests.');
    await page.getByLabel('Password', { exact: true }).fill(process.env.DASHBOARD_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await page.waitForSelector('.camera-row');
  sessionCookie = (await page.context().cookies(base)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  initial = await (await fetch(`${base}/api/state`)).json();
  const cameras = initial.cameras || [initial];
  const checkAudio = async () => {
    if (!process.env.AUDIO_TEST) return;
    const before = await page.locator('video').evaluateAll((videos) => videos.map((video) => video.webkitAudioDecodedByteCount || 0));
    await page.waitForFunction((counts) => [...document.querySelectorAll('video')].every((video, index) =>
      video.webkitAudioDecodedByteCount > counts[index]), before, { timeout: 30000 });
  };
  assert.equal(await page.locator('.camera-row').count(), cameras.length);
  const qualityTarget = cameras[0];
  const requested = qualityTarget.quality === '360p' && qualityTarget.fps === 5
    ? { quality: '480p', fps: 10, width: 854, height: 480 }
    : { quality: '360p', fps: 5, width: 640, height: 360 };
  const qualityRow = page.locator(`[data-camera="${qualityTarget.id}"]`);
  await page.waitForFunction((id) => {
    const video = document.querySelector(`[data-camera="${id}"] [data-feed="original"] video`);
    return video.readyState >= 2 && video.currentTime > 0 && !video.paused;
  }, qualityTarget.id, { timeout: 60000 });
  const originalBefore = await qualityRow.locator('[data-feed="original"] video').evaluate((video) => ({
    width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
  }));
  await page.waitForFunction(() => /^\d/.test(document.getElementById('cpu-value').textContent), null, { timeout: 15000 });
  const resourceTimestamp = await page.locator('#resource-scope').getAttribute('title');
  await page.waitForFunction((before) => document.getElementById('resource-scope').title !== before, resourceTimestamp);
  const metrics = await (await fetch(`${base}/api/metrics`)).json();
  assert.equal(metrics.available, true);
  assert.equal(metrics.scope, 'container');
  assert.ok(metrics.cpu.capacity > 0 && metrics.cpu.percent >= 0);
  assert.ok(metrics.memory.used > 0 && metrics.memory.capacity > 0);
  await qualityRow.locator('.quality').selectOption(requested.quality);
  await qualityRow.locator('.fps').selectOption(String(requested.fps));
  await qualityRow.locator('.apply-quality').click();
  await page.waitForFunction((id) => {
    const row = document.querySelector(`[data-camera="${id}"]`);
    return row.querySelector('.settings-state').textContent === 'Saved';
  }, qualityTarget.id);
  const changed = await (await fetch(`${base}/api/state`)).json();
  const changedCameras = changed.cameras || [changed];
  assert.equal(changedCameras[0].quality, requested.quality);
  assert.equal(changedCameras[0].fps, requested.fps);
  for (const camera of changedCameras.slice(1)) {
    const expected = cameras.find((entry) => entry.id === camera.id);
    assert.equal(camera.quality, expected.quality);
    assert.equal(camera.fps, expected.fps);
  }
  await page.waitForFunction(({ id, width, height }) => {
    const video = document.querySelector(`[data-camera="${id}"] [data-feed="processed"] video`);
    return video.videoWidth === width && video.videoHeight === height && !video.paused;
  }, { id: qualityTarget.id, ...requested }, { timeout: 60000 });
  const originalAfter = await qualityRow.locator('[data-feed="original"] video').evaluate((video) => ({
    width: video.videoWidth, height: video.videoHeight, time: video.currentTime,
  }));
  assert.equal(originalAfter.width, originalBefore.width);
  assert.equal(originalAfter.height, originalBefore.height);
  assert.ok(originalAfter.time > originalBefore.time, 'Original preview must advance independently during quality changes.');
  assert.equal(changedCameras[0].originalHeight, 480);
  assert.equal(changedCameras[0].originalFps, 10);
  await qualityRow.locator('.quality').selectOption(qualityTarget.quality);
  await qualityRow.locator('.fps').selectOption(String(qualityTarget.fps));
  await qualityRow.locator('.apply-quality').click();
  await page.waitForFunction((id) => document.querySelector(`[data-camera="${id}"] .settings-state`).textContent === 'Saved', qualityTarget.id);
  await page.waitForFunction((count) => {
    const videos = [...document.querySelectorAll('video')];
    return videos.length === count * 2 && videos.every((video) => video.readyState >= 2
      && video.videoWidth > 0 && !video.paused && video.currentTime > 0);
  }, cameras.length, { timeout: 90000 });
  const times = await page.locator('video').evaluateAll((videos) => videos.map((video) => video.currentTime));
  await page.waitForFunction((before) => [...document.querySelectorAll('video')]
    .every((video, index) => video.currentTime > before[index] + 2), times, { timeout: 30000 });
  const timing = await page.evaluate(() => ({ at: performance.now(),
    times: [...document.querySelectorAll('video')].map((video) => video.currentTime) }));
  await page.waitForFunction((at) => performance.now() - at >= 10000, timing.at);
  const throughput = await page.evaluate((before) => ({ elapsed: (performance.now() - before.at) / 1000,
    advances: [...document.querySelectorAll('video')].map((video, index) => video.currentTime - before.times[index]),
  }), timing);
  assert.ok(throughput.advances.every((advance) => advance >= throughput.elapsed * 0.85),
    `Previews cannot sustain real time: ${JSON.stringify(throughput)}`);
  const pixels = await page.locator('video').evaluateAll((videos) => videos.map((video) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, 32, 18);
    const data = [...context.getImageData(0, 0, 32, 18).data].filter((value, index) => index % 4 !== 3);
    return { label: video.getAttribute('aria-label'), range: Math.max(...data) - Math.min(...data) };
  }));
  assert.ok(pixels.every((frame) => frame.range > 20), 'Every preview must contain nonblank video pixels.');
  await checkAudio();
  await page.locator('#record-button').click();
  await page.waitForFunction(() => document.getElementById('replay-state').textContent === 'Recording all cameras');
  assert.equal(await qualityRow.locator('.quality').isDisabled(), true);
  await page.locator('#stop-button').click();
  await page.waitForFunction(() => document.getElementById('replay-state').textContent === 'Live', null, { timeout: 30000 });
  if (process.env.REPLAY_TEST) {
    await page.locator('#record-button').click();
    await page.waitForFunction(() => document.getElementById('replay-clock').textContent < '01:59');
    const session = await (await fetch(`${base}/api/state`)).json();
    assert.equal(session.replay.phase, 'recording');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('replay-state').textContent === 'Recording all cameras');
    assert.equal((await (await fetch(`${base}/api/state`)).json()).replay.endsAt, session.replay.endsAt);
    await page.waitForFunction(() => document.getElementById('replay-state').textContent === 'Looping recorded video', null, { timeout: 160000 });
    const replay = await (await fetch(`${base}/api/state`)).json();
    assert.ok(replay.cameras.every((camera) => camera.mode === 'replay' && camera.originalStreaming));
    await page.waitForFunction(() => [...document.querySelectorAll('video')].every((video) => video.readyState >= 2 && !video.paused), null, { timeout: 60000 });
    await page.screenshot({ path: join(output, 'replay.png'), fullPage: true });
    await checkAudio();
    const began = Date.now();
    await page.waitForFunction((start) => Date.now() - start > 125000, began, { timeout: 140000 });
    const looped = await (await fetch(`${base}/api/state`)).json();
    assert.equal(looped.replay.phase, 'replay');
    assert.ok(looped.cameras.every((camera) => camera.streaming && camera.mode === 'replay'));
    await checkAudio();
    await page.locator('#stop-button').click();
    await page.waitForFunction(() => document.getElementById('replay-state').textContent === 'Live', null, { timeout: 30000 });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].every((video) => video.readyState >= 2 && !video.paused), null, { timeout: 60000 });
    assert.ok((await (await fetch(`${base}/api/state`)).json()).cameras.every((camera) => camera.mode === 'live'));
    await checkAudio();
  }
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} must not overflow horizontally`);
    const layout = await page.locator('.workspace').first().evaluate((workspace) => {
      const [original, processed] = [...workspace.children].map((entry) => entry.getBoundingClientRect());
      return { sideBySide: Math.abs(original.top - processed.top) < 2, stacked: processed.top >= original.bottom };
    });
    assert.ok(name === 'desktop' ? layout.sideBySide : layout.stacked);
    if (name === 'mobile') {
      await page.waitForFunction(() => [...document.querySelectorAll('video')].every((video) => {
        const rect = video.closest('figure').getBoundingClientRect();
        return rect.top < innerHeight && rect.bottom > 0 || video.paused && !video.getAttribute('src');
      }));
      await page.locator('.camera-row').first().scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some((video) => video.videoWidth > 0 && !video.paused));
      await page.evaluate(() => window.scrollTo(0, 0));
    } else {
      await page.waitForFunction(() => [...document.querySelectorAll('video')].every((video) => video.readyState >= 2 && !video.paused));
    }
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ cameras: cameras.length, playingPreviews: pixels.length,
    pixels, throughput, recordingCancel: 'passed', fullReplayCycle: process.env.REPLAY_TEST ? 'passed' : 'not requested', qualityControls: 'passed', originalUnchanged: 'passed',
    serverMetrics: metrics, mobileOffscreenPause: 'passed', audioDecoding: process.env.AUDIO_TEST ? 'passed' : 'not requested',
    layouts: ['desktop', 'mobile'], screenshots: output }, null, 2));
} finally {
  if (initial) {
    await fetch(`${base}/api/replay/stop`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    for (const camera of initial.cameras || [initial]) {
      const current = await (await fetch(`${base}/api/state`)).json();
      const state = (current.cameras || [current]).find((entry) => entry.id === camera.id);
      if (state.quality !== camera.quality || state.fps !== camera.fps) {
        await fetch(`${base}/api/cameras/${camera.id}/quality`, { method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json' },
          body: JSON.stringify({ quality: camera.quality, fps: camera.fps }), signal: AbortSignal.timeout(15000) }).catch(() => {});
      }
    }
  }
  await browser.close();
}