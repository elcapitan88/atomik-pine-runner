import { describe, it, expect } from 'vitest';
import { tradesFrom, metricsFrom, equityCurveFrom, chartFrom, toBacktestPayload } from '../src/translate.mjs';

const T0 = Date.UTC(2026, 5, 1, 14, 30);
const H = 3_600_000;
const trade = (i, entry, exit, size = 1) => ({ id: `t${i}`, entry_id: 'L', entry_price: entry, exit_price: exit, entry_time: T0 + i * 24 * H, exit_time: T0 + i * 24 * H + H, size, profit: 0, commission: 0 });

describe('trades', () => {
  it('points per contract, direction from size sign', () => {
    const r = { strategy: { closedtrades: [trade(0, 100, 110), trade(1, 100, 90, -2)] } };
    const t = tradesFrom(r);
    expect(t[0]).toMatchObject({ direction: 'long', pnl_points: 10, size: 1 });
    expect(t[1]).toMatchObject({ direction: 'short', pnl_points: 10, size: 2 });
    expect(t[0].entry_time).toBe(new Date(T0).toISOString());
  });
});

describe('metrics mirror the Python engine', () => {
  it('empty', () => {
    expect(metricsFrom([])).toMatchObject({ total_trades: 0, profit_factor: 0, sharpe_ratio: 0 });
  });
  it('win rate, profit factor, drawdown, averages', () => {
    const r = { strategy: { closedtrades: [trade(0, 100, 110), trade(1, 100, 95), trade(2, 100, 120), trade(3, 100, 90)] } };
    const t = tradesFrom(r);
    const m = metricsFrom(t);
    expect(m.total_trades).toBe(4);
    expect(m.win_rate).toBe(50);
    expect(m.profit_factor).toBe(2); // 30 / 15
    expect(m.total_pnl_points).toBe(15);
    expect(m.avg_win_points).toBe(15);
    expect(m.avg_loss_points).toBe(-7.5);
    // cum: 10, 5, 25, 15 -> peak 25, trough 15 -> dd 10
    expect(m.max_drawdown_points).toBe(10);
    expect(m.sharpe_ratio).not.toBe(0);
  });
  it('profit factor Infinity with no losers', () => {
    const t = tradesFrom({ strategy: { closedtrades: [trade(0, 100, 110)] } });
    expect(metricsFrom(t).profit_factor).toBe(Infinity);
  });
  it('sharpe is 0 with fewer than two trading days', () => {
    const same = [trade(0, 100, 110), { ...trade(0, 100, 105), id: 'x' }];
    expect(metricsFrom(tradesFrom({ strategy: { closedtrades: same } })).sharpe_ratio).toBe(0);
  });
});

describe('equity curve + chart', () => {
  it('cumulative pnl at exit times', () => {
    const t = tradesFrom({ strategy: { closedtrades: [trade(0, 100, 110), trade(1, 100, 95)] } });
    expect(equityCurveFrom(t)).toEqual([
      { timestamp: t[0].exit_time, cumulative_pnl: 10 },
      { timestamp: t[1].exit_time, cumulative_pnl: 5 },
    ]);
  });
  it('plots, markers, boxes, levels in the backend shape', () => {
    const c = chartFrom({
      plots: { fast: { color: '#FF9800FF', points: [[T0, 1.5]] } },
      shapes: [{ t: T0, price: 99, dir: 'down', text: 'S' }],
      drawings: {
        boxes: [{ id: 1, t1: T0, t2: T0 + H, top: 105, bottom: 101, color: '#4CAF5033' }],
        lines: [{ id: 2, t1: T0, t2: T0 + H, p1: 100, p2: 100, style: 'style_dashed' }, { id: 3, t1: T0, t2: T0 + H, p1: 100, p2: 101 }],
        labels: [{ id: 4, t: T0, price: 100, text: 'PDH' }],
      },
    });
    expect(c.plots[0]).toMatchObject({ name: 'fast', color: '#FF9800', data: [{ time: new Date(T0).toISOString(), value: 1.5 }] });
    expect(c.markers[0]).toMatchObject({ shape: 'arrow_down', location: 'above', price: 99 });
    expect(c.boxes[0]).toMatchObject({ price_top: 105, price_bottom: 101, color: '#4CAF50' });
    expect(c.levels).toEqual([{ id: 'line-2', label: 'PDH', price: 100, kind: 'info', style: 'dashed' }]);
  });
  it('full payload has every BacktestResponse field', () => {
    const p = toBacktestPayload({ ms: 12, bars: 3, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, strategy: { closedtrades: [], opentrades: [], pending_orders: [], netprofit: 0 }, warnings: [] });
    for (const k of ['metrics', 'equity_curve', 'trades', 'execution_time_ms', 'bars_processed', 'chart', 'strategy_errors', 'fill_fidelity', 'fills_total', 'bracket_ambiguities', 'limit_entries_placed', 'same_bar_exits_suppressed', 'custom_metrics']) {
      expect(p).toHaveProperty(k);
    }
    expect(p.custom_metrics.runtime).toBe('pinets');
  });
});
