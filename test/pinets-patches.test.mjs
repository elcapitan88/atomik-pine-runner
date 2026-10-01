// Our fixes to PineTS 0.10.0 (vendor/pinets/README.md). Each script is valid on
// TradingView; unpatched PineTS dies with "ReferenceError: <name> is not
// defined" (or halts on the session string). Keep these green when moving to
// an upstream release.
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
});
