// Pine alerts on live sessions: scripts' alert()/alertcondition() reach the
// backend (the user's notification bell) and the chart, once each, live only.
import { describe, it, expect, afterEach } from 'vitest';
import { runPine, PineStream } from '../src/sandbox.mjs';
import { LiveManager } from '../src/live/manager.mjs';
import { barsFor, fetchBars, symbolInfo } from './synthetic.mjs';
import { providerFor, upsert, ticksOf, baseOpts } from './stream-harness.mjs';

const SCRIPT = `//@version=6
indicator("Alerts", overlay=true)
up = close > open
if up
    alert("bar up " + str.tostring(bar_index), alert.freq_once_per_bar_close)
alertcondition(not up, "Down bar", "bar closed down")
plot(close)`;

const open = [];
afterEach(() => { for (const s of open.splice(0)) s?.dispose(); });

describe('alerts in the sandbox', () => {
  it('a live run reports the alerts of every bar, newest last', async () => {
    const r = await runPine({ source: SCRIPT, tickerId: 'NQ', timeframe: '5', limit: 300, symbolInfo, fetchBars, timeoutMs: 30_000, liveAlerts: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.alerts.length).toBeGreaterThan(50);
    const last = r.alerts.at(-1);
    expect(['alert', 'alertcondition']).toContain(last.type);
    expect(typeof last.time).toBe('number');
    expect(r.alerts.some((a) => a.type === 'alertcondition' && a.title === 'Down bar' && a.message === 'bar closed down')).toBe(true);
    expect(r.alerts.some((a) => a.type === 'alert' && /^bar up \d+$/.test(a.message))).toBe(true);
  });

  it('a backtest/compile run (not live) keeps PineTS realtime-only alerts', async () => {
    const r = await runPine({ source: SCRIPT, tickerId: 'NQ', timeframe: '5', limit: 300, symbolInfo, fetchBars, timeoutMs: 30_000 });
    expect(r.alerts.length).toBeLessThanOrEqual(2);
  });

  it('a stream fires once_per_bar_close when the bar closes, and each alert once per bar', async () => {
    const all = barsFor('5').slice(0, 260);
    const live = all.slice(0, 250).map((b) => ({ ...b }));
    const s = await PineStream.open({ ...baseOpts, timeframe: '5', source: SCRIPT, limit: live.length, fetchBars: providerFor(live), liveAlerts: true });
    expect(s.ok, s.error).toBe(true);
    open.push(s.stream);
    const seen = [];
    for (const b of all.slice(250)) {
      let first = true;
      for (const t of ticksOf(b)) {
        upsert(live, t);
        const u = await s.stream.update({ newBar: first, maxSeriesBars: 2 });
        expect(u.ok, u.error).toBe(true);
        seen.push(...u.alerts);
        first = false;
      }
    }
    // Every "bar up" alert names a bar that had closed up; none fires twice.
    const ups = seen.filter((a) => a.type === 'alert');
    const keys = ups.map((a) => a.message);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ups.length).toBeGreaterThan(0);
    const conds = seen.filter((a) => a.type === 'alertcondition');
    expect(new Set(conds.map((a) => a.time)).size).toBe(conds.length);
  });
});

describe('alerts on live sessions', () => {
  function setup(results) {
    const posts = [];
    const frames = [];
    const m = new LiveManager({
      config: { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://b', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000, liveIntrabarSeconds: 60, liveHeartbeatSeconds: 60 },
      pool: { run: async () => ({ ok: true, live: results.shift() }) },
      log: { info() {}, warn() {}, error() {} },
      fetchImpl: async (url, opts) => {
        if (url.includes('/internal/pine/active')) return { ok: true, json: async () => [{ strategy_code_id: 3, strategy_key: 'k', symbol: 'NQ', timeframe: '5m', source: '//@version=6\nindicator("x")' }] };
        posts.push({ url, body: JSON.parse(opts.body), key: opts.headers['X-API-Key'] });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
    m.bus = { publishState: async (p, o) => { frames.push({ alerts: p.alerts || null, cache: !o || o.cache !== false }); return true; }, stats: {} };
    m.feed = { setSymbols() {}, stats: {} };
    return { m, posts, frames };
  }
  const T = Date.UTC(2026, 9, 1, 14, 0);
  const bar = (i) => ({ openTime: T + i * 300_000, open: 1, high: 2, low: 0, close: 1, volume: 1, closeTime: T + i * 300_000 + 299_999 });
  const result = (lastI, alerts) => ({ kind: 'indicator', bars: lastI + 1, lastTime: bar(lastI).openTime, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: null, alerts });
  const al = (i, msg) => ({ type: 'alert', id: 'a0', title: null, message: msg, time: bar(i).openTime });

  it('history is a baseline; each new live alert is sent once and rides on a chart frame', async () => {
    const { m, posts, frames } = setup([
      result(2, [al(0, 'old'), al(2, 'at start')]),          // warm-up run: baseline
      result(3, [al(0, 'old'), al(2, 'at start'), al(3, 'new!')]),
      result(3, [al(3, 'new!')]),                             // same bar again: nothing new
    ]);
    await m.sync();
    const s = m.sessions.get('3:NQ');
    s.bars = [0, 1, 2].map(bar);
    s.warmed = true;
    await m.onBarForTest('NQ', 300, bar(2));
    await m.onBarForTest('NQ', 300, bar(3));
    await m.onBarForTest('NQ', 300, bar(3));
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://b/api/v1/internal/pine/alerts');
    expect(posts[0].key).toBe('k');
    expect(posts[0].body).toMatchObject({ strategy_code_id: 3, symbol: 'NQ', timeframe: '5m', alerts: [{ type: 'alert', message: 'new!' }] });
    const withAlerts = frames.filter((f) => f.alerts);
    expect(withAlerts).toEqual([{ alerts: [al(3, 'new!')], cache: false }]);
    expect(m.stats.sessions[0].alerts).toEqual({ sent: 1, dropped: 0 });
  });

  it('at most 20 a minute per session', async () => {
    const many = Array.from({ length: 30 }, (_, k) => al(3, `m${k}`));
    const { m, posts } = setup([result(2, []), result(3, many)]);
    await m.sync();
    const s = m.sessions.get('3:NQ');
    s.bars = [0, 1, 2].map(bar);
    s.warmed = true;
    await m.onBarForTest('NQ', 300, bar(2));
    await m.onBarForTest('NQ', 300, bar(3));
    await new Promise((r) => setTimeout(r, 10));
    expect(posts[0].body.alerts).toHaveLength(20);
    expect(m.stats.sessions[0].alerts).toEqual({ sent: 20, dropped: 10 });
  });
});
