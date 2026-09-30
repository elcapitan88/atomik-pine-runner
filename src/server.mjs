// HTTP API used by the Atomik backend (private network only).
//   GET  /health
//   POST /v1/compile   {source, symbol?, timeframe?, symbol_info?}
//   POST /v1/backtest  {source, symbol, timeframe, start, end, symbol_info?}
import Fastify from 'fastify';
import { config } from './config.mjs';
import { requireServiceKey } from './auth.mjs';
import { WorkerPool } from './pool.mjs';
import { SUPPORTED_TIMEFRAMES } from './timeframes.mjs';
import { tickerToRoot } from './symbols.mjs';
import * as warehouse from './warehouse.mjs';

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const pool = new WorkerPool({ size: config.workerCount, log: app.log });
warehouse.connect(config.timescaleUrl);

app.get('/health', async () => ({
  ok: true,
  runtime: 'pinets',
  warehouse: await warehouse.ping(),
  pool: pool.stats,
}));

function checkSource(source) {
  if (typeof source !== 'string' || !source.trim()) return 'source is required';
  if (Buffer.byteLength(source) > config.maxSourceBytes) return `source exceeds ${config.maxSourceBytes} bytes`;
  if (/^\s*\/\/@PineTS\b/m.test(source)) return 'PineTS JavaScript mode is not accepted; submit Pine Script with a //@version header';
  if (!/^\s*\/\/@version\s*=\s*[56]\b/m.test(source)) return 'Pine Script must start with //@version=5 or //@version=6';
  return null;
}

app.register(async (v1) => {
  v1.addHook('onRequest', requireServiceKey);

  v1.post('/compile', async (req, reply) => {
    const body = req.body || {};
    const bad = checkSource(body.source);
    if (bad) return reply.code(400).send({ detail: bad });
    const symbol = body.symbol ? tickerToRoot(body.symbol) : null;
    if (body.symbol && !symbol) return reply.code(400).send({ detail: `Unknown symbol '${body.symbol}'` });
    if (body.timeframe && !SUPPORTED_TIMEFRAMES.includes(body.timeframe)) return reply.code(400).send({ detail: `Unsupported timeframe '${body.timeframe}'` });
    const res = await pool.run({ type: 'compile', source: body.source, symbol, timeframe: body.timeframe || null, symbol_info: body.symbol_info || null }, { timeoutMs: config.compileTimeoutMs });
    if (!res.ok) return reply.code(res.status || 500).send({ detail: res.detail });
    return res.compile;
  });

  v1.post('/backtest', async (req, reply) => {
    const body = req.body || {};
    const bad = checkSource(body.source);
    if (bad) return reply.code(400).send({ detail: bad });
    const symbol = tickerToRoot(body.symbol);
    if (!symbol) return reply.code(400).send({ detail: `Unknown symbol '${body.symbol}'` });
    if (!SUPPORTED_TIMEFRAMES.includes(body.timeframe)) return reply.code(400).send({ detail: `Unsupported timeframe '${body.timeframe}'. Available: ${SUPPORTED_TIMEFRAMES.join(', ')}` });
    const start = Date.parse(body.start);
    const end = Date.parse(body.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return reply.code(400).send({ detail: 'start and end must be ISO timestamps with end after start' });
    const res = await pool.run({ type: 'backtest', source: body.source, symbol, timeframe: body.timeframe, start_ms: start, end_ms: end, symbol_info: body.symbol_info || null }, { timeoutMs: config.backtestTimeoutMs });
    if (!res.ok) return reply.code(res.status || 500).send({ detail: res.detail, line: res.line ?? null });
    if (res.backtest.bars_processed === 0) return reply.code(400).send({ detail: `No historical data for ${symbol} ${body.timeframe} between ${body.start} and ${body.end}.` });
    return res.backtest;
  });
}, { prefix: '/v1' });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal}: shutting down`);
  await app.close();
  await pool.close();
  await warehouse.close();
  // No process.exit(): let killed isolates finish tearing down (a hard exit
  // while they do segfaults on Linux).
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exitCode = 1;
});
