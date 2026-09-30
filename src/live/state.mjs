// Sandbox result -> the `strategy_state` payload the chart renders.
//   drawings: box {kind:'box', id, t1, t2, p1(top), p2(bottom)}      epoch SECONDS
//             shape {kind:'shape', id, t, price, dir:'up'|'down', text}
//   levels:   {id, label, price, kind:'info', style}
//   series:   plot()/hline()/fill()/barcolor()/bgcolor() values on one time
//             axis — the chart registers a native TradingView study from it
//             (legend, hover values, sub-pane, plot styles). See sandbox.mjs.
import { createHash } from 'node:crypto';

const MAX_BOXES = 100;
const MAX_SHAPES = 60;
const MAX_LEVELS = 8;
const sec = (ms) => Math.floor(ms / 1000);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function stateFrom(result, { strategyKey, symbol }) {
  const drawings = [];
  const levels = [];

  const boxes = (result.drawings?.boxes || []).filter((b) => num(b.t1) && num(b.t2) && num(b.top) && num(b.bottom));
  for (const b of boxes.slice(-MAX_BOXES)) {
    drawings.push({ kind: 'box', id: `b${b.id}`, t1: sec(Math.min(b.t1, b.t2)), t2: sec(Math.max(b.t1, b.t2)), p1: Math.max(b.top, b.bottom), p2: Math.min(b.top, b.bottom) });
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

  for (const l of result.drawings?.lines || []) {
    if (num(l.p1) && l.p1 === l.p2 && levels.length < MAX_LEVELS) {
      levels.push({ id: `L${l.id}`, label: '', price: l.p1, kind: 'info', style: l.style === 'style_dashed' ? 'dashed' : l.style === 'style_dotted' ? 'dotted' : 'solid' });
    }
  }
  for (const lb of result.drawings?.labels || []) {
    if (!num(lb.price)) continue;
    const hit = levels.find((lv) => lv.price === lb.price && !lv.label);
    if (hit) hit.label = lb.text || '';
    else if (levels.length < MAX_LEVELS) levels.push({ id: `T${lb.id}`, label: lb.text || '', price: lb.price, kind: 'info', style: 'dotted' });
  }

  const s = result.series;
  const hasSeries = s && (s.plots?.length || s.hlines?.length || s.barcolor || s.bgcolor);
  const series = hasSeries ? s : null;

  return { strategy: strategyKey, symbol, side: null, levels, drawings, series, ts: new Date().toISOString() };
}

/** Stable fingerprint of the drawable content (ignores `ts`). */
export function stateHash(payload) {
  return createHash('sha1').update(JSON.stringify({ l: payload.levels, d: payload.drawings, s: payload.series })).digest('hex');
}

export function emptyState({ strategyKey, symbol }) {
  return { strategy: strategyKey, symbol, side: null, levels: [], drawings: [], series: null, ts: new Date().toISOString() };
}
