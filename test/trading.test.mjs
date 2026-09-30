// Live trading: a `kind:'trade'` session diffs the script's ledger after every
// run and sends signals (or logs them in shadow mode) through the per-session
// outbox, in order, without blocking the chart.
import { describe, it, expect } from 'vitest';
import { LiveManager } from '../src/live/manager.mjs';

const T0 = Date.UTC(2026, 8, 29, 14, 30);
const bar = (i, close = 1) => ({ openTime: T0 + i * 300_000, open: 1, high: 2, low: 0, close, volume: 1, closeTime: T0 + i * 300_000 + 299_999 });
const base = { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://backend', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000, liveIntrabarSeconds: 2, liveHeartbeatSeconds: 60, executionApiKey: 'engine-key' };
const item = (extra = {}) => ({ strategy_code_id: 9, strategy_key: 'my_strat_(pine_#9)', strategy_name: 'My Strat (pine #9)', symbol: 'NQ', timeframe: '5m', source: '//@version=6\nstrategy("x")', kind: 'trade', activations: [{ activated_strategy_id: 1, account_id: 'PAPER1', quantity: 1, is_paper: true }], symbol_info: { mintick: 0.25 }, ...extra });

function liveResult(bars, ledger) {
  return { kind: 'strategy', title: 'x', bars: bars.length, lastTime: bars.at(-1)?.openTime ?? null, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: null, strategy: ledger };
}

async function setup({ tradingEnabled, items, ledgers }) {
  const sent = [];
  const stored = {};
  const m = new LiveManager({
    config: { ...base, tradingEnabled },
    pool: { run: async (job) => ({ ok: true, live: liveResult(job.bars, ledgers.shift() || { opentrades: [], closedtrades: [], pending_orders: [] }) }) },
    log: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, opts) => {
      if (url.includes('/internal/pine/active')) return { ok: true, json: async () => items };
      sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      return { status: 200, json: async () => ({ signal_processed: true }) };
    },
  });
  m.bus = { publishState: async () => true, setJson: async (k, v) => { stored[k] = v; return true; }, getJson: async (k) => stored[k] ?? null, del: async (k) => { delete stored[k]; return true; }, stats: {} };
  m.feed = { setSymbols() {}, stats: {} };
  await m.sync();
  const s = m.sessions.get('9:NQ');
  s.bars = [bar(0), bar(1), bar(2)];
  s.warmed = true;
  return { m, s, sent, stored };
}

const openL = (t = T0 + 3 * 300_000) => ({ id: 'trade_0', entry_id: 'L', entry_price: 100, entry_time: t, size: 1 });
const closedL = (t = T0 + 3 * 300_000) => ({ id: 'trade_0', entry_id: 'L', entry_price: 100, entry_time: t, size: 1, exit_id: 'close_L', exit_price: 104, exit_time: t + 600_000 });
const bracket = { id: 'LX', category: 'exit', from_entry: 'L', loss: 8, profit: 16, status: 'pending' };

describe('trade sessions', () => {
  it('sync marks activated rows as trading and keeps the session across activation changes', async () => {
    const { m, s } = await setup({ tradingEnabled: false, items: [item()], ledgers: [] });
    expect(s.trading).toBe(true);
    expect(s.strategyName).toBe('My Strat (pine #9)');
    s.ledger.live.set('L|1|1', { action: 'BUY' });
    m.fetch = async () => ({ ok: true, json: async () => [item({ activations: [] })] });
    await m.sync();
    const same = m.sessions.get('9:NQ');
    expect(same).toBe(s); // not rebuilt
    expect(same.trading).toBe(false);
    expect(same.ledger.live.size).toBe(1); // positions survive
    expect(m.stats.trading.enabled).toBe(false);
  });

  it('a row listed as both viz and trade on one symbol keeps the trade session, whichever comes first', async () => {
    const viz = item({ kind: 'viz', activations: [] });
    for (const items of [[viz, item()], [item(), viz]]) {
      const { m } = await setup({ tradingEnabled: false, items, ledgers: [] });
      expect(m.sessions.size).toBe(1);
      expect(m.sessions.get('9:NQ').trading).toBe(true);
    }
  });

  it('shadow mode logs signals and persists positions but sends nothing', async () => {
    const ledgers = [
      { opentrades: [], closedtrades: [], pending_orders: [] },         // baseline (bar 3)
      { opentrades: [openL()], closedtrades: [], pending_orders: [bracket] }, // bar 4: entry filled
    ];
    const { m, s, sent, stored } = await setup({ tradingEnabled: false, items: [item()], ledgers });
    await m.onBarForTest('NQ', 300, bar(3));
    await m.onBarForTest('NQ', 300, bar(4));
    expect(sent).toEqual([]);
    expect(s.shadowSignals).toBe(1);
    expect(s.signalLog[0]).toMatchObject({ action: 'BUY', comment: 'L', mode: 'shadow', stop_loss: 98, take_profit: 104 });
    expect(Object.keys(stored)).toEqual(['pine_trading:9:NQ']);
    expect(m.stats.sessions[0].trading).toMatchObject({ strategy: 'My Strat (pine #9)', activations: 1, live_accounts: 0, shadow: 1, sent: 0 });
  });

  it('enabled: sends BUY with the bracket, then EXIT, in order, with the engine key', async () => {
    const ledgers = [
      { opentrades: [], closedtrades: [], pending_orders: [] },
      { opentrades: [openL()], closedtrades: [], pending_orders: [bracket] },
      { opentrades: [], closedtrades: [closedL()], pending_orders: [] },
    ];
    const { m, s, sent, stored } = await setup({ tradingEnabled: true, items: [item()], ledgers });
    await m.onBarForTest('NQ', 300, bar(3));
    await m.onBarForTest('NQ', 300, bar(4));
    await m.onBarForTest('NQ', 300, bar(5));
    await s.outbox;
    expect(sent.map((x) => x.body.action)).toEqual(['BUY', 'EXIT']);
    expect(sent[0].url).toBe('http://backend/api/v1/trades/execute');
    expect(sent[0].headers['X-API-Key']).toBe('engine-key');
    expect(sent[0].body).toMatchObject({ strategy_name: 'My Strat (pine #9)', symbol: 'NQ', comment: 'L', stop_loss: 98, take_profit: 104 });
    expect(sent[0].body.quantity).toBeUndefined();
    expect(sent[1].body).toMatchObject({ comment: 'EXIT_FINAL', exit_reason: 'strategy_exit' });
    expect(s.signalsSent).toBe(2);
    expect(stored['pine_trading:9:NQ']).toBeUndefined(); // flat -> nothing to restore
  });

  it('an intrabar run can fire the entry; the bar close does not repeat it', async () => {
    const ledgers = [
      { opentrades: [], closedtrades: [], pending_orders: [] },
      { opentrades: [openL()], closedtrades: [], pending_orders: [] }, // intrabar on bar 4
      { opentrades: [openL()], closedtrades: [], pending_orders: [] }, // bar 4 closes
    ];
    const { m, s, sent } = await setup({ tradingEnabled: true, items: [item()], ledgers });
    await m.onBarForTest('NQ', 300, bar(3));
    const { BarAggregator } = await import('../src/live/bars.mjs');
    const agg = new BarAggregator('NQ', 300, (b) => m.onBarForTest('NQ', 300, b));
    m.aggregators.set('NQ:300', agg);
    agg.trade(10, 1, T0 + 4 * 300_000 + 1_000);
    s.dirty = true; s.lastIntrabarAt = 0;
    await m.intrabarTickForTest();
    await m.onBarForTest('NQ', 300, bar(4));
    await s.outbox;
    expect(sent.map((x) => x.body.action)).toEqual(['BUY']);
  });

  it('restores positions from Redis on warm-up so an exit after a restart still travels', async () => {
    const key = 'L|' + (T0 + 3 * 300_000) + '|1';
    const ledgers = [
      { opentrades: [openL()], closedtrades: [], pending_orders: [] }, // warm-up baseline: still open
      { opentrades: [], closedtrades: [closedL()], pending_orders: [] },
    ];
    const sent = [];
    const stored = { 'pine_trading:9:NQ': { [key]: { action: 'BUY', entry_price: 100 } } };
    const m = new LiveManager({
      config: { ...base, tradingEnabled: true },
      pool: { run: async (job) => ({ ok: true, live: liveResult(job.bars, ledgers.shift()) }) },
      log: { info() {}, warn() {}, error() {} },
      fetchImpl: async (url, opts) => { if (url.includes('/internal/pine/active')) return { ok: true, json: async () => [item()] }; sent.push(JSON.parse(opts.body)); return { status: 200, json: async () => ({}) }; },
      warehouseImpl: { getBars: async () => [bar(0), bar(1), bar(2), bar(3)] },
    });
    m.bus = { publishState: async () => true, setJson: async (k, v) => { stored[k] = v; }, getJson: async (k) => stored[k] ?? null, del: async (k) => { delete stored[k]; }, stats: {} };
    m.feed = { setSymbols() {}, stats: {} };
    await m.sync();
    const s = m.sessions.get('9:NQ');
    for (let i = 0; i < 100 && !(s.warmed && s.runs >= 1 && !s.running); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.ledger.live.has(key)).toBe(true);
    await m.onBarForTest('NQ', 300, bar(4));
    await s.outbox;
    expect(sent.map((x) => x.action)).toEqual(['EXIT']);
  });
});
