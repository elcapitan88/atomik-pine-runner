// Go/no-go check: does PineTS run inside an isolated-vm isolate, and does the
// sandbox hold? Uses synthetic bars and generic scripts only (no private strategies).
// Exits 1 if any check fails.
import { runPine } from '../src/sandbox.mjs';

// ---- deterministic synthetic 1m bars (20 days) ------------------------------
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const START = Date.UTC(2026, 5, 1, 0, 0);
const BASE_1M = [];
{
  let p = 20000;
  for (let i = 0; i < 60 * 24 * 20; i++) {
    const o = p;
    const c = o + (rnd() - 0.5) * 8;
    const t = START + i * 60_000;
    BASE_1M.push({ openTime: t, open: o, high: Math.max(o, c) + rnd() * 3, low: Math.min(o, c) - rnd() * 3, close: c, volume: 100 + rnd() * 900, closeTime: t + 59_999 });
    p = c;
  }
}
const TF_MINUTES = { '1': 1, '5': 5, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, D: 1440, '1D': 1440 };
const aggCache = new Map();
function barsFor(tf) {
  const minutes = TF_MINUTES[tf];
  if (!minutes) throw new Error(`unsupported timeframe ${tf}`);
  if (aggCache.has(minutes)) return aggCache.get(minutes);
  const ms = minutes * 60_000;
  const out = [];
  for (const b of BASE_1M) {
    const k = Math.floor(b.openTime / ms) * ms;
    const last = out[out.length - 1];
    if (!last || last.openTime !== k) out.push({ ...b, openTime: k, closeTime: k + ms - 1 });
    else { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume; }
  }
  aggCache.set(minutes, out);
  return out;
}
async function fetchBars(_tickerId, timeframe, limit, sDate, eDate) {
  let bars = barsFor(String(timeframe));
  if (sDate) bars = bars.filter((b) => b.openTime >= sDate);
  if (eDate) bars = bars.filter((b) => b.openTime <= eDate);
  if (limit) bars = bars.slice(-limit);
  return bars;
}
const symbolInfo = { ticker: 'NQ1!', tickerid: 'CME_MINI:NQ1!', root: 'NQ', prefix: 'CME_MINI', type: 'futures', mintick: 0.25, pointvalue: 20, minmove: 1, pricescale: 100, currency: 'USD', timezone: 'America/Chicago', session: '1700-1600', description: 'E-mini Nasdaq-100' };
const run = (source, extra = {}) => runPine({ source, tickerId: 'CME_MINI:NQ1!', timeframe: '5', limit: 2000, symbolInfo, fetchBars, ...extra });

// ---- scripts -----------------------------------------------------------------
const S = {
  ema_cross_strategy: `//@version=6
strategy("EMA cross", overlay=true)
f = ta.ema(close, 9)
s = ta.ema(close, 21)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
    strategy.exit("LX", "L", profit=80, loss=40)
if ta.crossunder(f, s)
    strategy.close("L")
plot(f, "fast")`,
  mtf_security: `//@version=6
indicator("MTF")
plot(request.security(syminfo.tickerid, "60", ta.ema(close, 20)), "h1")
plot(request.security(syminfo.tickerid, "240", close), "h4")`,
  fvg_boxes: `//@version=6
indicator("FVG", overlay=true, max_boxes_count=50)
if low > high[2]
    box.new(bar_index - 2, low, bar_index, high[2])
if high < low[2]
    box.new(bar_index - 2, low[2], bar_index, high)`,
  v6_types_maps_while: `//@version=6
indicator("v6")
type Pt
    float p
var m = map.new<string, float>()
var pt = Pt.new(0.0)
pt.p := pt.p + 1
m.put("last", close)
i = 0
s = 0.0
while i < 3
    s += close[i]
    i += 1
plot(pt.p + m.get("last") * 0 + s * 0, "count")`,
  probe_env_read: `//@version=6
indicator("env")
v = process.env.PATH
plot(str.length(v), "len")`,
  probe_js_mode: `//@PineTS
indicator('js');
globalThis.__probe = [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof Deno].join(',');
plot(close, 'c');`,
  probe_js_infinite_loop: `//@PineTS
indicator('spin');
while (true) {}`,
  probe_pine_nested_loops: `//@version=6
indicator("nested")
x = 0.0
for i = 0 to 100000
    for j = 0 to 100000
        x += 1
plot(x)`,
  probe_memory_bomb: `//@version=6
indicator("mem")
var a = array.new_float(0)
for i = 0 to 200000
    array.push(a, i)
plot(array.size(a))`,
};

// ---- checks ------------------------------------------------------------------
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// SPIKE_KILL selects which force-kill probes run: both (default) | timeout | memory | none.
// Used to find which isolate teardown path misbehaves on a given platform.
const KILL = process.env.SPIKE_KILL || 'both';
if (!['both', 'timeout'].includes(KILL)) delete S.probe_pine_nested_loops;
if (!['both', 'memory'].includes(KILL)) delete S.probe_memory_bomb;
console.log(`SPIKE_KILL=${KILL}`);

const r = {};
for (const [name, src] of Object.entries(S)) {
  const timeoutMs = name.startsWith('probe_') ? 5_000 : 30_000;
  r[name] = await run(src, { timeoutMs });
  const x = r[name];
  console.log(`  ${name}: ok=${x.ok} ms=${x.ms}${x.setupMs != null ? ` setup=${x.setupMs}` : ''} ${x.ok ? `plots=${JSON.stringify(x.plots)} trades=${x.trades}` : `reason=${x.reason} error=${x.error}`}`);
}

check('ema_cross_strategy runs + trades', r.ema_cross_strategy.ok && r.ema_cross_strategy.trades > 0, `trades=${r.ema_cross_strategy.trades}`);
check('request.security 60 + 240 via host provider', r.mtf_security.ok && r.mtf_security.plots?.h1 > 0 && r.mtf_security.plots?.h4 > 0, JSON.stringify(r.mtf_security.plots || r.mtf_security.error));
check('box drawings come back', r.fvg_boxes.ok && r.fvg_boxes.plots?.__boxes__ > 0, `boxes=${r.fvg_boxes.plots?.__boxes__}`);
check('v6 types/maps/while', r.v6_types_maps_while.ok, r.v6_types_maps_while.error || 'ok');
check('process.env NOT readable', !r.probe_env_read.ok || !(r.probe_env_read.plots?.len > 0), r.probe_env_read.error || JSON.stringify(r.probe_env_read.plots));
check('no Node/web globals in isolate', r.probe_js_mode.ok && r.probe_js_mode.probe === 'undefined,undefined,undefined,undefined,undefined', `probe=${r.probe_js_mode.probe} ${r.probe_js_mode.error || ''}`);
check('raw JS infinite loop stopped', !r.probe_js_infinite_loop.ok && r.probe_js_infinite_loop.ms < 8_000, `reason=${r.probe_js_infinite_loop.reason} ms=${r.probe_js_infinite_loop.ms}`);
if (r.probe_pine_nested_loops) {
  check('Pine nested loops killed by wall-clock timeout', r.probe_pine_nested_loops.reason === 'timeout' && r.probe_pine_nested_loops.ms < 8_000, `reason=${r.probe_pine_nested_loops.reason} ms=${r.probe_pine_nested_loops.ms} ${r.probe_pine_nested_loops.error || ''}`);
}
if (r.probe_memory_bomb) {
  check('memory bomb contained', !r.probe_memory_bomb.ok, `reason=${r.probe_memory_bomb.reason} ${r.probe_memory_bomb.error || ''}`);
}

// Host must still be healthy after the probes.
const after = await run(S.ema_cross_strategy);
check('host healthy after probes', after.ok && after.trades === r.ema_cross_strategy.trades, `trades=${after.trades} ms=${after.ms} setup=${after.setupMs}`);

// Throughput: 20 days of 1m bars with the strategy emulator.
const perf = await runPine({ source: S.ema_cross_strategy, tickerId: 'CME_MINI:NQ1!', timeframe: '1', limit: BASE_1M.length, symbolInfo, fetchBars, timeoutMs: 60_000, memoryMb: 256 });
check('throughput 28.8k 1m bars', perf.ok, `ms=${perf.ms} setup=${perf.setupMs} bars=${perf.bars} (${perf.ok ? ((perf.ms - perf.setupMs) / perf.bars * 1000).toFixed(1) : '-'} us/bar) trades=${perf.trades}`);

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
// Let the event loop drain instead of process.exit(), so isolated-vm tears down normally.
process.exitCode = failed.length ? 1 : 0;
