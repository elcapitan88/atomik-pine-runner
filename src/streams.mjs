// Live streams live in their own worker process(es), apart from the pool that
// runs compiles and backtests, so a 90s backtest never queues ahead of a
// tick. Each session key sticks to one worker (its isolate lives there); a
// worker handles many streams at once (each isolate runs on its own thread).
// A worker that dies takes its streams with it: pending calls fail with
// `stream_lost`, later updates get `stream_missing`, and the live manager
// reopens those sessions from history.
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const WORKER_PATH = new URL('./worker.mjs', import.meta.url);

export class StreamHost {
  /**
   * @param {object} [opts]
   * @param {number} [opts.size]        stream worker processes
   * @param {number} [opts.maxStreams]  open streams across all workers (each holds an isolate)
   * @param {number} [opts.graceMs]     extra time before a silent worker is killed
   */
  constructor({ size = 1, maxStreams = 8, graceMs = 5_000, log = console, workerPath = WORKER_PATH, env = undefined } = {}) {
    this.size = size;
    this.maxStreams = maxStreams;
    this.graceMs = graceMs;
    this.log = log;
    this.workerPath = workerPath;
    this.env = env;
    this.workers = [];
    this.owner = new Map(); // key -> worker
    this.closing = false;
    this.crashes = 0;
    for (let i = 0; i < size; i++) this.#spawn();
  }

  #spawn() {
    const child = fork(this.workerPath, [], { execArgv: ['--no-node-snapshot'], serialization: 'json', env: this.env });
    const w = { child, ready: false, pending: new Map(), keys: new Set(), readyWaiters: [] };
    // A send racing the worker's death fails with EPIPE; the exit handler
    // settles everything pending, so the error itself needs no handling.
    child.on('error', (err) => this.log.warn?.(`stream worker error: ${err.message}`));
    child.on('message', (msg) => {
      if (msg && msg.ready) {
        w.ready = true;
        for (const r of w.readyWaiters.splice(0)) r();
        return;
      }
      const p = msg && w.pending.get(msg.id);
      if (!p) return;
      w.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    });
    child.on('exit', (code, signal) => {
      if (!this.closing) {
        this.crashes++;
        this.log.warn?.(`stream worker exited (code=${code} signal=${signal}); ${w.keys.size} stream(s) lost`);
      }
      for (const [id, p] of w.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, status: 500, stream_lost: true, detail: 'stream worker crashed' });
      }
      w.pending.clear();
      for (const key of w.keys) if (this.owner.get(key) === w) this.owner.delete(key);
      w.keys.clear();
      this.workers = this.workers.filter((x) => x !== w);
      if (!this.closing) setTimeout(() => this.#spawn(), 500);
    });
    this.workers.push(w);
  }

  async #readyWorker(timeoutMs = 10_000) {
    const pick = () => {
      const ready = this.workers.filter((x) => x.ready && x.child.connected);
      if (!ready.length) return null;
      return ready.reduce((a, b) => (b.keys.size < a.keys.size ? b : a));
    };
    let w = pick();
    if (w || !this.workers.length) return w;
    await Promise.race([
      new Promise((r) => { for (const x of this.workers) x.readyWaiters.push(r); }),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    return pick();
  }

  #send(w, payload, timeoutMs) {
    if (!w.child.connected) return Promise.resolve({ ok: false, status: 500, stream_lost: true, detail: 'stream worker unavailable' });
    const id = randomUUID();
    return new Promise((resolve) => {
      // The worker disposes an isolate that overruns `timeoutMs` itself; this
      // only fires if the whole process stops answering (a native hang).
      const timer = setTimeout(() => {
        this.log.error?.(`stream worker hung on ${payload.type} ${payload.key}; killing`);
        w.child.kill('SIGKILL');
      }, timeoutMs + this.graceMs);
      w.pending.set(id, { resolve, timer });
      w.child.send({ ...payload, id }, (err) => {
        if (!err || !w.pending.has(id)) return;
        w.pending.delete(id);
        clearTimeout(timer);
        resolve({ id, ok: false, status: 500, stream_lost: true, detail: `stream worker unavailable: ${err.message}` });
      });
    });
  }

  #forget(key) {
    const w = this.owner.get(key);
    this.owner.delete(key);
    w?.keys.delete(key);
    return w;
  }

  /**
   * Open (or reopen) the stream for `key` from the given history. Resolves
   * with the worker's reply ({ok, live, heap_mb} or {ok:false, detail}).
   * `capacity: true` = too many open streams; the caller should run stateless.
   */
  async open(key, payload, { timeoutMs }) {
    if (this.closing) return { ok: false, status: 503, detail: 'shutting down' };
    let w = this.owner.get(key);
    if (!w || !w.child.connected) {
      if (w) this.#forget(key);
      if (this.owner.size >= this.maxStreams) return { ok: false, capacity: true, detail: `stream limit reached (${this.maxStreams})` };
      w = await this.#readyWorker();
      if (!w) return { ok: false, status: 503, capacity: true, detail: 'no stream worker ready' };
    }
    this.owner.set(key, w);
    w.keys.add(key);
    const res = await this.#send(w, { ...payload, type: 'stream_open', key }, timeoutMs);
    if (!res.ok && this.owner.get(key) === w) this.#forget(key);
    return res;
  }

  /** Advance the stream. `stream_missing` / `stream_lost` = reopen it. */
  async update(key, payload, { timeoutMs }) {
    const w = this.owner.get(key);
    if (!w) return { ok: false, stream_missing: true, detail: 'stream is not open' };
    const res = await this.#send(w, { ...payload, type: 'stream_update', key }, timeoutMs);
    if (!res.ok && (res.stream_missing || res.stream_lost) && this.owner.get(key) === w) this.#forget(key);
    return res;
  }

  /** Dispose one session's stream. (`close()` shuts the whole host down.) */
  closeStream(key) {
    const w = this.#forget(key);
    if (w && w.child.connected) w.child.send({ type: 'stream_close', key, id: randomUUID() }, () => {});
  }

  has(key) {
    return this.owner.has(key);
  }

  get stats() {
    return {
      workers: this.workers.length,
      ready: this.workers.filter((w) => w.ready).length,
      streams: this.owner.size,
      maxStreams: this.maxStreams,
      pending: this.workers.reduce((n, w) => n + w.pending.size, 0),
      crashes: this.crashes,
    };
  }

  async close() {
    this.closing = true;
    for (const w of this.workers) {
      for (const [id, p] of w.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, status: 503, detail: 'shutting down' });
      }
      w.pending.clear();
      if (w.child.connected) w.child.disconnect();
    }
    this.owner.clear();
    await new Promise((r) => setTimeout(r, 200));
    for (const w of this.workers) if (!w.child.killed && w.child.exitCode === null) w.child.kill('SIGTERM');
  }
}
