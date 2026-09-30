// StreamHost with real worker processes: streams open and update in a
// dedicated worker, stick to it, respect the stream limit, and a crashed
// worker surfaces as stream_lost / stream_missing (the manager then reopens).
import { describe, it, expect, afterEach } from 'vitest';
import { StreamHost } from '../src/streams.mjs';
import { barsFor, SCRIPTS } from './synthetic.mjs';

const BARS = barsFor('5').slice(0, 800);
const env = { ...process.env, PINE_SYNTHETIC_DATA: '1', ENVIRONMENT: 'test', TIMESCALE_URL: '' };
const hosts = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.close(); });

const openPayload = (source, bars = BARS.slice(0, 600)) => ({ source, symbol: 'NQ', timeframe: '5m', bars, symbol_info: { mintick: 0.25 }, max_series_bars: 50 });

describe('StreamHost', () => {
  it('opens a stream, then updates it with only the new bars', async () => {
    const host = new StreamHost({ size: 1, maxStreams: 4, env, log: { warn() {}, error() {} } });
    hosts.push(host);
    const opened = await host.open('9:NQ', openPayload(SCRIPTS.ema_cross_strategy), { timeoutMs: 20_000 });
    expect(opened.ok, opened.detail).toBe(true);
    expect(opened.live.bars).toBe(600);
    expect(opened.live.kind).toBe('strategy');
    expect(opened.heap_mb).toBeGreaterThan(0);

    const forming = { ...BARS[600], high: BARS[600].open, low: BARS[600].open, close: BARS[600].open };
    const u1 = await host.update('9:NQ', { bars: [BARS[599], forming], new_bar: true, max_series_bars: 2 }, { timeoutMs: 20_000 });
    expect(u1.ok, u1.detail).toBe(true);
    expect(u1.live.bars).toBe(601);
    expect(u1.live.series.times.length).toBe(2);
    const u2 = await host.update('9:NQ', { bars: [BARS[600]], new_bar: false, max_series_bars: 2 }, { timeoutMs: 20_000 });
    expect(u2.ok, u2.detail).toBe(true);
    expect(u2.live.bars).toBe(601);
    expect(u2.live.ms).toBeLessThan(opened.live.ms);
    expect(host.stats).toMatchObject({ workers: 1, streams: 1 });
  });

  it('update without an open stream says so', async () => {
    const host = new StreamHost({ size: 1, env, log: { warn() {}, error() {} } });
    hosts.push(host);
    const r = await host.update('nope', { bars: [] }, { timeoutMs: 5_000 });
    expect(r).toMatchObject({ ok: false, stream_missing: true });
  });

  it('refuses streams beyond the limit (capacity)', async () => {
    const host = new StreamHost({ size: 1, maxStreams: 1, env, log: { warn() {}, error() {} } });
    hosts.push(host);
    const a = await host.open('a', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 });
    expect(a.ok, a.detail).toBe(true);
    const b = await host.open('b', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 });
    expect(b).toMatchObject({ ok: false, capacity: true });
    // Reopening the SAME key is not a new stream.
    const again = await host.open('a', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 });
    expect(again.ok, again.detail).toBe(true);
    host.closeStream('a');
    const c = await host.open('b', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 });
    expect(c.ok, c.detail).toBe(true);
  });

  it('a script error on update loses the stream; the next update reports it missing', async () => {
    const host = new StreamHost({ size: 1, env, log: { warn() {}, error() {} } });
    hosts.push(host);
    const src = `//@version=6
indicator("boom")
if bar_index >= 600
    runtime.error("boom")
plot(close)`;
    expect((await host.open('x', openPayload(src), { timeoutMs: 20_000 })).ok).toBe(true);
    const r = await host.update('x', { bars: [BARS[599], BARS[600]], new_bar: true }, { timeoutMs: 20_000 });
    expect(r).toMatchObject({ ok: false, stream_lost: true });
    expect(r.detail).toMatch(/boom/);
    expect(host.has('x')).toBe(false);
    expect((await host.update('x', { bars: [] }, { timeoutMs: 5_000 })).stream_missing).toBe(true);
  });

  it('a crashed worker loses its streams and is replaced', async () => {
    const host = new StreamHost({ size: 1, env, log: { warn() {}, error() {} } });
    hosts.push(host);
    expect((await host.open('k', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 })).ok).toBe(true);
    host.workers[0].child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    expect(host.has('k')).toBe(false);
    expect(host.stats.crashes).toBe(1);
    expect((await host.update('k', { bars: [] }, { timeoutMs: 5_000 })).stream_missing).toBe(true);
    // The replacement worker takes new streams.
    await new Promise((r) => setTimeout(r, 1_000));
    const again = await host.open('k', openPayload(SCRIPTS.fvg_boxes), { timeoutMs: 20_000 });
    expect(again.ok, again.detail).toBe(true);
  });
});
