// Runs a Pine script with PineTS inside an isolated-vm isolate.
//
// Why an isolate: PineTS compiles scripts to JavaScript and runs them with
// `new Function`, and identifiers it does not recognise fall through to the JS
// global scope. In a plain Node process a script can read `process.env`. Inside
// an isolate there is no `process`, `require`, `fetch`, file system or network;
// the only way out is the host functions we hand in explicitly.
import ivm from 'isolated-vm';
import { readFileSync } from 'node:fs';

const BUNDLE_PATH = new URL('../node_modules/pinets/dist/pinets.min.browser.js', import.meta.url);
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

// Runs inside the isolate. $0 = Pine source, $1 = run options (JSON).
// Everything it returns is plain JSON: the host never receives live objects.
const RUN_CLOSURE = `
const source = $0;
const opts = JSON.parse($1);
// PineTS never settles if a provider call rejects (the constructor's ready
// promise has no catch), so the provider must never reject: it records the
// failure, hands back no bars, and the closure raises it after the run.
let dataError = null;
const provider = {
  async getMarketData(tickerId, timeframe, limit, sDate, eDate) {
    try {
      const json = await __hostFetchBars.apply(
        undefined,
        [tickerId, timeframe, limit ?? null, sDate ?? null, eDate ?? null],
        { arguments: { copy: true }, result: { promise: true, copy: true } },
      );
      return JSON.parse(json);
    } catch (err) {
      dataError = dataError || String((err && err.message) || err);
      return [];
    }
  },
  async getSymbolInfo() { return opts.symbolInfo; },
  configure() {},
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
return (async () => {
  const pine = new PineTS(provider, opts.tickerId, opts.timeframe, opts.limit ?? undefined, opts.sDate ?? undefined, opts.eDate ?? undefined);
  let ctx;
  try {
    ctx = await pine.run(source);
  } catch (err) {
    if (dataError) throw new Error(dataError);
    throw err;
  }
  if (dataError) throw new Error(dataError);
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
  const drawings = { boxes: [], lines: [], labels: [] };
  for (const [name, plot] of Object.entries(ctx.plots || {})) {
    const data = (plot && plot.data) || [];
    if (name === '__boxes__' || name === '__lines__' || name === '__labels__') {
      const last = data.length ? data[data.length - 1].value : null;
      const items = Array.isArray(last) ? last.filter((d) => d && !d._deleted) : [];
      if (name === '__boxes__') {
        for (const b of items) drawings.boxes.push({ id: b.id, t1: xToTime(b.left, b.xloc), t2: xToTime(b.right, b.xloc), top: b.top, bottom: b.bottom, color: b.bgcolor || b.border_color || null, text: b.text || '' });
      } else if (name === '__lines__') {
        for (const l of items) drawings.lines.push({ id: l.id, t1: xToTime(l.x1, l.xloc), t2: xToTime(l.x2, l.xloc), p1: l.y1, p2: l.y2, color: l.color || null, style: l.style || null, extend: l.extend || 'none' });
      } else {
        for (const l of items) drawings.labels.push({ id: l.id, t: xToTime(l.x, l.xloc), price: isNum(l.y) ? l.y : null, text: l.text || '', style: l.style || null });
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
        const bar = md.find((b) => b.openTime === p.time) || null;
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

  // Native-study series: every plot/hline/fill/barcolor/bgcolor as values
  // aligned on ONE time axis (the last maxSeriesBars bars), plus per-bar
  // colours as palette indexes. The chart turns this into a real TradingView
  // study (legend, hover values, sub-pane, styles).
  const cssColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) : (typeof c === 'string' && c ? c : null));
  const maxBars = Math.max(100, opts.maxSeriesBars || 3000);
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
    closedtrades: (st.closedtrades || []).map((t) => ({
      id: t.id, entry_id: t.entry_id, entry_comment: t.entry_comment || null, entry_price: t.entry_price, entry_time: t.entry_time, entry_bar_index: t.entry_bar_index,
      exit_id: t.exit_id || null, exit_comment: t.exit_comment || null, exit_price: t.exit_price, exit_time: t.exit_time, exit_bar_index: t.exit_bar_index,
      size: t.size, profit: t.profit, commission: t.commission, max_drawdown: t.max_drawdown, max_runup: t.max_runup,
    })),
    opentrades: (st.opentrades || []).map((t) => ({ id: t.id, entry_id: t.entry_id, entry_price: t.entry_price, entry_time: t.entry_time, size: t.size })),
    pending_orders: (st.pending_orders || []).map((o) => ({ id: o.id, direction: o.direction, qty: o.qty, type: o.type, limit: o.limit ?? null, stop: o.stop ?? null, category: o.category || null, status: o.status })),
    netprofit: st.netprofit, grossprofit: st.grossprofit, grossloss: st.grossloss, max_drawdown: st.max_drawdown, max_runup: st.max_runup,
    wintrades: st.wintrades, losstrades: st.losstrades, eventrades: st.eventrades, position_size: st.position_size,
    sharpe_ratio: st.sharpe_ratio, sortino_ratio: st.sortino_ratio, initial_capital: st.initial_capital, equity: st.equity,
  } : null;

  const titleMatch = source.match(/^\\s*(?:strategy|indicator)\\s*\\(\\s*(?:title\\s*=\\s*)?["']([^"']*)["']/m);
  return JSON.stringify({
    kind: st ? 'strategy' : 'indicator',
    title: (st && st.config && st.config.title) || (titleMatch ? titleMatch[1] : null),
    bars: n,
    firstTime: n ? md[0].openTime : null,
    lastTime: n ? md[n - 1].openTime : null,
    plots, shapes, drawings, series,
    strategy: strat,
    alerts: (ctx.alerts || []).slice(0, 200),
    warnings: (ctx.warnings || []).slice(0, 50).map(String),
    probe: globalThis.__probe ?? null,
  });
})();
`;

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
export async function runPine({ source, tickerId, timeframe, limit = null, sDate = null, eDate = null, symbolInfo, fetchBars, timeoutMs = 10_000, memoryMb = 128, maxPlotPoints = 3000, maxSeriesBars = 3000 }) {
  const started = performance.now();
  const logs = [];
  const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
  let timedOut = false;
  let fetchError = null;
  const killer = setTimeout(() => {
    timedOut = true;
    if (!isolate.isDisposed) isolate.dispose();
  }, timeoutMs);

  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('__hostLog', new ivm.Reference((level, msg) => {
      if (logs.length < 50) logs.push(`${level}: ${String(msg).slice(0, 300)}`);
    }));
    await jail.set('__hostFetchBars', new ivm.Reference(async (...a) => {
      try {
        return JSON.stringify(await fetchBars(...a));
      } catch (err) {
        // Remember the real cause; the isolate only sees a generic failure.
        fetchError = fetchError || err;
        throw new Error('market data unavailable');
      }
    }));
    await context.eval(PRELUDE);

    const script = await isolate.compileScript(BUNDLE_SOURCE, bundleCache
      ? { cachedData: bundleCache }
      : { produceCachedData: true });
    if (!bundleCache && script.cachedData) bundleCache = script.cachedData;
    await script.run(context);
    const setupMs = performance.now() - started;

    const json = await context.evalClosure(RUN_CLOSURE, [source, JSON.stringify({ tickerId, timeframe, limit, sDate, eDate, symbolInfo, maxPlotPoints, maxSeriesBars })], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    });
    return { ok: true, ms: Math.round(performance.now() - started), setupMs: Math.round(setupMs), logs, ...JSON.parse(json) };
  } catch (err) {
    const reason = fetchError ? 'data' : timedOut ? 'timeout' : (isolate.isDisposed ? 'disposed' : 'error');
    const error = fetchError ? String(fetchError.message || fetchError) : String(err?.message || err);
    return { ok: false, reason, error: error.slice(0, 500), ms: Math.round(performance.now() - started), logs, dataError: fetchError || null };
  } finally {
    clearTimeout(killer);
    if (!isolate.isDisposed) isolate.dispose();
  }
}
