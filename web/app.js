/* global Hls, lucide */
const element = (id) => document.getElementById(id);
const rows = new Map();
const players = [];
let stopped = false;
let pollTimer;
let metricsTimer;
let replayState = { phase: 'live', duration: 120, remaining: 120 };
let replayChanging = false;
let replayError = '';

function renderReplay(state, cameras) {
  replayState = state;
  const busy = state.phase !== 'live';
  element('record-button').disabled = replayChanging || busy || !cameras.every((camera) => camera.streaming && !camera.restarting);
  element('stop-button').disabled = replayChanging || !busy || state.phase === 'stopping';
  const remaining = state.phase === 'live' ? 120 : state.remaining;
  element('replay-clock').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  element('replay-progress').value = state.phase === 'live' ? 0 : 120 - remaining;
  const labels = { live: 'Live', recording: state.remaining ? 'Recording all cameras' : 'Finalizing recordings',
    preparing: 'Starting replay', replay: 'Looping recorded video', stopping: 'Returning to live' };
  element('replay-state').textContent = labels[state.phase] || state.phase;
  element('replay-error').textContent = state.error || replayError;
}

async function replayAction(action) {
  replayChanging = true;
  replayError = '';
  element('record-button').disabled = true;
  element('stop-button').disabled = true;
  try {
    const response = await fetch(`/api/replay/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Recording action failed.');
    replayChanging = false;
    const cameras = result.cameras || [result];
    renderReplay(result.replay, cameras);
    cameras.forEach(render);
  } catch (error) {
    replayError = error.message;
    element('replay-error').textContent = replayError;
  } finally { replayChanging = false; }
}

const bytes = (value) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(0)} MiB`;

async function refreshMetrics() {
  try {
    if (document.hidden) return;
    const response = await fetch('/api/metrics', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Resource monitor unavailable.');
    const metrics = await response.json();
    if (!metrics.available) throw new Error(metrics.reason || 'Resource counters unavailable.');
    const { cpu, memory } = metrics;
    element('resource-scope').textContent = metrics.scope === 'container' ? 'Docker container' : 'Whole host';
    element('cpu-value').textContent = cpu.percent === null ? 'Sampling' : `${cpu.percent.toFixed(1)}%`;
    element('cpu-meter').value = Math.min(100, cpu.percent ?? 0);
    element('cpu-value').classList.toggle('resource-alert', cpu.percent >= 85);
    element('cpu-detail').textContent = `${cpu.coresUsed === null ? '--' : cpu.coresUsed.toFixed(2)} / ${cpu.capacity} cores`
      + (cpu.throttledPercent === null ? '' : ` | Throttled periods: ${cpu.throttledPercent.toFixed(1)}%`);
    const percent = memory.used / memory.capacity * 100;
    element('memory-value').textContent = `${bytes(memory.used)} / ${bytes(memory.capacity)}`;
    element('memory-meter').value = Math.min(100, percent);
    element('memory-value').classList.toggle('resource-alert', percent >= 85);
    element('memory-detail').textContent = `${memory.capacityKind}${memory.limit === null && metrics.scope === 'container' ? ' (no container limit)' : ''}`
      + (metrics.scope === 'container' ? ` | Includes cache | OOM kills: ${memory.oomKills ?? '--'}` : '');
    for (const resource of ['cpu', 'memory']) {
      element(`${resource}-meter`).title = `${element('resource-scope').textContent}: ${element(`${resource}-detail`).textContent}`;
    }
    element('resource-error').textContent = '';
    element('resource-scope').title = `Updated ${metrics.timestamp}`;
  } catch (error) {
    element('resource-scope').textContent = 'Unavailable';
    element('cpu-value').textContent = '--';
    element('memory-value').textContent = '--';
    element('cpu-meter').value = 0;
    element('memory-meter').value = 0;
    element('cpu-detail').textContent = '';
    element('memory-detail').textContent = '';
    element('cpu-meter').title = 'Unavailable';
    element('memory-meter').title = 'Unavailable';
    element('resource-error').textContent = error.message;
  } finally {
    if (!stopped) metricsTimer = setTimeout(refreshMetrics, 2000);
  }
}

function player(figure, source, name) {
  const video = figure.querySelector('video');
  const waiting = figure.querySelector('.waiting');
  const status = figure.querySelector('.feed-state');
  video.setAttribute('aria-label', name);
  let hls;
  let retryTimer;
  let closed = false;
  let active = false;
  const connect = () => {
    if (closed || stopped || !active) return;
    clearTimeout(retryTimer);
    hls?.destroy();
    if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5,
        maxBufferLength: 6, backBufferLength: 0, maxMaxBufferLength: 12 });
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {
        waiting.hidden = true;
        status.textContent = 'Paused';
      }));
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          waiting.hidden = false;
          waiting.querySelector('span').textContent = 'Reconnecting to video';
          status.textContent = 'Reconnecting';
          hls.destroy();
          retryTimer = setTimeout(connect, 3000);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source;
      video.play().catch(() => { waiting.hidden = true; });
    } else {
      waiting.querySelector('span').textContent = 'Playback unavailable in this browser';
    }
  };
  video.addEventListener('playing', () => { waiting.hidden = true; status.textContent = figure.dataset.mode === 'replay' ? 'Replay / buffered' : 'Live / buffered'; });
  video.addEventListener('waiting', () => { status.textContent = 'Buffering'; });
  video.addEventListener('pause', () => { status.textContent = 'Paused'; });
  video.addEventListener('error', () => { if (!Hls.isSupported()) retryTimer = setTimeout(connect, 3000); });
  const suspend = () => {
    active = false;
    clearTimeout(retryTimer);
    hls?.destroy();
    hls = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    waiting.hidden = false;
    waiting.querySelector('span').textContent = 'Preview paused';
    status.textContent = 'Paused';
  };
  const mobile = matchMedia('(max-width: 740px)');
  let visible = false;
  const sync = () => {
    const needed = !document.hidden && (!mobile.matches || visible);
    if (needed && !active) {
      active = true;
      waiting.querySelector('span').textContent = 'Connecting to video';
      connect();
    } else if (!needed && active) suspend();
  };
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  observer.observe(figure);
  mobile.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
  players.push(() => {
    closed = true;
    observer.disconnect();
    mobile.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', sync);
    suspend();
  });
  return { setMode(mode) {
    if (figure.dataset.mode && figure.dataset.mode !== mode) connect();
    figure.dataset.mode = mode;
    if (!video.paused) status.textContent = mode === 'replay' ? 'Replay / buffered' : 'Live / buffered';
  } };
}

function createRow(state) {
  const row = element('camera-template').content.firstElementChild.cloneNode(true);
  row.dataset.camera = state.id;
  row.querySelector('h2').textContent = state.name;
  row.querySelector('.camera-host').textContent = state.camera;
  const quality = row.querySelector('.quality');
  const fps = row.querySelector('.fps');
  const apply = row.querySelector('.apply-quality');
  quality.setAttribute('aria-label', `${state.name} processed quality`);
  fps.setAttribute('aria-label', `${state.name} frame rate`);
  const entry = { row, changing: false, dirty: false, state };
  const edit = () => {
    entry.dirty = quality.value !== entry.state.quality || Number(fps.value) !== entry.state.fps;
    apply.disabled = !entry.dirty || replayState.phase !== 'live';
    row.querySelector('.settings-state').textContent = entry.dirty ? 'Unsaved' : '';
  };
  quality.addEventListener('change', edit);
  fps.addEventListener('change', edit);
  apply.addEventListener('click', async () => {
    entry.changing = true;
    for (const control of [quality, fps, apply]) control.disabled = true;
    row.querySelector('.error').textContent = '';
    row.querySelector('.settings-state').textContent = 'Saving...';
    try {
      const response = await fetch(`/api/cameras/${state.id}/quality`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality: quality.value, fps: Number(fps.value) }), signal: AbortSignal.timeout(15000) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || 'Settings change failed.');
      entry.state = next;
      entry.dirty = false;
      row.querySelector('.settings-state').textContent = 'Saved';
    } catch (error) {
      row.querySelector('.error').textContent = error.message;
      row.querySelector('.settings-state').textContent = 'Not confirmed';
    } finally {
      entry.changing = false;
      render(entry.state);
    }
  });
  rows.set(state.id, entry);
  row.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(entry.state[button.dataset.copy]);
        element('notice').textContent = 'URL copied';
      } catch { element('notice').textContent = 'Clipboard unavailable'; }
      setTimeout(() => { element('notice').textContent = ''; }, 2500);
    });
  });
  element('cameras').append(row);
  player(row.querySelector('[data-feed="original"]'), state.originalPreview, `${state.name} original`);
  entry.processedPlayer = player(row.querySelector('[data-feed="processed"]'), state.processedPreview, `${state.name} processed`);
  lucide.createIcons();
  return entry;
}

function render(state) {
  const entry = rows.get(state.id) || createRow(state);
  if (entry.changing) return;
  entry.state = state;
  const locked = replayState.phase !== 'live' || state.recordingLocked;
  entry.row.querySelector('.quality').disabled = locked;
  entry.row.querySelector('.fps').disabled = locked;
  entry.row.querySelector('.apply-quality').disabled = !entry.dirty || locked;
  if (!entry.dirty) {
    entry.row.querySelector('.quality').value = state.quality;
    entry.row.querySelector('.fps').value = String(state.fps);
  }
  entry.row.querySelector('.output-mode').textContent = state.mode === 'replay' ? 'Replay' : 'Live';
  entry.row.querySelector('.output-mode').dataset.replay = String(state.mode === 'replay');
  entry.processedPlayer.setMode(state.mode || 'live');
  entry.row.querySelector('.signal').classList.toggle('live', state.streaming);
  entry.row.querySelector('.connection').textContent = state.streaming ? 'Streaming' : 'Reconnecting';
  entry.row.querySelector('.output-meta').textContent = `${state.height}p / ${state.fps} fps`;
  entry.row.querySelector('.original-stats').textContent = `${state.originalHeight}p / ${state.originalFps} fps / fixed`
    + (state.originalStreaming ? '' : ' / reconnecting');
  const stats = entry.row.querySelector('.processed-stats');
  stats.textContent = state.streaming ? `Encoder avg: ${state.encodeFps.toFixed(1)} / ${state.fps} fps | ${state.encodeSpeed.toFixed(2)}x real time` : 'Encoder reconnecting';
  stats.classList.toggle('resource-alert', state.streaming && state.encodeSpeed > 0 && state.encodeSpeed < 0.9);
  for (const key of ['rtsp', 'onvif', 'passthrough']) entry.row.querySelector(`[data-url="${key}"]`).textContent = state[key] || 'Unavailable';
}

async function refresh() {
  try {
    const response = await fetch('/api/state', { signal: AbortSignal.timeout(5000) });
    if (response.status === 401) { location.replace('/login'); return; }
    if (!response.ok) throw new Error('Control server is unavailable.');
    const state = await response.json();
    const cameras = state.cameras || [state];
    renderReplay(state.replay || { phase: 'live', remaining: 120 }, cameras);
    cameras.forEach(render);
    const online = cameras.filter((camera) => camera.streaming).length;
    element('signal').classList.toggle('live', online === cameras.length);
    element('connection').textContent = `${online} / ${cameras.length} streaming`;
    element('page-error').textContent = '';
  } catch {
    element('record-button').disabled = true;
    element('stop-button').disabled = true;
    for (const entry of rows.values()) entry.row.querySelectorAll('select, .apply-quality').forEach((control) => { control.disabled = true; });
    element('signal').classList.remove('live');
    element('connection').textContent = 'Offline';
    element('page-error').textContent = 'Control server unavailable. Reconnecting...';
  } finally {
    if (!stopped) pollTimer = setTimeout(refresh, 1000);
  }
}

window.addEventListener('pagehide', () => {
  stopped = true;
  clearTimeout(pollTimer);
  clearTimeout(metricsTimer);
  players.forEach((stop) => stop());
});

lucide.createIcons();
element('record-button').addEventListener('click', () => replayAction('start'));
element('stop-button').addEventListener('click', () => replayAction('stop'));
refresh();
refreshMetrics();