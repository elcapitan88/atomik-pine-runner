import { describe, it, expect } from 'vitest';
import { runPine } from '../src/sandbox.mjs';
import { fetchBars, symbolInfo, SCRIPTS, BASE_1M } from './synthetic.mjs';

const run = (source, extra = {}) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: 2000, symbolInfo, fetchBars, timeoutMs: 30_000, memoryMb: 128, ...extra });

describe('sandbox runs PineTS', () => {
  it('strategy: trades, plots, shapes', async () => {
    const r = await run(SCRIPTS.ema_cross_strategy);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('strategy');
    expect(r.title).toBe('EMA cross');
    expect(r.strategy.closedtrades.length).toBeGreaterThan(0);
    expect(r.plots.fast.points.length).toBeGreaterThan(100);
    expect(r.shapes.length).toBeGreaterThan(0);
    expect(r.shapes[0]).toMatchObject({ dir: 'up', title: 'Buy' });
    expect(Number.isFinite(r.shapes[0].price)).toBe(true);
  });

  it('short strategy has negative size', async () => {
    const r = await run(SCRIPTS.short_strategy);
    expect(r.ok).toBe(true);
    expect(r.strategy.closedtrades.some((t) => t.size < 0)).toBe(true);
  });

  it('request.security through the host provider', async () => {
    const r = await run(SCRIPTS.mtf_security);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('indicator');
    expect(r.plots.h1.points.length).toBeGreaterThan(100);
    expect(r.plots.h4.points.length).toBeGreaterThan(100);
  });

  it('boxes come back with times', async () => {
    const r = await run(SCRIPTS.fvg_boxes);
    expect(r.ok).toBe(true);
    expect(r.drawings.boxes.length).toBe(50);
    const b = r.drawings.boxes[0];
    expect(b.t1).toBeGreaterThan(1e12);
    expect(b.t2).toBeGreaterThan(b.t1);
  });

  it('lines and labels come back', async () => {
    const r = await run(SCRIPTS.levels);
    expect(r.ok).toBe(true);
    expect(r.drawings.lines.length).toBe(1);
    expect(r.drawings.labels[0].text).toBe('PDH');
  });

  it('v6 types, maps, while', async () => {
    const r = await run(SCRIPTS.v6_types_maps_while);
    expect(r.ok).toBe(true);
  });

  it('plot downsampling respects maxPlotPoints', async () => {
    const r = await run(SCRIPTS.ema_cross_strategy, { maxPlotPoints: 100 });
    expect(r.plots.fast.points.length).toBeLessThanOrEqual(101);
  });
});

describe('sandbox holds', () => {
  it('process.env is not readable', async () => {
    const r = await run(SCRIPTS.probe_env_read, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/process is not defined/);
  });

  it('no Node or web globals', async () => {
    const r = await run(SCRIPTS.probe_js_mode, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.probe).toBe('undefined,undefined,undefined,undefined,undefined');
  });

  it('raw JS infinite loop is stopped', async () => {
    const r = await run(SCRIPTS.probe_js_infinite_loop, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBeLessThan(8000);
  });

  it('Pine nested loops hit the wall clock', async () => {
    const r = await run(SCRIPTS.probe_pine_nested_loops, { timeoutMs: 3000 });
    expect(r.reason).toBe('timeout');
    expect(r.ms).toBeLessThan(6000);
  });

  it('memory bomb is contained', async () => {
    const r = await run(SCRIPTS.probe_memory_bomb, { timeoutMs: 5000, memoryMb: 64 });
    expect(r.ok).toBe(false);
  });

  it('data errors are reported as data, not script errors', async () => {
    const r = await run(SCRIPTS.ema_cross_strategy, { fetchBars: async () => { throw new Error('db down'); } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('data');
    expect(r.error).toBe('db down');
  });

  it('syntax errors carry the line', async () => {
    const r = await run(SCRIPTS.bad_syntax, { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at 3:/);
  });

  it('host healthy after probes; throughput', async () => {
    const t0 = performance.now();
    const r = await runPine({ source: SCRIPTS.ema_cross_strategy, tickerId: 'NQ', timeframe: '1', limit: BASE_1M.length, symbolInfo, fetchBars, timeoutMs: 60_000, memoryMb: 256 });
    expect(r.ok).toBe(true);
    expect(r.bars).toBe(BASE_1M.length);
    expect(performance.now() - t0).toBeLessThan(20_000);
  });
});
