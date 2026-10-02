// Sandbox result -> the `strategy_state` payload the chart renders.
//   drawings: box {kind:'box', id, t1, t2, p1(top), p2(bottom)}      epoch SECONDS
//             shape {kind:'shape', id, t, price, dir:'up'|'down', text}
//   levels:   {id, label, price, kind:'info', style}
// Rich drawings (PINE_RICH_DRAWINGS) replace the plain box and the line/label
// levels with styled box/line/label kinds: see richDrawings below.
//   series:   plot()/hline()/fill()/barcolor()/bgcolor() values on one time
//             axis — the chart registers a native TradingView study from it
//             (legend, hover values, sub-pane, plot styles). See sandbox.mjs.
import { createHash } from 'node:crypto';

const MAX_BOXES = 100;
const MAX_SHAPES = 60;
const MAX_LEVELS = 8;
// Strategy Tester: trades listed, and trades marked on the chart (entry + exit).
const MAX_TESTER_TRADES = 100;
const MAX_TRADE_MARKERS = 40;
const sec = (ms) => Math.floor(ms / 1000);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function stateFrom(result, { strategyKey, symbol, rich = false, maxDrawings = MAX_RICH_DRAWINGS }) {
  const drawings = [];
  const levels = [];

  if (rich) {
    drawings.push(...richDrawings(result.drawings, maxDrawings));
  } else {
    const boxes = (result.drawings?.boxes || []).filter((b) => num(b.t1) && num(b.t2) && num(b.top) && num(b.bottom));
    for (const b of boxes.slice(-MAX_BOXES)) {
      drawings.push({ kind: 'box', id: `b${b.id}`, t1: sec(Math.min(b.t1, b.t2)), t2: sec(Math.max(b.t1, b.t2)), p1: Math.max(b.top, b.bottom), p2: Math.min(b.top, b.bottom) });
    }
  }

  // Shape ids must be STABLE across runs (the chart diffs by id): key them by
  // bar time + direction + per-bar ordinal, never by position in the list,
  // which shifts as the window rolls and would redraw every marker each update.
  const shapes = (result.shapes || []).filter((s) => num(s.t) && num(s.price));
  const perBar = new Map();
  for (const s of shapes.slice(-MAX_SHAPES)) {
    const t = sec(s.t);
    const dir = s.dir === 'down' ? 'down' : 'up';
    const k = `${t}_${dir}`;
    const n = perBar.get(k) || 0;
    perBar.set(k, n + 1);
    drawings.push({ kind: 'shape', id: `s${k}_${n}`, t, price: s.price, dir, text: s.text || '' });
  }

  // Without rich drawings, horizontal lines and priced labels become levels
  // (price lines with their text on the axis).
  for (const l of rich ? [] : result.drawings?.lines || []) {
    if (num(l.p1) && l.p1 === l.p2 && levels.length < MAX_LEVELS) {
      levels.push({ id: `L${l.id}`, label: '', price: l.p1, kind: 'info', style: l.style === 'style_dashed' ? 'dashed' : l.style === 'style_dotted' ? 'dotted' : 'solid' });
    }
  }
  for (const lb of rich ? [] : result.drawings?.labels || []) {
    if (!num(lb.price)) continue;
    const hit = levels.find((lv) => lv.price === lb.price && !lv.label);
    if (hit) hit.label = lb.text || '';
    else if (levels.length < MAX_LEVELS) levels.push({ id: `T${lb.id}`, label: lb.text || '', price: lb.price, kind: 'info', style: 'dotted' });
  }

  const s = result.series;
  const hasSeries = s && (s.plots?.length || s.hlines?.length || s.barcolor || s.bgcolor);
  const series = hasSeries ? s : null;

  const tester = testerFrom(result);
  if (tester) drawings.push(...tradeMarkers(result.strategy));

  return { strategy: strategyKey, symbol, side: null, levels, drawings, series, ...(tester ? { tester } : {}), ts: new Date().toISOString() };
}

// ---- Rich drawings ---------------------------------------------------------
// Pine box/line/label objects with their full style, for the chart to draw them
// like TradingView. Times are epoch SECONDS; colors are '#rrggbbaa', or null
// for none (`na`); TradingView's defaults are already applied.
//   box   {kind:'box', id, t1, t2, p1(top), p2(bottom), bg, border, border_width,
//          border_style:'solid'|'dashed'|'dotted', extend:'none'|'left'|'right'|'both',
//          text?, text_color?, text_size?, text_halign?:'left'|'center'|'right',
//          text_valign?:'top'|'center'|'bottom'}        (text_* only with text)
//   line  {kind:'line', id, t1, p1, t2, p2, color, width, extend,
//          style:'solid'|'dashed'|'dotted'|'arrow_left'|'arrow_right'|'arrow_both'}
//   label {kind:'label', id, t, price, text, style, color (background),
//          text_color, size, textalign, yloc:'price'|'abovebar'|'belowbar', tooltip?}
//          style: label_down|label_up|label_left|label_right|label_center|
//          label_upper_left|label_upper_right|label_lower_left|label_lower_right|
//          none|text_outline|arrowup|arrowdown|triangleup|triangledown|circle|
//          square|diamond|cross|xcross|flag
//   sizes: 'auto'|'tiny'|'small'|'normal'|'large'|'huge', or a number (points)
// Ids are `${prefix}${creation bar, seconds}_${order on that bar}`: PineTS's own
// ids are global counters that move every time the forming bar re-executes,
// which would make the chart delete and redraw those objects on every tick.
// The newest `maxDrawings` of each kind are kept (TradingView allows 500).
export const MAX_RICH_DRAWINGS = 300;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/**
 * A Pine color as '#rrggbbaa'. PineTS hands '#RRGGBB[AA]' or 'rgba(...)';
 * '' means the argument was left out (-> `fallback`, TradingView's default),
 * null / NaN means `na` (-> null: nothing drawn).
 */
export function pineColor(v, fallback = null) {
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return null;
  if (typeof v !== 'string') return fallback;
  const c = v.trim();
  if (!c) return fallback;
  let m = c.match(HEX);
  if (m) {
    let h = m[1].toLowerCase();
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return `#${h.length === 6 ? `${h}ff` : h}`;
  }
  m = c.match(RGBA);
  if (m) return `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}${hex2(m[4] === undefined ? 255 : +m[4] * 255)}`;
  return fallback;
}

const bare = (v, prefix) => String(v ?? '').replace(prefix, '');
const lineStyle = (s) => {
  const v = bare(s, /^(style_|linestyle_)/);
  return ['dashed', 'dotted', 'arrow_left', 'arrow_right', 'arrow_both'].includes(v) ? v : 'solid';
};
const EXTEND = { l: 'left', left: 'left', r: 'right', right: 'right', b: 'both', both: 'both' };
const extendOf = (e) => EXTEND[String(e ?? '')] || 'none';
const SIZES = new Set(['auto', 'tiny', 'small', 'normal', 'large', 'huge']);
const sizeOf = (v, fallback) => (num(v) ? (v > 0 ? v : fallback) : SIZES.has(bare(v, /^size_/)) ? bare(v, /^size_/) : fallback);
const oneOf = (list, fallback) => (v) => { const x = bare(v, /^align_/); return list.includes(x) ? x : fallback; };
const halignOf = oneOf(['left', 'center', 'right'], 'center');
const valignOf = oneOf(['top', 'center', 'bottom'], 'center');
const LABEL_STYLES = new Set([
  'label_down', 'label_up', 'label_left', 'label_right', 'label_center', 'label_upper_left', 'label_upper_right', 'label_lower_left', 'label_lower_right',
  'none', 'text_outline', 'arrowup', 'arrowdown', 'triangleup', 'triangledown', 'circle', 'square', 'diamond', 'cross', 'xcross', 'flag',
]);
const labelStyle = (s) => { const v = bare(s, /^style_/); return LABEL_STYLES.has(v) ? v : 'label_down'; };

// TradingView's defaults for arguments a script leaves out.
const DEFAULT_BLUE = '#2962ffff';
const DEFAULT_LABEL_TEXT = '#ffffffff';
const DEFAULT_BOX_TEXT = '#000000ff';

/** Newest `max` items (creation order) with their stable ids. */
function keyed(items, prefix, max) {
  const order = new Map();
  return [...items].sort((a, b) => a.id - b.id).map((it) => {
    if (!num(it.at)) return { it, id: `${prefix}#${it.id}` };
    const t = sec(it.at);
    const k = order.get(t) || 0;
    order.set(t, k + 1);
    return { it, id: `${prefix}${t}_${k}` };
  }).slice(-max);
}

export function richDrawings(d, maxDrawings = MAX_RICH_DRAWINGS) {
  const max = Math.max(0, Math.floor(maxDrawings));
  if (!max) return [];
  const out = [];
  const boxes = (d?.boxes || []).filter((b) => num(b.t1) && num(b.t2) && num(b.top) && num(b.bottom));
  for (const { it: b, id } of keyed(boxes, 'bx', max)) {
    const box = {
      kind: 'box', id, t1: sec(Math.min(b.t1, b.t2)), t2: sec(Math.max(b.t1, b.t2)), p1: Math.max(b.top, b.bottom), p2: Math.min(b.top, b.bottom),
      bg: pineColor(b.bgcolor, DEFAULT_BLUE), border: pineColor(b.border_color, DEFAULT_BLUE),
      border_width: num(b.border_width) ? Math.max(0, b.border_width) : 1, border_style: lineStyle(b.border_style), extend: extendOf(b.extend),
    };
    if (b.text) {
      Object.assign(box, {
        text: String(b.text), text_color: pineColor(b.text_color, DEFAULT_BOX_TEXT), text_size: sizeOf(b.text_size, 'auto'),
        text_halign: halignOf(b.text_halign), text_valign: valignOf(b.text_valign),
      });
    }
    out.push(box);
  }
  const lines = (d?.lines || []).filter((l) => num(l.t1) && num(l.t2) && num(l.p1) && num(l.p2));
  for (const { it: l, id } of keyed(lines, 'ln', max)) {
    out.push({
      kind: 'line', id, t1: sec(l.t1), p1: l.p1, t2: sec(l.t2), p2: l.p2,
      color: pineColor(l.color, DEFAULT_BLUE), width: num(l.width) ? Math.max(0, l.width) : 1, style: lineStyle(l.style), extend: extendOf(l.extend),
    });
  }
  const labels = (d?.labels || []).filter((l) => num(l.t) && num(l.price));
  for (const { it: l, id } of keyed(labels, 'lb', max)) {
    const label = {
      kind: 'label', id, t: sec(l.t), price: l.price, text: String(l.text ?? ''), style: labelStyle(l.style),
      color: pineColor(l.color, DEFAULT_BLUE), text_color: pineColor(l.textcolor, DEFAULT_LABEL_TEXT), size: sizeOf(l.size, 'normal'),
      textalign: halignOf(l.textalign), yloc: l.yloc === 'abovebar' || l.yloc === 'belowbar' ? l.yloc : 'price',
    };
    if (l.tooltip) label.tooltip = String(l.tooltip);
    out.push(label);
  }
  return out;
}

const fmtMoney = (v) => (num(v) ? `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}` : '');

/**
 * Entry/exit markers for a strategy's latest trades, like TradingView's
 * Strategy Tester draws them: an entry arrow at the fill (up = long), an exit
 * arrow the other way labelled with the exit and its P&L. Ids are keyed by the
 * fill times, so a marker never moves or flickers as the history slides.
 */
function tradeMarkers(st) {
  const out = [];
  const dirOf = (t) => ((t.size ?? 0) < 0 ? -1 : 1);
  const entry = (t) => {
    const long = dirOf(t) > 0;
    return { kind: 'shape', id: `te${sec(t.entry_time)}${long ? 'l' : 's'}`, t: sec(t.entry_time), price: t.entry_price, dir: long ? 'up' : 'down', text: String(t.entry_id ?? (long ? 'Long' : 'Short')) };
  };
  for (const t of (st.closedtrades || []).slice(-MAX_TRADE_MARKERS)) {
    if (!num(t.entry_time) || !num(t.entry_price) || !num(t.exit_time) || !num(t.exit_price)) continue;
    const long = dirOf(t) > 0;
    out.push(entry(t));
    out.push({ kind: 'shape', id: `tx${sec(t.exit_time)}_${sec(t.entry_time)}`, t: sec(t.exit_time), price: t.exit_price, dir: long ? 'down' : 'up', text: `${t.exit_id || 'Close'} ${fmtMoney(t.profit)}`.trim() });
  }
  for (const t of st.opentrades || []) {
    if (num(t.entry_time) && num(t.entry_price)) out.push(entry(t));
  }
  return out;
}

/**
 * Strategy Tester summary from the session's own ledger (the same PineTS
 * emulator a backtest runs), over the bars the session holds: overview
 * numbers, the latest trades, open trades. Null for indicators.
 */
export function testerFrom(result) {
  const st = result.strategy;
  if (!st) return null;
  const closed = st.closedtrades || [];
  const gp = num(st.grossprofit) ? st.grossprofit : null;
  const gl = num(st.grossloss) ? Math.abs(st.grossloss) : null;
  const wins = num(st.wintrades) ? st.wintrades : null;
  const total = num(st.closedtrades_total) ? st.closedtrades_total : closed.length;
  return {
    title: result.title || null,
    since: num(result.firstTime) ? sec(result.firstTime) : null,
    closed_total: total,
    netprofit: num(st.netprofit) ? st.netprofit : null,
    grossprofit: gp,
    grossloss: gl,
    profit_factor: gp != null && gl ? gp / gl : null,
    win_rate: wins != null && total ? wins / total : null,
    wintrades: wins,
    losstrades: num(st.losstrades) ? st.losstrades : null,
    max_drawdown: num(st.max_drawdown) ? st.max_drawdown : null,
    initial_capital: num(st.initial_capital) ? st.initial_capital : null,
    position_size: num(st.position_size) ? st.position_size : 0,
    open: (st.opentrades || []).map((t) => ({ entry_id: t.entry_id ?? null, entry_time: num(t.entry_time) ? sec(t.entry_time) : null, entry_price: t.entry_price ?? null, size: t.size ?? null })),
    trades: closed.slice(-MAX_TESTER_TRADES).map((t) => ({
      entry_id: t.entry_id ?? null, entry_time: num(t.entry_time) ? sec(t.entry_time) : null, entry_price: t.entry_price ?? null,
      exit_id: t.exit_id ?? null, exit_time: num(t.exit_time) ? sec(t.exit_time) : null, exit_price: t.exit_price ?? null,
      size: t.size ?? null, profit: num(t.profit) ? t.profit : null,
    })),
  };
}

/**
 * The STRUCTURE of a native-study series (plots, styles, palettes, hlines,
 * fills, pane) without its per-bar values: what the chart needs to register
 * the study before the script ever runs live. Same shape as `series` with
 * empty value arrays, so the chart reads both the same way.
 */
export function seriesSpec(series) {
  if (!series) return null;
  return {
    overlay: !!series.overlay, title: series.title || null, shorttitle: series.shorttitle || null, precision: series.precision ?? null,
    times: [],
    plots: (series.plots || []).map((p) => ({ id: p.id, key: p.key, title: p.title, style: p.style, color: p.color, linewidth: p.linewidth, overlay: p.overlay, values: [], colors: p.colors ? { palette: p.colors.palette, idx: [] } : null })),
    hlines: series.hlines || [],
    fills: series.fills || [],
    barcolor: series.barcolor ? { palette: series.barcolor.palette, idx: [] } : null,
    bgcolor: series.bgcolor ? { palette: series.bgcolor.palette, idx: [] } : null,
  };
}

/**
 * Intrabar frame: the forming bar's values only (last time on the axis), plus
 * the full drawings/levels (small). `partial: true` tells the chart to merge
 * that one row instead of replacing the series. Null when there is no series.
 * Colour indexes come WITH their palette: an intrabar run builds its palette
 * from its own last bars, so its indexes don't match the full frame's; the
 * chart maps them back by colour.
 */
export function partialStateFrom(result, opts) {
  const { tester, ...full } = stateFrom(result, opts); // the tester rides on full frames only
  const s = full.series;
  if (!s || !s.times.length) return null;
  const i = s.times.length - 1;
  return {
    ...full,
    partial: true,
    series: {
      times: [s.times[i]],
      plots: s.plots.map((p) => ({ id: p.id, values: [p.values[i]], colors: p.colors ? { palette: p.colors.palette, idx: [p.colors.idx[i]] } : null })),
      barcolor: s.barcolor ? { palette: s.barcolor.palette, idx: [s.barcolor.idx[i]] } : null,
      bgcolor: s.bgcolor ? { palette: s.bgcolor.palette, idx: [s.bgcolor.idx[i]] } : null,
    },
  };
}

/** Stable fingerprint of the drawable content (ignores `ts`). */
export function stateHash(payload) {
  return createHash('sha1').update(JSON.stringify({ l: payload.levels, d: payload.drawings, s: payload.series })).digest('hex');
}

export function emptyState({ strategyKey, symbol }) {
  return { strategy: strategyKey, symbol, side: null, levels: [], drawings: [], series: null, ts: new Date().toISOString() };
}
