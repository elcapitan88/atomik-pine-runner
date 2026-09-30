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
    const child = fork(WORKER_PATH, [], { execArgv: ['--no-node-snapshot'], serialization: 'json' });
    const w = { child, busy: null, ready: false };
    child.on('message', (msg) => {
      if (msg && msg.ready) { w.ready = true; this.#pump(); return; }
      if (w.busy && msg && msg.id === w.busy.id) {
        clearTimeout(w.busy.timer);
        const job = w.busy;
        w.busy = null;
        job.resolve(msg);
        this.#pump();
      }
    });
    child.on('exit', (code, signal) => {
      this.log.warn?.(`sandbox worker exited (code=${code} signal=${signal})`);
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

  #pump() {
    while (this.queue.length) {
      const w = this.workers.find((x) => x.ready && !x.busy);
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

  /** @returns {Promise<object>} the worker's reply */
  run(payload, { timeoutMs }) {
    if (this.closing) return Promise.resolve({ ok: false, status: 503, detail: 'shutting down' });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.queue.push({ id, payload: { ...payload, id }, timeoutMs, resolve, timer: null });
      this.#pump();
    });
  }

  get stats() {
    return { workers: this.workers.length, ready: this.workers.filter((w) => w.ready).length, busy: this.workers.filter((w) => w.busy).length, queued: this.queue.length };
  }

  async close() {
    this.closing = true;
    for (const job of this.queue.splice(0)) job.resolve({ id: job.id, ok: false, status: 503, detail: 'shutting down' });
    for (const w of this.workers) w.child.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    for (const w of this.workers) if (!w.child.killed && w.child.exitCode === null) w.child.kill('SIGTERM');
  }
}
