// Deterministic synthetic bars + a provider bridge, shared by tests and the spike.
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const START = Date.UTC(2026, 5, 1, 0, 0);

export const BASE_1M = [];
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

const TF_MINUTES = { '1': 1, '2': 2, '3': 3, '5': 5, '10': 10, '15': 15, '30': 30, '60': 60, '120': 120, '240': 240, D: 1440, '1D': 1440 };
const aggCache = new Map();

export function barsFor(tf) {
  const minutes = TF_MINUTES[String(tf)];
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

export async function fetchBars(_tickerId, timeframe, limit, sDate, eDate) {
  let bars = barsFor(String(timeframe));
  if (sDate) bars = bars.filter((b) => b.openTime >= sDate);
  if (eDate) bars = bars.filter((b) => b.openTime <= eDate);
  if (limit) bars = bars.slice(-limit);
  return bars;
}

export const symbolInfo = { ticker: 'NQ', tickerid: 'CME_MINI:NQ', root: 'NQ', prefix: 'CME_MINI', type: 'futures', mintick: 0.25, pointvalue: 20, minmove: 1, pricescale: 100, currency: 'USD', timezone: 'America/Chicago', session: '1700-1600', description: 'E-mini Nasdaq-100' };

export const SCRIPTS = {
  ema_cross_strategy: `//@version=6
strategy("EMA cross", overlay=true)
f = ta.ema(close, 9)
s = ta.ema(close, 21)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
    strategy.exit("LX", "L", profit=80, loss=40)
if ta.crossunder(f, s)
    strategy.close("L")
plot(f, "fast")
plotshape(ta.crossover(f, s), "Buy", shape.triangleup, location.belowbar, color.green)`,
  short_strategy: `//@version=6
strategy("Short only", overlay=true)
f = ta.ema(close, 5)
s = ta.ema(close, 20)
if ta.crossunder(f, s)
    strategy.entry("S", strategy.short)
if ta.crossover(f, s)
    strategy.close("S")`,
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
  levels: `//@version=6
indicator("Levels", overlay=true)
var float pdh = na
if ta.change(time("D")) != 0
    pdh := high[1]
if barstate.islast
    line.new(bar_index - 50, pdh, bar_index, pdh, xloc=xloc.bar_index)
    label.new(bar_index, pdh, "PDH")`,
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
  bad_syntax: `//@version=6
indicator("x")
x = = 1
plot(close)`,
  bad_function: `//@version=6
indicator("x")
plot(ta.nope(close))`,
};
