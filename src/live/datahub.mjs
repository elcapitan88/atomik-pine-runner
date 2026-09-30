// DataHub WebSocket client: raw trades for a set of symbols.
// Protocol (atomik-data-hub server.py /ws): connect with ?api_key=, send
// {"type":"subscribe","symbols":[...]} / {"type":"unsubscribe",...}, receive
// {"type":"trade","data":{symbol,price,size,timestamp,side}}. The server drops
// clients idle for 120s, so we ping every 45s.
export class DataHubFeed {
  /**
   * @param {object} opts
   * @param {string} opts.url       ws://host:port/ws
   * @param {string} opts.apiKey
   * @param {(symbol: string, price: number, size: number, ms: number) => void} opts.onTrade
   * @param {object} [opts.log]
   */
  constructor({ url, apiKey, onTrade, log = console }) {
    this.url = url;
    this.apiKey = apiKey;
    this.onTrade = onTrade;
    this.log = log;
    this.symbols = new Set();
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.backoffMs = 1000;
    this.pingTimer = null;
    this.lastTradeAt = null;
    this.tradesSeen = 0;
  }

  start() {
    this.closed = false;
    this.#connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch {}
  }

  /** Make the subscription set exactly `symbols`. */
  setSymbols(symbols) {
    const want = new Set(symbols.map((s) => String(s).toUpperCase()));
    const add = [...want].filter((s) => !this.symbols.has(s));
    const drop = [...this.symbols].filter((s) => !want.has(s));
    this.symbols = want;
    if (!this.connected) return;
    if (add.length) this.#send({ type: 'subscribe', symbols: add });
    if (drop.length) this.#send({ type: 'unsubscribe', symbols: drop });
  }

  get stats() {
    return { connected: this.connected, symbols: [...this.symbols], tradesSeen: this.tradesSeen, lastTradeAt: this.lastTradeAt };
  }

  #send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch (err) { this.log.warn?.(`datahub send failed: ${err.message}`); }
  }

  #connect() {
    if (this.closed) return;
    const sep = this.url.includes('?') ? '&' : '?';
    let ws;
    try {
      ws = new WebSocket(`${this.url}${sep}api_key=${encodeURIComponent(this.apiKey)}&client_type=pine-runner`);
    } catch (err) {
      this.log.error?.(`datahub connect error: ${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.connected = true;
      this.backoffMs = 1000;
      this.log.info?.(`datahub connected (${this.symbols.size} symbols)`);
      if (this.symbols.size) this.#send({ type: 'subscribe', symbols: [...this.symbols] });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.#send({ type: 'ping' }), 45_000);
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg?.type !== 'trade') return;
      const d = msg.data || msg;
      const price = Number(d.price);
      const ms = Date.parse(d.timestamp);
      if (!d.symbol || !Number.isFinite(price) || !Number.isFinite(ms)) return;
      this.tradesSeen++;
      this.lastTradeAt = Date.now();
      this.onTrade(String(d.symbol).toUpperCase(), price, Number(d.size ?? d.volume ?? 0) || 0, ms);
    });
    ws.addEventListener('close', (ev) => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.log.warn?.(`datahub closed (code=${ev.code})`);
      this.#scheduleReconnect();
    });
    ws.addEventListener('error', () => { /* close follows */ });
  }

  #scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => this.#connect(), delay);
  }
}
