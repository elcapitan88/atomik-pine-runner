// Live chart indicators. One session per (StrategyCode, symbol) the backend
// reports as active; each session keeps a bar history (warehouse warmup +
// closed live bars), re-runs the script in the sandbox on every closed bar,
// and publishes the resulting drawings when they change.
//
// Re-running from history on each bar (instead of streaming inside PineTS) is
// deliberate: it's a few ms per run, it makes `var` state identical to a
// backtest over the same bars, and a restart loses nothing.
import { BarAggregator, mergeBar } from './bars.mjs';
import { DataHubFeed } from './datahub.mjs';
import { StateBus } from './redis.mjs';
import { stateFrom, stateHash, emptyState, partialStateFrom } from './state.mjs';
import { atomikToSeconds, SUPPORTED_TIMEFRAMES } from '../timeframes.mjs';
import { tickerToRoot } from '../symbols.mjs';
import * as warehouse from '../warehouse.mjs';

export class LiveManager {
  constructor({ config, pool, log = console, fetchImpl = fetch }) {
    this.config = config;
    this.pool = pool;
    this.log = log;
    this.fetch = fetchImpl;
    this.sessions = new Map();     // key -> session
    this.aggregators = new Map();  // `${symbol}:${seconds}` -> BarAggregator
    this.bus = new StateBus({ url: config.redisUrl, log });
    this.feed = new DataHubFeed({ url: config.datahubWsUrl, apiKey: config.datahubApiKey, onTrade: (s, p, z, ms) => this.#onTrade(s, p, z, ms), log });
    this.syncTimer = null;
    this.tickTimer = null;
    this.syncing = false;
    this.lastSync = null;
    this.lastSyncError = null;
    this.reloadTimer = null;
  }

  async start() {
    await this.bus.start(() => this.#reloadSoon());
    this.feed.start();
    this.tickTimer = setInterval(() => { const now = Date.now(); for (const a of this.aggregators.values()) a.tick(now); }, 5_000);
    this.syncTimer = setInterval(() => this.sync(), this.config.liveSyncSeconds * 1000);
    // Heartbeat: re-send each session's last state. Tradesocket only relays
    // pushes (a chart's catch-up request is dropped on Tradovate connections),
    // so without this a chart opened between bar closes stays empty.
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), Math.max(15, this.config.liveHeartbeatSeconds || 60) * 1000);
    // Intrabar: sessions whose symbol traded since their last run re-run on
    // the forming bar, throttled per session (see #maybeIntrabar).
    this.intrabarTimer = setInterval(() => this.#intrabarTick(), 1_000);
    await this.sync();
  }

  async stop() {
    clearInterval(this.syncTimer);
    clearInterval(this.tickTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.intrabarTimer);
    clearTimeout(this.reloadTimer);
    this.feed.stop();
    await this.bus.stop();
  }

  get stats() {
    return {
      sessions: [...this.sessions.values()].map((s) => ({ key: s.key, symbol: s.symbol, timeframe: s.timeframe, bars: s.bars.length, runs: s.runs, intrabarRuns: s.intrabarRuns, intrabarMs: s.intrabarMs, lastRunMs: s.lastRunMs, lastError: s.lastError })),
      feed: this.feed.stats,
      bus: this.bus.stats,
      lastSync: this.lastSync,
      lastSyncError: this.lastSyncError,
    };
  }

  async #heartbeat() {
    for (const s of this.sessions.values()) {
      if (!s.lastPayload) continue;
      await this.bus.publishState({ ...s.lastPayload, ts: new Date().toISOString() });
    }
  }

  #reloadSoon() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.sync(), 1_000);
  }

  /** Reconcile sessions with the backend's list of active pinets rows. */
  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const items = await this.#fetchActive();
      const wanted = new Map();
      for (const it of items) {
        const symbol = tickerToRoot(it.symbol);
        const timeframe = SUPPORTED_TIMEFRAMES.includes(it.timeframe) ? it.timeframe : '5m';
        if (!symbol || !it.source || !it.strategy_key) continue;
        wanted.set(`${it.strategy_code_id}:${symbol}`, { ...it, symbol, timeframe });
      }
      // Drop sessions that are gone (clear their drawings on the chart).
      for (const [key, s] of this.sessions) {
        if (!wanted.has(key)) {
          this.sessions.delete(key);
          await this.bus.publishState(emptyState({ strategyKey: s.strategyKey, symbol: s.symbol }));
          this.log.info?.(`live: dropped ${key}`);
        }
      }
      // Add new / changed sessions.
      for (const [key, it] of wanted) {
        const cur = this.sessions.get(key);
        if (cur && cur.source === it.source && cur.timeframe === it.timeframe && cur.strategyKey === it.strategy_key) continue;
        const s = { key, id: it.strategy_code_id, strategyKey: it.strategy_key, symbol: it.symbol, timeframe: it.timeframe, seconds: atomikToSeconds(it.timeframe), source: it.source, symbolInfo: it.symbol_info || null, bars: [], warmed: false, runs: 0, intrabarRuns: 0, lastRunMs: null, lastError: null, lastHash: null, lastPayload: null, lastPartialHash: null, running: false, pending: false, dirty: false, lastIntrabarAt: 0, intrabarMs: (this.config.liveIntrabarSeconds || 2) * 1000 };
        this.sessions.set(key, s);
        this.log.info?.(`live: ${cur ? 'updated' : 'added'} ${key} (${it.symbol} ${it.timeframe})`);
        this.#warm(s).catch((err) => { s.lastError = `warmup: ${err.message}`; this.log.warn?.(`live: warmup failed for ${key}: ${err.message}`); });
      }
      this.#syncFeed();
      this.lastSync = new Date().toISOString();
      this.lastSyncError = null;
    } catch (err) {
      this.lastSyncError = err.message;
      this.log.warn?.(`live: sync failed: ${err.message}`);
    } finally {
      this.syncing = false;
    }
  }

  async #fetchActive() {
    const r = await this.fetch(`${this.config.backendInternalUrl}/api/v1/internal/pine/active`, { headers: { 'X-API-Key': this.config.serviceKey }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`backend /internal/pine/active -> ${r.status}`);
    const body = await r.json();
    return Array.isArray(body) ? body : (body.items || []);
  }

  #syncFeed() {
    const symbols = new Set([...this.sessions.values()].map((s) => s.symbol));
    // Aggregators: one per (symbol, seconds) in use.
    const need = new Set([...this.sessions.values()].map((s) => `${s.symbol}:${s.seconds}`));
    for (const k of [...this.aggregators.keys()]) if (!need.has(k)) this.aggregators.delete(k);
    for (const k of need) {
      if (!this.aggregators.has(k)) {
        const [symbol, secs] = k.split(':');
        this.aggregators.set(k, new BarAggregator(symbol, Number(secs), (bar) => this.#onBar(symbol, Number(secs), bar)));
      }
    }
    this.feed.setSymbols([...symbols]);
  }

  #onTrade(symbol, price, size, ms) {
    for (const a of this.aggregators.values()) if (a.symbol === symbol) a.trade(price, size, ms);
    for (const s of this.sessions.values()) if (s.symbol === symbol) s.dirty = true;
  }

  #onBar(symbol, seconds, bar) {
    for (const s of this.sessions.values()) {
      if (s.symbol !== symbol || s.seconds !== seconds || !s.warmed) continue;
      mergeBar(s.bars, bar, this.config.liveWarmupBars);
      this.#run(s);
    }
  }

  // Test hooks (private methods aren't reachable from tests).
  async intrabarTickForTest() { this.#intrabarTick(); await this.#drain(); }
  async onBarForTest(symbol, seconds, bar) { this.#onBar(symbol, seconds, bar); await this.#drain(); }
  async #drain() { for (let i = 0; i < 50; i++) { if (![...this.sessions.values()].some((s) => s.running)) return; await new Promise((r) => setTimeout(r, 5)); } }

  /** Once a second: sessions whose symbol traded re-run on the forming bar,
   * no more often than their interval (2s, stretched to 3x the last run time
   * so a slow script can't monopolise the workers). */
  #intrabarTick() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.warmed || !s.dirty || s.running) continue;
      if (now - s.lastIntrabarAt < s.intrabarMs) continue;
      const forming = this.aggregators.get(`${s.symbol}:${s.seconds}`)?.forming;
      const last = s.bars[s.bars.length - 1];
      if (!forming || (last && forming.openTime <= last.openTime)) continue;
      s.dirty = false;
      s.lastIntrabarAt = now;
      this.#run(s, { forming });
    }
  }

  async #warm(s) {
    const bars = await warehouse.getBars(s.symbol, s.timeframe, null, null, this.config.liveWarmupBars);
    if (!this.sessions.has(s.key)) return;
    s.bars = bars;
    s.warmed = true;
    this.log.info?.(`live: ${s.key} warmed with ${bars.length} ${s.timeframe} bars`);
    await this.#run(s); // draw from history right away, not at the next bar close
  }

  /**
   * Re-run the script over the session's bars and publish what changed.
   *
   * Closed-bar runs publish the FULL state (and cache it as `:last` for late
   * joiners). Intrabar runs (`forming` given) append the forming bar to the
   * history and publish a small PARTIAL frame — the last bar's values only —
   * on the channel but not into the cache, so a chart that opens between bar
   * closes still gets a complete picture and one already open gets the live
   * candle's values every couple of seconds.
   */
  async #run(s, { forming = null } = {}) {
    if (s.running) { if (!forming) s.pending = true; return; }
    s.running = true;
    try {
      do {
        s.pending = false;
        const intrabar = !!forming;
        const bars = intrabar ? [...s.bars, forming] : s.bars;
        forming = null; // a queued re-run after this one is always a full run
        const started = Date.now();
        const res = await this.pool.run({ type: 'live_run', source: s.source, symbol: s.symbol, timeframe: s.timeframe, bars, symbol_info: s.symbolInfo }, { timeoutMs: this.config.liveRunTimeoutMs });
        s.lastRunMs = Date.now() - started;
        if (intrabar) {
          s.intrabarRuns++;
          s.intrabarMs = Math.max((this.config.liveIntrabarSeconds || 2) * 1000, 3 * s.lastRunMs);
        } else {
          s.runs++;
        }
        if (!res.ok) { s.lastError = res.detail; this.log.warn?.(`live: ${s.key} run failed: ${res.detail}`); continue; }
        s.lastError = null;
        if (intrabar) {
          const partial = partialStateFrom(res.live, { strategyKey: s.strategyKey, symbol: s.symbol });
          if (!partial) continue;
          const hash = stateHash(partial);
          if (hash !== s.lastPartialHash) {
            s.lastPartialHash = hash;
            await this.bus.publishState(partial, { cache: false });
          }
          continue;
        }
        const payload = stateFrom(res.live, { strategyKey: s.strategyKey, symbol: s.symbol });
        const hash = stateHash(payload);
        s.lastPayload = payload;
        s.lastPartialHash = null;
        if (hash !== s.lastHash) {
          s.lastHash = hash;
          await this.bus.publishState(payload);
        }
      } while (s.pending && this.sessions.has(s.key));
    } finally {
      s.running = false;
    }
  }
}
