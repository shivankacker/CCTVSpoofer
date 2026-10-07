export function createReplayController({ cameras, duration = 120, clock = Date.now, library }) {
  let phase = 'live';
  let endsAt = null;
  let error = null;
  let generation = 0;
  let work = Promise.resolve();
  let stoppingTask;
  let closed = false;
  let source = null;
  const saves = new Set();
  const getStatus = () => ({ phase, duration, endsAt, error, sourceRecording: source?.id ?? null,
    remaining: phase === 'recording' ? Math.max(0, Math.ceil((endsAt - clock()) / 1000)) : 0 });
  const saveSource = () => {
    const session = source;
    source = null;
    if (!session) return;
    const task = library.finish(session.id, () => Promise.all(session.handles.map((handle) => handle.stop())))
      .catch(() => { error = 'Live video restored, but the source recording could not be saved completely.'; })
      .finally(() => saves.delete(task));
    saves.add(task);
  };
  const restore = async () => {
    await Promise.all(cameras.map((camera) => camera.cancelRecording()));
    await Promise.all(cameras.map((camera) => camera.resumeLive()));
    await Promise.all(cameras.map((camera) => camera.deleteRecording()));
  };
  const stop = () => {
    if (stoppingTask) return stoppingTask;
    if (phase === 'live') return Promise.resolve();
    generation++;
    phase = 'stopping';
    endsAt = null;
    stoppingTask = (async () => {
      await Promise.all(cameras.map((camera) => camera.cancelRecording()));
      await work;
      saveSource();
      await restore();
    })().catch(() => { error = 'Could not fully restore live video. Check camera connections.'; })
      .finally(() => { phase = 'live'; stoppingTask = null; });
    return stoppingTask;
  };
  const start = () => {
    if (closed || phase !== 'live' || !cameras.every((camera) => camera.getStatus().streaming && !camera.getStatus().restarting)) {
      throw new Error('All cameras must be live and idle before recording.');
    }
    phase = 'recording';
    endsAt = clock() + duration * 1000;
    error = null;
    const token = ++generation;
    work = (async () => {
      try {
        await Promise.all(cameras.map((camera) => camera.record(duration)));
        if (token !== generation) return;
        phase = 'preparing';
        if (library) {
          // Start before switching so the source recording covers the whole loop.
          const session = await library.create(cameras.map((camera) => camera.getStatus()));
          source = { id: session.id, handles: cameras.map((camera) => camera.recordSource(session.directory)) };
          if (token !== generation) return;
        }
        await Promise.all(cameras.map((camera) => camera.playRecording()));
        if (token !== generation) return;
        phase = 'replay';
        endsAt = null;
      } catch {
        if (token !== generation) return;
        phase = 'stopping';
        error = 'Recording or playback failed. Returned to live; no partial recording was selected.';
        saveSource();
        try { await restore(); } catch { error = 'Recording failed. Check camera connections before trying again.'; }
        if (token === generation) { phase = 'live'; endsAt = null; }
      }
    })();
    return getStatus();
  };
  const watchdog = setInterval(() => {
    if (phase === 'replay' && cameras.some((camera) => !camera.getStatus().streaming)) {
      error = 'Replay stopped unexpectedly. Returning to live.';
      void stop();
    }
  }, 2000);
  watchdog.unref?.();
  return { start, stop, getStatus, async close() {
    closed = true;
    clearInterval(watchdog);
    await stop();
    await Promise.all(saves);
  } };
}