// LiveManager on streams: a session opens its stream from history once, then
// sends only the bars from the stream's last bar on; a lost stream reopens;
// a failing or unavailable stream falls back to a stateless full re-run.
import { describe, it, expect } from 'vitest';
import { LiveManager } from '../src/live/manager.mjs';
import { BarAggregator } from '../src/live/bars.mjs';

const T0 = Date.UTC(2026, 8, 29, 14, 30);
const bar = (i, close = 1) => ({ openTime: T0 + i * 300_000, open: 1, high: 2, low: 0, close, volume: 1, closeTime: T0 + i * 300_000 + 299_999 });
const cfg = { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://backend', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000, liveIntrabarSeconds: 60, liveHeartbeatSeconds: 60, liveStreamIntrabarMs: 1000, liveStreamRecycleBars: 50 };

function liveResult(n, lastTime) {
  return { kind: 'indicator', title: 't', bars: n, lastTime, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: { overlay: true, title: 't', shorttitle: null, precision: null, times: [Math.floor(lastTime / 1000)], plots: [{ id: 'p0', key: 'x', title: 'x', style: 'line', color: '#2962ff', linewidth: 1, overlay: true, values: [n], colors: null }], hlines: [], fills: [], barcolor: null, bgcolor: null } };
}

// In-process stand-in for StreamHost: remembers what each stream has seen.
function fakeStreams({ failUpdates = 0, failOpens = 0, capacity = false } = {}) {
  const calls = [];
  const known = new Map(); // key -> bars
  return {
    calls,
    known,
    failUpdates,
    failOpens,
    async open(key, p) {
      calls.push({ op: 'open', key, bars: p.bars.length, last: p.bars.at(-1)?.openTime, max: p.max_series_bars });
      if (capacity) return { ok: false, capacity: true, detail: 'full' };
      if (this.failOpens > 0) { this.failOpens--; return { ok: false, status: 400, detail: 'open failed' }; }
      known.set(key, p.bars.map((b) => ({ ...b })));
      return { ok: true, live: liveResult(p.bars.length, p.bars.at(-1).openTime), heap_mb: 7 };
    },
    async update(key, p) {
      calls.push({ op: 'update', key, times: p.bars.map((b) => b.openTime), newBar: p.new_bar, max: p.max_series_bars });
      const bars = known.get(key);
      if (!bars) return { ok: false, stream_missing: true, detail: 'missing' };
      if (this.failUpdates > 0) { this.failUpdates--; known.delete(key); return { ok: false, stream_lost: true, detail: 'update failed' }; }
      for (const b of p.bars) { const l = bars.at(-1); if (l.openTime === b.openTime) bars[bars.length - 1] = b; else if (b.openTime > l.openTime) bars.push(b); }
      return { ok: true, live: liveResult(bars.length, bars.at(-1).openTime), heap_mb: 8 };
    },
    closeStream(key) { calls.push({ op: 'close', key }); known.delete(key); },
    stats: { streams: 0 },
  };
}

async function setup(streams, items = null) {
  const published = [];
  const poolRuns = [];
  const m = new LiveManager({
    config: cfg,
    pool: { run: async (job) => { poolRuns.push(job.bars.length); return { ok: true, live: liveResult(job.bars.length, job.bars.at(-1).openTime) }; } },
    streams,
    log: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => ({ ok: true, json: async () => items || [{ strategy_code_id: 1, strategy_key: 'k', symbol: 'NQ', timeframe: '5m', source: '//@version=6\nindicator("x")' }] }),
  });
  m.bus = { publishState: async (p, o) => { published.push({ partial: !!p.partial, cache: !o || o.cache !== false }); return true; }, stats: {} };
  m.feed = { setSymbols() {}, stats: {} };
  await m.sync();
  const s = m.sessions.get('1:NQ');
  s.bars = [0, 1, 2].map((i) => bar(i));
  s.warmed = true;
  const agg = new BarAggregator('NQ', 300, (b) => m.onBarForTest('NQ', 300, b));
  m.aggregators.set('NQ:300', agg);
  return { m, s, agg, published, poolRuns };
}

describe('streamed live sessions', () => {
  it('open once from history, then send only the tail from the stream\'s last bar', async () => {
    const streams = fakeStreams();
    const { m, s, agg, published, poolRuns } = await setup(streams);

    // First run (like #warm): opens the stream from the closed history.
    await m.onBarForTest('NQ', 300, bar(2, 5));
    expect(streams.calls[0]).toMatchObject({ op: 'open', bars: 3, last: bar(2).openTime, max: 100 });
    expect(s.streamed).toBe(true);
    expect(s.streamLast).toBe(bar(2).openTime);

    // Bar 3's first print closed bar 2 (what #onBar leaves behind), so the
    // boundary update sends [bar 2 (final), forming 3] as a new bar.
    s.closedPending = true;
    await m.onTradeForTest('NQ', 7, 1, bar(3).openTime + 1_000);
    const boundary = streams.calls.find((c) => c.op === 'update');
    expect(boundary.times).toEqual([bar(2).openTime, bar(3).openTime]);
    expect(boundary.newBar).toBe(true);
    expect(boundary.max).toBe(2);
    expect(s.streamLast).toBe(bar(3).openTime);
    await m.intrabarTickForTest(); // the follow-up closed-history run the boundary queued

    // Intrabar ticks: only the forming bar, not a new bar, at the stream cadence (1s).
    agg.trade(8, 1, bar(3).openTime + 2_000);
    s.dirty = true;
    s.lastIntrabarAt = 0;
    const before = streams.calls.length;
    await m.intrabarTickForTest();
    const tick = streams.calls.slice(before).find((c) => c.op === 'update');
    expect(tick.times).toEqual([bar(3).openTime]);
    expect(tick.newBar).toBe(false);
    expect(s.intrabarMs).toBe(1000);

    // Nothing went through the stateless pool.
    expect(poolRuns).toEqual([]);
    expect(published.some((p) => p.partial)).toBe(true);
    expect(m.stats.sessions[0].stream).toMatchObject({ on: true, opens: 1, heapMb: 8 });
  });

  it('a lost stream reopens from history in the same run', async () => {
    const streams = fakeStreams();
    const { m, s } = await setup(streams);
    await m.onBarForTest('NQ', 300, bar(2));
    streams.known.delete('1:NQ'); // e.g. the stream worker restarted
    await m.onBarForTest('NQ', 300, bar(3));
    expect(streams.calls.map((c) => c.op)).toEqual(['open', 'update', 'open']);
    expect(streams.calls[2]).toMatchObject({ bars: 4, last: bar(3).openTime });
    expect(s.streamOpens).toBe(2);
    expect(s.streamed).toBe(true);
  });

  it('a stream that keeps failing falls back to full re-runs, then turns streaming off', async () => {
    const streams = fakeStreams({ failOpens: 99 });
    const { m, s, poolRuns } = await setup(streams);
    for (let i = 2; i < 6; i++) await m.onBarForTest('NQ', 300, bar(i));
    expect(poolRuns.length).toBe(4); // every run still produced output
    expect(s.streamOff).toBe(true);
    const opens = streams.calls.filter((c) => c.op === 'open').length;
    await m.onBarForTest('NQ', 300, bar(6));
    expect(streams.calls.filter((c) => c.op === 'open').length).toBe(opens); // no more attempts
  });

  it('no stream capacity: stateless now, retry later without counting a failure', async () => {
    const streams = fakeStreams({ capacity: true });
    const { m, s, poolRuns } = await setup(streams);
    await m.onBarForTest('NQ', 300, bar(2));
    expect(poolRuns.length).toBe(1);
    expect(s.streamFailures).toBe(0);
    expect(s.streamRetryAt).toBeGreaterThan(Date.now());
  });

  it('recycles a long-lived stream from history on a closed bar', async () => {
    const streams = fakeStreams();
    const { m, s } = await setup(streams);
    await m.onBarForTest('NQ', 300, bar(2));
    s.streamBars = cfg.liveWarmupBars + cfg.liveStreamRecycleBars; // grown past the bound
    await m.onBarForTest('NQ', 300, bar(3));
    expect(streams.calls.map((c) => c.op)).toEqual(['open', 'open']);
    expect(s.streamOpens).toBe(2);
  });

  it('closes the stream when the session is dropped', async () => {
    const streams = fakeStreams();
    const { m } = await setup(streams);
    await m.onBarForTest('NQ', 300, bar(2));
    m.fetch = async () => ({ ok: true, json: async () => [] });
    await m.sync();
    expect(streams.calls.at(-1)).toEqual({ op: 'close', key: '1:NQ' });
    expect(m.sessions.size).toBe(0);
  });
});
