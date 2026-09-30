import { describe, it, expect } from 'vitest';
import { runPine } from '../src/sandbox.mjs';
import { fetchBars, symbolInfo } from './synthetic.mjs';
import { stateFrom } from '../src/live/state.mjs';

const run = (source, extra = {}) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: 600, symbolInfo, fetchBars, timeoutMs: 30_000, ...extra });

const SCRIPT = `//@version=6
indicator("Styles", shorttitle="STY", overlay=false, precision=2)
f = ta.ema(close, 9)
s = ta.ema(close, 21)
plot(f, "fast", color=color.new(color.orange, 0), linewidth=2)
plot(s, "slow", color=f > s ? color.green : color.red)
plot(f - s, "hist", style=plot.style_histogram, color=color.blue)
h = hline(0, "zero", color=color.gray, linestyle=hline.style_dashed)
fill(plot(f, "a"), plot(s, "b"), color=color.new(color.blue, 90), title="band")
barcolor(f > s ? color.lime : color.maroon, title="bars")
bgcolor(f > s ? color.new(color.green, 90) : na, title="bg")`;
// NOTE: untitled bgcolor()+barcolor() in one script share PineTS's fallback
// plot key ("plot") and their points merge — an upstream quirk. Titled calls
// (or a single untitled one) are fine.

describe('native-study series', () => {
  it('captures declaration, plots, styles, per-bar colours, hline, fill, barcolor, bgcolor', async () => {
    const r = await run(SCRIPT);
    expect(r.ok).toBe(true);
    const s = r.series;
    expect(s.overlay).toBe(false);
    expect(s.title).toBe('Styles');
    expect(s.shorttitle).toBe('STY');
    expect(s.precision).toBe(2);
    expect(s.times.length).toBe(600);
    expect(s.times[1] - s.times[0]).toBe(300);

    const byTitle = Object.fromEntries(s.plots.map((p) => [p.title, p]));
    expect(Object.keys(byTitle).sort()).toEqual(['a', 'b', 'fast', 'hist', 'slow']);
    expect(byTitle.fast).toMatchObject({ style: 'line', color: '#FF9800', linewidth: 2, colors: null });
    expect(byTitle.fast.values.length).toBe(600);
    expect(byTitle.fast.values.filter((v) => v !== null).length).toBeGreaterThan(590);
    expect(byTitle.hist.style).toBe('histogram');
    // slow changes colour per bar -> palette + index per bar (green/red, plus
    // possibly the na-warmup colour)
    expect(byTitle.slow.colors.palette.length).toBeGreaterThanOrEqual(2);
    expect(byTitle.slow.colors.palette.length).toBeLessThanOrEqual(3);
    expect(byTitle.slow.colors.idx.filter((i) => i !== null).length).toBeGreaterThan(590);

    expect(s.hlines).toEqual([{ title: 'zero', price: 0, color: '#787B86', linestyle: 'dashed' }]);
    // TradingView's color.blue is #2962FF (alpha stripped)
    expect(s.fills).toEqual([{ title: 'band', plot1: byTitle.a.id, plot2: byTitle.b.id, color: '#2962FF' }]);
    expect(s.barcolor.palette.length).toBeGreaterThanOrEqual(2);
    expect(s.barcolor.palette.length).toBeLessThanOrEqual(3);
    expect(s.barcolor.idx.filter((i) => i !== null).length).toBeGreaterThan(590);
    expect(s.bgcolor.palette).toEqual(['#4CAF50']);
    expect(s.bgcolor.idx.some((i) => i === 0)).toBe(true);
    expect(s.bgcolor.idx.some((i) => i === null)).toBe(true);
  });

  it('overlay indicator, series bars capped, hidden plots skipped', async () => {
    const r = await run(`//@version=6
indicator("Ov", overlay=true)
plot(ta.sma(close, 5), "vis")
plot(ta.sma(close, 6), "hidden", display=display.none)`, { maxSeriesBars: 200 });
    expect(r.series.overlay).toBe(true);
    expect(r.series.times.length).toBe(200);
    expect(r.series.plots.map((p) => p.title)).toEqual(['vis']);
    expect(r.series.plots[0].values.length).toBe(200);
  });

  it('state payload carries series and no polylines', async () => {
    const r = await run(SCRIPT);
    const st = stateFrom(r, { strategyKey: 'k', symbol: 'NQ' });
    expect(st.series.plots.length).toBe(5);
    expect(st.drawings.some((d) => d.kind === 'polyline')).toBe(false);
  });
});
