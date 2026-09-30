// Intrabar: a session whose symbol traded re-runs on the forming bar and
// publishes a PARTIAL frame (not cached); a closed bar publishes a FULL frame.
import { describe, it, expect } from 'vitest';
import { LiveManager } from '../src/live/manager.mjs';
import { BarAggregator } from '../src/live/bars.mjs';

const T0 = Date.UTC(2026, 8, 29, 14, 30);
const cfg = { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://backend', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000, liveIntrabarSeconds: 2, liveHeartbeatSeconds: 60 };

function liveResult(bars) {
  const times = bars.map((b) => Math.floor(b.openTime / 1000));
  return { kind: 'indicator', title: 't', bars: bars.length, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: { overlay: true, title: 't', shorttitle: null, precision: null, times, plots: [{ id: 'p0', key: 'x', title: 'x', style: 'line', color: '#2962ff', linewidth: 1, overlay: true, values: bars.map((b) => b.close), colors: null }], hlines: [], fills: [], barcolor: null, bgcolor: null } };
}

async function setup() {
  const published = [];
  const runs = [];
  const m = new LiveManager({
    config: cfg,
    pool: { run: async (job) => { runs.push(job.bars.length); return { ok: true, live: liveResult(job.bars) }; } },
    log: { info() {}, warn() {} },
    fetchImpl: async () => ({ ok: true, json: async () => [{ strategy_code_id: 1, strategy_key: 'k', symbol: 'NQ', timeframe: '5m', source: '//@version=6\nindicator("x")' }] }),
  });
  m.bus = { publishState: async (p, o) => { published.push({ partial: !!p.partial, cache: !o || o.cache !== false, times: p.series ? p.series.times : null }); return true; }, stats: {} };
  m.feed = { setSymbols() {}, stats: {} };
  await m.sync();
  // Seed the session like #warm would (no warehouse in tests).
  const s = m.sessions.get('1:NQ');
  s.bars = [0, 1, 2].map((i) => ({ openTime: T0 + i * 300_000, open: 1, high: 2, low: 0, close: 1 + i, volume: 1, closeTime: T0 + i * 300_000 + 299_999 }));
  s.warmed = true;
  const agg = new BarAggregator('NQ', 300, (bar) => m.onBarForTest('NQ', 300, bar));
  m.aggregators.set('NQ:300', agg);
  return { m, s, agg, published, runs };
}

describe('intrabar runs', () => {
  it('publishes partial frames for the forming bar and full frames on bar close', async () => {
    const { m, s, agg, published, runs } = await setup();

    // A trade in a NEW bucket -> forming bar; the session is dirty.
    agg.trade(10, 1, T0 + 3 * 300_000 + 5_000);
    s.dirty = true;
    s.lastIntrabarAt = 0;
    await m.intrabarTickForTest();
    expect(runs.at(-1)).toBe(4); // 3 closed + the forming bar
    expect(published.at(-1)).toEqual({ partial: true, cache: false, times: [Math.floor((T0 + 3 * 300_000) / 1000)] });
    expect(s.bars.length).toBe(3); // history untouched by an intrabar run

    // No new trades -> not dirty -> no run.
    const before = runs.length;
    await m.intrabarTickForTest();
    expect(runs.length).toBe(before);

    // Dirty again but inside the per-session interval -> throttled.
    s.dirty = true;
    await m.intrabarTickForTest();
    expect(runs.length).toBe(before);

    // Same values again after the interval -> run, but nothing new to publish.
    s.lastIntrabarAt = 0;
    const pubBefore = published.length;
    await m.intrabarTickForTest();
    expect(runs.length).toBe(before + 1);
    expect(published.length).toBe(pubBefore);

    // Bar closes -> merged into history, FULL frame, cached.
    const closed = { openTime: T0 + 3 * 300_000, open: 10, high: 10, low: 10, close: 10, volume: 1, closeTime: T0 + 3 * 300_000 + 299_999 };
    await m.onBarForTest('NQ', 300, closed);
    expect(s.bars.length).toBe(4);
    expect(published.at(-1).partial).toBe(false);
    expect(published.at(-1).cache).toBe(true);
    expect(published.at(-1).times.length).toBe(4);
  });

  it('skips the intrabar run when the forming bar is not newer than history', async () => {
    const { m, s, agg, runs } = await setup();
    agg.trade(10, 1, T0 + 2 * 300_000 + 5_000); // same bucket as the last closed bar
    s.dirty = true;
    s.lastIntrabarAt = 0;
    await m.intrabarTickForTest();
    expect(runs.length).toBe(0);
  });
});
