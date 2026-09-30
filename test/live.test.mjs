import { describe, it, expect } from 'vitest';
import { BarAggregator, mergeBar } from '../src/live/bars.mjs';
import { stateFrom, stateHash, emptyState, partialStateFrom } from '../src/live/state.mjs';
import { LiveManager } from '../src/live/manager.mjs';

const T0 = Date.UTC(2026, 8, 29, 14, 30); // 14:30Z, on a 5-minute boundary

describe('BarAggregator', () => {
  it('buckets trades into start-stamped bars and closes on the next bucket', () => {
    const closed = [];
    const a = new BarAggregator('NQ', 300, (b) => closed.push(b));
    a.trade(100, 1, T0 + 1000);
    a.trade(102, 2, T0 + 60_000);
    a.trade(99, 1, T0 + 200_000);
    expect(closed.length).toBe(0);
    expect(a.forming).toMatchObject({ openTime: T0, open: 100, high: 102, low: 99, close: 99, volume: 4, closeTime: T0 + 299_999 });
    a.trade(101, 1, T0 + 300_000);
    expect(closed.length).toBe(1);
    expect(closed[0]).toMatchObject({ openTime: T0, close: 99 });
    expect(a.forming.openTime).toBe(T0 + 300_000);
  });
  it('closes on the wall clock and ignores late trades', () => {
    const closed = [];
    const a = new BarAggregator('NQ', 60, (b) => closed.push(b));
    a.trade(100, 1, T0);
    a.tick(T0 + 30_000);
    expect(closed.length).toBe(0);
    a.tick(T0 + 60_000);
    expect(closed.length).toBe(1);
    a.trade(50, 1, T0 - 5_000); // late
    expect(a.forming).toBe(null);
  });
  it('mergeBar replaces same-open bars and caps length', () => {
    const bars = [{ openTime: 1 }, { openTime: 2 }];
    mergeBar(bars, { openTime: 2, close: 9 }, 10);
    expect(bars.length).toBe(2);
    expect(bars[1].close).toBe(9);
    mergeBar(bars, { openTime: 3 }, 2);
    expect(bars.map((b) => b.openTime)).toEqual([2, 3]);
    mergeBar(bars, { openTime: 1 }, 2);
    expect(bars.map((b) => b.openTime)).toEqual([2, 3]);
  });
});

describe('stateFrom', () => {
  const result = {
    plots: { fast: { color: '#FF9800FF', points: [[T0, 1], [T0 + 300_000, 2], [T0 + 600_000, 3]] } },
    shapes: [{ t: T0, price: 99, dir: 'down', text: 'S' }, { t: T0, price: NaN, dir: 'up', text: '' }],
    drawings: {
      boxes: [{ id: 7, t1: T0 + 300_000, t2: T0, top: 101, bottom: 105 }],
      lines: [{ id: 1, p1: 100, p2: 100, style: 'style_dashed' }, { id: 2, p1: 100, p2: 103 }],
      labels: [{ id: 3, price: 100, text: 'PDH' }],
    },
  };
  it('produces relay-shaped drawings in epoch seconds', () => {
    const s = stateFrom(result, { strategyKey: 'fvg_(viz_#9)', symbol: 'NQ' });
    expect(s.strategy).toBe('fvg_(viz_#9)');
    expect(s.symbol).toBe('NQ');
    expect(s.side).toBe(null);
    const box = s.drawings.find((d) => d.kind === 'box');
    expect(box).toEqual({ kind: 'box', id: 'b7', t1: T0 / 1000, t2: T0 / 1000 + 300, p1: 105, p2: 101 });
    const shapes = s.drawings.filter((d) => d.kind === 'shape');
    expect(shapes.length).toBe(1);
    expect(shapes[0]).toMatchObject({ t: T0 / 1000, price: 99, dir: 'down', text: 'S' });
    expect(s.drawings.some((d) => d.kind === 'polyline')).toBe(false); // plots ship as `series` now
    expect(s.series).toBe(null); // this fixture has no series block
    expect(s.levels).toEqual([{ id: 'L1', label: 'PDH', price: 100, kind: 'info', style: 'dashed' }]);
  });
  it('series passes through when present', () => {
    const s = stateFrom({ ...result, series: { times: [1], plots: [{ id: 'p0', values: [1] }], hlines: [], fills: [] } }, { strategyKey: 'k', symbol: 'NQ' });
    expect(s.series.plots.length).toBe(1);
  });
  it('hash ignores ts', () => {
    const a = stateFrom(result, { strategyKey: 'k', symbol: 'NQ' });
    const b = { ...a, ts: 'other' };
    expect(stateHash(a)).toBe(stateHash(b));
    expect(stateHash(a)).not.toBe(stateHash(emptyState({ strategyKey: 'k', symbol: 'NQ' })));
  });
});

describe('partialStateFrom', () => {
  it('carries only the last bar of each plot, keeps drawings, flags partial', () => {
    const r = { plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: { times: [1, 2, 3], plots: [{ id: 'p0', values: [1, 2, 3], colors: { palette: ['#a', '#b'], idx: [0, 1, 0] } }, { id: 'p1', values: [null, 5, 6], colors: null }], hlines: [], fills: [], barcolor: { palette: ['#c'], idx: [null, 0, 0] }, bgcolor: null } };
    const p = partialStateFrom(r, { strategyKey: 'k', symbol: 'NQ' });
    expect(p.partial).toBe(true);
    expect(p.series.times).toEqual([3]);
    expect(p.series.plots).toEqual([{ id: 'p0', values: [3], colors: { palette: ['#a', '#b'], idx: [0] } }, { id: 'p1', values: [6], colors: null }]);
    expect(p.series.barcolor).toEqual({ palette: ['#c'], idx: [0] });
    expect(partialStateFrom({ plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: null }, { strategyKey: 'k', symbol: 'NQ' })).toBe(null);
  });
});

describe('LiveManager sync', () => {
  const cfg = { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://backend', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000 };
  const fakeItems = [
    { strategy_code_id: 5, strategy_key: 'fvg_(viz_#5)', symbol: 'CME_MINI:NQ1!', timeframe: '5m', source: '//@version=6\nindicator("x")' },
    { strategy_code_id: 6, strategy_key: 'bad', symbol: 'NQ 1', timeframe: '5m', source: 'x' },
    { strategy_code_id: 7, strategy_key: 'tf', symbol: 'ES', timeframe: '7m', source: 'x' },
  ];
  it('creates sessions for valid rows, normalises symbol/timeframe, feeds the right symbols', async () => {
    const published = [];
    const m = new LiveManager({ config: cfg, pool: { run: async () => ({ ok: false, detail: 'no' }) }, log: { info() {}, warn() {} }, fetchImpl: async () => ({ ok: true, json: async () => fakeItems }) });
    m.bus = { publishState: async (p) => { published.push(p); return true; }, stats: {} };
    const subscribed = [];
    m.feed = { setSymbols: (s) => subscribed.push(s), stats: {} };
    await m.sync();
    expect([...m.sessions.keys()]).toEqual(['5:NQ', '7:ES']);
    expect(m.sessions.get('7:ES').timeframe).toBe('5m');
    expect(subscribed.at(-1).sort()).toEqual(['ES', 'NQ']);
    // Removal publishes an empty state so the chart clears.
    m.fetch = async () => ({ ok: true, json: async () => [] });
    await m.sync();
    expect(m.sessions.size).toBe(0);
    expect(published.map((p) => p.strategy).sort()).toEqual(['fvg_(viz_#5)', 'tf']);
    expect(published[0].drawings).toEqual([]);
  });
});
