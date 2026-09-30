// Turns a sandbox result into the payload the Atomik backend's
// /strategy-builder/backtest already returns for Python strategies
// (fastapi_backend BacktestResponse), so the Builder renders a Pine backtest
// with no new UI. Metric formulas mirror backtest_service._calculate_metrics
// so a Pine result and a Python result on the same trades read the same.

export const FILL_FIDELITY = 'pinets_bar_emulator';

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : v);

export function tradesFrom(result) {
  const closed = result.strategy?.closedtrades || [];
  return closed
    .filter((t) => Number.isFinite(t.entry_price) && Number.isFinite(t.exit_price))
    .map((t) => {
      const direction = (t.size ?? 0) < 0 ? 'short' : 'long';
      const sign = direction === 'long' ? 1 : -1;
      // Points per contract, like the Python engine. PineTS's own `profit` is
      // currency for the full size after commission; it goes to custom_metrics.
      const pnl = sign * (t.exit_price - t.entry_price);
      return {
        entry_time: iso(t.entry_time),
        exit_time: iso(t.exit_time),
        direction,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        pnl_points: round(pnl, 4),
        exit_reason: 'strategy_exit',
        exit_comment: t.exit_comment || t.exit_id || null,
        stop_price: null,
        target_price: null,
        planned_risk_points: null,
        entry_id: t.entry_id || null,
        size: Math.abs(t.size ?? 0) || null,
        commission: t.commission ?? 0,
      };
    })
    .sort((a, b) => (a.exit_time < b.exit_time ? -1 : a.exit_time > b.exit_time ? 1 : 0));
}

export function metricsFrom(trades) {
  const zero = {
    total_trades: 0, win_rate: 0, profit_factor: 0, sharpe_ratio: 0,
    total_pnl_points: 0, max_drawdown_points: 0, avg_win_points: 0, avg_loss_points: 0,
  };
  if (!trades.length) return zero;
  const winners = trades.filter((t) => t.pnl_points > 0);
  const losers = trades.filter((t) => t.pnl_points <= 0);
  const sum = (xs) => xs.reduce((a, t) => a + t.pnl_points, 0);
  const grossProfit = sum(winners);
  const grossLoss = Math.abs(sum(losers));
  let profitFactor = 0;
  if (grossLoss > 0) profitFactor = grossProfit / grossLoss;
  else if (grossProfit > 0) profitFactor = Infinity;

  // Sharpe: daily PnL grouped by exit date (UTC), sample std, annualised by sqrt(252).
  let sharpe = 0;
  if (trades.length >= 2) {
    const daily = new Map();
    for (const t of trades) {
      const day = (t.exit_time || '').slice(0, 10);
      daily.set(day, (daily.get(day) || 0) + t.pnl_points);
    }
    if (daily.size >= 2) {
      const xs = [...daily.values()];
      const n = xs.length;
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
      const std = Math.sqrt(variance);
      if (std > 0) sharpe = (mean / std) * Math.sqrt(252);
    }
  }

  let peak = 0; let maxDd = 0; let cum = 0;
  for (const t of trades) {
    cum += t.pnl_points;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }

  return {
    total_trades: trades.length,
    win_rate: round((winners.length / trades.length) * 100, 1),
    profit_factor: Number.isFinite(profitFactor) ? round(profitFactor, 2) : profitFactor,
    sharpe_ratio: round(sharpe, 2),
    total_pnl_points: round(sum(trades), 1),
    max_drawdown_points: round(maxDd, 1),
    avg_win_points: round(winners.length ? grossProfit / winners.length : 0, 1),
    avg_loss_points: round(losers.length ? sum(losers) / losers.length : 0, 1),
  };
}

export function equityCurveFrom(trades) {
  let cum = 0;
  return trades.map((t) => {
    cum += t.pnl_points;
    return { timestamp: t.exit_time, cumulative_pnl: round(cum, 2) };
  });
}

const cssColor = (c) => {
  if (typeof c !== 'string' || !c) return null;
  // PineTS emits #RRGGBBAA; the chart wants #RRGGBB (alpha handled by the renderer).
  const m = c.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  return m ? `#${m[1]}` : c;
};

export function chartFrom(result) {
  const plots = Object.entries(result.plots || {}).map(([name, p]) => ({
    name,
    pane: 'main',
    color: cssColor(p.color) || '#2962ff',
    style: 'line',
    data: (p.points || []).map(([t, v]) => ({ time: iso(t), value: v })),
  }));
  const markers = (result.shapes || []).map((s) => ({
    time: iso(s.t),
    text: s.text || '',
    price: s.price,
    shape: s.dir === 'down' ? 'arrow_down' : 'arrow_up',
    color: s.dir === 'down' ? '#ef5350' : '#26a69a',
    location: s.dir === 'down' ? 'above' : 'below',
  }));
  const boxes = (result.drawings?.boxes || [])
    .filter((b) => Number.isFinite(b.t1) && Number.isFinite(b.t2) && Number.isFinite(b.top) && Number.isFinite(b.bottom))
    .map((b) => ({
      price_top: Math.max(b.top, b.bottom),
      price_bottom: Math.min(b.top, b.bottom),
      time_start: iso(Math.min(b.t1, b.t2)),
      time_end: iso(Math.max(b.t1, b.t2)),
      color: cssColor(b.color) || '#26a69a',
      label: b.text || '',
    }));
  // Horizontal lines and priced labels become levels; sloped lines are dropped for now.
  const levels = [];
  for (const l of result.drawings?.lines || []) {
    if (Number.isFinite(l.p1) && l.p1 === l.p2) levels.push({ id: `line-${l.id}`, label: '', price: l.p1, kind: 'info', style: l.style === 'style_dashed' ? 'dashed' : l.style === 'style_dotted' ? 'dotted' : 'solid' });
  }
  for (const l of result.drawings?.labels || []) {
    if (Number.isFinite(l.price)) {
      const hit = levels.find((lv) => lv.price === l.price && !lv.label);
      if (hit) hit.label = l.text || '';
      else levels.push({ id: `label-${l.id}`, label: l.text || '', price: l.price, kind: 'info', style: 'dotted' });
    }
  }
  return { plots, markers, boxes, levels: levels.slice(0, 50) };
}

/** Full backtest payload in the backend's BacktestResponse shape. */
export function toBacktestPayload(result) {
  const trades = tradesFrom(result);
  const st = result.strategy || {};
  return {
    metrics: metricsFrom(trades),
    equity_curve: equityCurveFrom(trades),
    trades,
    execution_time_ms: result.ms,
    bars_processed: result.bars,
    chart: chartFrom(result),
    strategy_errors: 0,
    strategy_error_sample: null,
    fill_fidelity: FILL_FIDELITY,
    fills_total: 0,
    fills_resolved_1s: 0,
    fills_assumed: 0,
    fill_resolution_pct: null,
    bracket_ambiguities: 0,
    brackets_rejected: 0,
    brackets_rejected_sample: null,
    limit_entries_placed: 0,
    limit_entries_filled: 0,
    limit_entries_expired: 0,
    same_bar_exits_suppressed: 0,
    custom_metrics: {
      runtime: 'pinets',
      pinets_netprofit: st.netprofit ?? null,
      pinets_grossprofit: st.grossprofit ?? null,
      pinets_grossloss: st.grossloss ?? null,
      pinets_max_drawdown: st.max_drawdown ?? null,
      pinets_sharpe: st.sharpe_ratio ?? null,
      open_trades_at_end: (st.opentrades || []).length,
      pending_orders_at_end: (st.pending_orders || []).length,
      warnings: result.warnings || [],
    },
  };
}
