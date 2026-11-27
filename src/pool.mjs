// A small pool of sandbox worker processes with a FIFO queue. A worker that
// dies (native crash, hard kill after a hung job) is replaced; its job fails.
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const WORKER_PATH = new URL('./worker.mjs', import.meta.url);

export class WorkerPool {
  constructor({ size = 2, jobGraceMs = 5_000, log = console } = {}) {
    this.size = size;
    this.jobGraceMs = jobGraceMs;
    this.log = log;
    this.workers = [];
    this.queue = [];
    this.closing = false;
    for (let i = 0; i < size; i++) this.#spawn();
  }

  #spawn() {
    // --expose-gc: the worker collects host garbage itself (worker.mjs).
    const child = fork(WORKER_PATH, [], { execArgv: ['--no-node-snapshot', '--expose-gc'], serialization: 'json' });
    const w = { child, busy: null, ready: false, mem: null, retiring: false };
    child.on('message', (msg) => {
      if (msg && msg.ready) { w.ready = true; this.#pump(); return; }
      if (w.busy && msg && msg.id === w.busy.id) {
        clearTimeout(w.busy.timer);
        const job = w.busy;
        w.busy = null;
        if (msg.mem) w.mem = msg.mem;
        job.resolve(msg);
        if (w.retiring) this.#retire(w);
        this.#pump();
      }
    });
    child.on('exit', (code, signal) => {
      if (w.retiring) this.log.info?.('sandbox worker replaced (recycle)');
      else this.log.warn?.(`sandbox worker exited (code=${code} signal=${signal})`);
      if (w.busy) {
        clearTimeout(w.busy.timer);
        w.busy.resolve({ id: w.busy.id, ok: false, status: 500, detail: 'sandbox worker crashed' });
        w.busy = null;
      }
      this.workers = this.workers.filter((x) => x !== w);
      if (!this.closing) setTimeout(() => this.#spawn(), 500);
    });
    this.workers.push(w);
  }

  // A retiring worker takes no new job; once idle it exits and the exit
  // handler spawns its replacement.
  #retire(w) {
    w.retiring = true;
    if (w.busy || !w.child.connected) return;
    w.ready = false;
    w.child.disconnect();
    setTimeout(() => { if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill('SIGTERM'); }, 10_000).unref();
  }

  /**
   * Replace every worker (the daily recycle, or the memory watchdog with one
   * worker). A busy worker finishes its job first; nothing queued is lost.
   */
  recycle(which = null) {
    for (const w of which ? [which] : [...this.workers]) this.#retire(w);
  }

  /** The worker using the most memory, from its last reply (or null). */
  largest() {
    return this.workers.filter((w) => w.mem && !w.retiring).sort((a, b) => b.mem.rss_mb - a.mem.rss_mb)[0] || null;
  }

  #pump() {
    while (this.queue.length) {
      const w = this.workers.find((x) => x.ready && !x.busy && !x.retiring);
      if (!w) return;
      const job = this.queue.shift();
      w.busy = job;
      job.timer = setTimeout(() => {
        this.log.error?.(`sandbox worker hung on job ${job.id}; killing`);
        w.child.kill('SIGKILL');
      }, job.timeoutMs + this.jobGraceMs);
      w.child.send(job.payload);
    }
  }

  /**
   * @param {object} payload
   * @param {{timeoutMs: number, priority?: boolean}} opts  priority jobs go to the
   *   front of the queue (a trading session's run must not wait behind chart runs)
   * @returns {Promise<object>} the worker's reply
   */
  run(payload, { timeoutMs, priority = false }) {
    if (this.closing) return Promise.resolve({ ok: false, status: 503, detail: 'shutting down' });
    const id = randomUUID();
    return new Promise((resolve) => {
      const job = { id, payload: { ...payload, id }, timeoutMs, resolve, timer: null };
      if (priority) this.queue.unshift(job); else this.queue.push(job);
      this.#pump();
    });
  }

  get stats() {
    return {
      workers: this.workers.length, ready: this.workers.filter((w) => w.ready).length, busy: this.workers.filter((w) => w.busy).length, queued: this.queue.length,
      memory: this.workers.map((w) => w.mem),
    };
  }

  async close() {
    this.closing = true;
    for (const job of this.queue.splice(0)) job.resolve({ id: job.id, ok: false, status: 503, detail: 'shutting down' });
    for (const w of this.workers) w.child.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    for (const w of this.workers) if (!w.child.killed && w.child.exitCode === null) w.child.kill('SIGTERM');
  }
}
