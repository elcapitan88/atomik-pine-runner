// Turns PineTS's simulated ledger into Atomik trade signals.
//
// The runner re-runs a strategy from history on every bar (and on the
// forming bar every few seconds), so each run hands back a fresh ledger:
// open trades, closed trades, pending orders. Live signals are the DIFF
// between consecutive ledgers:
//
//   * A trade is signalled when it APPEARS open (its entry filled). Market
//     entries fill at the next bar's open in Pine, which the first intrabar
//     run of that bar sees within seconds; stop/limit entries fill intrabar
//     when price crosses, which the same runs catch.
//   * A trade WE entered is exited when it shows up closed. This is sent even
//     when Pine says its own stop/target closed it: if the broker holds a
//     native bracket the backend finds the account flat and does nothing, and
//     if it holds none the EXIT is what gets the trader flat.
//   * Nothing from before the session started is ever signalled: the first
//     ledger is the baseline. A position Pine "holds" from history is not a
//     position on the account.
//
// Trades are identified by their ENTRY (id, fill time, direction), never by
// PineTS's `trade_N` ids: those are ordinals over the ledger, and the history
// window slides one bar per close, so an old trade dropping off the front
// would renumber every later one.
//
// Quantity is never sent — the backend uses each activation's quantity. A
// reversal comes out as EXIT then the new entry (the backend refuses entries
// against an open position). A partial close (qty_percent) is EXIT_{pct}.
import { createHash } from 'node:crypto';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const dirOf = (t) => ((t.size ?? 0) < 0 ? -1 : 1);

export const entryKey = (t) => `${t.entry_id}|${t.entry_time}|${dirOf(t)}`;
const closedKey = (t) => `${entryKey(t)}|${t.exit_time}|${t.exit_id || ''}|${Math.abs(t.size ?? 0)}`;

/** @param {object|null} restoredLive  positions persisted by a previous process ({key: pos}) */
export function newLedgerState(restoredLive = null) {
  return {
    baselined: false,
    known: new Set(),        // entry keys ever seen (open or closed)
    closedSeen: new Set(),   // closed-record keys already handled
    live: new Map(restoredLive ? Object.entries(restoredLive) : []), // entry key -> position we opened
  };
}

export const liveSnapshot = (state) => Object.fromEntries(state.live);

/**
 * Does this ledger need re-runs INSIDE the bar? Pine evaluates a script once
 * per bar close (unless calc_on_every_tick), and market entries fill at the
 * next open, which the boundary run sees. Only resting stop/limit ENTRY orders
 * and trailing exits can fill mid-bar (the broker holds the plain brackets).
 */
export function needsIntrabar(strategy) {
  if (!strategy) return false;
  if (strategy.config?.calc_on_every_tick) return true;
  for (const o of strategy.pending_orders || []) {
    if (o.status && o.status !== 'pending') continue;
    if (o.category === 'entry' && o.type && o.type !== 'market') return true;
    if (o.category === 'exit' && (num(o.trail_price) || num(o.trail_points) || num(o.trail_offset))) return true;
  }
  return false;
}

function signalId(strategyName, symbol, kind, key) {
  return createHash('sha1').update(`${strategyName}|${symbol}|${kind}|${key}`).digest('hex').slice(0, 32);
}

/** Absolute stop/target for an entry from the ledger's pending exit orders. */
function bracketFor(trade, pendingOrders, mintick) {
  const dir = dirOf(trade);
  let stop = null;
  let target = null;
  for (const o of pendingOrders || []) {
    if (o.category !== 'exit' || (o.status && o.status !== 'pending')) continue;
    if (o.from_entry && o.from_entry !== trade.entry_id) continue;
    if (num(o.stop)) stop = o.stop;
    else if (num(o.loss) && num(mintick)) stop = trade.entry_price - dir * o.loss * mintick;
    if (num(o.limit)) target = o.limit;
    else if (num(o.profit) && num(mintick)) target = trade.entry_price + dir * o.profit * mintick;
  }
  const valid = (p) => num(p) && p > 0;
  return { stop_loss: valid(stop) ? stop : null, take_profit: valid(target) ? target : null };
}

function exitReason(t, pos) {
  if (/^close/i.test(String(t.exit_id || ''))) return 'strategy_exit';
  const ep = t.exit_price;
  if (!num(ep)) return 'strategy_exit';
  const ds = num(pos?.stop_loss) ? Math.abs(ep - pos.stop_loss) : Infinity;
  const dt = num(pos?.take_profit) ? Math.abs(ep - pos.take_profit) : Infinity;
  if (ds === Infinity && dt === Infinity) return 'strategy_exit';
  return ds <= dt ? 'stop_loss' : 'take_profit';
}

function exitSignal(ctx, key, pos, { comment = 'EXIT_FINAL', reason, idKey, note = null, exit_price = null }) {
  return {
    action: 'EXIT', comment, exit_reason: reason, trade_key: key,
    signal_id: signalId(ctx.strategyName, ctx.symbol, 'exit', idKey), note, exit_price,
    entry_price: pos?.entry_price ?? null,
  };
}

/**
 * @param {object} state    mutable, from newLedgerState()
 * @param {object} ledger   res.strategy: {opentrades, closedtrades, pending_orders}
 * @param {object} ctx      {strategyName, symbol, mintick}
 * @param {object} opts     {full}: true for a closed-bar run (desync + bracket
 *                          checks happen only then; intrabar runs only add)
 * @returns {{signals: object[], amends: object[]}}  signals in send order (exits first)
 */
export function diffLedger(state, ledger, ctx, { full = true } = {}) {
  const open = ledger?.opentrades || [];
  const closed = ledger?.closedtrades || [];
  const pending = ledger?.pending_orders || [];
  const signals = [];
  const amends = [];
  const openByKey = new Map(open.map((t) => [entryKey(t), t]));

  if (!state.baselined) {
    for (const t of open) state.known.add(entryKey(t));
    for (const t of closed) { state.known.add(entryKey(t)); state.closedSeen.add(closedKey(t)); }
    state.baselined = true;
    // Positions carried over from a previous process: if the script no longer
    // holds one open, the account should not either.
    for (const [k, pos] of [...state.live]) {
      if (openByKey.has(k)) continue;
      state.live.delete(k);
      signals.push(exitSignal(ctx, k, pos, { reason: 'strategy_exit', idKey: `restart|${k}`, note: 'restart_reconcile' }));
    }
    return { signals, amends };
  }

  // Exits: a trade we entered that now has a closed record.
  for (const t of closed) {
    const ck = closedKey(t);
    if (state.closedSeen.has(ck)) continue;
    state.closedSeen.add(ck);
    const k = entryKey(t);
    state.known.add(k);
    const pos = state.live.get(k);
    if (!pos) continue; // historical, or never ours
    const remainder = openByKey.get(k);
    let comment = 'EXIT_FINAL';
    if (remainder) {
      const pct = Math.round((Math.abs(t.size ?? 0) / (Math.abs(t.size ?? 0) + Math.abs(remainder.size ?? 0))) * 100);
      comment = pct >= 100 || pct <= 0 ? 'EXIT_FINAL' : `EXIT_${pct}`;
    } else {
      state.live.delete(k);
    }
    signals.push(exitSignal(ctx, k, pos, { comment, reason: exitReason(t, pos), idKey: ck, note: t.exit_comment || t.exit_id || null, exit_price: t.exit_price ?? null }));
  }

  // Entries: a trade that just appeared open; bracket moves on ones we hold.
  for (const t of open) {
    const k = entryKey(t);
    const br = bracketFor(t, pending, ctx.mintick);
    const pos = state.live.get(k);
    if (pos) {
      if (full && (br.stop_loss !== pos.stop_loss || br.take_profit !== pos.take_profit)) {
        pos.stop_loss = br.stop_loss;
        pos.take_profit = br.take_profit;
        if (br.stop_loss != null || br.take_profit != null) amends.push({ trade_key: k, ...br });
      }
      continue;
    }
    if (state.known.has(k)) continue; // from before the session started
    state.known.add(k);
    const action = dirOf(t) < 0 ? 'SELL' : 'BUY';
    state.live.set(k, { action, entry_price: t.entry_price, entry_time: t.entry_time, size: t.size, ...br });
    signals.push({
      action, comment: String(t.entry_id || t.entry_comment || 'ENTRY'), trade_key: k,
      signal_id: signalId(ctx.strategyName, ctx.symbol, 'entry', k), ...br,
      entry_price: t.entry_price, entry_time: t.entry_time,
    });
  }

  // A position we hold that the script's ledger no longer knows in EITHER list
  // (a recompute over the slid history window changed its mind): the script
  // thinks it is flat, so get flat. Closed-bar runs only — and never for a
  // position that filled on a bar this run did not include (a closed-history
  // run right after a boundary run cannot see the forming bar's fill).
  if (full) {
    const lastTime = num(ledger?.lastTime) ? ledger.lastTime : null;
    for (const [k, pos] of [...state.live]) {
      if (openByKey.has(k)) continue;
      if (lastTime != null && num(pos?.entry_time) && pos.entry_time > lastTime) continue;
      state.live.delete(k);
      signals.push(exitSignal(ctx, k, pos, { reason: 'strategy_exit', idKey: `desync|${k}|${ledger?.lastTime ?? ''}`, note: 'ledger_desync' }));
    }
  }

  signals.sort((a, b) => (a.action === 'EXIT' ? 0 : 1) - (b.action === 'EXIT' ? 0 : 1));
  return { signals, amends };
}
