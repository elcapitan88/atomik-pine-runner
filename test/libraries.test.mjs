// Imported Pine libraries running in PineTS: the vendored jdehorty libraries
// against an independent JavaScript port (test/reference/jdehorty.mjs), our
// FormattingUtils stand-in, Pine features through an import (types, enums,
// methods, per-call `var` state), error positions, and streaming parity.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPine } from '../src/sandbox.mjs';
import { expandImports } from '../src/imports.mjs';
import { fetchBars, symbolInfo } from './synthetic.mjs';
import { streamThrough, trades, opens, plotValues, labels } from './stream-harness.mjs';
import * as J from './reference/jdehorty.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BARS = 2000;
const run = (source, extra = {}) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: BARS, symbolInfo, fetchBars, timeoutMs: 60_000, memoryMb: 256, maxPlotPoints: BARS, ...extra });

/** A plot as one value per bar (NaN where it plotted nothing). */
function perBar(result, title, bars) {
  const at = new Map(bars.map((b, i) => [b.openTime, i]));
  const out = new Array(bars.length).fill(NaN);
  for (const [t, v] of result.plots[title]?.points || []) {
    const i = at.get(t);
    if (i != null && v != null) out[i] = v;
  }
  return out;
}

/** Largest relative difference where both have a value; -1 when their na bars differ. */
function maxDiff(got, want, from = 0) {
  let worst = 0;
  for (let i = from; i < want.length; i++) {
    const a = got[i]; const b = want[i];
    const an = Number.isNaN(a); const bn = J.na(b) || !Number.isFinite(b);
    if (an || bn) { if (an !== bn) return -1; continue; }
    worst = Math.max(worst, Math.abs(a - b) / Math.max(1, Math.abs(b)));
  }
  return worst;
}

describe('jdehorty MLExtensions v2 + KernelFunctions v2 in PineTS', async () => {
  const bars = await fetchBars('NQ', '5', BARS);
  const c = bars.map((b) => b.close); const h = bars.map((b) => b.high); const l = bars.map((b) => b.low);
  const v = bars.map((b) => b.volume);
  const hlc3 = bars.map((b) => (b.high + b.low + b.close) / 3);
  const ohlc4 = bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
  const idx = bars.map((_, i) => i);
  const b01 = (a) => a.map((x) => (x ? 1 : 0));
  const bt = J.backtest(bars, idx.map((i) => i % 37 === 0), idx.map((i) => i % 37 === 20), idx.map((i) => i % 53 === 0), idx.map((i) => i % 53 === 30), idx.map((i) => i % 5 === 0), 100, c, false);
  const expected = {
    rescale: J.rescale(c, 19000, 21000, 0, 1),
    normalize_close: J.normalize(c, 0, 1),
    normalize_volume: J.normalize(v, -1, 1),
    normalizeDeriv: J.normalizeDeriv(c, 10),
    tanh: J.tanh(J.normalizeDeriv(c, 10)),
    dualPoleFilter: J.dualPoleFilter(c, 6),
    tanhTransform: J.tanhTransform(c, 1, 5),
    n_rsi: J.n_rsi(c, 14, 1),
    n_rsi_9_3: J.n_rsi(c, 9, 3),
    n_cci: J.n_cci(c, 20, 1),
    n_wt: J.n_wt(hlc3, 10, 11),
    n_adx: J.n_adx(h, l, c, 14),
    regime_filter: b01(J.regime_filter(ohlc4, bars, -0.1, true)),
    filter_adx: b01(J.filter_adx(c, bars, 14, 20, true)),
    filter_volatility: b01(J.filter_volatility(bars, 1, 10, true)),
    rationalQuadratic: J.rationalQuadratic(c, 8, 8, 25),
    rationalQuadratic_rw1: J.rationalQuadratic(c, 8, 1, 25),
    gaussian: J.gaussian(c, 6, 25),
    periodic: J.periodic(c, 8, 100, 25),
    locallyPeriodic: J.locallyPeriodic(c, 8, 24, 25),
    bt_wins: bt.map((x) => x[0]),
    bt_losses: bt.map((x) => x[1]),
    bt_flips: bt.map((x) => x[2]),
    bt_trades: bt.map((x) => x[3]),
    bt_winrate: bt.map((x) => x[5]),
  };
  // PineTS stores every number rounded to 10 decimals. On the first bar of
  // normalize(close) the historic min equals the price, so that rounding is
  // the whole result (0.0036 instead of 0). Real prices are tick multiples and
  // are not changed by it; the synthetic ones have many decimals.
  const fromBar = { normalize_close: 1, normalize_volume: 1 };

  for (const version of [6, 5]) {
    it(`every exported function matches the reference (//@version=${version})`, async () => {
      const source = fixture('jdehorty-parity.pine').replace('//@version=6', `//@version=${version}`);
      const r = await run(source);
      expect(r.ok, r.error).toBe(true);
      expect(r.bars).toBe(BARS);
      for (const [title, want] of Object.entries(expected)) {
        const d = maxDiff(perBar(r, title, bars), want, fromBar[title] || 0);
        expect(d, `${title}: na on different bars`).toBeGreaterThanOrEqual(0);
        expect(d, title).toBeLessThan(1e-8);
      }
    });
  }
});

describe('imports in PineTS', () => {
  it('FormattingUtils.textSizeFromChoice maps each choice, anything else to normal', async () => {
    const r = await run(`//@version=6
indicator("sizes", overlay=true)
import LuxSignals/FormattingUtils/3 as f
if barstate.islast
    for [i, c] in array.from("Tiny", "Small", "Normal", "Large", "Huge", "")
        label.new(bar_index - i, close, c, size=f.textSizeFromChoice(c))
`, { limit: 50 });
    expect(r.ok, r.error).toBe(true);
    const sizes = Object.fromEntries(r.drawings.labels.map((lb) => [lb.text, lb.size]));
    expect(sizes).toEqual({ Tiny: 'tiny', Small: 'small', Normal: 'normal', Large: 'large', Huge: 'normal', '': 'normal' });
  });

  it('types, enums, methods, constants, nested imports and per-call var state survive the inlining', async () => {
    const dir = fileURLToPath(new URL('./fixtures/pine-libs/', import.meta.url));
    const { source } = expandImports(`//@version=6
indicator("Util", overlay=false)
import acme/Util/1 as u
p = u.Point.new(close, bar_index)
p.bump(1.5)
plot(p.price - close, "bumped")
plot(u.scaled(2.0), "scaled")
plot(u.twice(close) - 2 * close, "twice")
a = u.counter()
b = u.counter()
plot(a, "counter_a")
plot(b, "counter_b")
plot(u.sideName(u.Side.short) == "Short" ? 1 : 0, "enum")
`, { dir });
    const r = await run(source, { limit: 30 });
    expect(r.ok, r.error).toBe(true);
    const last = (t) => r.plots[t].points.at(-1)[1];
    expect(last('bumped')).toBeCloseTo(1.5, 9);
    expect(last('scaled')).toBe(6);
    expect(last('twice')).toBeCloseTo(0, 6);
    // Each call site keeps its own `var`, as on TradingView.
    expect(last('counter_a')).toBe(30);
    expect(last('counter_b')).toBe(30);
    expect(last('enum')).toBe(1);
  });

  it('the ML stand-in strategy runs, trades and labels with the chosen size', async () => {
    const r = await run(fixture('ml-kernel-standin.pine'));
    expect(r.ok, r.error).toBe(true);
    expect(r.kind).toBe('strategy');
    expect(r.title).toBe('Stand-in ML kernel strategy');
    expect(r.strategy.closedtrades.length).toBeGreaterThan(0);
    expect(r.drawings.labels.map((lb) => lb.size)).toEqual(['small']);
    expect(r.inputs.map((i) => i.title)).toEqual(['Label size', 'Lookback', 'Relative weight', 'Start at bar']);
  });

  it('a library that is not available is a script error on the import line', async () => {
    const r = await run('//@version=6\nindicator("t")\n\nimport someone/Missing/1 as m\nplot(m.f(close))\n');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('error');
    expect(r.error).toBe('The Pine library someone/Missing/1 is not available on Atomik yet (at 4:1)');
  });

  it('a syntax error after the imports reports the user\'s own line', async () => {
    const r = await run('//@version=6\nindicator("t")\nimport jdehorty/KernelFunctions/2 as k\nx = k.gaussian(close, 8, 25)\nplot(x\n');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\bat 6:1\b/);
    expect(r.error).not.toMatch(/__lib_/);
  });

  it('streamed bar by bar it ends where a one-shot run does', async () => {
    const r = await streamThrough(fixture('ml-kernel-standin.pine'), { history: 600, liveBars: 20 });
    expect(r.error).toBeUndefined();
    expect(r.oneShot.ok, r.oneShot.error).toBe(true);
    expect(trades(r.streamed)).toEqual(trades(r.oneShot));
    expect(opens(r.streamed)).toEqual(opens(r.oneShot));
    expect(plotValues(r.streamed)).toEqual(plotValues(r.oneShot));
    expect(labels(r.streamed)).toEqual(labels(r.oneShot));
    r.stream?.dispose();
  }, 120_000);
});
