import { describe, it, expect } from 'vitest';
import { diffLedger, newLedgerState, liveSnapshot, entryKey } from '../src/live/signals.mjs';
import { ExecutionClient } from '../src/live/execution.mjs';

const CTX = { strategyName: 'My Strat (pine #9)', symbol: 'NQ', mintick: 0.25 };
const T = 1_790_000_000_000;
const open = (id, size, entry, extra = {}) => ({ id, entry_id: 'L', entry_price: entry, entry_time: T, size, ...extra });
const closed = (id, size, entry, exit, extra = {}) => ({ id, entry_id: 'L', entry_price: entry, exit_price: exit, entry_time: T, exit_time: T + 60_000, size, exit_id: 'LX', exit_comment: null, ...extra });
const empty = { opentrades: [], closedtrades: [], pending_orders: [] };
const baseline = () => { const st = newLedgerState(); diffLedger(st, empty, CTX); return st; };

describe('diffLedger', () => {
  it('first ledger is a baseline: nothing is signalled, even open trades', () => {
    const st = newLedgerState();
    const { signals } = diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [closed('t0', 1, 90, 95)], pending_orders: [] }, CTX);
    expect(signals).toEqual([]);
    expect(st.baselined).toBe(true);
    expect(st.live.size).toBe(0);
  });

  it('a newly open long is a BUY with the bracket from pending exit orders (ticks -> prices)', () => {
    const st = baseline();
    const { signals } = diffLedger(st, {
      opentrades: [open('t1', 2, 20000)],
      closedtrades: [],
      pending_orders: [{ id: 'LX', category: 'exit', from_entry: 'L', profit: 80, loss: 40, type: 'market', status: 'pending' }],
    }, CTX);
    expect(signals.length).toBe(1);
    expect(signals[0]).toMatchObject({ action: 'BUY', comment: 'L', stop_loss: 20000 - 40 * 0.25, take_profit: 20000 + 80 * 0.25 });
    expect(signals[0].signal_id).toHaveLength(32);
    expect(liveSnapshot(st)[entryKey(open('t1', 2, 20000))]).toMatchObject({ action: 'BUY', stop_loss: 19990, take_profit: 20020 });
  });

  it('absolute stop/limit on the exit order win over ticks; short entries are SELL', () => {
    const st = baseline();
    const { signals } = diffLedger(st, {
      opentrades: [open('t1', -1, 20000, { entry_id: 'S' })],
      closedtrades: [],
      pending_orders: [{ id: 'SX', category: 'exit', from_entry: 'S', stop: 20050, limit: 19900, status: 'pending' }],
    }, CTX);
    expect(signals[0]).toMatchObject({ action: 'SELL', comment: 'S', stop_loss: 20050, take_profit: 19900 });
  });

  it('a close of a trade we entered is an EXIT with the reason inferred from the exit price', () => {
    const st = baseline();
    diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [{ id: 'LX', category: 'exit', from_entry: 'L', loss: 10, profit: 20 }] }, CTX);
    // closed by the stop (exit price at the stop level) -> still an EXIT (the
    // backend no-ops if a native bracket already flattened the account)
    let r = diffLedger(st, { opentrades: [], closedtrades: [closed('t1', 1, 100, 97.5)], pending_orders: [] }, CTX);
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]).toMatchObject({ action: 'EXIT', comment: 'EXIT_FINAL', exit_reason: 'stop_loss', exit_price: 97.5 });
    expect(st.live.size).toBe(0);

    // a second trade closed by strategy.close -> strategy_exit, comment carried as note
    diffLedger(st, { opentrades: [open('t2', 1, 100, { entry_time: T + 120_000 })], closedtrades: [closed('t1', 1, 100, 97.5)], pending_orders: [] }, CTX);
    r = diffLedger(st, { opentrades: [], closedtrades: [closed('t1', 1, 100, 97.5), closed('t2', 1, 100, 104, { entry_time: T + 120_000, exit_time: T + 300_000, exit_id: 'close_L', exit_comment: 'flat' })], pending_orders: [] }, CTX);
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]).toMatchObject({ action: 'EXIT', comment: 'EXIT_FINAL', exit_reason: 'strategy_exit', note: 'flat' });
  });

  it('a reversal comes out as EXIT then the new entry', () => {
    const st = baseline();
    diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [] }, CTX);
    const { signals } = diffLedger(st, { opentrades: [open('t2', -1, 101, { entry_id: 'S', entry_time: T + 60_000 })], closedtrades: [closed('t1', 1, 100, 101, { exit_id: 'close_L' })], pending_orders: [] }, CTX);
    expect(signals.map((x) => x.action)).toEqual(['EXIT', 'SELL']);
  });

  it('a partial close is EXIT_{pct}; the remainder stays live', () => {
    const st = baseline();
    diffLedger(st, { opentrades: [open('t1', 4, 100)], closedtrades: [], pending_orders: [] }, CTX);
    let r = diffLedger(st, { opentrades: [open('t1', 2, 100)], closedtrades: [closed('t3', 2, 100, 103, { exit_id: 'close_L' })], pending_orders: [] }, CTX);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({ action: 'EXIT', comment: 'EXIT_50' });
    expect(st.live.size).toBe(1);
    r = diffLedger(st, { opentrades: [], closedtrades: [closed('t3', 2, 100, 103, { exit_id: 'close_L' }), closed('t4', 2, 100, 105, { exit_id: 'close_L', exit_time: T + 90_000 })], pending_orders: [] }, CTX);
    expect(r.signals[0]).toMatchObject({ action: 'EXIT', comment: 'EXIT_FINAL' });
    expect(st.live.size).toBe(0);
  });

  it('identity survives PineTS renumbering trade ids when the history window slides', () => {
    const st = baseline();
    diffLedger(st, { opentrades: [open('trade_57', 1, 100)], closedtrades: [], pending_orders: [] }, CTX);
    // next run: an old trade dropped off the front, so ours is now trade_56
    const r = diffLedger(st, { opentrades: [open('trade_56', 1, 100)], closedtrades: [], pending_orders: [] }, CTX);
    expect(r.signals).toEqual([]);
    expect(st.live.size).toBe(1);
  });

  it('a historical position closing is NOT exited (we never entered it); repeats are idempotent', () => {
    const st = newLedgerState();
    diffLedger(st, { opentrades: [open('h1', 1, 100)], closedtrades: [], pending_orders: [] }, CTX);
    let r = diffLedger(st, { opentrades: [], closedtrades: [closed('h1', 1, 100, 105)], pending_orders: [] }, CTX);
    expect(r.signals).toEqual([]);
    diffLedger(st, { opentrades: [open('t1', 1, 100, { entry_time: T + 60_000 })], closedtrades: [closed('h1', 1, 100, 105)], pending_orders: [] }, CTX);
    r = diffLedger(st, { opentrades: [open('t1', 1, 100, { entry_time: T + 60_000 })], closedtrades: [closed('h1', 1, 100, 105)], pending_orders: [] }, CTX);
    expect(r.signals).toEqual([]); // same ledger again -> nothing new
  });

  it('a bracket that moves on a closed bar is an amend; intrabar runs never amend', () => {
    const st = baseline();
    diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [{ id: 'LX', category: 'exit', from_entry: 'L', stop: 95, status: 'pending' }] }, CTX);
    let r = diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [{ id: 'LX', category: 'exit', from_entry: 'L', stop: 97, status: 'pending' }] }, CTX, { full: false });
    expect(r.amends).toEqual([]);
    r = diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [{ id: 'LX', category: 'exit', from_entry: 'L', stop: 97, status: 'pending' }] }, CTX);
    expect(r.amends).toEqual([{ trade_key: entryKey(open('t1', 1, 100)), stop_loss: 97, take_profit: null }]);
    r = diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [{ id: 'LX', category: 'exit', from_entry: 'L', stop: 97, status: 'pending' }] }, CTX);
    expect(r.amends).toEqual([]); // unchanged
  });

  it('a held position the script forgot (window recompute) is exited on a closed-bar run only', () => {
    const st = baseline();
    diffLedger(st, { opentrades: [open('t1', 1, 100)], closedtrades: [], pending_orders: [] }, CTX);
    let r = diffLedger(st, empty, CTX, { full: false });
    expect(r.signals).toEqual([]);
    r = diffLedger(st, empty, CTX);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({ action: 'EXIT', comment: 'EXIT_FINAL', note: 'ledger_desync' });
    expect(st.live.size).toBe(0);
  });

  it('a closed-history run cannot desync a position that filled on the forming bar it did not include', () => {
    const st = baseline();
    // boundary run: history up to T, forming bar T+5m -> fill at T+5m open
    diffLedger(st, { opentrades: [open('t1', 1, 100, { entry_time: T + 300_000 })], closedtrades: [], pending_orders: [], lastTime: T + 300_000 }, CTX);
    // follow-up full run over the closed history only (last bar T): the trade is not there yet
    let r = diffLedger(st, { ...empty, lastTime: T }, CTX);
    expect(r.signals).toEqual([]);
    expect(st.live.size).toBe(1);
    // a later full run that INCLUDES that bar and still lacks the trade -> desync exit
    r = diffLedger(st, { ...empty, lastTime: T + 600_000 }, CTX);
    expect(r.signals.map((x) => x.note)).toEqual(['ledger_desync']);
  });

  it('positions restored from a previous process are kept when still open, exited when not', () => {
    const k1 = entryKey(open('a', 1, 100));
    const k2 = entryKey(open('b', -1, 200, { entry_id: 'S', entry_time: T - 60_000 }));
    const st = newLedgerState({ [k1]: { action: 'BUY', entry_price: 100 }, [k2]: { action: 'SELL', entry_price: 200 } });
    const { signals } = diffLedger(st, { opentrades: [open('trade_3', 1, 100)], closedtrades: [], pending_orders: [] }, CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ action: 'EXIT', note: 'restart_reconcile', trade_key: k2 });
    expect([...st.live.keys()]).toEqual([k1]);
    // ...and its later close is still signalled
    const r = diffLedger(st, { opentrades: [], closedtrades: [closed('trade_3', 1, 100, 101, { exit_id: 'close_L' })], pending_orders: [] }, CTX);
    expect(r.signals[0]).toMatchObject({ action: 'EXIT', trade_key: k1 });
  });
});

describe('ExecutionClient', () => {
  const mk = (responses) => {
    const calls = [];
    const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); const r = responses.shift(); if (r instanceof Error) throw r; return { status: r.status, json: async () => r.body }; };
    const c = new ExecutionClient({ backendUrl: 'http://b', apiKey: 'k', log: { info() {}, error() {} }, fetchImpl, sleep: async () => {} });
    return { c, calls };
  };

  it('posts the engine-shaped payload and reports success', async () => {
    const { c, calls } = mk([{ status: 200, body: { success: true } }]);
    const r = await c.send({ action: 'BUY', comment: 'L', signal_id: 'abc', stop_loss: 1, take_profit: 2, trade_key: 'L|1|1', entry_price: 100 }, { strategyName: 'X (pine #1)', symbol: 'NQ' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('http://b/api/v1/trades/execute');
    expect(calls[0].body).toMatchObject({ strategy_name: 'X (pine #1)', symbol: 'NQ', action: 'BUY', comment: 'L', signal_id: 'abc', stop_loss: 1, take_profit: 2 });
    expect(calls[0].body.context).toMatchObject({ source: 'pinets', trade_key: 'L|1|1', pine_entry_price: 100 });
    expect(c.stats.sent).toBe(1);
  });

  it('retries transport errors with the same signal_id; gives up on 4xx', async () => {
    const { c, calls } = mk([new Error('down'), { status: 200, body: {} }]);
    const r = await c.send({ action: 'EXIT', comment: 'EXIT_FINAL', signal_id: 'e1' }, { strategyName: 'X', symbol: 'NQ' });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(calls.map((x) => x.body.signal_id)).toEqual(['e1', 'e1']);

    const bad = mk([{ status: 400, body: { detail: 'no' } }]);
    const r2 = await bad.c.send({ action: 'BUY', signal_id: 'b1' }, { strategyName: 'X', symbol: 'NQ' });
    expect(r2.ok).toBe(false);
    expect(r2.attempts).toBe(1);
    expect(bad.c.stats.failed).toBe(1);
  });

  it('amend posts to /bracket/amend once', async () => {
    const { c, calls } = mk([{ status: 200, body: { amended: 1 } }]);
    const r = await c.amend({ stop_loss: 97, take_profit: null }, { strategyName: 'X', symbol: 'NQ' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('http://b/api/v1/trades/bracket/amend');
    expect(calls[0].body).toEqual({ strategy_name: 'X', symbol: 'NQ', stop_loss: 97 });
    expect(c.stats.amended).toBe(1);
  });
});
