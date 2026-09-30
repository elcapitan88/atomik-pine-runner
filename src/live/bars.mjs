// Trades -> closed bars. One aggregator per (symbol, bar seconds). Buckets are
// epoch // seconds, stamped with the bucket start, like the Atomik SDK's
// consolidator and the warehouse, so live bars line up with warmup bars.
export class BarAggregator {
  /**
   * @param {string} symbol
   * @param {number} seconds
   * @param {(bar: object) => void} onClose  called with each CLOSED bar (PineTS Kline shape)
   */
  constructor(symbol, seconds, onClose) {
    this.symbol = symbol;
    this.seconds = seconds;
    this.spanMs = seconds * 1000;
    this.onClose = onClose;
    this.current = null; // forming bar
    this.lastClosedOpen = -Infinity; // trades for this bucket or earlier are late
  }

  bucketStart(ms) {
    return Math.floor(ms / this.spanMs) * this.spanMs;
  }

  /** Feed one trade. Closes the forming bar when the trade belongs to a later bucket. */
  trade(price, size, ms) {
    const start = this.bucketStart(ms);
    if (start <= this.lastClosedOpen) return; // late trade for a closed bar; ignore
    if (this.current && start > this.current.openTime) this.#close();
    if (!this.current) {
      this.current = { openTime: start, open: price, high: price, low: price, close: price, volume: 0, closeTime: start + this.spanMs - 1 };
    } else if (start < this.current.openTime) {
      return; // late trade for an already-closed bar; ignore
    }
    const b = this.current;
    if (price > b.high) b.high = price;
    if (price < b.low) b.low = price;
    b.close = price;
    b.volume += size || 0;
  }

  /** Wall-clock check: close the forming bar once its bucket has ended. */
  tick(nowMs) {
    if (this.current && nowMs > this.current.closeTime) this.#close();
  }

  /** The forming bar, or null. */
  get forming() {
    return this.current ? { ...this.current } : null;
  }

  #close() {
    const bar = this.current;
    this.current = null;
    this.lastClosedOpen = bar.openTime;
    this.onClose(bar);
  }
}

/** Append a closed bar to an ascending bar array, replacing a bar with the same openTime. */
export function mergeBar(bars, bar, maxBars) {
  const last = bars[bars.length - 1];
  if (!last || bar.openTime > last.openTime) bars.push(bar);
  else if (bar.openTime === last.openTime) bars[bars.length - 1] = bar;
  else return bars; // older than the tail: ignore
  if (maxBars && bars.length > maxBars) bars.splice(0, bars.length - maxBars);
  return bars;
}
