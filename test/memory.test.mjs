// Memory: workers collect host garbage and report their memory, stream and
// sandbox workers can be replaced in a controlled way, the live manager
// recycles them once a day in the CME break, and the watchdog replaces the
// largest worker when the total passes its budget.
import { describe, it, expect, afterEach } from 'vitest';
import { StreamHost } from '../src/streams.mjs';
import { WorkerPool } from '../src/pool.mjs';
import { LiveManager, cmeBreakDay } from '../src/live/manager.mjs';
import { MemoryWatchdog, memoryLine } from '../src/memory.mjs';
import { barsFor, SCRIPTS } from './synthetic.mjs';

const BARS = barsFor('5').slice(0, 800);
const env = { ...process.env, PINE_SYNTHETIC_DATA: '1', ENVIRONMENT: 'test', TIMESCALE_URL: '' };
const quiet = { info() {}, warn() {}, error() {} };
const openPayload = (source, bars = BARS.slice(0, 600)) => ({ source, symbol: 'NQ', timeframe: '5m', bars, symbol_info: { mintick: 0.25 }, max_series_bars: 50 });
const closers = [];
afterEach(async () => { for (const c of closers.splice(0)) await c.close(); });

describe('cmeBreakDay', () => {
  // America/Chicago: UTC-6 in winter (CST), UTC-5 in summer (CDT).
  it.each([
    ['2026-11-30T22:05:00Z', '2026-11-30'], // Mon 16:05 CST
    ['2026-11-30T22:54:59Z', '2026-11-30'], // Mon 16:54 CST
    ['2026-11-30T22:04:59Z', null], //         16:04: too early (bars still closing)
    ['2026-11-30T22:55:00Z', null], //         16:55: too close to the 17:00 open
    ['2026-11-30T15:30:00Z', null], //         market hours
    ['2026-12-04T22:30:00Z', '2026-12-04'], // Friday's close
    ['2026-12-05T22:30:00Z', null], //         Saturday
    ['2026-12-06T22:30:00Z', null], //         Sunday
    ['2026-06-01T21:10:00Z', '2026-06-01'], // Mon 16:10 CDT
    ['2026-06-01T22:10:00Z', null], //         Mon 17:10 CDT: reopened
  ])('%s -> %s', (iso, day) => {
    expect(cmeBreakDay(Date.parse(iso))).toBe(day);
  });
});

describe('workers report memory and can be replaced', () => {
  it('a stream worker reports its memory; recycle closes its streams and a fresh worker takes new ones', async () => {
    const host = new StreamHost({ size: 1, maxStreams: 4, env, log: quiet });
    closers.push(host);
    expect((await host.open('1:NQ', openPayload(SCRIPTS.ema_cross_strategy), { timeoutMs: 20_000 })).ok).toBe(true);
    const old = host.workers[0];
    expect(old.mem).toMatchObject({ rss_mb: expect.any(Number), external_mb: expect.any(Number) });
    expect(host.largest()).toBe(old);

    const closed = await host.recycle();
    expect(closed).toBe(1);
    expect(host.stats).toMatchObject({ workers: 1, ready: 1, streams: 0, crashes: 0 });
    expect(host.workers[0]).not.toBe(old);
    expect((await host.update('1:NQ', { bars: [BARS[600]], new_bar: true }, { timeoutMs: 5_000 })).stream_missing).toBe(true);
    const reopened = await host.open('1:NQ', openPayload(SCRIPTS.ema_cross_strategy), { timeoutMs: 20_000 });
    expect(reopened.ok, reopened.detail).toBe(true);
  }, 60_000);

  it('host garbage stays bounded over many stream updates', async () => {
    const host = new StreamHost({ size: 1, maxStreams: 2, env, log: quiet });
    closers.push(host);
    expect((await host.open('2:NQ', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 })).ok).toBe(true);
    let maxExternal = 0;
    for (let i = 600; i < 800; i++) {
      for (const f of [0.3, 0.6, 1]) {
        const b = BARS[i];
        const tick = { ...b, close: b.open + (b.close - b.open) * f };
        const r = await host.update('2:NQ', { bars: [f === 0.3 ? BARS[i - 1] : b, tick].slice(f === 0.3 ? 0 : 1), new_bar: f === 0.3, max_series_bars: 50 }, { timeoutMs: 20_000 });
        expect(r.ok, r.detail).toBe(true);
        maxExternal = Math.max(maxExternal, host.workers[0].mem.external_mb);
      }
    }
    // The worker collects once external memory passes 64 MB (PINE_GC_EXTERNAL_MB).
    expect(maxExternal).toBeLessThan(100);
  }, 120_000);

  it('a sandbox worker is replaced after its job, never during it', async () => {
    const pool = new WorkerPool({ size: 1, log: quiet });
    closers.push(pool);
    const job = { type: 'compile', source: SCRIPTS.ema_cross_strategy, symbol: 'NQ' };
    const first = await pool.run(job, { timeoutMs: 20_000 });
    expect(first.mem).toMatchObject({ rss_mb: expect.any(Number) });
    const old = pool.workers[0];
    const busy = pool.run(job, { timeoutMs: 20_000 });
    pool.recycle();
    expect(old.retiring).toBe(true);
    expect((await busy).id).toBeTruthy(); // the job in flight finished on the old worker
    for (let i = 0; i < 100 && (pool.workers[0] === old || !pool.workers[0]?.ready); i++) await new Promise((r) => setTimeout(r, 100));
    expect(pool.workers).toHaveLength(1);
    expect(pool.workers[0]).not.toBe(old);
    expect((await pool.run(job, { timeoutMs: 20_000 })).id).toBeTruthy();
  }, 60_000);
});

describe('daily recycle in the live manager', () => {
  const T0 = Date.UTC(2026, 10, 30, 15, 0);
  const bar = (i) => ({ openTime: T0 + i * 300_000, open: 1, high: 2, low: 0, close: 1, volume: 1, closeTime: T0 + i * 300_000 + 299_999 });
  const live = (n, t) => ({ kind: 'indicator', title: 't', bars: n, lastTime: t, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: { overlay: true, title: 't', shorttitle: null, precision: null, times: [Math.floor(t / 1000)], plots: [], hlines: [], fills: [], barcolor: null, bgcolor: null } });

  async function setup(config = {}) {
    const calls = [];
    const streams = {
      async open(key, p) { calls.push(['open', key]); return { ok: true, live: live(p.bars.length, p.bars.at(-1).openTime), heap_mb: 5 }; },
      async update() { return { ok: false, stream_missing: true }; },
      async recycle() { calls.push(['recycle streams']); return 2; },
      closeStream() {},
      stats: { streams: 2, memory: [] },
    };
    const pool = { run: async (job) => ({ ok: true, live: live(job.bars.length, job.bars.at(-1).openTime) }), recycle() { calls.push(['recycle pool']); } };
    const m = new LiveManager({
      config: { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://b', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000, liveIntrabarSeconds: 60, liveHeartbeatSeconds: 60, liveStreamIntrabarMs: 1000, liveStreamRecycleBars: 50, dailyRecycle: true, ...config },
      pool, streams, log: quiet,
      fetchImpl: async () => ({ ok: true, json: async () => [
        { strategy_code_id: 1, strategy_key: 'a', symbol: 'NQ', timeframe: '5m', source: '//@version=6\nindicator("x")' },
        { strategy_code_id: 2, strategy_key: 'b', symbol: 'ES', timeframe: '5m', source: '//@version=6\nindicator("y")' },
      ] }),
    });
    m.bus = { publishState: async () => true, stats: {} };
    m.feed = { setSymbols() {}, stats: {} };
    await m.sync();
    for (const s of m.sessions.values()) { s.bars = [0, 1, 2].map(bar); s.warmed = true; s.streamed = true; }
    return { m, calls };
  }

  it('in the break it replaces the workers and reopens every session from history, once per day', async () => {
    const { m, calls } = await setup();
    await m.maintenanceForTest(Date.parse('2026-11-30T15:30:00Z')); // market hours: nothing
    expect(calls).toEqual([]);
    await m.maintenanceForTest(Date.parse('2026-11-30T22:10:00Z')); // Mon 16:10 CT
    expect(calls).toEqual([['recycle pool'], ['recycle streams'], ['open', '1:NQ'], ['open', '2:ES']]);
    for (const s of m.sessions.values()) expect(s.streamed).toBe(true);
    await m.maintenanceForTest(Date.parse('2026-11-30T22:30:00Z')); // same break: done already
    expect(calls).toHaveLength(4);
    await m.maintenanceForTest(Date.parse('2026-12-01T22:10:00Z')); // next day
    expect(calls).toHaveLength(8);
  });

  it('PINE_DAILY_RECYCLE=false turns it off', async () => {
    const { m, calls } = await setup({ dailyRecycle: false });
    await m.maintenanceForTest(Date.parse('2026-11-30T22:10:00Z'));
    expect(calls).toEqual([]);
  });
});

describe('MemoryWatchdog', () => {
  const worker = (rss) => ({ mem: { rss_mb: rss, external_mb: 1 } });
  function setup(total, { poolBig = 300, streamBig = 900 } = {}) {
    const done = [];
    const p = worker(poolBig);
    const s = worker(streamBig);
    const pool = { largest: () => p, recycle: (w) => done.push(['sandbox', w.mem.rss_mb]) };
    const streams = { largest: () => s, recycle: async (w) => { done.push(['stream', w.mem.rss_mb]); return 3; } };
    let t = 0;
    const dog = new MemoryWatchdog({ pool, streams, budgetMb: 3400, cooldownMs: 60_000, log: quiet, now: () => t, snapshot: () => ({ total_mb: total, main_mb: 100, pool: [], streams: [], open_streams: 3 }) });
    return { dog, done, advance: (ms) => { t += ms; } };
  }

  it('does nothing under budget', async () => {
    const { dog, done } = setup(3000);
    expect(await dog.check()).toBeNull();
    expect(done).toEqual([]);
  });

  it('over budget it replaces the largest worker, then waits out the cooldown', async () => {
    const { dog, done, advance } = setup(3600);
    expect(await dog.check()).toEqual({ kind: 'stream', mb: 900, closed: 3 });
    expect(await dog.check()).toBeNull();
    advance(60_000);
    await dog.check();
    expect(done).toEqual([['stream', 900], ['stream', 900]]);
  });

  it('picks a sandbox worker when it is the largest', async () => {
    const { dog, done } = setup(3600, { poolBig: 1500, streamBig: 400 });
    expect(await dog.check()).toEqual({ kind: 'sandbox', mb: 1500 });
    expect(done).toEqual([['sandbox', 1500]]);
  });

  it('logs one readable line', () => {
    expect(memoryLine({ total_mb: 900, main_mb: 100, pool: [{ rss_mb: 300, external_mb: 2 }, null], streams: [{ rss_mb: 500, external_mb: 9 }], open_streams: 4 }, 3400))
      .toBe('memory: total=900MB of budget 3400MB, main=100MB, sandbox=[300/2ext, ?], streams=[500/9ext] holding 4 stream(s)');
  });
});
