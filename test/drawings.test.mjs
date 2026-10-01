// Rich drawings (PINE_RICH_DRAWINGS): box/line/label objects reach the chart
// with their full style, keyed by ids that survive the forming bar's
// re-executions.
import { describe, it, expect, afterEach } from 'vitest';
import { runPine } from '../src/sandbox.mjs';
import { stateFrom, partialStateFrom, stateHash, pineColor, richDrawings } from '../src/live/state.mjs';
import { config } from '../src/config.mjs';
import { fetchBars, symbolInfo } from './synthetic.mjs';
import { streamThrough } from './stream-harness.mjs';

const run = (source) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: 300, symbolInfo, fetchBars, timeoutMs: 30_000, memoryMb: 128 });
const RICH = { strategyKey: 'k', symbol: 'NQ', rich: true };
const LEGACY = { strategyKey: 'k', symbol: 'NQ' };

const STYLED = `//@version=6
indicator("Styled", overlay=true)
if barstate.islast
    box.new(bar_index - 20, high + 10, bar_index - 10, low - 10, border_color=color.red, border_width=2, border_style=line.style_dashed, bgcolor=color.new(color.green, 80), extend=extend.right, text="Zone", text_color=color.white, text_size=size.small, text_halign=text.align_left, text_valign=text.align_top)
    box.new(bar_index - 5, high, bar_index, low)
    box.new(bar_index - 5, high, bar_index, low, border_color=na, bgcolor=na)
    line.new(bar_index - 30, low, bar_index, high, color=color.orange, width=3, style=line.style_dotted, extend=extend.both)
    line.new(bar_index - 30, low, bar_index, high, style=line.style_arrow_right)
    line.new(bar_index - 40, close, bar_index, close, color=color.rgb(10, 20, 30, 50))
    label.new(bar_index, high, "Down", style=label.style_label_down, color=color.new(color.black, 100), textcolor=color.yellow, size=size.large, textalign=text.align_right)
    label.new(bar_index - 3, na, "Above", yloc=yloc.abovebar, style=label.style_triangledown, tooltip="tip")
    label.new(bar_index - 4, low, "default")
    label.new(time, low, "pts", xloc=xloc.bar_time, style=label.style_none, size=14)`;

describe('rich drawings: the payload', () => {
  it('boxes, lines and labels keep their style; lines and labels are no longer levels', async () => {
    const r = await run(STYLED);
    expect(r.ok, r.error).toBe(true);
    const s = stateFrom(r, RICH);
    expect(s.levels).toEqual([]);
    const boxes = s.drawings.filter((d) => d.kind === 'box');
    const lines = s.drawings.filter((d) => d.kind === 'line');
    const labels = s.drawings.filter((d) => d.kind === 'label');
    expect([boxes.length, lines.length, labels.length]).toEqual([3, 3, 4]);

    expect(boxes[0]).toMatchObject({ bg: '#4caf5033', border: '#f23645ff', border_width: 2, border_style: 'dashed', extend: 'right', text: 'Zone', text_color: '#ffffffff', text_size: 'small', text_halign: 'left', text_valign: 'top' });
    expect(boxes[0].p1).toBeGreaterThan(boxes[0].p2);
    expect(boxes[0].t2).toBeGreaterThan(boxes[0].t1);
    expect(boxes[0].t1).toBeLessThan(1e11); // seconds
    // TradingView's defaults when left out; text fields only with text.
    expect(boxes[1]).toMatchObject({ bg: '#2962ffff', border: '#2962ffff', border_width: 1, border_style: 'solid', extend: 'none' });
    expect(boxes[1]).not.toHaveProperty('text');
    // na = nothing drawn.
    expect(boxes[2]).toMatchObject({ bg: null, border: null });

    expect(lines[0]).toMatchObject({ color: '#ff9800ff', width: 3, style: 'dotted', extend: 'both' });
    expect(lines[0].p2).toBeGreaterThan(lines[0].p1); // direction kept: low -> high
    expect(lines[1]).toMatchObject({ color: '#2962ffff', width: 1, style: 'arrow_right', extend: 'none' });
    expect(lines[2].color).toBe('#0a141e80');

    expect(labels[0]).toMatchObject({ text: 'Down', style: 'label_down', color: '#363a4500', text_color: '#fdd835ff', size: 'large', textalign: 'right', yloc: 'price' });
    expect(labels[1]).toMatchObject({ text: 'Above', style: 'triangledown', yloc: 'abovebar', tooltip: 'tip' });
    expect(Number.isFinite(labels[1].price)).toBe(true); // placed on the bar's high
    expect(labels[2]).toMatchObject({ style: 'label_down', color: '#2962ffff', text_color: '#ffffffff', size: 'normal', textalign: 'center' });
    expect(labels[2]).not.toHaveProperty('tooltip');
    expect(labels[3]).toMatchObject({ style: 'none', size: 14 });
    expect(labels[3].t).toBe(Math.floor(r.lastTime / 1000)); // xloc.bar_time
  });

  it('flag off: the payload the deployed chart already draws', async () => {
    const r = await run(STYLED);
    const s = stateFrom(r, LEGACY);
    expect(s.drawings.every((d) => d.kind === 'box')).toBe(true);
    expect(Object.keys(s.drawings[0]).sort()).toEqual(['id', 'kind', 'p1', 'p2', 't1', 't2']);
    expect(s.levels.length).toBeGreaterThan(0); // the horizontal line + priced labels
    expect(config.richDrawings).toBe(false); // off unless PINE_RICH_DRAWINGS=true
  });

  it('intrabar frames carry the same rich drawings; the hash sees style changes', async () => {
    const r = await run(STYLED);
    const withSeries = { ...r, series: { times: [1, 2], plots: [{ id: 'p0', values: [1, 2], colors: null }], hlines: [], fills: [], barcolor: null, bgcolor: null } };
    expect(partialStateFrom(withSeries, RICH).drawings).toEqual(stateFrom(withSeries, RICH).drawings);
    const a = stateFrom(r, RICH);
    const recolored = { ...r, drawings: { ...r.drawings, boxes: r.drawings.boxes.map((b, i) => (i ? b : { ...b, bgcolor: '#FF0000' })) } };
    expect(stateHash(stateFrom(recolored, RICH))).not.toBe(stateHash(a));
  });

  it('keeps the newest objects of each kind', () => {
    const boxes = Array.from({ length: 10 }, (_, i) => ({ id: i, at: 1_000_000 + i * 60_000, t1: 1e12, t2: 1e12 + 60_000, top: 2, bottom: 1, bgcolor: '#2962ff' }));
    const out = richDrawings({ boxes: [...boxes].reverse(), lines: [], labels: [] }, 3);
    expect(out.map((d) => d.id)).toEqual(['bx1420_0', 'bx1480_0', 'bx1540_0']); // created at 1000s + i * 60s, i = 7..9
  });
});

describe('pineColor', () => {
  it('normalises to #rrggbbaa; "" is the default, na is none', () => {
    expect(pineColor('#4CAF50E5')).toBe('#4caf50e5');
    expect(pineColor('#2962ff')).toBe('#2962ffff');
    expect(pineColor('#abc')).toBe('#aabbccff');
    expect(pineColor('rgba(10, 20, 30, 0.5)')).toBe('#0a141e80');
    expect(pineColor('rgb(255,0,0)')).toBe('#ff0000ff');
    expect(pineColor('', '#2962ffff')).toBe('#2962ffff');
    expect(pineColor(null, '#2962ffff')).toBe(null);
    expect(pineColor(NaN, '#2962ffff')).toBe(null);
    expect(pineColor('nonsense', '#000000ff')).toBe('#000000ff');
  });
});

describe('rich drawings: stable ids', () => {
  const open = [];
  afterEach(() => { for (const s of open.splice(0)) s?.dispose(); });

  // A label re-created on every tick of the last bar, two lines per 50th bar
  // and a box moved forward every bar: PineTS's ids differ between a stream
  // and a one-shot run, the chart ids must not.
  const SRC = `//@version=6
indicator("Live objects", overlay=true)
var label last = na
var box b = box.new(bar_index, high, bar_index + 2, low, bgcolor=color.new(color.teal, 70))
box.set_left(b, bar_index + 1)
box.set_right(b, bar_index + 3)
if barstate.islast
    label.delete(last)
    last := label.new(bar_index, high, str.tostring(close), style=label.style_label_left)
if bar_index % 50 == 0
    line.new(bar_index, low, bar_index + 5, high)
    line.new(bar_index, high, bar_index + 5, low, style=line.style_dashed)`;

  it('a stream and a one-shot run over the same bars give the same drawings', async () => {
    const r = await streamThrough(SRC, { history: 600, liveBars: 6 });
    open.push(r.stream);
    expect(r.error).toBeUndefined();
    expect(r.oneShot.ok, r.oneShot.error).toBe(true);
    // PineTS's raw ids moved on with every tick of the stream...
    expect(r.streamed.drawings.labels[0].id).not.toBe(r.oneShot.drawings.labels[0].id);
    // ...the chart's do not.
    const a = stateFrom(r.streamed, RICH).drawings;
    const b = stateFrom(r.oneShot, RICH).drawings;
    expect(a.length).toBeGreaterThan(20);
    expect(a).toEqual(b);
    const box = a.find((d) => d.kind === 'box');
    expect(box.id).toBe(`bx${Math.floor(r.oneShot.firstTime / 1000)}_0`); // created on the first bar
    expect(new Set(a.map((d) => d.id)).size).toBe(a.length);
  });
});
