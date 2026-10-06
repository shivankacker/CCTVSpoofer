import { readFile } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, platform, totalmem } from 'node:os';

function counters(text) {
  return Object.fromEntries(text.trim().split('\n').filter(Boolean).map((line) => {
    const [key, value] = line.trim().split(/\s+/);
    return [key, Number(value)];
  }));
}

function cpuSetSize(text) {
  if (!text.trim()) return Infinity;
  return text.trim().split(',').reduce((total, range) => {
    const [first, last = first] = range.split('-').map(Number);
    return total + last - first + 1;
  }, 0);
}

export function createResourceMonitor({ read = readFile, clock = () => performance.now(),
  system = platform(), processors = availableParallelism(), memoryTotal = totalmem(),
  hostCpus = cpus, hostFree = freemem } = {}) {
  let previous;
  let cached;
  let cachedAt = -Infinity;
  let pending;
  const sample = async () => {
    const at = clock();
    const timestamp = new Date().toISOString();
    if (system !== 'linux') {
      const cpu = hostCpus().reduce((sum, entry) => ({
        idle: sum.idle + entry.times.idle,
        total: sum.total + Object.values(entry.times).reduce((total, value) => total + value, 0),
      }), { idle: 0, total: 0 });
      const elapsed = previous ? cpu.total - previous.total : 0;
      const percent = elapsed > 0 ? 100 * (1 - (cpu.idle - previous.idle) / elapsed) : null;
      previous = cpu;
      return { available: true, scope: 'host', timestamp,
        cpu: { percent, coresUsed: percent === null ? null : percent * processors / 100,
          capacity: processors, throttledPercent: null },
        memory: { used: memoryTotal - hostFree(), capacity: memoryTotal, capacityKind: 'Host RAM',
          limit: null, oomKills: null } };
    }
    const root = '/sys/fs/cgroup/';
    try {
      const [cpuText, quotaText, cpusetText, memoryText, limitText, eventText] = await Promise.all([
        read(root + 'cpu.stat', 'utf8'), read(root + 'cpu.max', 'utf8'),
        read(root + 'cpuset.cpus.effective', 'utf8'), read(root + 'memory.current', 'utf8'),
        read(root + 'memory.max', 'utf8'), read(root + 'memory.events', 'utf8'),
      ]);
      const cpu = counters(cpuText);
      const [quota, period] = quotaText.trim().split(/\s+/);
      const quotaCpus = quota === 'max' ? Infinity : Number(quota) / Number(period);
      const capacity = Math.min(processors, cpuSetSize(cpusetText), quotaCpus);
      const used = Number(memoryText.trim());
      const limit = limitText.trim() === 'max' ? null : Number(limitText.trim());
      if (!Number.isFinite(cpu.usage_usec) || !(capacity > 0) || !Number.isFinite(used)
        || (limit !== null && !(limit > 0))) throw new Error('Invalid resource counters.');
      const elapsed = previous ? at - previous.at : 0;
      const usage = previous ? cpu.usage_usec - previous.usage_usec : -1;
      const coresUsed = elapsed > 0 && usage >= 0 ? usage / (elapsed * 1000) : null;
      const periods = previous ? cpu.nr_periods - previous.nr_periods : 0;
      const throttled = previous ? cpu.nr_throttled - previous.nr_throttled : 0;
      previous = { ...cpu, at };
      return { available: true, scope: 'container', timestamp,
        cpu: { coresUsed, capacity, percent: coresUsed === null ? null : coresUsed / capacity * 100,
          throttledPercent: periods > 0 && throttled >= 0 ? Math.min(100, throttled / periods * 100) : 0 },
        memory: { used, limit, capacity: Math.min(limit ?? memoryTotal, memoryTotal),
          capacityKind: limit !== null && limit <= memoryTotal ? 'Container limit' : 'VM/host RAM',
          oomKills: counters(eventText).oom_kill ?? null } };
    } catch {
      previous = undefined;
      return { available: false, scope: 'unavailable', timestamp,
        reason: 'Whole-container metrics require readable cgroup v2 counters.' };
    }
  };
  return {
    async sample() {
      if (cached && clock() - cachedAt < 1000) return cached;
      if (!pending) {
        pending = sample().then((value) => { cached = value; cachedAt = clock(); return value; })
          .finally(() => { pending = undefined; });
      }
      return pending;
    },
  };
}