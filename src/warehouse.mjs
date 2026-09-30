// Read-only access to the TimescaleDB bar warehouse (the same one the backend's
// backtests and atomik-research read). Mirrors atomik-research's
// research/engine/warehouse.py: 1m from the `bars` hypertable, 5m/15m/30m/1h/1d
// from continuous aggregates, everything else bucketed from 1m at query time.
import pg from 'pg';
import { atomikToSeconds } from './timeframes.mjs';

const { Pool } = pg;

const RELATIONS = {
  '1m': ['bars', 'ts'],
  '5m': ['bars_5m', 'bucket'],
  '15m': ['bars_15m', 'bucket'],
  '30m': ['bars_30m', 'bucket'],
  '1h': ['bars_1h', 'bucket'],
  '1d': ['bars_1d', 'bucket'],
};

let pool = null;

export function connect(url) {
  if (!url) return null;
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000, statement_timeout: 60_000 });
    pool.on('error', (err) => console.error('warehouse pool error', err.message));
  }
  return pool;
}

export async function close() {
  if (pool) await pool.end();
  pool = null;
}

export class WarehouseUnavailable extends Error {}
export class TimeframeUnsupported extends Error {}

/**
 * Bars for [startMs, endMs) as PineTS Klines (openTime/closeTime in ms, ascending).
 * @param {string} symbol   warehouse root, e.g. 'NQ'
 * @param {string} timeframe Atomik timeframe, e.g. '5m'
 */
export async function getBars(symbol, timeframe, startMs, endMs, limit = null) {
  if (!pool) throw new WarehouseUnavailable('TIMESCALE_URL is not configured');
  const seconds = atomikToSeconds(timeframe);
  if (!seconds) throw new TimeframeUnsupported(`timeframe ${timeframe} is not served by the warehouse`);

  const start = new Date(startMs);
  const end = new Date(endMs);
  let sql;
  let params;
  if (RELATIONS[timeframe]) {
    const [table, col] = RELATIONS[timeframe];
    sql = `SELECT extract(epoch FROM ${col}) * 1000 AS t, open, high, low, close, volume
           FROM ${table} WHERE symbol = $1 AND ${col} >= $2 AND ${col} < $3 ORDER BY 1 ASC`;
    params = [symbol, start, end];
  } else {
    sql = `SELECT extract(epoch FROM time_bucket(make_interval(secs => $4), ts)) * 1000 AS t,
                  first(open, ts) AS open, max(high) AS high, min(low) AS low,
                  last(close, ts) AS close, sum(volume) AS volume
           FROM bars WHERE symbol = $1 AND ts >= $2 AND ts < $3
           GROUP BY 1 ORDER BY 1 ASC`;
    params = [symbol, start, end, seconds];
  }
  if (limit && limit > 0) {
    // Newest `limit` bars, still returned ascending.
    sql = `SELECT * FROM (${sql.replace('ORDER BY 1 ASC', 'ORDER BY 1 DESC')} LIMIT ${Number(limit)}) q ORDER BY t ASC`;
  }

  let rows;
  try {
    ({ rows } = await pool.query(sql, params));
  } catch (err) {
    throw new WarehouseUnavailable(`warehouse read failed for ${symbol} ${timeframe}: ${err.message}`);
  }
  const span = seconds * 1000;
  return rows.map((r) => {
    const t = Number(r.t);
    return {
      openTime: t,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
      closeTime: t + span - 1,
    };
  });
}

const coverageCache = new Map(); // symbol -> {min, max, at}

/** First/last 1m bar timestamps (ms) the warehouse holds for a root, cached 5 min. */
export async function coverage(symbol) {
  if (!pool) throw new WarehouseUnavailable('TIMESCALE_URL is not configured');
  const hit = coverageCache.get(symbol);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  let rows;
  try {
    ({ rows } = await pool.query(
      'SELECT extract(epoch FROM min(ts)) * 1000 AS mn, extract(epoch FROM max(ts)) * 1000 AS mx FROM bars WHERE symbol = $1',
      [symbol],
    ));
  } catch (err) {
    throw new WarehouseUnavailable(`warehouse coverage failed for ${symbol}: ${err.message}`);
  }
  const row = rows[0] || {};
  const out = { min: row.mn == null ? null : Number(row.mn), max: row.mx == null ? null : Number(row.mx), at: Date.now() };
  coverageCache.set(symbol, out);
  return out;
}

export async function ping() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
