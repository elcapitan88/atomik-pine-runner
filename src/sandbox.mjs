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
const RUN_CLOSURE = `
const source = $0;
const opts = JSON.parse($1);
const provider = {
  async getMarketData(tickerId, timeframe, limit, sDate, eDate) {
    const json = await __hostFetchBars.apply(
      undefined,
      [tickerId, timeframe, limit ?? null, sDate ?? null, eDate ?? null],
      { arguments: { copy: true }, result: { promise: true, copy: true } },
    );
    return JSON.parse(json);
  },
  async getSymbolInfo() { return opts.symbolInfo; },
  configure() {},
};
return (async () => {
  const pine = new PineTS(provider, opts.tickerId, opts.timeframe, opts.limit);
  const ctx = await pine.run(source);
  const plots = {};
  for (const [name, plot] of Object.entries(ctx.plots || {})) {
    const data = (plot && plot.data) || [];
    if (name.startsWith('__')) {
      const last = data.length ? data[data.length - 1].value : null;
      plots[name] = Array.isArray(last) ? last.filter((d) => d && !d._deleted).length : 0;
    } else {
      plots[name] = data.filter((p) => p && p.value !== null && p.value !== undefined
        && !(typeof p.value === 'number' && Number.isNaN(p.value))).length;
    }
  }
  const st = ctx.strategy;
  return JSON.stringify({
    bars: ctx.marketData.length,
    plots,
    trades: st ? st.closedtrades.length : null,
    openTrades: st ? st.opentrades.length : null,
    netprofit: st ? st.netprofit : null,
    probe: globalThis.__probe ?? null,
  });
})();
`;

/**
 * @param {object} args
 * @param {string} args.source         Pine source
 * @param {string} args.tickerId       chart symbol, e.g. 'CME_MINI:NQ1!'
 * @param {string} args.timeframe      chart timeframe, e.g. '5'
 * @param {number} args.limit          bars to load for the chart timeframe
 * @param {object} args.symbolInfo     PineTS ISymbolInfo subset
 * @param {(tickerId, timeframe, limit, sDate, eDate) => Promise<object[]>} args.fetchBars
 * @param {number} [args.timeoutMs]    wall-clock limit; the isolate is disposed when it passes
 * @param {number} [args.memoryMb]     isolate heap limit
 */
export async function runPine({ source, tickerId, timeframe, limit, symbolInfo, fetchBars, timeoutMs = 10_000, memoryMb = 128 }) {
  const started = performance.now();
  const logs = [];
  const isolate = new ivm.Isolate({ memoryLimit: memoryMb });
  let timedOut = false;
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
    await jail.set('__hostFetchBars', new ivm.Reference(async (...a) => JSON.stringify(await fetchBars(...a))));
    await context.eval(PRELUDE);

    const script = await isolate.compileScript(BUNDLE_SOURCE, bundleCache
      ? { cachedData: bundleCache }
      : { produceCachedData: true });
    if (!bundleCache && script.cachedData) bundleCache = script.cachedData;
    await script.run(context);
    const setupMs = performance.now() - started;

    const json = await context.evalClosure(RUN_CLOSURE, [source, JSON.stringify({ tickerId, timeframe, limit, symbolInfo })], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    });
    return { ok: true, ms: Math.round(performance.now() - started), setupMs: Math.round(setupMs), logs, ...JSON.parse(json) };
  } catch (err) {
    const reason = timedOut ? 'timeout' : (isolate.isDisposed ? 'disposed' : 'error');
    return { ok: false, reason, error: String(err?.message || err).slice(0, 300), ms: Math.round(performance.now() - started), logs };
  } finally {
    clearTimeout(killer);
    if (!isolate.isDisposed) isolate.dispose();
  }
}
