// Sends trade signals to the Atomik backend's signal endpoint — the same one
// the Python strategy engine uses — with the engine's delivery policy:
// entries expire fast (a late entry is a different trade), exits retry hard
// (getting flat is safety). The signal_id is reused on every retry so the
// backend's dedupe sees one logical signal.
const ENTRY_DELAYS = [1000, 3000, 5000];
const EXIT_DELAYS = [1000, 3000, 5000, 15000, 15000, 15000, 15000, 15000];

export class ExecutionClient {
  constructor({ backendUrl, apiKey, log = console, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.url = `${backendUrl.replace(/\/$/, '')}/api/v1/trades/execute`;
    this.apiKey = apiKey;
    this.log = log;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.sent = 0;
    this.failed = 0;
    this.amended = 0;
    this.lastSentAt = null;
    this.lastError = null;
  }

  /** @returns {Promise<{ok: boolean, status?: number, body?: any, attempts: number}>} */
  async send(signal, { strategyName, symbol }) {
    const payload = {
      strategy_name: strategyName,
      symbol,
      action: signal.action,
      timestamp: new Date().toISOString(),
      comment: signal.comment || null,
      signal_id: signal.signal_id,
    };
    if (signal.stop_loss != null) payload.stop_loss = signal.stop_loss;
    if (signal.take_profit != null) payload.take_profit = signal.take_profit;
    if (signal.exit_reason) payload.exit_reason = signal.exit_reason;
    payload.context = {
      source: 'pinets', trade_key: signal.trade_key ?? null, note: signal.note ?? null,
      pine_entry_price: signal.entry_price ?? null, pine_exit_price: signal.exit_price ?? null,
    };

    const delays = signal.action === 'EXIT' ? EXIT_DELAYS : ENTRY_DELAYS;
    let attempts = 0;
    let last = null;
    for (;;) {
      attempts++;
      try {
        const r = await this.fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        });
        let body = null;
        try { body = await r.json(); } catch { body = null; }
        if (r.status === 200) {
          this.sent++;
          this.lastSentAt = Date.now();
          this.lastError = null;
          this.log.info?.(`signal ${signal.action} ${strategyName} ${symbol} delivered (${signal.signal_id}) -> ${JSON.stringify(body).slice(0, 160)}`);
          return { ok: true, status: 200, body, attempts };
        }
        last = { status: r.status, body };
        // 4xx = the backend refused it (unknown strategy, no position, ...);
        // retrying won't change that.
        if (r.status >= 400 && r.status < 500) break;
      } catch (err) {
        last = { error: String(err?.message || err) };
      }
      if (attempts > delays.length) break;
      await this.sleep(delays[attempts - 1]);
    }
    this.failed++;
    this.lastError = `${signal.action} ${strategyName} ${symbol}: ${JSON.stringify(last).slice(0, 200)}`;
    this.log.error?.(`signal FAILED after ${attempts} attempts: ${this.lastError}`);
    return { ok: false, ...last, attempts };
  }

  /** Move a resting bracket (single attempt: the previous level still protects the position). */
  async amend({ stop_loss = null, take_profit = null }, { strategyName, symbol }) {
    const payload = { strategy_name: strategyName, symbol };
    if (stop_loss != null) payload.stop_loss = stop_loss;
    if (take_profit != null) payload.take_profit = take_profit;
    try {
      const r = await this.fetch(this.url.replace(/\/execute$/, '/bracket/amend'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      if (r.status === 200) { this.amended++; return { ok: true, body }; }
      this.lastError = `amend ${strategyName} ${symbol}: ${r.status} ${JSON.stringify(body).slice(0, 160)}`;
      return { ok: false, status: r.status, body };
    } catch (err) {
      this.lastError = `amend ${strategyName} ${symbol}: ${String(err?.message || err)}`;
      return { ok: false, error: this.lastError };
    }
  }

  get stats() {
    return { sent: this.sent, failed: this.failed, amended: this.amended || 0, lastSentAt: this.lastSentAt, lastError: this.lastError };
  }
}
