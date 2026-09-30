// Streaming parity: a PineStream fed bar by bar (several partial ticks per bar,
// then the final bar) must end in the same state as a one-shot run over the
// same bars. This is what lets live sessions update in milliseconds instead
// of re-running the whole history on every tick.
import { describe, it, expect, afterEach } from 'vitest';
import { PineStream } from '../src/sandbox.mjs';
import { barsFor, SCRIPTS } from './synthetic.mjs';
import { streamThrough, providerFor, ticksOf, upsert, baseOpts, trades, opens, pending, boxes, lines, plotValues, median } from './stream-harness.mjs';

const HISTORY = 1200;
const ALL = barsFor('5').slice(0, HISTORY + 30);
const opts = { ...baseOpts, timeframe: '5', timeoutMs: 30_000 };

const open = [];
afterEach(() => { for (const s of open.splice(0)) s?.dispose(); });

async function parity(source) {
  const r = await streamThrough(source, { history: HISTORY });
  open.push(r.stream);
  expect(r.error).toBeUndefined();
  expect(r.oneShot.ok, r.oneShot.error).toBe(true);
  return r;
}

describe('PineStream', () => {
  it('strategy with brackets: same trades, plots and markers as a one-shot run', async () => {
    const { streamed, oneShot, first, times } = await parity(SCRIPTS.ema_cross_strategy);
    expect(streamed.bars).toBe(HISTORY + 30);
    expect(trades(streamed)).toEqual(trades(oneShot));
    expect(opens(streamed)).toEqual(opens(oneShot));
    expect(pending(streamed)).toEqual(pending(oneShot));
    expect(streamed.strategy.closedtrades.length).toBeGreaterThan(trades(first).length); // trades happened live
    expect(streamed.series.times).toEqual(oneShot.series.times);
    expect(plotValues(streamed)).toEqual(plotValues(oneShot));
    expect(streamed.shapes).toEqual(oneShot.shapes);
    // An update re-executes one or two bars: far cheaper than the full run.
    expect(median(times)).toBeLessThan(Math.max(50, first.ms / 5));
  });

  it('indicator with boxes: same boxes as a one-shot run', async () => {
    const { streamed, oneShot } = await parity(SCRIPTS.fvg_boxes);
    expect(boxes(streamed)).toEqual(boxes(oneShot));
  });

  it('request.security: same higher-timeframe values', async () => {
    const { streamed, oneShot } = await parity(SCRIPTS.mtf_security);
    expect(plotValues(streamed)).toEqual(plotValues(oneShot));
  });

  it('var state is rolled back between ticks of the same bar', async () => {
    const src = `//@version=6
indicator("count")
var int n = 0
n += 1
plot(n, "n")`;
    const { streamed, oneShot } = await parity(src);
    const n = streamed.series.plots[0].values;
    expect(n.at(-1)).toBe(HISTORY + 30); // one increment per BAR, not per tick
    expect(plotValues(streamed)).toEqual(plotValues(oneShot));
  });

  // PineTS's own live rollback misses what happens INSIDE objects; the deep
  // snapshot in sandbox.mjs covers it. One increment per bar, never per tick.
  const MUTABLE = {
    array: `//@version=6
indicator("a")
var a = array.new<float>()
array.push(a, close)
if array.size(a) > 300
    array.shift(a)
plot(array.size(a) + array.avg(a) * 0, "n")`,
    map: `//@version=6
indicator("m")
var m = map.new<string, int>()
m.put("k", nz(m.get("k")) + 1)
plot(m.get("k"), "n")`,
    udt: `//@version=6
indicator("u")
type C
    int n = 0
    array<float> xs
var c = C.new(0, array.new<float>())
c.n += 1
c.xs.push(close)
plot(c.n + c.xs.size(), "n")`,
    matrix: `//@version=6
indicator("mx")
var mx = matrix.new<float>(1, 1, 0)
mx.set(0, 0, mx.get(0, 0) + 1)
plot(mx.get(0, 0), "n")`,
    local_var: `//@version=6
indicator("fn")
count() =>
    var arr = array.new<int>()
    array.push(arr, 1)
    array.size(arr)
plot(count(), "n")`,
    line_edits: `//@version=6
indicator("l", overlay=true)
var line ln = line.new(bar_index, close, bar_index + 1, close)
line.set_x2(ln, bar_index)
line.set_y2(ln, close)
var box bx = na
if bar_index % 7 == 0
    box.delete(bx)
    bx := box.new(bar_index, high, bar_index + 3, low)
plot(line.get_y2(ln), "n")`,
    security_gaps: `//@version=6
indicator("gaps")
plot(request.security(syminfo.tickerid, "60", close, gaps=barmerge.gaps_on), "h1")`,
  };
  for (const [name, src] of Object.entries(MUTABLE)) {
    it(`mutable state rolls back between ticks: ${name}`, async () => {
      const { streamed, oneShot } = await parity(src);
      expect(plotValues(streamed)).toEqual(plotValues(oneShot));
      expect(boxes(streamed)).toEqual(boxes(oneShot));
      expect(lines(streamed)).toEqual(lines(oneShot));
    });
  }

  it('barstate.isnew is true on a bar\'s first tick only', async () => {
    const src = `//@version=6
indicator("isnew")
plot(barstate.isnew ? 1 : 0, "isnew")`;
    const live = ALL.slice(0, HISTORY).map((b) => ({ ...b }));
    const s = await PineStream.open({ ...opts, source: src, limit: live.length, fetchBars: providerFor(live), maxSeriesBars: 2 });
    expect(s.ok, s.error).toBe(true);
    open.push(s.stream);
    const [t1, t2] = ticksOf(ALL[HISTORY]);
    upsert(live, t1);
    const a = await s.stream.update({ newBar: true, maxSeriesBars: 2 });
    upsert(live, t2);
    const b = await s.stream.update({ newBar: false, maxSeriesBars: 2 });
    expect(a.series.plots[0].values.at(-1)).toBe(1);
    expect(b.series.plots[0].values.at(-1)).toBe(0);
  });

  it('an update with no new data changes nothing', async () => {
    const live = ALL.slice(0, HISTORY).map((b) => ({ ...b }));
    const s = await PineStream.open({ ...opts, source: SCRIPTS.ema_cross_strategy, limit: live.length, fetchBars: providerFor(live), maxSeriesBars: 50 });
    open.push(s.stream);
    const again = await s.stream.update({ maxSeriesBars: 50 });
    expect(again.ok).toBe(true);
    expect(again.bars).toBe(HISTORY);
    expect(trades(again)).toEqual(trades(s));
  });

  it('can return only the newest closed trades', async () => {
    const live = ALL.slice(0, HISTORY).map((b) => ({ ...b }));
    const s = await PineStream.open({ ...opts, source: SCRIPTS.ema_cross_strategy, limit: live.length, fetchBars: providerFor(live) });
    open.push(s.stream);
    const r = await s.stream.update({ maxClosedTrades: 3 });
    expect(r.strategy.closedtrades.length).toBe(3);
    expect(r.strategy.closedtrades_total).toBe(s.strategy.closedtrades.length);
    expect(trades(r)).toEqual(trades(s).slice(-3));
  });

  it('a script error on a live bar disposes the stream', async () => {
    const src = `//@version=6
indicator("boom")
if bar_index >= ${HISTORY}
    runtime.error("boom")
plot(close)`;
    const live = ALL.slice(0, HISTORY).map((b) => ({ ...b }));
    const s = await PineStream.open({ ...opts, source: src, limit: live.length, fetchBars: providerFor(live) });
    expect(s.ok, s.error).toBe(true);
    upsert(live, { ...ALL[HISTORY] });
    const r = await s.stream.update({ newBar: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom/);
    expect(s.stream.alive).toBe(false);
  });

  it('a runaway loop on a live bar is stopped and disposes the stream', async () => {
    const src = `//@version=6
indicator("spin")
x = 0.0
if bar_index >= ${HISTORY}
    for i = 0 to 100000000
        for j = 0 to 100000000
            x += 1
plot(x)`;
    const live = ALL.slice(0, HISTORY).map((b) => ({ ...b }));
    const s = await PineStream.open({ ...opts, source: src, limit: live.length, fetchBars: providerFor(live) });
    expect(s.ok, s.error).toBe(true);
    upsert(live, { ...ALL[HISTORY] });
    const r = await s.stream.update({ newBar: true, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(s.stream.alive).toBe(false);
  });
});
