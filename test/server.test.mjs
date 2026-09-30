// End-to-end HTTP contract: the real server + worker pool, synthetic bars.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { SCRIPTS } from './synthetic.mjs';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const KEY = 'test-key';
const BASE = `http://127.0.0.1:${PORT}`;
let server;

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        const j = await r.json();
        if (j.pool.ready >= 1) return j;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy');
}

const post = (path, body, key = KEY) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  server = spawn(process.execPath, ['--no-node-snapshot', 'src/server.mjs'], {
    env: { ...process.env, PORT: String(PORT), PINE_RUNNER_KEY: KEY, PINE_SYNTHETIC_DATA: '1', PINE_WORKERS: '1', ENVIRONMENT: 'test', PINE_BACKTEST_TIMEOUT_MS: '8000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
});

describe('auth', () => {
  it('rejects a missing or wrong key', async () => {
    expect((await post('/v1/compile', { source: SCRIPTS.fvg_boxes }, null)).status).toBe(401);
    expect((await post('/v1/compile', { source: SCRIPTS.fvg_boxes }, 'nope')).status).toBe(401);
  });
});

describe('POST /v1/compile', () => {
  it('indicator', async () => {
    const r = await post('/v1/compile', { source: SCRIPTS.fvg_boxes, symbol: 'CME_MINI:NQ1!', timeframe: '5m' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, kind: 'indicator', title: 'FVG', is_automatable: false, has_drawings: true, errors: [] });
    expect(j.bars_checked).toBeGreaterThan(100);
  });
  it('strategy', async () => {
    const j = await (await post('/v1/compile', { source: SCRIPTS.ema_cross_strategy })).json();
    expect(j).toMatchObject({ ok: true, kind: 'strategy', is_automatable: true });
    expect(j.trades_in_sample).toBeGreaterThan(0);
  });
  it('syntax error with line', async () => {
    const r = await post('/v1/compile', { source: SCRIPTS.bad_syntax });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.errors[0].line).toBe(3);
    expect(j.errors[0].message).toMatch(/Unexpected token/);
  });
  it('unknown function is a runtime error', async () => {
    const j = await (await post('/v1/compile', { source: SCRIPTS.bad_function })).json();
    expect(j.ok).toBe(false);
    expect(j.errors[0].message).toMatch(/ta\.nope/);
  });
  it('refuses JS mode and missing version header', async () => {
    expect((await post('/v1/compile', { source: SCRIPTS.probe_js_mode })).status).toBe(400);
    expect((await post('/v1/compile', { source: 'plot(close)' })).status).toBe(400);
  });
  it('sandboxed: process.env read fails cleanly', async () => {
    const j = await (await post('/v1/compile', { source: SCRIPTS.probe_env_read })).json();
    expect(j.ok).toBe(false);
    expect(j.errors[0].message).toMatch(/process is not defined/);
  });
});

describe('POST /v1/backtest', () => {
  it('returns the backend BacktestResponse shape', async () => {
    const r = await post('/v1/backtest', { source: SCRIPTS.ema_cross_strategy, symbol: 'NQ', timeframe: '5m', start: '2026-06-02T00:00:00Z', end: '2026-06-20T00:00:00Z', symbol_info: { mintick: 0.25, pointvalue: 20 } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.kind).toBe('strategy');
    expect(j.bars_processed).toBeGreaterThan(1000);
    expect(j.metrics.total_trades).toBeGreaterThan(0);
    expect(j.trades[0]).toHaveProperty('entry_time');
    expect(j.trades[0].entry_time).toMatch(/^2026-06/);
    expect(j.equity_curve.length).toBe(j.trades.length);
    expect(j.chart.plots[0].name).toBe('fast');
    expect(j.chart.markers.length).toBeGreaterThan(0);
    expect(j.fill_fidelity).toBe('pinets_bar_emulator');
    expect(j.custom_metrics.runtime).toBe('pinets');
  });
  it('request.security works with a partial symbol_info', async () => {
    const source = SCRIPTS.ema_cross_strategy.replace('plot(f, "fast")', 'plot(request.security(syminfo.tickerid, "60", ta.ema(close, 20)), "h1")');
    const r = await post('/v1/backtest', { source, symbol: 'NQ', timeframe: '5m', start: '2026-06-02', end: '2026-06-16', symbol_info: { mintick: 0.25, pointvalue: 20 } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.chart.plots.find((p) => p.name === 'h1').data.length).toBeGreaterThan(100);
  });
  it('indicator is not backtestable', async () => {
    const r = await post('/v1/backtest', { source: SCRIPTS.fvg_boxes, symbol: 'NQ', timeframe: '5m', start: '2026-06-02', end: '2026-06-10' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/indicator/);
  });
  it('validates symbol, timeframe, dates', async () => {
    expect((await post('/v1/backtest', { source: SCRIPTS.ema_cross_strategy, symbol: 'NQ 1', timeframe: '5m', start: '2026-06-02', end: '2026-06-10' })).status).toBe(400);
    expect((await post('/v1/backtest', { source: SCRIPTS.ema_cross_strategy, symbol: 'NQ', timeframe: '7m', start: '2026-06-02', end: '2026-06-10' })).status).toBe(400);
    expect((await post('/v1/backtest', { source: SCRIPTS.ema_cross_strategy, symbol: 'NQ', timeframe: '5m', start: '2026-06-10', end: '2026-06-02' })).status).toBe(400);
  });
  it('no data in range', async () => {
    const r = await post('/v1/backtest', { source: SCRIPTS.ema_cross_strategy, symbol: 'NQ', timeframe: '5m', start: '2020-01-01', end: '2020-01-05' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/No historical data/);
  });
  it('script runtime error is a 400 with the message', async () => {
    const r = await post('/v1/backtest', { source: SCRIPTS.bad_function.replace('indicator("x")', 'strategy("x")'), symbol: 'NQ', timeframe: '5m', start: '2026-06-02', end: '2026-06-10' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/ta\.nope/);
  });
  it('pool survives a killed worker', async () => {
    const r = await post('/v1/backtest', { source: SCRIPTS.probe_pine_nested_loops.replace('indicator("nested")', 'strategy("nested")'), symbol: 'NQ', timeframe: '5m', start: '2026-06-02', end: '2026-06-03' });
    expect(r.status).toBe(400);
    const ok = await post('/v1/compile', { source: SCRIPTS.fvg_boxes });
    expect(ok.status).toBe(200);
  }, 60_000);
});
