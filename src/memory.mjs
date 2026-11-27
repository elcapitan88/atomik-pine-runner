// The runner's memory across its processes, logged and watched.
//
// Nov 2026: memory climbed ~0.1-0.2 GB a day until the container's 4 GB limit
// killed the stream worker (SIGKILL on Nov 5, Nov 13 and Nov 24, the last one
// during market hours), dropping every live session at once. The causes are
// handled where they happen (host GC in worker.mjs, the daily recycle in
// live/manager.mjs); this is the safety net and the instrument: one log line
// every few minutes, and a controlled replacement of the largest worker if the
// total still passes the budget.

/** Memory of the main process and every worker, as last reported (MB). */
export function memorySnapshot({ pool, streams }) {
  const main = Math.round(process.memoryUsage.rss() / 1048576);
  const poolMem = pool ? pool.stats.memory : [];
  const streamMem = streams ? streams.stats.memory : [];
  const sum = (xs) => xs.reduce((n, m) => n + (m?.rss_mb || 0), 0);
  return {
    total_mb: main + sum(poolMem) + sum(streamMem),
    main_mb: main,
    pool: poolMem,
    streams: streamMem,
    open_streams: streams ? streams.stats.streams : 0,
  };
}

export function memoryLine(snap, budgetMb) {
  const fmt = (xs) => `[${xs.map((m) => (m ? `${m.rss_mb}/${m.external_mb}ext` : '?')).join(', ')}]`;
  return `memory: total=${snap.total_mb}MB of budget ${budgetMb}MB, main=${snap.main_mb}MB, sandbox=${fmt(snap.pool)}, streams=${fmt(snap.streams)} holding ${snap.open_streams} stream(s)`;
}

export class MemoryWatchdog {
  /**
   * @param {object} o
   * @param {object} o.pool       WorkerPool
   * @param {object} [o.streams]  StreamHost
   * @param {number} o.budgetMb   act above this total
   * @param {number} [o.cooldownMs] wait at least this long between two actions
   */
  constructor({ pool, streams = null, budgetMb, cooldownMs = 15 * 60_000, log = console, now = () => Date.now(), snapshot = memorySnapshot }) {
    Object.assign(this, { pool, streams, budgetMb, cooldownMs, log, now, snapshot });
    this.lastActionAt = -Infinity;
    this.actions = 0;
  }

  /** Replace the largest worker when the total is over budget. Returns what it did. */
  async check() {
    const snap = this.snapshot({ pool: this.pool, streams: this.streams });
    if (snap.total_mb <= this.budgetMb) return null;
    if (this.now() - this.lastActionAt < this.cooldownMs) return null;
    const p = this.pool?.largest?.();
    const s = this.streams?.largest?.();
    const target = s && (!p || s.mem.rss_mb >= p.mem.rss_mb) ? { kind: 'stream', w: s } : p ? { kind: 'sandbox', w: p } : null;
    if (!target) return null;
    this.lastActionAt = this.now();
    this.actions++;
    this.log.warn?.(`${memoryLine(snap, this.budgetMb)}: over budget, replacing the ${target.kind} worker (${target.w.mem.rss_mb}MB)`);
    if (target.kind === 'stream') {
      // Its sessions reopen from history on their next update.
      const closed = await this.streams.recycle(target.w);
      return { kind: 'stream', mb: target.w.mem.rss_mb, closed };
    }
    this.pool.recycle(target.w);
    return { kind: 'sandbox', mb: target.w.mem.rss_mb };
  }
}
