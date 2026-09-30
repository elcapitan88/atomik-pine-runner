// Sandbox worker: one child process that fetches bars, runs the isolate and
// translates the result. A native crash here loses this worker, not the API.
// Messages: {id, type: 'compile'|'backtest', ...} -> {id, ok, ...}.
import { config } from './config.mjs';
import { runPine } from './sandbox.mjs';
import { toBacktestPayload } from './translate.mjs';
import * as warehouse from './warehouse.mjs';
import { tickerToRoot } from './symbols.mjs';
import { atomikToPine, atomikToSeconds, pineToSeconds, secondsToAtomik } from './timeframes.mjs';

warehouse.connect(config.timescaleUrl);

export class ScriptError extends Error {
  constructor(message, line = null) {
    super(message);
    this.line = line;
  }
}

// Test-only data source: synthetic bars instead of the warehouse, so the HTTP
// contract can be exercised in CI without a database.
const synthetic = process.env.PINE_SYNTHETIC_DATA === '1'
  ? (await import('../test/synthetic.mjs')).fetchBars
  : null;

/** Provider bridge: PineTS (tickerId, pineTf, limit, sDate, eDate) -> warehouse bars. */
async function fetchBars(tickerId, pineTf, limit, sDate, eDate) {
  const root = tickerToRoot(tickerId);
  if (!root) throw new ScriptError(`Unknown symbol "${tickerId}". Use a futures root like NQ or a TradingView ticker like CME_MINI:NQ1!.`);
  const seconds = pineToSeconds(pineTf);
  const tf = seconds ? secondsToAtomik(seconds) : null;
  if (!tf) throw new ScriptError(`Timeframe "${pineTf}" is not available for backtesting. Available: 1, 2, 3, 5, 10, 15, 30, 60, 120, 240, D.`);
  if (synthetic) return synthetic(root, pineTf, limit, sDate, eDate);
  // Open bounds are fine: "newest N bars" (compile dry-run) needs no range.
  return warehouse.getBars(root, tf, sDate ?? null, eDate ?? null, limit);
}

function parseLine(message) {
  const m = /\bat (\d+):(\d+)\b/.exec(message || '');
  return m ? Number(m[1]) : null;
}

function cleanError(message) {
  return String(message || '')
    .replace(/^Failed to transpile Pine Script version \d+:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .slice(0, 500);
}

async function compile(job) {
  const tf = job.timeframe || config.compileTimeframe;
  const symbol = job.symbol || config.compileSymbol;
  const res = await runPine({
    source: job.source,
    tickerId: symbol,
    timeframe: atomikToPine(tf) || '5',
    limit: config.compileBars,
    symbolInfo: symbolInfoFor(symbol, job.symbol_info),
    fetchBars,
    timeoutMs: config.compileTimeoutMs,
    memoryMb: config.isolateMemoryMb,
    maxPlotPoints: 50,
  });
  if (!res.ok) {
    if (res.reason === 'data') return { ok: false, status: 503, detail: res.error };
    const message = res.reason === 'timeout'
      ? `The script did not finish ${config.compileBars} bars within ${Math.round(config.compileTimeoutMs / 1000)}s. Check for runaway loops.`
      : cleanError(res.error);
    return { ok: true, compile: { ok: false, kind: null, title: null, errors: [{ line: parseLine(res.error), message }], warnings: res.logs.filter((l) => l.startsWith('warn')).slice(0, 10), bars_checked: 0, ms: res.ms } };
  }
  return {
    ok: true,
    compile: {
      ok: true,
      kind: res.kind,
      title: res.title,
      is_automatable: res.kind === 'strategy',
      errors: [],
      warnings: [...res.warnings, ...res.logs.filter((l) => l.startsWith('warn'))].slice(0, 20),
      bars_checked: res.bars,
      plots: Object.keys(res.plots || {}),
      has_drawings: !!(res.drawings && (res.drawings.boxes.length || res.drawings.lines.length || res.drawings.labels.length)) || (res.shapes || []).length > 0,
      trades_in_sample: res.strategy ? res.strategy.closedtrades.length : null,
      ms: res.ms,
    },
  };
}

async function backtest(job) {
  const pineTf = atomikToPine(job.timeframe);
  if (!pineTf) return { ok: false, status: 400, detail: `Unsupported timeframe '${job.timeframe}'.` };
  const res = await runPine({
    source: job.source,
    tickerId: job.symbol,
    timeframe: pineTf,
    sDate: job.start_ms,
    eDate: job.end_ms,
    symbolInfo: symbolInfoFor(job.symbol, job.symbol_info),
    fetchBars,
    timeoutMs: config.backtestTimeoutMs,
    memoryMb: config.isolateMemoryMb,
    maxPlotPoints: config.maxPlotPoints,
  });
  if (!res.ok) {
    if (res.reason === 'data') return { ok: false, status: res.dataError instanceof ScriptError ? 400 : 503, detail: res.error };
    if (res.reason === 'timeout') return { ok: false, status: 400, detail: `The backtest did not finish within ${Math.round(config.backtestTimeoutMs / 1000)}s. Shorten the range or simplify the script.` };
    if (res.reason === 'disposed') return { ok: false, status: 400, detail: 'The script ran out of memory. Reduce array sizes or lookbacks.' };
    return { ok: false, status: 400, detail: `Script error: ${cleanError(res.error)}`, line: parseLine(res.error) };
  }
  if (res.bars === 0) return { ok: false, status: 400, detail: `No historical data for ${job.symbol} ${job.timeframe} in that range.` };
  if (res.kind !== 'strategy') return { ok: false, status: 400, detail: 'This script is an indicator (no strategy.entry/exit calls), so there is nothing to backtest. It can still be shown on your chart.' };
  return { ok: true, backtest: { ...toBacktestPayload(res), kind: res.kind, title: res.title } };
}

// Live chart run: the primary series comes from the session's own bar history
// (passed in), so a live bar that the warehouse hasn't stored yet is still
// seen; request.security for other timeframes reads the warehouse.
async function liveRun(job) {
  const pineTf = atomikToPine(job.timeframe);
  if (!pineTf) return { ok: false, status: 400, detail: `Unsupported timeframe '${job.timeframe}'.` };
  const primary = job.bars || [];
  const wantSeconds = atomikToSeconds(job.timeframe);
  const provider = async (tickerId, tf, limit, sDate, eDate) => {
    const root = tickerToRoot(tickerId);
    if (root === job.symbol && pineToSeconds(tf) === wantSeconds) {
      let bars = primary;
      if (sDate != null) bars = bars.filter((b) => b.openTime >= sDate);
      if (eDate != null) bars = bars.filter((b) => b.openTime <= eDate);
      if (limit) bars = bars.slice(-limit);
      return bars;
    }
    return fetchBars(tickerId, tf, limit, sDate, eDate);
  };
  const res = await runPine({
    source: job.source,
    tickerId: job.symbol,
    timeframe: pineTf,
    limit: primary.length,
    symbolInfo: symbolInfoFor(job.symbol, job.symbol_info),
    fetchBars: provider,
    timeoutMs: config.liveRunTimeoutMs,
    memoryMb: config.isolateMemoryMb,
    maxPlotPoints: 400,
    maxSeriesBars: config.liveWarmupBars,
  });
  if (!res.ok) return { ok: false, status: 400, detail: res.reason === 'data' ? res.error : `Script error: ${cleanError(res.error)}` };
  return { ok: true, live: { kind: res.kind, title: res.title, bars: res.bars, lastTime: res.lastTime, plots: res.plots, shapes: res.shapes, drawings: res.drawings, series: res.series, ms: res.ms } };
}

function defaultSymbolInfo(symbol) {
  return {
    ticker: symbol, tickerid: symbol, root: symbol, prefix: '', type: 'futures', description: symbol,
    mintick: 0.25, minmove: 1, pricescale: 100, pointvalue: 1, currency: 'USD', basecurrency: '',
    timezone: 'America/Chicago', session: '1700-1600', volumetype: 'base',
  };
}

// A caller may send only the fields it knows (tick size, point value). Every
// other syminfo.* field must still exist: `request.security(syminfo.tickerid, ...)`
// with an undefined tickerid fails deep inside PineTS with "Invalid timeframe".
function symbolInfoFor(symbol, partial) {
  const merged = { ...defaultSymbolInfo(symbol) };
  for (const [k, v] of Object.entries(partial || {})) if (v !== null && v !== undefined && v !== '') merged[k] = v;
  return merged;
}

process.on('message', async (job) => {
  let reply;
  try {
    reply = job.type === 'compile' ? await compile(job) : job.type === 'live_run' ? await liveRun(job) : await backtest(job);
  } catch (err) {
    reply = { ok: false, status: 500, detail: `worker failure: ${String(err?.message || err).slice(0, 300)}` };
  }
  process.send({ id: job.id, ...reply });
});

process.on('disconnect', async () => {
  await warehouse.close();
  process.exitCode = 0;
});

process.send?.({ ready: true });
