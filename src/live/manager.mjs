// Live chart indicators. One session per (StrategyCode, symbol) the backend
// reports as active; each session keeps a bar history (warehouse warmup +
// closed live bars), runs the script on every closed bar and on the forming
// bar, and publishes the resulting drawings when they change.
//
// STREAMING (default): each session's script stays open in a StreamHost
// isolate and an update re-executes only the last bar or two (milliseconds),
// with an exact rollback between ticks (see PineStream in sandbox.mjs). The
// parity tests prove a streamed session ends in the same state as a one-shot
// run over the same bars. Any stream failure reopens it from history; a
// session whose stream keeps failing, or that finds no stream capacity, falls
// back to the stateless path: re-run the whole history on every update.
import { BarAggregator, mergeBar } from './bars.mjs';
import { DataHubFeed } from './datahub.mjs';
import { StateBus } from './redis.mjs';
import { stateFrom, stateHash, emptyState, partialStateFrom } from './state.mjs';
import { diffLedger, newLedgerState, liveSnapshot, needsIntrabar } from './signals.mjs';
import { ExecutionClient } from './execution.mjs';
import { atomikToSeconds, SUPPORTED_TIMEFRAMES } from '../timeframes.mjs';
import { tickerToRoot } from '../symbols.mjs';
import * as warehouse from '../warehouse.mjs';

const liveKey = (s) => `pine_trading:${s.id}:${s.symbol}`;

export class LiveManager {
  constructor({ config, pool, streams = null, log = console, fetchImpl = fetch, warehouseImpl = warehouse }) {
    this.config = config;
    this.pool = pool;
    this.streams = streams;
    this.log = log;
    this.fetch = fetchImpl;
    this.warehouse = warehouseImpl;
    this.sessions = new Map();     // key -> session
    this.aggregators = new Map();  // `${symbol}:${seconds}` -> BarAggregator
    this.bus = new StateBus({ url: config.redisUrl, log });
    // Trading: strategies activated on an account get their ledger diffed into
    // signals. With PINE_TRADING_ENABLED unset the signals are only logged
    // ("shadow"), which is how a strategy is checked before it trades.
    this.execution = new ExecutionClient({ backendUrl: config.backendInternalUrl, apiKey: config.executionApiKey || '', log, fetchImpl });
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
      sessions: [...this.sessions.values()].map((s) => ({
        key: s.key, symbol: s.symbol, timeframe: s.timeframe, bars: s.bars.length, runs: s.runs, intrabarRuns: s.intrabarRuns, intrabarMs: s.intrabarMs, lastRunMs: s.lastRunMs, lastBoundaryMs: s.lastBoundaryMs ?? null, lastError: s.lastError,
        stream: this.streams ? { on: s.streamed, opens: s.streamOpens, bars: s.streamBars, heapMb: s.heapMb, off: s.streamOff || null, failures: s.streamFailures } : null,
        trading: s.trading ? { strategy: s.strategyName, activations: s.activations.length, live_accounts: s.activations.filter((a) => !a.is_paper).length, positions: liveSnapshot(s.ledger), shadow: s.shadowSignals, sent: s.signalsSent, failed: s.signalsFailed, lastLatencyMs: s.lastLatencyMs, recent: s.signalLog.slice(-10) } : null,
      })),
      trading: { enabled: !!this.config.tradingEnabled, execution: this.execution.stats },
      streams: this.streams ? this.streams.stats : null,
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
        const key = `${it.strategy_code_id}:${symbol}`;
        // One session per (row, symbol). The backend lists a row once per kind,
        // so a row both drawn and traded on one symbol arrives twice: the trade
        // item wins (it draws too; a viz item can never trade).
        const prev = wanted.get(key);
        if (prev && prev.kind === 'trade' && it.kind !== 'trade') continue;
        wanted.set(key, { ...it, symbol, timeframe });
      }
      // Drop sessions that are gone (clear their drawings on the chart).
      for (const [key, s] of this.sessions) {
        if (!wanted.has(key)) {
          this.sessions.delete(key);
          this.streams?.closeStream(key);
          await this.bus.publishState(emptyState({ strategyKey: s.strategyKey, symbol: s.symbol }));
          this.log.info?.(`live: dropped ${key}`);
        }
      }
      // Add new / changed sessions.
      for (const [key, it] of wanted) {
        const cur = this.sessions.get(key);
        const activations = Array.isArray(it.activations) ? it.activations : [];
        const trading = it.kind === 'trade' && activations.length > 0 && !!it.strategy_name;
        const inputs = it.inputs && typeof it.inputs === 'object' ? it.inputs : null;
        const inputsKey = JSON.stringify(inputs || {});
        if (cur && cur.source === it.source && cur.timeframe === it.timeframe && cur.strategyKey === it.strategy_key && cur.inputsKey === inputsKey) {
          // Same script: refresh who trades it without resetting the session
          // (a rebuild would forget the positions it opened).
          if (trading && !cur.trading) this.log.info?.(`live: ${key} now trading as "${it.strategy_name}" (${activations.length} account(s))`);
          if (!trading && cur.trading) this.log.info?.(`live: ${key} stopped trading`);
          cur.trading = trading; cur.activations = activations; cur.strategyName = it.strategy_name || cur.strategyName; cur.symbolInfo = it.symbol_info || cur.symbolInfo;
          continue;
        }
        const s = {
          key, id: it.strategy_code_id, strategyKey: it.strategy_key, symbol: it.symbol, timeframe: it.timeframe, seconds: atomikToSeconds(it.timeframe), source: it.source, symbolInfo: it.symbol_info || null,
          // Settings-dialog overrides ({in_N: value}); a change rebuilds the session.
          inputs, inputsKey,
          bars: [], warmed: false, runs: 0, intrabarRuns: 0, lastRunMs: null, lastError: null, lastHash: null, lastPayload: null, lastPartialHash: null, running: false, pending: false, wantBoundary: false, closedPending: false, closedAt: 0, dirty: false, lastIntrabarAt: 0, triggerAt: 0, intrabarMs: (this.config.liveIntrabarSeconds || 5) * 1000, intrabarNeeded: false,
          streamed: false, streamLast: null, streamBars: 0, streamOpens: 0, streamFailures: 0, streamOff: false, streamRetryAt: 0, heapMb: null,
          trading, activations, strategyName: it.strategy_name || null, ledger: newLedgerState(), outbox: Promise.resolve(), shadowSignals: 0, signalsSent: 0, signalsFailed: 0, signalLog: [], lastLatencyMs: null,
        };
        if (cur) { s.ledger = cur.ledger; s.shadowSignals = cur.shadowSignals; s.signalsSent = cur.signalsSent; s.signalsFailed = cur.signalsFailed; s.signalLog = cur.signalLog; s.outbox = cur.outbox; }
        this.sessions.set(key, s);
        this.log.info?.(`live: ${cur ? 'updated' : 'added'} ${key} (${it.symbol} ${it.timeframe})${trading ? ` trading as "${it.strategy_name}"` : ''}`);
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
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.symbol !== symbol) continue;
      s.dirty = true;
      if (!s.warmed || !s.closedPending) continue;
      // This print opened a new bar and closed the previous one (#onBar just
      // flagged the session). Run ONCE over the closed history plus the
      // forming bar: the closed-bar state and the new bar's fills come out of
      // the same run, so a trading session's entry is decided one run after
      // the first print instead of two runs and a throttle later.
      const forming = this.aggregators.get(`${s.symbol}:${s.seconds}`)?.forming;
      const last = s.bars[s.bars.length - 1];
      if (!forming || !last || forming.openTime <= last.openTime) continue;
      s.closedPending = false;
      s.dirty = false;
      s.lastIntrabarAt = now;
      s.triggerAt = now;
      this.#run(s, { forming, full: true });
    }
  }

  #onBar(symbol, seconds, bar) {
    for (const s of this.sessions.values()) {
      if (s.symbol !== symbol || s.seconds !== seconds || !s.warmed) continue;
      mergeBar(s.bars, bar, this.config.liveWarmupBars);
      // Closed by a print: #onTrade runs it with the forming bar right away.
      // Closed by the wall clock (quiet symbol): #intrabarTick runs the
      // closed history on its next pass.
      s.closedPending = true;
      s.closedAt = Date.now();
    }
  }

  // Test hooks (private methods aren't reachable from tests).
  async intrabarTickForTest() { this.#intrabarTick(); await this.#drain(); }
  async onBarForTest(symbol, seconds, bar) { this.#onBar(symbol, seconds, bar); this.#flushClosed(0); await this.#drain(); }
  async onTradeForTest(symbol, price, size, ms) { this.#onTrade(symbol, price, size, ms); await this.#drain(); }
  async #drain() {
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 200; i++) { if (![...this.sessions.values()].some((s) => s.running)) return; await new Promise((r) => setTimeout(r, 5)); }
  }

  /** Closed bars no print has picked up yet (wall-clock closes): run the closed history. */
  #flushClosed(minAgeMs) {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.closedPending || !s.warmed || now - s.closedAt < minAgeMs) continue;
      s.closedPending = false;
      s.triggerAt = now;
      this.#run(s);
    }
  }

  /** Once a second: sessions whose symbol traded re-run on the forming bar,
   * no more often than their interval, stretched to 3x the last run time so
   * a slow script can't monopolise the workers. A STREAMED session updates in
   * milliseconds, so it runs at the stream cadence (1s by default). A
   * stateless session re-runs its whole history each time: charts get the
   * configured cadence, and a trading session drops to 1s only while its
   * ledger has orders that can fill mid-bar (resting stop/limit entries,
   * trailing exits), since everything else is decided by the boundary run. On
   * a shared CPU a tight full-recompute loop burns the burst budget and makes
   * EVERY run slower — so idle is the stateless default. */
  #intrabarTick() {
    this.#flushClosed(1000);
    const now = Date.now();
    const chartFloor = (this.config.liveIntrabarSeconds || 5) * 1000;
    const streamFloor = this.config.liveStreamIntrabarMs || 1000;
    for (const s of this.sessions.values()) {
      if (!s.warmed || !s.dirty || s.running || s.closedPending) continue;
      const floor = s.streamed ? streamFloor : s.trading && s.intrabarNeeded ? 1000 : chartFloor;
      s.intrabarMs = Math.max(floor, 3 * (s.lastRunMs || 0));
      if (now - s.lastIntrabarAt < s.intrabarMs) continue;
      const forming = this.aggregators.get(`${s.symbol}:${s.seconds}`)?.forming;
      const last = s.bars[s.bars.length - 1];
      if (!forming || (last && forming.openTime <= last.openTime)) continue;
      s.dirty = false;
      s.lastIntrabarAt = now;
      s.triggerAt = now;
      this.#run(s, { forming });
    }
  }

  async #warm(s) {
    if (s.trading && !s.ledger.baselined) {
      // Positions opened by a previous process, so their exits still travel.
      const restored = await this.bus.getJson(liveKey(s));
      if (restored && Object.keys(restored).length) {
        s.ledger = newLedgerState(restored);
        this.log.info?.(`live: ${s.key} restored ${Object.keys(restored).length} open position(s) from a previous run`);
      }
    }
    const bars = await this.warehouse.getBars(s.symbol, s.timeframe, null, null, this.config.liveWarmupBars);
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
  async #run(s, { forming = null, full = null } = {}) {
    if (s.running) {
      // Queue behind the run in flight: a bar boundary re-runs with whatever
      // the forming bar looks like by then; a plain closed-bar run re-runs
      // the history; an ordinary intrabar request is simply dropped (the next
      // tick brings a fresher one).
      if (forming && full) s.wantBoundary = true;
      else if (!forming) s.pending = true;
      return;
    }
    s.running = true;
    try {
      let next = { forming, full };
      do {
        const f = next.forming;
        const boundary = !!(f && next.full);    // first print of a new bar
        const isFull = next.full ?? !f;         // ledger semantics (desync/amend checks)
        // The boundary run exists to decide fills fast, so it ships only the
        // last bars' chart values like an intrabar run; the closed history
        // gets its full, cached frame from the follow-up run queued below.
        const chartFull = isFull && !boundary;
        const triggerAt = s.triggerAt || Date.now();
        const started = Date.now();
        const res = await this.#execute(s, f, chartFull ? this.config.liveWarmupBars : 2);
        s.lastRunMs = Date.now() - started;
        if (isFull) s.runs++; else s.intrabarRuns++;
        if (boundary) { s.lastBoundaryMs = s.lastRunMs; s.pending = true; }
        if (!res.ok) {
          s.lastError = res.detail;
          this.log.warn?.(`live: ${s.key} run failed: ${res.detail}`);
        } else {
          s.lastError = null;
          if (s.trading) s.intrabarNeeded = needsIntrabar(res.live.strategy);
          if (s.trading && res.live.strategy) {
            try { await this.#trade(s, res.live.strategy, { full: isFull, lastTime: res.live.lastTime, triggerAt }); } catch (err) { this.log.error?.(`live: ${s.key} trade step failed: ${err.message}`); }
          }
          if (!chartFull) {
            const partial = partialStateFrom(res.live, { strategyKey: s.strategyKey, symbol: s.symbol });
            if (partial) {
              const hash = stateHash(partial);
              if (hash !== s.lastPartialHash) {
                s.lastPartialHash = hash;
                await this.bus.publishState(partial, { cache: false });
              }
            }
          } else {
            const payload = stateFrom(res.live, { strategyKey: s.strategyKey, symbol: s.symbol });
            const hash = stateHash(payload);
            s.lastPayload = payload;
            s.lastPartialHash = null;
            if (hash !== s.lastHash) {
              s.lastHash = hash;
              await this.bus.publishState(payload);
            }
          }
        }
        // Follow-ups that queued while this run was in flight.
        if (s.wantBoundary) {
          s.wantBoundary = false;
          s.pending = false;
          s.triggerAt = Date.now();
          const cf = this.aggregators.get(`${s.symbol}:${s.seconds}`)?.forming;
          const last = s.bars[s.bars.length - 1];
          next = cf && last && cf.openTime > last.openTime ? { forming: cf, full: true } : { forming: null, full: null };
        } else if (s.pending) {
          s.pending = false;
          s.triggerAt = Date.now();
          next = { forming: null, full: null };
        } else {
          next = null;
        }
      } while (next && this.sessions.has(s.key));
    } finally {
      s.running = false;
    }
  }

  /**
   * Run the script for this session: through its stream when streaming is on,
   * else (or when the stream fails) as a stateless full re-run in the pool.
   * `forming` is the forming bar (newer than every closed bar) or null.
   */
  async #execute(s, forming, maxSeries) {
    let streamFailed = false;
    if (this.streams && !s.streamOff && Date.now() >= s.streamRetryAt) {
      const res = await this.#streamRun(s, forming, maxSeries);
      if (res.ok) { s.streamFailures = 0; return res; }
      s.streamed = false;
      if (res.capacity) {
        s.streamRetryAt = Date.now() + 300_000;
        this.log.warn?.(`live: ${s.key} no stream capacity (${res.detail}); full re-runs for now`);
      } else {
        streamFailed = true;
        s.streamFailures++;
        this.log.warn?.(`live: ${s.key} stream failed (${res.detail}); full re-run`);
      }
    }
    const bars = forming ? [...s.bars, forming] : s.bars;
    const res = await this.pool.run(
      { type: 'live_run', source: s.source, symbol: s.symbol, timeframe: s.timeframe, bars, symbol_info: s.symbolInfo, max_series_bars: maxSeries, inputs: s.inputs },
      { timeoutMs: this.config.liveRunTimeoutMs, priority: !!s.trading },
    );
    if (streamFailed) {
      if (!res.ok) {
        // The script itself fails: not the stream's fault. Don't count it,
        // and don't pay for a second failing run on every update for a while.
        s.streamFailures = Math.max(0, s.streamFailures - 1);
        s.streamRetryAt = Date.now() + 60_000;
      } else if (s.streamFailures >= 3) {
        s.streamOff = true;
        this.log.warn?.(`live: ${s.key} streaming OFF after ${s.streamFailures} stream-only failures; full re-runs from now on`);
      }
    }
    return res;
  }

  /**
   * Advance the session's stream with every bar from the stream's last bar on
   * (that bar itself, now final or still forming, plus newer closed bars and
   * the forming bar), or open it from history when it has none. A stream that
   * has grown `liveStreamRecycleBars` past the warmup is reopened on a closed
   * bar so its history stays bounded.
   */
  async #streamRun(s, forming, maxSeries) {
    const timeoutMs = this.config.liveRunTimeoutMs;
    const recycle = s.streamed && !forming && s.streamBars >= this.config.liveWarmupBars + (this.config.liveStreamRecycleBars || 2000);
    if (s.streamed && !recycle) {
      const tail = [];
      for (let i = s.bars.length - 1; i >= 0 && s.bars[i].openTime >= s.streamLast; i--) tail.unshift(s.bars[i]);
      if (forming) tail.push(forming);
      const newBar = tail.some((b) => b.openTime > s.streamLast);
      const res = await this.streams.update(s.key, { bars: tail, new_bar: newBar, max_series_bars: maxSeries, timeout_ms: timeoutMs }, { timeoutMs });
      if (res.ok) {
        if (tail.length) s.streamLast = tail[tail.length - 1].openTime;
        s.streamBars = res.live.bars;
        s.heapMb = res.heap_mb ?? s.heapMb;
        return res;
      }
      if (!res.stream_missing && !res.stream_lost) return res;
      this.log.info?.(`live: ${s.key} stream lost (${res.detail}); reopening from history`);
      s.streamed = false;
    }
    const bars = forming ? [...s.bars, forming] : s.bars;
    const res = await this.streams.open(s.key, { source: s.source, symbol: s.symbol, timeframe: s.timeframe, bars, symbol_info: s.symbolInfo, max_series_bars: maxSeries, timeout_ms: timeoutMs, inputs: s.inputs }, { timeoutMs });
    if (res.ok) {
      s.streamed = true;
      s.streamOpens++;
      s.streamLast = bars.length ? bars[bars.length - 1].openTime : null;
      s.streamBars = res.live.bars;
      s.heapMb = res.heap_mb ?? null;
    }
    return res;
  }

  /**
   * Diff the script's ledger against what this session already signalled and
   * send (or, in shadow mode, log) the difference. Sends are queued per
   * session so exits and entries leave in order even while the next run is
   * already computing; a slow retry never blocks the chart.
   */
  async #trade(s, ledger, { full, lastTime = null, triggerAt = null }) {
    const ctx = { strategyName: s.strategyName, symbol: s.symbol, mintick: s.symbolInfo?.mintick };
    const hadPositions = s.ledger.live.size;
    const { signals, amends } = diffLedger(s.ledger, { ...ledger, lastTime }, ctx, { full });
    if (!signals.length && !amends.length) return;
    if (signals.length || s.ledger.live.size !== hadPositions) {
      if (s.ledger.live.size) await this.bus.setJson(liveKey(s), liveSnapshot(s.ledger));
      else await this.bus.del(liveKey(s));
    }
    const enabled = !!this.config.tradingEnabled;
    // Decision latency: from the print (or bar close) that triggered this run
    // to the signal leaving the diff. The wire adds ~100ms on top.
    const latencyMs = triggerAt ? Date.now() - triggerAt : null;
    if (signals.length && latencyMs != null) s.lastLatencyMs = latencyMs;
    for (const sig of signals) {
      const rec = { at: new Date().toISOString(), action: sig.action, comment: sig.comment, trade_key: sig.trade_key, stop_loss: sig.stop_loss ?? null, take_profit: sig.take_profit ?? null, exit_reason: sig.exit_reason ?? null, note: sig.note ?? null, latency_ms: latencyMs, mode: enabled ? 'send' : 'shadow', result: null };
      s.signalLog.push(rec);
      if (s.signalLog.length > 30) s.signalLog.shift();
      const line = `${sig.action} ${sig.comment} "${s.strategyName}" ${s.symbol}${sig.stop_loss != null ? ` sl=${sig.stop_loss}` : ''}${sig.take_profit != null ? ` tp=${sig.take_profit}` : ''}${sig.note ? ` (${sig.note})` : ''} id=${sig.signal_id}${latencyMs != null ? ` latency=${latencyMs}ms` : ''}`;
      if (!enabled) { s.shadowSignals++; this.log.warn?.(`trade[shadow] ${s.key}: ${line}`); continue; }
      this.log.info?.(`trade ${s.key}: ${line}`);
      s.outbox = s.outbox
        .then(() => this.execution.send(sig, ctx))
        .then((r) => { if (r.ok) s.signalsSent++; else s.signalsFailed++; rec.result = r.ok ? 'ok' : (r.status ? `http ${r.status}` : r.error || 'failed'); })
        .catch((err) => { s.signalsFailed++; rec.result = String(err?.message || err); });
    }
    for (const a of amends) {
      const line = `AMEND "${s.strategyName}" ${s.symbol} sl=${a.stop_loss} tp=${a.take_profit}`;
      if (!enabled) { this.log.warn?.(`trade[shadow] ${s.key}: ${line}`); continue; }
      this.log.info?.(`trade ${s.key}: ${line}`);
      s.outbox = s.outbox.then(() => this.execution.amend(a, ctx)).catch(() => {});
    }
  }
}
