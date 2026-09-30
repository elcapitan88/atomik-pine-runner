// Shared by the streaming parity tests: feed a PineStream bar by bar (a few
// partial ticks per bar, then the final bar), then run the same bars one-shot.
import { runPine, PineStream } from '../src/sandbox.mjs';
import { barsFor, fetchBars as syntheticFetch, symbolInfo } from './synthetic.mjs';

// Provider: the chart series comes from the live array (what the session has
// seen so far); other timeframes from the synthetic warehouse, cut at the
// live edge like the real warehouse (it never holds bars from the future).
export const providerFor = (live, chartTf = '5') => async (tickerId, tf, limit, sDate, eDate) => {
  if (String(tf) !== chartTf) {
    const edge = live[live.length - 1].closeTime;
    return syntheticFetch(tickerId, tf, limit, sDate, eDate == null ? edge : Math.min(eDate, edge));
  }
  let bars = live;
  if (sDate != null) bars = bars.filter((b) => b.openTime >= sDate);
  if (eDate != null) bars = bars.filter((b) => b.openTime <= eDate);
  if (limit) bars = bars.slice(-limit);
  return bars.map((b) => ({ ...b }));
};

// Ticks inside one bar: opens flat, widens toward the final range, then the final bar.
export function ticksOf(b) {
  const mid = (b.high + b.low) / 2;
  return [
    { ...b, high: b.open, low: b.open, close: b.open, volume: 1 },
    { ...b, high: Math.max(b.open, mid), low: Math.min(b.open, mid), close: mid, volume: b.volume / 2 },
    { ...b },
  ];
}

export function upsert(live, bar) {
  const last = live[live.length - 1];
  if (last && last.openTime === bar.openTime) live[live.length - 1] = bar;
  else live.push(bar);
}

export const baseOpts = { tickerId: 'NQ', symbolInfo, timeoutMs: 60_000, memoryMb: 256, maxPlotPoints: 400 };

/**
 * @returns {{first, streamed, oneShot, times: number[], stream: PineStream|null, error?: string}}
 */
export async function streamThrough(source, { history = 1200, liveBars = 30, timeframe = '5', maxSeriesBars } = {}) {
  const all = barsFor(timeframe).slice(0, history + liveBars);
  const series = maxSeriesBars ?? history + liveBars;
  const live = all.slice(0, history).map((b) => ({ ...b }));
  const opts = { ...baseOpts, timeframe };
  const first = await PineStream.open({ ...opts, source, limit: live.length, fetchBars: providerFor(live, timeframe), maxSeriesBars: series });
  if (!first.ok) return { first, error: `open: ${first.error}` };
  const times = [];
  let last = first;
  for (const b of all.slice(history)) {
    let isNew = true;
    for (const t of ticksOf(b)) {
      upsert(live, t);
      last = await first.stream.update({ newBar: isNew, maxSeriesBars: series });
      if (!last.ok) return { first, stream: first.stream, error: `update: ${last.error}` };
      times.push(last.ms);
      isNew = false;
    }
  }
  const oneShot = await runPine({ ...opts, source, limit: live.length, fetchBars: providerFor(live, timeframe), maxSeriesBars: series });
  return { first, streamed: last, oneShot, times, stream: first.stream };
}

export const trades = (r) => (r.strategy?.closedtrades || []).map((t) => [t.entry_id, t.entry_time, t.entry_price, t.exit_id, t.exit_time, t.exit_price, t.size]);
export const opens = (r) => (r.strategy?.opentrades || []).map((t) => [t.entry_id, t.entry_time, t.entry_price, t.size]);
export const pending = (r) => (r.strategy?.pending_orders || []).map((o) => [o.id, o.category, o.type, o.limit, o.stop, o.from_entry, o.status]);
export const boxes = (r) => r.drawings.boxes.map((b) => [b.t1, b.t2, b.top, b.bottom]);
export const lines = (r) => r.drawings.lines.map((l) => [l.t1, l.t2, l.p1, l.p2]);
export const labels = (r) => r.drawings.labels.map((l) => [l.t, l.price, l.text]);
export const plotValues = (r) => (r.series?.plots || []).map((p) => [p.title, p.values]);
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
