// Our fixes to PineTS 0.10.0 (vendor/pinets/README.md). Each script is valid on
// TradingView; unpatched PineTS dies on it (ReferenceError / TypeError / parse
// error, or halts on the session string) or silently returns wrong values.
// Keep these green when moving to an upstream release.
import { describe, it, expect } from 'vitest';
import { runPine } from '../src/sandbox.mjs';
import { fetchBars, symbolInfo } from './synthetic.mjs';

const run = (source) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: 200, symbolInfo, fetchBars, timeoutMs: 30_000, maxSeriesBars: 200 });
const lastValue = (r) => r.series.plots[0].values.at(-1);

const UDT = `//@version=6
indicator("p")
type S
    bool show = true
type C
    float x = 1.0
    S settings
var C c1 = C.new(1.0, S.new())
`;

describe('PineTS patches', () => {
  it('a function returns an expression reading a global UDT field', async () => {
    const r = await run(UDT + 'f() => c1.x + 1\nplot(f())');
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(2);
  });

  it('a method on another type reads a global UDT in its return value', async () => {
    const r = await run(UDT + "type H\n    string n = 'h'\nmethod m(H h) =>\n    c1.x > 0 ? 3 : 0\nH h = H.new()\nplot(h.m())");
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(3);
  });

  it('an if-condition inside a function reads a global UDT chain', async () => {
    const r = await run(UDT + 'f() =>\n    int n = 0\n    if c1.settings.show and close > 0\n        n := 5\n    n\nplot(f())');
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(5);
  });

  it('a switch assigned to a field reads the local it belongs to', async () => {
    const r = await run(`//@version=6
indicator("p")
type K
    float n = 1.0
    string d = ''
f() =>
    K k = K.new()
    if close > 0
        k.d := switch
            k.n > 0 => 'pos'
            => 'neg'
    k.d == 'pos' ? 7 : 0
plot(f())`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(7);
  });

  it('a timezone in the session slot of time() is not a session filter', async () => {
    const r = await run('//@version=6\nindicator("p")\nt = time("60", "America/New_York")\nplot(na(t) ? 0 : 1)');
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(1);
  });

  it('a real session string still filters', async () => {
    const r = await run('//@version=6\nindicator("p")\nplot(na(time(timeframe.period, "0000-0001")) ? 0 : 1)');
    expect(r.ok, r.error).toBe(true);
    expect(r.series.plots[0].values.filter((v) => v === 0).length).toBeGreaterThan(100);
  });

  it('str.tostring pads to the pattern\'s integer zeros ("00" → "09")', async () => {
    const r = await run(`//@version=6
indicator("p")
ok = str.tostring(9, "00") == "09" and str.tostring(34, "00") == "34" and str.tostring(-5, "00") == "-05" and str.tostring(1.5, "00.0") == "01.5" and str.tostring(7, "#") == "7"
plot(ok ? 1 : 0)`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(1);
  });

  it('a malformed session string still halts, like TradingView', async () => {
    const r = await run('//@version=6\nindicator("p")\nplot(na(time(timeframe.period, "9am to 5pm")) ? 0 : 1)');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/session/i);
  });

  // ── Compatibility round 2 (community-indicator corpus) ──────────────────

  it('a function parameter named like a global UDT type shadows it', async () => {
    const r = await run(`//@version=5
indicator("p")
type kz
    string title
    float[] store
var a = kz.new("x", array.new_float())
f(kz kz) =>
    array.unshift(kz.store, close)
    array.size(kz.store)
plot(f(a))`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(200);
  });

  it('a user method named like a built-in runs on typed array elements', async () => {
    const r = await run(`//@version=5
indicator("p")
type Gap
    float v
var cnt = 0
method delete(Gap this) =>
    cnt += 1
    this.v
var gaps = array.new<Gap>()
gaps.push(Gap.new(close))
gaps.push(Gap.new(close))
gaps.shift().delete()
for g in gaps
    g.delete()
plot(cnt)`);
    expect(r.ok, r.error).toBe(true);
    // bar i: one shift plus (i + 1) loop elements
    expect(lastValue(r)).toBe(200 + (200 * 201) / 2);
  });

  it('a method call on an na loop element is a no-op', async () => {
    const r = await run('//@version=5\nindicator("p")\nvar boxes = array.new_box(3)\nn = 0\nfor b in boxes\n    b.delete()\n    n += 1\nplot(n)');
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(3);
  });

  it('a local variable named indicator does not hide indicator()', async () => {
    const r = await run('//@version=5\nindicator("p")\ncalc() =>\n    indicator = ""\n    indicator := close > 0 ? "up" : "dn"\n    indicator\nplot(calc() == "up" ? 1 : 0)');
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(1);
  });

  it('request.security in a function called from two places, and by named argument', async () => {
    const r = await run(`//@version=5
indicator("p")
f_tf(_r) =>
    request.security(syminfo.tickerid, _r, close)
a = f_tf("15")
b = f_tf("60")
n = request.security(symbol=syminfo.tickerid, timeframe="60", expression=close)
[t, c] = request.security(syminfo.tickerid, "60", [time, close])
ok = a == request.security(syminfo.tickerid, "15", close) and b == n and c == n and t == request.security(syminfo.tickerid, "60", time)
plot(ok ? 1 : 0)`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(1);
  });

  it('a UDT field history read with a variable index in a call argument', async () => {
    const r = await run('//@version=5\nindicator("p")\ntype B\n    int i = bar_index\nB b = B.new()\nlen = 3\nplot(b.i[len])');
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(199 - 3);
  });

  it('comma statements after a var declaration in a function, nested param chains', async () => {
    const r = await run(`//@version=5
indicator("p")
type S
    int depth = 10
type Z
    S settings
method d(Z this) =>
    var int c = 0, c += 1
    math.floor(this.settings.depth / 2) + c * 0
var z = Z.new(S.new())
plot(z.d())`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(5);
  });

  it('strategy.opentrades members in call arguments', async () => {
    const r = await run(`//@version=5
strategy("p")
if bar_index % 10 == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index % 10 == 5
    strategy.close("L")
plot(math.abs(strategy.opentrades.size(0)) == strategy.position_size or strategy.opentrades == 0 ? 1 : 0)
plot(strategy.closedtrades)`);
    expect(r.ok, r.error).toBe(true);
    expect(r.series.plots[0].values.every((v) => v === 1)).toBe(true);
    expect(r.series.plots[1].values.at(-1)).toBeGreaterThan(10);
  });

  it('bare ta.vwap is ta.vwap(hlc3)', async () => {
    const r = await run(`//@version=5
indicator("p")
src = ta.vwap
plot(src == ta.vwap(hlc3) and not na(src) ? 1 : 0)`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(1);
  });

  it('ta.vwap resets at the CME trading-day open (17:00 CT), not at midnight', async () => {
    // Synthetic NQ: session 1700-1600 America/Chicago, 5m bars, 600 bars = 50 hours.
    const r = await runPine({ source: `//@version=6
indicator("p")
open17 = hour == 17 and minute == 0
mid = hour == 0 and minute == 0
v = ta.vwap
plot(open17 ? (math.abs(v - hlc3) < 1e-9 ? 1 : 0) : na)
plot(mid ? (math.abs(v - hlc3) < 1e-9 ? 1 : 0) : na)
plot(bar_index > 0 and timeframe.change("D") != open17 ? 1 : 0)`, tickerId: 'NQ', timeframe: '5', limit: 600, symbolInfo, fetchBars, timeoutMs: 30_000, maxSeriesBars: 600 });
    expect(r.ok, r.error).toBe(true);
    const [atOpen, atMidnight, mismatch] = r.series.plots.map((p) => p.values.filter((x) => x !== null));
    expect(atOpen.length).toBeGreaterThan(0);
    expect(atOpen.every((x) => x === 1)).toBe(true);
    expect(atMidnight.length).toBeGreaterThan(0);
    expect(atMidnight.every((x) => x === 0)).toBe(true);
    expect(mismatch.every((x) => x === 0)).toBe(true);
  });

  it('strategy.closedtrades[1] is the previous bar count', async () => {
    const r = await run(`//@version=5
strategy("p")
if bar_index % 10 == 0
    strategy.entry("L", strategy.long, qty = 1)
if bar_index % 10 == 5
    strategy.close("L")
ct = strategy.closedtrades + 0
plot(strategy.closedtrades > strategy.closedtrades[1] ? 1 : 0)
plot(ct > ct[1] ? 1 : 0)`);
    expect(r.ok, r.error).toBe(true);
    expect(r.series.plots[0].values).toEqual(r.series.plots[1].values);
    expect(r.series.plots[0].values.filter((x) => x === 1).length).toBeGreaterThan(5);
  });

  it('request.earnings and friends return na (built-in VWAP anchors)', async () => {
    const r = await run(`//@version=5
indicator("p")
e = request.earnings(syminfo.tickerid, earnings.actual, barmerge.gaps_on, barmerge.lookahead_on, ignore_invalid_symbol=true)
d = request.dividends(syminfo.tickerid, dividends.gross, barmerge.gaps_on, barmerge.lookahead_on, ignore_invalid_symbol=true)
plot(na(e) and na(d) ? 1 : 0)`);
    expect(r.ok, r.error).toBe(true);
    expect(lastValue(r)).toBe(1);
  });

  it('a one-off breakeven stop after a partial closes the runner', async () => {
    // Short 3 at 20000; 2 come off at 19995 on the entry bar; the script then
    // moves the runner's stop to breakeven ONCE. Price goes back up to 20010
    // and stays: the runner must stop out, not ride forever waiting for its
    // target (a script that skips setups while in a trade went silent).
    const T0 = Date.UTC(2026, 8, 17, 8, 0);
    const bars = Array.from({ length: 40 }, (_, i) => {
      const p = i >= 20 ? 20010 : 20000;
      return { openTime: T0 + i * 60_000, closeTime: T0 + i * 60_000 + 59_999, open: p, high: p + 1, low: i === 11 ? 19990 : p - 1, close: p, volume: 100 };
    });
    const r = await runPine({ source: `//@version=6
strategy("be", overlay=true, pyramiding=0, initial_capital=10000, margin_long=0, margin_short=0)
var bool beDone = false
if bar_index == 10
    strategy.entry("S", strategy.short, qty = 3)
    strategy.exit("S TP1", "S", qty = 2, limit = 19995, stop = 20050)
    strategy.exit("S TP2", "S", limit = 19950, stop = 20050)
if strategy.position_size < 0 and strategy.position_size > -3 and not beDone
    strategy.exit("S TP2", "S", limit = 19950, stop = strategy.position_avg_price)
    beDone := true`, tickerId: 'NQ', timeframe: '1', limit: 40, symbolInfo, fetchBars: async () => bars, timeoutMs: 30_000 });
    expect(r.ok, r.error).toBe(true);
    expect(r.strategy.opentrades).toEqual([]);
    const runner = r.strategy.closedtrades.find((t) => t.exit_id === 'S TP2');
    expect(runner?.exit_price).toBe(20000);
  });
});
