// Runs a Pine script with PineTS inside an isolated-vm isolate.
//
// Why an isolate: PineTS compiles scripts to JavaScript and runs them with
// `new Function`, and identifiers it does not recognise fall through to the JS
// global scope. In a plain Node process a script can read `process.env`. Inside
// an isolate there is no `process`, `require`, `fetch`, file system or network;
// the only way out is the host functions we hand in explicitly.
import ivm from 'isolated-vm';
import { readFileSync } from 'node:fs';

// PineTS 0.10.0 + our transpiler fixes (vendor/pinets/README.md). Back to
// node_modules/pinets once an upstream release carries them.
const BUNDLE_PATH = new URL('../vendor/pinets/pinets.min.browser.js', import.meta.url);
const BUNDLE_SOURCE = readFileSync(BUNDLE_PATH, 'utf8');

// V8 code cache for the PineTS bundle, produced by the first isolate and reused
// by later ones so each run does not re-parse 650KB of JavaScript.
let bundleCache = null;

// Runs before the bundle. Isolates have no console or timers; PineTS only needs
// setTimeout for live-stream throttling, which we never use inside an isolate.
const PRELUDE = `
globalThis.console = {
  log: (...a) => __hostLog.applyIgnored(undefined, ['log', a.map(String).join(' ')]),
  info: (...a) => __hostLog.applyIgnored(undefined, ['info', a.map(String).join(' ')]),
  warn: (...a) => __hostLog.applyIgnored(undefined, ['warn', a.map(String).join(' ')]),
  error: (...a) => __hostLog.applyIgnored(undefined, ['error', a.map(String).join(' ')]),
  debug: () => {},
};
globalThis.setTimeout = (fn, _ms, ...args) => { Promise.resolve().then(() => fn(...args)); return 0; };
globalThis.clearTimeout = () => {};
`;

// Isolate-side helpers, installed once per isolate after the bundle. Every
// run hands the host plain JSON: the host never receives live objects.
const HELPERS = `
// PineTS never settles if a provider call rejects (the constructor's ready
// promise has no catch), so the provider must never reject: it records the
// failure on \`state\`, hands back no bars, and the caller raises it after.
globalThis.__makeProvider = (state, opts) => ({
  async getMarketData(tickerId, timeframe, limit, sDate, eDate) {
    try {
      const json = await __hostFetchBars.apply(
        undefined,
        [tickerId, timeframe, limit ?? null, sDate ?? null, eDate ?? null],
        { arguments: { copy: true }, result: { promise: true, copy: true } },
      );
      return JSON.parse(json);
    } catch (err) {
      state.dataError = state.dataError || String((err && err.message) || err);
      return [];
    }
  },
  async getSymbolInfo() { return opts.symbolInfo; },
  configure() {},
});

// PineTS's live mode re-executes the forming bar on every update, and plot()
// APPENDS a point each time, so the same bar time piles up in plots[*].data.
// Keep the last point per bar time for everything at or after \`cutoff\` (the
// open time of the bar that was the last one before the update).
globalThis.__compactPlots = (ctx, cutoff) => {
  for (const plot of Object.values(ctx.plots || {})) {
    const d = plot && plot.data;
    if (!Array.isArray(d) || d.length < 2) continue;
    let k = d.length;
    while (k > 0 && d[k - 1] && d[k - 1].time >= cutoff) k--;
    if (d.length - k < 2) continue;
    const byTime = new Map();
    for (let i = k; i < d.length; i++) byTime.set(d[i].time, d[i]);
    const tail = [...byTime.values()].sort((a, b) => a.time - b.time);
    d.length = k;
    for (const p of tail) d.push(p);
  }
};

// Exact rollback for streams. PineTS's live mode restores which object each
// var points to (Series length + last value) but not what is INSIDE the
// object, so array.push / map.put / udt.field := / box.delete made while
// computing a forming bar survive the rollback and pile up once per tick.
// On top of PineTS's own snapshot we record every mutable object reachable
// from the script's variables, ta state and drawing helpers (data fields
// only), and restore each one IN PLACE: identity is kept, so everything that
// references it (other vars, arrays of boxes, linefills) stays valid.
const __SKIP = new Set(['context', '_helper', '_definition', '_udt']);
const __isSeries = (v) => Array.isArray(v.data) && typeof v.get === 'function';
globalThis.__deepSnapshot = (ctx) => {
  const saved = new Map();
  const stack = [];
  const push = (v) => { if (v !== null && typeof v === 'object' && !saved.has(v)) stack.push(v); };
  const roots = (c) => {
    for (const scope of ['var', 'let', 'const', 'params']) {
      const cont = c && c[scope];
      if (!cont) continue;
      for (const k in cont) {
        const item = cont[k];
        if (item && typeof item === 'object' && __isSeries(item)) {
          const d = item.data;
          if (d.length) push(d[d.length - 1]);
          if (d.length > 1) push(d[d.length - 2]);
        } else push(item);
      }
    }
  };
  roots(ctx);
  if (ctx.lctx) ctx.lctx.forEach((l) => roots(l));
  push(ctx.taState);
  for (const h of ctx._drawingHelpers || []) push(h);
  while (stack.length) {
    const o = stack.pop();
    if (saved.has(o) || o === ctx || __isSeries(o) || ('marketData' in o && 'pine' in o) || Object.isFrozen(o)) continue;
    if (Array.isArray(o)) {
      saved.set(o, o.slice());
      for (const v of o) push(v);
    } else if (o instanceof Map) {
      const e = [...o.entries()];
      saved.set(o, e);
      for (const [k, v] of e) { push(k); push(v); }
    } else if (o instanceof Set) {
      const e = [...o];
      saved.set(o, e);
      for (const v of e) push(v);
    } else if (ArrayBuffer.isView(o)) {
      saved.set(o, o.slice());
    } else {
      const copy = {};
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (__SKIP.has(k) || typeof v === 'function') continue;
        copy[k] = v;
        push(v);
      }
      saved.set(o, copy);
    }
  }
  // request.security keeps per-call gap state (previous HTF index) as plain
  // numbers in ctx.cache; the secondaries themselves are rebuilt per update.
  const prims = {};
  for (const k in ctx.cache || {}) { const v = ctx.cache[k]; if (v === null || typeof v !== 'object') prims[k] = v; }
  return { saved, cache: ctx.cache || null, prims };
};
globalThis.__deepRestore = (snap) => {
  if (snap.cache) {
    for (const k in snap.cache) { const v = snap.cache[k]; if ((v === null || typeof v !== 'object') && !(k in snap.prims)) delete snap.cache[k]; }
    Object.assign(snap.cache, snap.prims);
  }
  for (const [o, s] of snap.saved) {
    if (Array.isArray(o)) {
      o.length = 0;
      for (let i = 0; i < s.length; i++) o.push(s[i]);
    } else if (o instanceof Map) {
      o.clear();
      for (const [k, v] of s) o.set(k, v);
    } else if (o instanceof Set) {
      o.clear();
      for (const v of s) o.add(v);
    } else if (ArrayBuffer.isView(o)) {
      o.set(s);
    } else {
      for (const k of Object.keys(o)) {
        if (!(k in s) && !__SKIP.has(k) && typeof o[k] !== 'function') delete o[k];
      }
      Object.assign(o, s);
    }
  }
};
// Script inputs (TradingView's settings dialog). The script runs as a PineTS
// Indicator carrying the user's overrides, keyed by input id (\`in_N\`).
// PineTS runs request.security's higher-timeframe copy from the bare source
// (or a pre-transpiled slice) with NO overrides, so a security expression that
// uses an input would silently keep its default: secondaries get the same
// overrides here. One script per isolate, so a global is enough.
globalThis.__pineInputs = null;
globalThis.__indicatorFor = (source, inputs) => {
  const has = inputs && typeof inputs === 'object' && Object.keys(inputs).length > 0;
  globalThis.__pineInputs = has ? inputs : null;
  if (has) {
    const proto = PineTS.prototype;
    if (!proto.__inputsPatched) {
      proto.__inputsPatched = true;
      const run = proto.run;
      const runPre = proto.runPretranspiled;
      proto.run = function (code, ...rest) {
        if (this._isSecondaryContext && globalThis.__pineInputs && typeof code === 'string') {
          code = new PineTSLib.Indicator(code, globalThis.__pineInputs);
        }
        return run.call(this, code, ...rest);
      };
      proto.runPretranspiled = function (fn, inputs, ...rest) {
        if (this._isSecondaryContext && globalThis.__pineInputs) inputs = { ...globalThis.__pineInputs, ...(inputs || {}) };
        return runPre.call(this, fn, inputs, ...rest);
      };
    }
  }
  return new PineTSLib.Indicator(source, has ? inputs : {});
};

// The script's declared inputs (id, type, default, title, options, range...),
// plain JSON for the settings dialog.
const __INPUT_FIELDS = ['id', 'name', 'type', 'defval', 'title', 'tooltip', 'group', 'inline', 'options', 'minval', 'maxval', 'step', 'display', 'confirm'];
globalThis.__inputsMeta = (ind) => {
  let meta = [];
  try { meta = ind.getInputsMeta() || []; } catch (e) { return []; }
  return meta.slice(0, 100).map((m) => {
    const o = {};
    for (const k of __INPUT_FIELDS) {
      const v = m[k];
      if (v === undefined || typeof v === 'function') continue;
      try { o[k] = JSON.parse(JSON.stringify(v)); } catch (e) { /* not JSON: skip */ }
    }
    return o;
  });
};

globalThis.__installDeepRollback = (PineTSClass) => {
  const proto = PineTSClass.prototype;
  if (proto.__deepRollback) return;
  const snap = proto._snapshotVarState;
  const restore = proto._restoreVarState;
  if (typeof snap !== 'function' || typeof restore !== 'function') throw new Error('PineTS rollback hooks not found');
  proto.__deepRollback = true;
  proto._snapshotVarState = function (ctx) {
    const s = snap.call(this, ctx);
    if (s) s.__deep = __deepSnapshot(ctx);
    return s;
  };
  proto._restoreVarState = function (ctx, s) {
    restore.call(this, ctx, s);
    if (s && s.__deep) __deepRestore(s.__deep);
  };
  // request.security refreshes its cached secondary with updateTail(), whose
  // tail rollback misses the per-bar value arrays (plain arrays, not Series)
  // and shifts them by a slot per update, so higher-timeframe values go
  // stale. Rebuild the secondary instead: fetch the new candles, re-run the
  // already-transpiled script over its (small) history, and move the result
  // into the SAME context object the cache holds.
  if (typeof proto.updateTail === 'function' && typeof proto.runPretranspiled === 'function') {
    proto.updateTail = async function (context) {
      if (!this.data || this.data.length === 0 || Array.isArray(this.source)) return false;
      const { newCandles, updatedLastCandle } = await this._updateMarketData();
      if (newCandles === 0 && !updatedLastCandle) return false;
      const fresh = await this.runPretranspiled(this._transpiledCode, context.inputs || {});
      for (const k of Object.keys(context)) delete context[k];
      Object.assign(context, fresh);
      return true;
    };
  }
};

// Alerts and warnings accumulate on the context; a stream reports each once.
globalThis.__drain = (ctx) => {
  if (Array.isArray(ctx.alerts)) ctx.alerts.length = 0;
  if (Array.isArray(ctx.warnings)) ctx.warnings.length = 0;
};

globalThis.__extract = (ctx, source, opts) => {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const md = ctx.marketData || [];
    const n = md.length;
    const timeAt = (i) => (i >= 0 && i < n ? md[i].openTime : null);
    // bar_index -> openTime; bar_time values pass through.
    const xToTime = (x, xloc) => {
      if (!isNum(x)) return null;
      if (xloc === 'bt' || xloc === 'bar_time' || x > 1e11) return x;
      const i = Math.round(x);
      if (i < 0) return timeAt(0);
      if (i >= n) return md[n - 1].openTime + (i - (n - 1)) * (n > 1 ? md[n - 1].openTime - md[n - 2].openTime : 0);
      return timeAt(i);
    };
    const stride = Math.max(1, Math.ceil(n / Math.max(1, opts.maxPlotPoints || 3000)));

    const plots = {};
    const shapes = [];
    let barByTime = null;
    const drawings = { boxes: [], lines: [], labels: [] };
    // Style fields pass through as PineTS holds them (colors '#RRGGBBAA' or
    // 'rgba(...)', '' = default, null = na; 'style_*' names; size names or
    // numbers); state.mjs normalises them for the chart.
    const str = (v) => (typeof v === 'string' ? v : (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? null : String(v)));
    const width = (v) => (isNum(v) ? v : null);
    const size = (v) => (isNum(v) ? v : str(v));
    // Open time of the bar each object was created on (\`at\`). PineTS ids are
    // global counters that move every time the forming bar re-executes, so the
    // chart keys drawings by creation bar + order instead. The plot copies
    // drop _createdAtBar; the helpers hold the live objects.
    const born = { boxes: new Map(), lines: new Map(), labels: new Map() };
    for (const h of ctx._drawingHelpers || []) {
      for (const [k, arr] of [['boxes', h && h._boxes], ['lines', h && h._lines], ['labels', h && h._labels]]) {
        if (Array.isArray(arr)) for (const o of arr) if (o && isNum(o._createdAtBar)) born[k].set(o.id, o._createdAtBar);
      }
    }
    const bornAt = (kind, o) => { const i = born[kind].get(o.id); return isNum(i) && i >= 0 && i < n ? md[i].openTime : null; };
    // The bar a label at yloc.abovebar / belowbar sits on.
    const barAt = (x, xloc) => {
      if (!isNum(x)) return null;
      if (xloc === 'bt' || xloc === 'bar_time' || x > 1e11) {
        if (!barByTime) barByTime = new Map(md.map((b) => [b.openTime, b]));
        return barByTime.get(x) || null;
      }
      const i = Math.round(x);
      return i >= 0 && i < n ? md[i] : null;
    };
    const DRAWING_PLOTS = { __boxes__: 'boxes', __boxes_overlay__: 'boxes', __lines__: 'lines', __lines_overlay__: 'lines', __labels__: 'labels', __labels_overlay__: 'labels' };
    for (const [name, plot] of Object.entries(ctx.plots || {})) {
      const data = (plot && plot.data) || [];
      const kind = DRAWING_PLOTS[name];
      if (kind) {
        const last = data.length ? data[data.length - 1].value : null;
        const items = Array.isArray(last) ? last.filter((d) => d && !d._deleted) : [];
        if (kind === 'boxes') {
          for (const b of items) {
            drawings.boxes.push({
              id: b.id, at: bornAt('boxes', b), t1: xToTime(b.left, b.xloc), t2: xToTime(b.right, b.xloc), top: b.top, bottom: b.bottom, color: b.bgcolor || b.border_color || null, text: b.text || '',
              bgcolor: str(b.bgcolor), border_color: str(b.border_color), border_width: width(b.border_width), border_style: str(b.border_style), extend: str(b.extend),
              text_color: str(b.text_color), text_size: size(b.text_size), text_halign: str(b.text_halign), text_valign: str(b.text_valign),
            });
          }
        } else if (kind === 'lines') {
          for (const l of items) drawings.lines.push({ id: l.id, at: bornAt('lines', l), t1: xToTime(l.x1, l.xloc), t2: xToTime(l.x2, l.xloc), p1: l.y1, p2: l.y2, color: str(l.color), style: l.style || null, extend: l.extend || 'none', width: width(l.width) });
        } else {
          for (const l of items) {
            const yloc = str(l.yloc);
            const above = yloc === 'ab' || yloc === 'abovebar';
            const below = yloc === 'bl' || yloc === 'belowbar';
            const bar = above || below ? barAt(l.x, l.xloc) : null;
            drawings.labels.push({
              id: l.id, at: bornAt('labels', l), t: xToTime(l.x, l.xloc), price: bar ? (above ? bar.high : bar.low) : (isNum(l.y) ? l.y : null), text: l.text || '', style: l.style || null,
              color: str(l.color), textcolor: str(l.textcolor), size: size(l.size), textalign: str(l.textalign),
              yloc: above ? 'abovebar' : below ? 'belowbar' : 'price', tooltip: str(l.tooltip),
            });
          }
        }
        continue;
      }
      if (name.startsWith('__')) continue;
      const first = data.find((p) => p && p.options);
      const o = (first && first.options) || {};
      const isShape = data.some((p) => p && p.value === true) && (o.shape || o.char || o.location);
      if (isShape) {
        for (let i = 0; i < data.length; i++) {
          const p = data[i];
          if (!p || p.value !== true) continue;
          if (!barByTime) barByTime = new Map(md.map((b) => [b.openTime, b]));
          const bar = barByTime.get(p.time) || null;
          const loc = String((p.options && p.options.location) || o.location || '').toLowerCase();
          const sh = String((p.options && p.options.shape) || o.shape || '').toLowerCase();
          const dir = /down|below|bear|sell/.test(sh) ? 'down' : /up|above|bull|buy/.test(sh) ? 'up' : (loc.includes('above') ? 'down' : 'up');
          const price = bar ? (loc.includes('above') ? bar.high : loc.includes('below') ? bar.low : bar.close) : null;
          shapes.push({ t: p.time, price, dir, text: (p.options && (p.options.text || p.options.char)) || o.text || o.char || '', title: name });
        }
        continue;
      }
      const points = [];
      for (let i = 0; i < data.length; i += stride) {
        const p = data[i];
        if (p && isNum(p.value)) points.push([p.time, p.value]);
      }
      plots[name] = { color: o.color || null, style: o.style || null, points, total: data.length };
    }

    // force_overlay objects sit in their own plot entries: back to creation order.
    for (const k of ['boxes', 'lines', 'labels']) drawings[k].sort((a, b) => a.id - b.id);

    // Native-study series: every plot/hline/fill/barcolor/bgcolor as values
    // aligned on ONE time axis (the last maxSeriesBars bars), plus per-bar
    // colours as palette indexes. The chart turns this into a real TradingView
    // study (legend, hover values, sub-pane, styles).
    const cssColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : (typeof c === 'string' && c ? c : null));
    const maxBars = Math.max(1, opts.maxSeriesBars || 3000);
    const from = Math.max(0, n - maxBars);
    const times = [];
    const timeIndex = new Map();
    for (let i = from; i < n; i++) { const t = Math.floor(md[i].openTime / 1000); timeIndex.set(t, times.length); times.push(t); }
    const decl = ctx.indicator || (st0 => st0 && st0.config)(ctx.strategy) || {};
    const series = {
      overlay: !!decl.overlay, title: decl.title || null, shorttitle: decl.shorttitle || null,
      precision: (typeof decl.precision === 'number' && decl.precision < 10) ? decl.precision : null,
      times, plots: [], hlines: [], fills: [], barcolor: null, bgcolor: null,
    };
    const styleName = (s) => {
      s = String(s || '');
      for (const k of ['histogram', 'columns', 'areabr', 'area', 'circles', 'cross', 'stepline', 'linebr']) if (s.includes(k)) return k;
      return 'line';
    };
    // Palettes must be DETERMINISTIC across runs: the chart registers a study
    // from them and rebuilds when they change, so first-seen order (which
    // shifts as bars roll) would rebuild the chart on every update. Colours are
    // sorted and indexes remapped once the run is complete.
    const paletteOf = () => {
      const list = []; const idx = new Map();
      const indexOf = (c) => { if (!c) return null; if (!idx.has(c)) { if (list.length >= 16) return null; idx.set(c, list.length); list.push(c); } return idx.get(c); };
      const finish = (indexes) => {
        const sorted = [...list].sort();
        const remap = new Map(list.map((c, i) => [i, sorted.indexOf(c)]));
        for (let i = 0; i < indexes.length; i++) if (indexes[i] !== null) indexes[i] = remap.get(indexes[i]);
        return sorted;
      };
      return { list, indexOf, finish };
    };
    for (const [name, plot] of Object.entries(ctx.plots || {})) {
      if (name.startsWith('__')) continue;
      const o = (plot && plot.options) || {};
      const style = String(o.style || '');
      if (style === 'shape' || style === 'char' || style === 'candle') continue;
      if (String(o.display || '').includes('none')) continue;
      const data = (plot && plot.data) || [];
      if (style === 'hline') {
        const first = data.find((p) => p && isNum(p.value));
        if (first) series.hlines.push({ title: plot.title || name, price: first.value, color: cssColor(o.color) || '#787b86', linestyle: String(o.linestyle || 'solid') });
        continue;
      }
      if (style === 'fill') {
        let color = cssColor(o.color);
        if (!color) { const p = data.find((d) => d && d.options && (d.options.color || d.options.top_color)); color = p ? cssColor(p.options.color || p.options.top_color) : null; }
        series.fills.push({ title: plot.title || name, plot1: o.plot1, plot2: o.plot2, color: color || '#2962ff' });
        continue;
      }
      if (style === 'background' || style === 'barcolor') {
        const pal = paletteOf();
        const idx = new Array(times.length).fill(null);
        for (const p of data) {
          if (!p || !p.value) continue;
          const i = timeIndex.get(Math.floor(p.time / 1000));
          if (i === undefined) continue;
          idx[i] = pal.indexOf(cssColor(p.options && p.options.color));
        }
        if (pal.list.length) series[style === 'barcolor' ? 'barcolor' : 'bgcolor'] = { palette: pal.finish(idx), idx };
        continue;
      }
      // Regular plot(): values by bar, colours as a palette when they vary.
      const values = new Array(times.length).fill(null);
      const colorIdx = new Array(times.length).fill(null);
      const pal = paletteOf();
      const defaultColor = cssColor(o.color) || '#2962ff';
      for (const p of data) {
        if (!p) continue;
        const i = timeIndex.get(Math.floor(p.time / 1000));
        if (i === undefined) continue;
        if (isNum(p.value)) values[i] = p.value;
        const c = cssColor(p.options && p.options.color);
        if (c) colorIdx[i] = pal.indexOf(c);
      }
      const multi = pal.list.length > 1 || (pal.list.length === 1 && pal.list[0] !== defaultColor);
      series.plots.push({
        id: 'p' + series.plots.length, key: name, title: plot.title || name,
        style: styleName(style), color: defaultColor, linewidth: isNum(o.linewidth) ? o.linewidth : 1,
        overlay: o.overlay === true, values, colors: multi ? { palette: pal.finish(colorIdx), idx: colorIdx } : null,
      });
    }
    // fills reference plot keys; resolve them to plot ids.
    for (const f of series.fills) {
      const a = series.plots.find((p) => p.key === f.plot1 || p.title === f.plot1);
      const b = series.plots.find((p) => p.key === f.plot2 || p.title === f.plot2);
      f.plot1 = a ? a.id : null; f.plot2 = b ? b.id : null;
    }
    series.fills = series.fills.filter((f) => f.plot1 && f.plot2);

    const st = ctx.strategy || null;
    const strat = st ? {
      config: st.config || null,
      closedtrades: (st.closedtrades || []).slice(opts.maxClosedTrades > 0 ? -opts.maxClosedTrades : 0).map((t) => ({
        id: t.id, entry_id: t.entry_id, entry_comment: t.entry_comment || null, entry_price: t.entry_price, entry_time: t.entry_time, entry_bar_index: t.entry_bar_index,
        exit_id: t.exit_id || null, exit_comment: t.exit_comment || null, exit_price: t.exit_price, exit_time: t.exit_time, exit_bar_index: t.exit_bar_index,
        size: t.size, profit: t.profit, commission: t.commission, max_drawdown: t.max_drawdown, max_runup: t.max_runup,
      })),
      opentrades: (st.opentrades || []).map((t) => ({ id: t.id, entry_id: t.entry_id, entry_comment: t.entry_comment || null, entry_price: t.entry_price, entry_time: t.entry_time, entry_bar_index: t.entry_bar_index, size: t.size })),
      // Exit orders keep strategy.exit's own fields: from_entry ties the bracket to
      // its entry, profit/loss are TICK offsets from the fill, limit/stop are
      // absolute prices. Live trading turns these into the entry's bracket.
      pending_orders: (st.pending_orders || []).map((o) => ({
        id: o.id, direction: o.direction, qty: o.qty, qty_percent: o.qty_percent ?? null, type: o.type, limit: o.limit ?? null, stop: o.stop ?? null,
        category: o.category || null, status: o.status, from_entry: o.from_entry ?? null, profit: o.profit ?? null, loss: o.loss ?? null,
        trail_price: o.trail_price ?? null, trail_points: o.trail_points ?? null, trail_offset: o.trail_offset ?? null, comment: o.comment ?? null,
      })),
      closedtrades_total: (st.closedtrades || []).length,
      netprofit: st.netprofit, grossprofit: st.grossprofit, grossloss: st.grossloss, max_drawdown: st.max_drawdown, max_runup: st.max_runup,
      wintrades: st.wintrades, losstrades: st.losstrades, eventrades: st.eventrades, position_size: st.position_size,
      sharpe_ratio: st.sharpe_ratio, sortino_ratio: st.sortino_ratio, initial_capital: st.initial_capital, equity: st.equity,
    } : null;

    const titleMatch = source.match(/^\\s*(?:strategy|indicator)\\s*\\(\\s*(?:title\\s*=\\s*)?["']([^"']*)["']/m);
    return {
      kind: st ? 'strategy' : 'indicator',
      title: (st && st.config && st.config.title) || (titleMatch ? titleMatch[1] : null),
      bars: n,
      firstTime: n ? md[0].openTime : null,
      lastTime: n ? md[n - 1].openTime : null,
      plots, shapes, drawings, series,
      strategy: strat,
      // Newest last; a live run only cares about its latest bars.
      alerts: (ctx.alerts || []).slice(-200).map((a) => ({
        type: a.type === 'alertcondition' ? 'alertcondition' : 'alert',
        id: a.id ?? null,
        title: a.title == null ? null : String(a.title).slice(0, 200),
        message: a.message == null ? null : String(a.message).slice(0, 1000),
        time: typeof a.time === 'number' ? a.time : null,
      })),
      warnings: (ctx.warnings || []).slice(0, 50).map(String),
      probe: globalThis.__probe ?? null,
    };
};
`;

// One-shot run. $0 = Pine source, $1 = run options (JSON).
const RUN_CLOSURE = `
const source = $0;
const opts = JSON.parse($1);
const state = { dataError: null };
return (async () => {
  const pine = new PineTS(__makeProvider(state, opts), opts.tickerId, opts.timeframe, opts.limit ?? undefined, opts.sDate ?? undefined, opts.eDate ?? undefined);
  // Live runs: alerts on every bar (the session keeps only new, live ones).
  // PineTS's default 'realtime' mode only fires on the LAST bar, which misses
  // alert.freq_once_per_bar_close when the close is seen with the next bar.
  if (opts.liveAlerts) pine.setAlertMode('all');
  let ctx;
  let ind;
  try {
    ind = __indicatorFor(source, opts.inputs);
    ctx = await pine.run(ind);
  } catch (err) {
    if (state.dataError) throw new Error(state.dataError);
    throw err;
  }
  if (state.dataError) throw new Error(state.dataError);
  const out = __extract(ctx, source, opts);
  out.inputs = __inputsMeta(ind);
  return JSON.stringify(out);
})();
`;

// Streaming run, opened once per live session. PineTS's paginated run() with a
// provider and no end date is its LIVE mode: after the history it asks the
// provider for candles from the last bar's open time on, replaces/appends
// them, rolls var state, the strategy ledger and drawings back to just before
// the last bar, and re-executes only the tail. $0 = source, $1 = options.
const STREAM_OPEN = `
const source = $0;
const opts = JSON.parse($1);
const S = globalThis.__stream = { source, opts, state: { dataError: null }, newBar: false, pine: null, it: null, ctx: null };
return (async () => {
  let r;
  try {
    __installDeepRollback(PineTS);
    S.pine = new PineTS(__makeProvider(S.state, opts), opts.tickerId, opts.timeframe, opts.limit ?? undefined);
    if (opts.liveAlerts) S.pine.setAlertMode('all');
    S.ind = __indicatorFor(source, opts.inputs);
    S.it = S.pine.run(S.ind, undefined, 1e9);
    r = await S.it.next();
  } catch (err) {
    if (S.state.dataError) throw new Error(S.state.dataError);
    throw err;
  }
  if (S.state.dataError) throw new Error(S.state.dataError);
  if (!r || r.done || !r.value) throw new Error('the script produced no result');
  S.ctx = r.value.fullContext || r.value;
  // TradingView: barstate.isnew is true on a bar's FIRST tick and false on
  // later ticks of it. PineTS's live mode latches it false for good after the
  // first update; make it follow whether this update opened a new bar.
  const bs = S.ctx.pine && S.ctx.pine.barstate;
  if (bs) bs.setLive = () => { bs._live = !S.newBar; };
  const out = __extract(S.ctx, source, opts);
  out.inputs = __inputsMeta(S.ind);
  __drain(S.ctx);
  return JSON.stringify(out);
})();
`;

// Advance an open stream by one provider fetch. $0 = update options (JSON).
const STREAM_UPDATE = `
const opts = JSON.parse($0);
const S = globalThis.__stream;
return (async () => {
  if (!S || !S.it) throw new Error('stream is not open');
  const d = S.pine.data;
  const cutoff = d.length ? d[d.length - 1].openTime : -Infinity;
  S.newBar = !!opts.newBar;
  S.state.dataError = null;
  const r = await S.it.next();
  if (S.state.dataError) throw new Error(S.state.dataError);
  if (!r || r.done) throw new Error('stream ended');
  __compactPlots(S.ctx, cutoff);
  const out = __extract(S.ctx, S.source, { ...S.opts, ...opts });
  __drain(S.ctx);
  out.changed = !!r.value;
  return JSON.stringify(out);
})();
`;

// Fresh context with the host bridges, the prelude, the bundle and the helpers.
async function prepareContext(isolate, logs, bridge) {
  const context = await isolate.createContext();
  const jail = context.global;
  await jail.set('__hostLog', new ivm.Reference((level, msg) => {
    if (logs.length < 50) logs.push(`${level}: ${String(msg).slice(0, 300)}`);
  }));
  await jail.set('__hostFetchBars', new ivm.Reference(async (...a) => {
    try {
      return JSON.stringify(await bridge.fetchBars(...a));
    } catch (err) {
      // Remember the real cause; the isolate only sees a generic failure.
      bridge.error = bridge.error || err;
      throw new Error('market data unavailable');
    }
  }));
  await context.eval(PRELUDE);
  const script = await isolate.compileScript(BUNDLE_SOURCE, bundleCache
    ? { cachedData: bundleCache }
    : { produceCachedData: true });
  if (!bundleCache && script.cachedData) bundleCache = script.cachedData;
  await script.run(context);
  await context.eval(HELPERS);
  return context;
}

// Wall-clock limit: the isolate is disposed when it passes, which aborts
// whatever is running inside it.
async function withDeadline(isolate, timeoutMs, fn) {
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    if (!isolate.isDisposed) isolate.dispose();
  }, timeoutMs);
  try {
    return { value: await fn() };
  } catch (err) {
    return { err, timedOut };
  } finally {
    clearTimeout(killer);
  }
}

function failure(out, isolate, bridge, logs, started) {
  const reason = bridge.error ? 'data' : out.timedOut ? 'timeout' : (isolate.isDisposed ? 'disposed' : 'error');
  const error = bridge.error ? String(bridge.error.message || bridge.error) : String(out.err?.message || out.err);
  return { ok: false, reason, error: error.slice(0, 500), ms: Math.round(performance.now() - started), logs, dataError: bridge.error || null };
}

/**
 * @param {object} args
 * @param {string} args.source         Pine source
 * @param {string} args.tickerId       chart symbol as the script should see it, e.g. 'NQ'
 * @param {string} args.timeframe      PineTS timeframe, e.g. '5'
 * @param {number} [args.limit]        newest N bars (compile checks)
 * @param {number} [args.sDate]        range start (ms) for backtests
 * @param {number} [args.eDate]        range end (ms) for backtests
 * @param {object} args.symbolInfo     PineTS ISymbolInfo subset
 * @param {(tickerId, timeframe, limit, sDate, eDate) => Promise<object[]>} args.fetchBars
 * @param {number} [args.timeoutMs]    wall-clock limit; the isolate is disposed when it passes
 * @param {number} [args.memoryMb]     isolate heap limit
 * @param {number} [args.maxPlotPoints]
 */
export async function runPine({ source, tickerId, timeframe, limit = null, sDate = null, eDate = null, symbolInfo, fetchBars, timeoutMs = 10_000, memoryMb = 128, maxPlotPoints = 3000, maxSeriesBars = 3000, inputs = null, liveAlerts = false }) {
  const started = performance.now();
  const logs = [];
  const bridge = { fetchBars, error: null };
  const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
  let setupMs = 0;
  try {
    const out = await withDeadline(isolate, timeoutMs, async () => {
      const context = await prepareContext(isolate, logs, bridge);
      setupMs = performance.now() - started;
      return context.evalClosure(RUN_CLOSURE, [source, JSON.stringify({ tickerId, timeframe, limit, sDate, eDate, symbolInfo, maxPlotPoints, maxSeriesBars, inputs, liveAlerts })], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
      });
    });
    if (out.err) return failure(out, isolate, bridge, logs, started);
    return { ok: true, ms: Math.round(performance.now() - started), setupMs: Math.round(setupMs), logs, ...JSON.parse(out.value) };
  } finally {
    if (!isolate.isDisposed) isolate.dispose();
  }
}

/**
 * A live session's script, kept running between updates: one isolate holding a
 * PineTS instance in live mode. `update()` re-executes only the bars at and
 * after the previous last bar (milliseconds) instead of the whole history.
 * The bars come from `fetchBars`, which the caller keeps current: an update
 * asks it for candles from the last known bar's open time on.
 *
 * Any failure (script error, timeout, memory) disposes the isolate: PineTS's
 * state is not trustworthy after a bar that threw halfway, so the caller
 * reopens from history.
 */
export class PineStream {
  constructor(isolate, context, bridge, logs) {
    this.isolate = isolate;
    this.context = context;
    this.bridge = bridge;
    this.logs = logs;
  }

  /** Same arguments and result fields as runPine, plus `stream` on success. */
  static async open({ source, tickerId, timeframe, limit = null, symbolInfo, fetchBars, timeoutMs = 20_000, memoryMb = 256, maxPlotPoints = 400, maxSeriesBars = 3000, maxClosedTrades = 0, inputs = null, liveAlerts = false }) {
    const started = performance.now();
    const logs = [];
    const bridge = { fetchBars, error: null };
    const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
    const out = await withDeadline(isolate, timeoutMs, async () => {
      const context = await prepareContext(isolate, logs, bridge);
      const json = await context.evalClosure(STREAM_OPEN, [source, JSON.stringify({ tickerId, timeframe, limit, symbolInfo, maxPlotPoints, maxSeriesBars, maxClosedTrades, inputs, liveAlerts })], {
        arguments: { copy: true },
        result: { promise: true, copy: true },
      });
      return { context, json };
    });
    if (out.err) {
      const f = failure(out, isolate, bridge, logs, started);
      if (!isolate.isDisposed) isolate.dispose();
      return f;
    }
    const stream = new PineStream(isolate, out.value.context, bridge, logs);
    return { ok: true, stream, ms: Math.round(performance.now() - started), logs, ...JSON.parse(out.value.json) };
  }

  get alive() {
    return !this.isolate.isDisposed;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.newBar]         this update opens a new bar (barstate.isnew)
   * @param {number} [opts.maxSeriesBars]   series bars to return (2 for an intrabar frame)
   * @param {number} [opts.maxClosedTrades] newest closed trades to return (0 = all)
   */
  async update({ newBar = false, maxSeriesBars, maxClosedTrades, timeoutMs = 20_000 } = {}) {
    const started = performance.now();
    if (!this.alive) return { ok: false, reason: 'disposed', error: 'stream is closed', ms: 0, logs: [] };
    this.bridge.error = null;
    const opts = { newBar };
    if (maxSeriesBars) opts.maxSeriesBars = maxSeriesBars;
    if (maxClosedTrades != null) opts.maxClosedTrades = maxClosedTrades;
    const out = await withDeadline(this.isolate, timeoutMs, () => this.context.evalClosure(STREAM_UPDATE, [JSON.stringify(opts)], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    }));
    if (out.err) {
      const f = failure(out, this.isolate, this.bridge, this.logs, started);
      this.dispose();
      return f;
    }
    return { ok: true, ms: Math.round(performance.now() - started), ...JSON.parse(out.value) };
  }

  /** Isolate heap in MB (null once disposed). */
  heapMb() {
    try {
      return Math.round(this.isolate.getHeapStatisticsSync().used_heap_size / 1048576);
    } catch {
      return null;
    }
  }

  dispose() {
    if (!this.isolate.isDisposed) this.isolate.dispose();
  }
}
