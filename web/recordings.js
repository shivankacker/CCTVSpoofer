/* global lucide */
const element = (id) => document.getElementById(id);
let lastResponse = '';
let viewing = null;

const formatTime = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const formatDuration = (milliseconds) => {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(total / 3600)}:${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const bytes = (value) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;

function closeViewer() {
  const video = element('viewer-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  element('viewer').hidden = true;
  viewing = null;
}

function view(session, file) {
  const video = element('viewer-video');
  element('page-error').textContent = '';
  element('viewer').hidden = false;
  element('viewer-title').textContent = `${file.cameraName} | ${formatTime(session.startedAt)}`;
  viewing = session.id;
  video.src = file.url;
  video.play().catch(() => {});
  element('viewer').scrollIntoView({ block: 'start' });
}

async function remove(session, button) {
  if (!confirm(`Delete the recording from ${formatTime(session.startedAt)}? This cannot be undone.`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/recordings/${session.id}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
    if (response.status === 401) { location.replace('/login'); return; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not delete the recording.');
    if (viewing === session.id) closeViewer();
    element('page-error').textContent = '';
  } catch (error) {
    element('page-error').textContent = error.message;
    button.disabled = false;
  }
  await load();
}

function render(sessions) {
  const focused = document.activeElement?.dataset?.key;
  element('sessions').replaceChildren(...sessions.map((session) => {
    const item = element('session-template').content.firstElementChild.cloneNode(true);
    const end = session.status === 'recording' ? Date.now() : Date.parse(session.endedAt);
    item.querySelector('.session-time').textContent = formatTime(session.startedAt);
    item.querySelector('.session-meta').textContent = `${formatDuration(end - Date.parse(session.startedAt))} | ${bytes(session.size)}`
      + ` | ${session.files.length} ${session.files.length === 1 ? 'file' : 'files'}`;
    item.querySelector('.session-status').textContent = { recording: 'Recording', saving: 'Saving' }[session.status] || '';
    const remover = item.querySelector('.delete-button');
    remover.dataset.key = `delete:${session.id}`;
    remover.disabled = session.status !== 'complete';
    remover.setAttribute('aria-label', `Delete recording from ${formatTime(session.startedAt)}`);
    remover.addEventListener('click', () => remove(session, remover));
    item.querySelector('.files').replaceChildren(...session.files.map((file) => {
      const row = element('file-template').content.firstElementChild.cloneNode(true);
      row.querySelector('.file-name').textContent = file.cameraName;
      row.querySelector('.file-size').textContent = bytes(file.size);
      const viewer = row.querySelector('.view-button');
      viewer.dataset.key = `view:${file.url}`;
      viewer.setAttribute('aria-label', `View ${file.cameraName} from ${formatTime(session.startedAt)}`);
      viewer.addEventListener('click', () => view(session, file));
      return row;
    }));
    return item;
  }));
  element('empty').hidden = sessions.length > 0;
  lucide.createIcons();
  if (focused) [...document.querySelectorAll('[data-key]')].find((control) => control.dataset.key === focused)?.focus();
}

async function load() {
  try {
    const response = await fetch('/api/recordings', { signal: AbortSignal.timeout(10000) });
    if (response.status === 401) { location.replace('/login'); return; }
    if (!response.ok) throw new Error('Recordings are unavailable.');
    const text = await response.text();
    const { recordings } = JSON.parse(text);
    if (text !== lastResponse || recordings.some((session) => session.status === 'recording')) render(recordings);
    lastResponse = text;
    if (element('page-error').textContent === 'Recordings are unavailable.') element('page-error').textContent = '';
  } catch {
    element('page-error').textContent = 'Recordings are unavailable.';
  }
}

async function poll() {
  if (!document.hidden) await load();
  setTimeout(poll, 5000);
}

element('viewer-close').addEventListener('click', closeViewer);
element('viewer-video').addEventListener('error', () => {
  if (element('viewer-video').getAttribute('src')) element('page-error').textContent = 'This browser could not play the recording.';
});
lucide.createIcons();
poll();
