// Sandbox worker: one child process that fetches bars, runs the isolate and
// translates the result. A native crash here loses this worker, not the API.
// Messages: {id, type: 'compile'|'backtest'|'live_run', ...} -> {id, ok, ...}.
// A worker forked by the StreamHost also holds live STREAMS (one isolate per
// session, kept between updates): 'stream_open' | 'stream_update' | 'stream_close'.
import { config } from './config.mjs';
import { runPine, PineStream } from './sandbox.mjs';
import { mergeBar } from './live/bars.mjs';
import { seriesSpec } from './live/state.mjs';
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
    inputs: job.inputs || null,
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
      // Plot structure (no values): the chart registers the script as a native
      // study from this before it ever runs live.
      series_spec: seriesSpec(res.series),
      // Declared inputs (TradingView's settings dialog): id, type, default, range, options.
      inputs: res.inputs || [],
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
    inputs: job.inputs || null,
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
// request.security data for live runs: the same higher-timeframe bars are asked
// for on every re-run (every couple of seconds per session), and they change at
// most once per bar of THAT timeframe. A short cache keeps the warehouse out
// of the intrabar path; staleness is bounded by the TTL.
const SECURITY_CACHE_TTL_MS = 20_000;
const securityCache = new Map(); // key -> {at, bars}

async function cachedFetchBars(tickerId, tf, limit, sDate, eDate) {
  const key = `${tickerId}|${tf}|${limit ?? ''}|${sDate ?? ''}|${eDate ?? ''}`;
  const hit = securityCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < SECURITY_CACHE_TTL_MS) return hit.bars;
  const bars = await fetchBars(tickerId, tf, limit, sDate, eDate);
  securityCache.set(key, { at: now, bars });
  if (securityCache.size > 64) securityCache.delete(securityCache.keys().next().value);
  return bars;
}

// The session's own series (symbol + timeframe) is served from `getBars()`;
// every other symbol/timeframe (request.security) from the warehouse.
function chartProvider(symbol, timeframe, getBars) {
  const wantSeconds = atomikToSeconds(timeframe);
  return async (tickerId, tf, limit, sDate, eDate) => {
    const root = tickerToRoot(tickerId);
    if (root === symbol && pineToSeconds(tf) === wantSeconds) {
      let bars = getBars();
      if (sDate != null) {
        let i = bars.length;
        while (i > 0 && bars[i - 1].openTime >= sDate) i--;
        bars = bars.slice(i);
      }
      if (eDate != null) bars = bars.filter((b) => b.openTime <= eDate);
      if (limit) bars = bars.slice(-limit);
      return bars;
    }
    return cachedFetchBars(tickerId, tf, limit, sDate, eDate);
  };
}

const liveFields = (res) => ({ kind: res.kind, title: res.title, bars: res.bars, firstTime: res.firstTime, lastTime: res.lastTime, plots: res.plots, shapes: res.shapes, drawings: res.drawings, series: res.series, strategy: res.strategy, ms: res.ms });

async function liveRun(job) {
  const pineTf = atomikToPine(job.timeframe);
  if (!pineTf) return { ok: false, status: 400, detail: `Unsupported timeframe '${job.timeframe}'.` };
  const primary = job.bars || [];
  const res = await runPine({
    source: job.source,
    tickerId: job.symbol,
    timeframe: pineTf,
    limit: primary.length,
    symbolInfo: symbolInfoFor(job.symbol, job.symbol_info),
    fetchBars: chartProvider(job.symbol, job.timeframe, () => primary),
    timeoutMs: config.liveRunTimeoutMs,
    memoryMb: config.isolateMemoryMb,
    maxPlotPoints: 400,
    inputs: job.inputs || null,
    // An intrabar run only ships the last bar's values, so it asks for a
    // couple of series bars instead of the whole history.
    maxSeriesBars: Number.isFinite(job.max_series_bars) && job.max_series_bars > 0 ? job.max_series_bars : config.liveWarmupBars,
  });
  if (!res.ok) return { ok: false, status: 400, detail: res.reason === 'data' ? res.error : `Script error: ${cleanError(res.error)}` };
  return { ok: true, live: liveFields(res) };
}

// Live streams: key -> {stream, bars}. `bars` is the session's series as this
// worker knows it; each update merges the bars the manager sends (the last
// known bar, now final or still forming, plus any newer ones) and the stream
// re-executes only from there.
const streams = new Map();
const STREAM_BAR_CAP = 20_000;
// Closed trades per update: enough to cover every trade that could have
// closed since the previous update; the ledger diff already knows the rest.
const STREAM_UPDATE_CLOSED_TRADES = 200;

function closeStream(key) {
  const entry = streams.get(key);
  streams.delete(key);
  entry?.stream?.dispose();
}

const liveError = (res) => (res.reason === 'data' ? res.error : res.reason === 'timeout' ? `Script timed out after ${res.ms}ms` : `Script error: ${cleanError(res.error)}`);

async function streamOpen(job) {
  const pineTf = atomikToPine(job.timeframe);
  if (!pineTf) return { ok: false, status: 400, detail: `Unsupported timeframe '${job.timeframe}'.` };
  closeStream(job.key);
  const entry = { bars: (job.bars || []).slice(-STREAM_BAR_CAP), stream: null };
  const res = await PineStream.open({
    source: job.source,
    tickerId: job.symbol,
    timeframe: pineTf,
    limit: entry.bars.length,
    symbolInfo: symbolInfoFor(job.symbol, job.symbol_info),
    fetchBars: chartProvider(job.symbol, job.timeframe, () => entry.bars),
    timeoutMs: job.timeout_ms || config.liveRunTimeoutMs,
    memoryMb: config.isolateMemoryMb,
    maxPlotPoints: 400,
    maxSeriesBars: Number.isFinite(job.max_series_bars) && job.max_series_bars > 0 ? job.max_series_bars : config.liveWarmupBars,
    inputs: job.inputs || null,
  });
  if (!res.ok) return { ok: false, status: 400, detail: liveError(res) };
  entry.stream = res.stream;
  streams.set(job.key, entry);
  return { ok: true, live: liveFields(res), heap_mb: res.stream.heapMb() };
}

async function streamUpdate(job) {
  const entry = streams.get(job.key);
  if (!entry || !entry.stream.alive) {
    closeStream(job.key);
    return { ok: false, status: 409, stream_missing: true, detail: 'stream is not open' };
  }
  for (const b of job.bars || []) mergeBar(entry.bars, b, STREAM_BAR_CAP);
  const res = await entry.stream.update({
    newBar: !!job.new_bar,
    maxSeriesBars: Number.isFinite(job.max_series_bars) && job.max_series_bars > 0 ? job.max_series_bars : 2,
    maxClosedTrades: STREAM_UPDATE_CLOSED_TRADES,
    timeoutMs: job.timeout_ms || config.liveRunTimeoutMs,
  });
  if (!res.ok) {
    // The stream is disposed on any failure: its state is not trustworthy
    // after a bar that threw halfway. The manager reopens it from history.
    closeStream(job.key);
    return { ok: false, status: 400, stream_lost: true, detail: liveError(res) };
  }
  return { ok: true, live: liveFields(res), heap_mb: entry.stream.heapMb() };
}

const HANDLERS = {
  compile,
  backtest,
  live_run: liveRun,
  stream_open: streamOpen,
  stream_update: streamUpdate,
  stream_close: async (job) => { closeStream(job.key); return { ok: true }; },
};

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
    const handler = HANDLERS[job.type] || backtest;
    reply = await handler(job);
  } catch (err) {
    reply = { ok: false, status: 500, detail: `worker failure: ${String(err?.message || err).slice(0, 300)}` };
  }
  if (process.connected) process.send({ id: job.id, ...reply }, () => {});
});

process.on('disconnect', async () => {
  for (const key of [...streams.keys()]) closeStream(key);
  await warehouse.close();
  process.exitCode = 0;
});

if (process.connected) process.send({ ready: true }, () => {});
