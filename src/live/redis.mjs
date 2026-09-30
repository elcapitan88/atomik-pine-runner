// Redis: publish chart state the way the Python engine does, and listen for
// the backend's reload pings.
//   channel  strategy_state:{strategy_key}:{symbol}   (Tradesocket relays to browsers)
//   key      strategy_state:{strategy_key}:{symbol}:last  (24h; late joiners read it)
//   channel  engine:strategy_reload                    (backend -> "resync now")
import { createClient } from 'redis';

export const RELOAD_CHANNEL = 'engine:strategy_reload';

export class StateBus {
  constructor({ url, log = console }) {
    this.url = url;
    this.log = log;
    this.pub = null;
    this.sub = null;
    this.published = 0;
  }

  async start(onReload) {
    this.pub = createClient({ url: this.url, socket: { reconnectStrategy: (n) => Math.min(1000 * 2 ** n, 30_000) } });
    this.pub.on('error', (err) => this.log.warn?.(`redis pub error: ${err.message}`));
    await this.pub.connect();
    this.sub = this.pub.duplicate();
    this.sub.on('error', (err) => this.log.warn?.(`redis sub error: ${err.message}`));
    await this.sub.connect();
    await this.sub.subscribe(RELOAD_CHANNEL, () => onReload());
  }

  async stop() {
    try { await this.sub?.quit(); } catch {}
    try { await this.pub?.quit(); } catch {}
  }

  /** Publish one strategy_state payload; `cache` also stores it as `:last`
   * for late joiners (never for partial/intrabar frames). */
  async publishState(payload, { cache = true } = {}) {
    if (!this.pub?.isOpen) return false;
    const channel = `strategy_state:${payload.strategy}:${payload.symbol}`;
    const body = JSON.stringify(payload);
    try {
      if (cache) await this.pub.multi().publish(channel, body).set(`${channel}:last`, body, { EX: 86_400 }).exec();
      else await this.pub.publish(channel, body);
      this.published++;
      return true;
    } catch (err) {
      this.log.warn?.(`publish ${channel} failed: ${err.message}`);
      return false;
    }
  }

  get stats() {
    return { connected: !!this.pub?.isOpen, published: this.published };
  }
}
