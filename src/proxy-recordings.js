import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { sourceRecordingArguments } from './proxy-media.js';

const execute = promisify(execFile);
export const sessionPattern = /^\d{13}-[0-9a-f]{8}$/;
export const recordingFilePattern = /^([a-z][a-z0-9-]{0,31})(?:\.part\d{1,4})?\.mp4$/;

export async function finalizeRecording(directory, name, parts) {
  const usable = [];
  for (const file of parts) {
    try {
      const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json',
        join(directory, file)], { timeout: 60000 });
      if (Number(JSON.parse(stdout).format?.duration) > 0) { usable.push(file); continue; }
    } catch { /* unreadable parts are discarded below */ }
    await rm(join(directory, file), { force: true });
  }
  if (!usable.length) return;
  const list = join(directory, `${name}.concat.txt`);
  const output = join(directory, `${name}.mp4.tmp`);
  try {
    await writeFile(list, usable.map((file) => `file '${file}'\n`).join(''), { mode: 0o600 });
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', list,
      '-map', '0', '-c', 'copy', '-copyinkf:a', '-movflags', '+faststart', '-f', 'mp4', '-y', output], { timeout: 10 * 60 * 1000 });
    await rename(output, join(directory, `${name}.mp4`));
    await Promise.all(usable.map((file) => rm(join(directory, file), { force: true })));
  } catch {
    await rm(output, { force: true });
  } finally {
    await rm(list, { force: true });
  }
}

export function recordSource({ source, directory, name, retryDelay = 5000 }) {
  const parts = [];
  let child = null;
  let timer;
  let stopped = false;
  const begin = () => {
    if (stopped) return;
    const file = `${name}.part${parts.length + 1}.mp4`;
    parts.push(file);
    const active = spawn('ffmpeg', sourceRecordingArguments({ source, destination: join(directory, file) }),
      { stdio: ['pipe', 'ignore', 'ignore'] });
    child = active;
    active.once('error', () => {});
    active.stdin.on('error', () => {});
    active.once('close', () => {
      if (child === active) child = null;
      if (!stopped) timer = setTimeout(begin, retryDelay);
    });
  };
  begin();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const active = child;
      if (active && active.exitCode === null && active.signalCode === null) {
        const closed = once(active, 'close').catch(() => {});
        active.stdin.end('q');
        const term = setTimeout(() => active.kill('SIGTERM'), 10000);
        const kill = setTimeout(() => active.kill('SIGKILL'), 15000);
        await closed;
        clearTimeout(term);
        clearTimeout(kill);
      }
      await finalizeRecording(directory, name, parts);
    },
  };
}

export async function createRecordingLibrary(root, clock = Date.now) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Clean up after a shutdown that interrupted finalization; leftover parts remain playable.
  for (const id of await readdir(root)) {
    if (!sessionPattern.test(id)) continue;
    const names = await readdir(join(root, id));
    for (const name of names) {
      const match = recordingFilePattern.exec(name);
      if (name.endsWith('.tmp') || name.endsWith('.concat.txt')
        || (match && name !== `${match[1]}.mp4` && names.includes(`${match[1]}.mp4`))) {
        await rm(join(root, id, name), { force: true });
      }
    }
  }
  const active = new Map();
  const readMeta = async (id) => JSON.parse(await readFile(join(root, id, 'session.json'), 'utf8'));
  return {
    async create(cameras) {
      const startedAt = clock();
      const id = `${startedAt}-${randomBytes(4).toString('hex')}`;
      const directory = join(root, id);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'session.json'), JSON.stringify({ startedAt: new Date(startedAt).toISOString(),
        endedAt: null, cameras: cameras.map(({ id: camera, name }) => ({ id: camera, name })) }), { mode: 0o600 });
      active.set(id, { endedAt: null });
      return { id, directory };
    },
    async finish(id, finalize) {
      const state = active.get(id);
      state.endedAt = new Date(clock()).toISOString();
      try {
        await finalize();
      } finally {
        const meta = await readMeta(id);
        const files = (await readdir(join(root, id))).filter((name) => recordingFilePattern.test(name));
        if (files.length) await writeFile(join(root, id, 'session.json'), JSON.stringify({ ...meta, endedAt: state.endedAt }), { mode: 0o600 });
        else await rm(join(root, id), { recursive: true, force: true });
        active.delete(id);
      }
    },
    async list() {
      const sessions = [];
      for (const id of await readdir(root)) {
        if (!sessionPattern.test(id)) continue;
        let meta;
        try { meta = await readMeta(id); } catch { continue; }
        const names = new Map(meta.cameras?.map((camera) => [camera.id, camera.name]));
        const files = [];
        let lastModified = 0;
        for (const name of (await readdir(join(root, id))).sort()) {
          const match = recordingFilePattern.exec(name);
          if (!match) continue;
          const info = await stat(join(root, id, name)).catch(() => null);
          if (!info?.isFile() || !info.size) continue;
          lastModified = Math.max(lastModified, info.mtimeMs);
          files.push({ name, camera: match[1], cameraName: names.get(match[1]) || match[1], size: info.size,
            url: `/recordings/${id}/${name}` });
        }
        const state = active.get(id);
        sessions.push({ id, startedAt: meta.startedAt,
          endedAt: state ? state.endedAt : meta.endedAt || (lastModified ? new Date(lastModified).toISOString() : meta.startedAt),
          status: state ? (state.endedAt ? 'saving' : 'recording') : 'complete',
          size: files.reduce((total, file) => total + file.size, 0), files });
      }
      return sessions.sort((left, right) => right.id.localeCompare(left.id));
    },
    async remove(id) {
      if (!sessionPattern.test(id)) return 'missing';
      if (active.has(id)) return 'active';
      try { await stat(join(root, id, 'session.json')); } catch { return 'missing'; }
      await rm(join(root, id), { recursive: true, force: true });
      return 'deleted';
    },
    file(id, name) {
      return sessionPattern.test(id) && recordingFilePattern.test(name) ? join(root, id, name) : null;
    },
  };
}
