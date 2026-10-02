# Vendored PineTS (patched)

`pinets.min.browser.js` is the browser bundle of [LuxAlgo/PineTS](https://github.com/LuxAlgo/PineTS)
**0.10.0** (commit `1f65fa2`), built with `npm run build:prod:browser` after applying
`atomik.patch`. The sandbox (`src/sandbox.mjs`) loads this file instead of
`node_modules/pinets`. PineTS is AGPL-3.0 (`LICENSE`); the patch plus the upstream commit are
the corresponding source.

## Why

Valid TradingView scripts that PineTS 0.10.0 cannot run: it dies with a `ReferenceError` /
`TypeError` / parse error, or silently returns wrong values. Each fix below has a minimal
regression test in PineTS's own suite (in the patch) and a case in
`test/pinets-patches.test.mjs`. They were found by running a corpus of ~45 open-source community
scripts (ICT/SMC, sessions, VWAP, MTF, pivots, volume profile, strategies).

**Round 1 — scripts built on user-defined types** (e.g. "ICT HTF Candles"):

1. **Return expression of a function**: the walker never scoped the base of a member chain, so
   `f() => t.x + 1` (with `t` a global UDT instance) emitted a bare `t.x`.
2. **`if` conditions inside a function**: `transformExpression` only recursed into a one-level
   member (`Signal.Buy`), so `if htf1.settings.show` emitted a bare `htf1`.
3. **`switch` assigned to a field** (`candle.dow := switch …`): the switch's IIFE on the right
   was never traversed, so every identifier inside it leaked.
4. **`time(tf, "America/New_York")`**: a timezone in the session slot halted the script
   ("Invalid session specification"). TradingView accepts it, so it's now ignored as a session.
5. **`str.tostring(9, "00")`** gave `"9"`: each `0` left of the decimal point is a required
   integer digit, so it's now `"09"` (countdown labels read `05:09`, not `5:9`).

A guard (`isScopedContextRef`) keeps 1 and 2 from re-scoping chains that are already context
references (`$.var.…`, `$$.let.…`).

**Round 2 — community-indicator corpus** (one PineTS commit each):

6. **A function parameter named like a global** (`manage(kz kz)` with a UDT type `kz`) resolved
   to the global inside namespace-call arguments, so `array.unshift(kz.store, x)` got `undefined`.
   Parameters are now declared in the function scope.
7. **User methods named like built-ins on array elements**: `gaps.shift().delete()`,
   `gaps.get(i).delete()`, `array.pop(gaps).delete()` and `for g in gaps -> g.delete()` fell to the
   built-in member. The element type now flows from `array.new<T>()`, `array<T>`/`T[]`
   annotations, typed params and UDT fields.
8. **A method call on an `na` loop element** (`for b in boxes -> b.delete()` over `na` slots, or
   drawings created inside a `request.security` context) threw; it is a no-op on TradingView.
9. **A variable named like a built-in function** (a screener's `indicator = ""`, `barcolor = …`)
   hid the built-in: the top-level `indicator(...)` threw "indicator is not defined".
10. **`request.security` inside a function called from several places**: the secondary-context
    slice stopped at the first call site, so later ones threw "Cannot read properties of
    undefined (reading '<idx>')".
11. **`request.security(..., expression = close)` by name** was not recorded per bar (same error).
12. **`time` / `time_close` inside a `request.security` tuple** were stored as helper objects, so
    the values plotted as null.
13. **UDT field history in a call argument** (`label.new(b.i[len], …)`): the variable index leaked
    ("len is not defined"), and before enough history `plot(b.i[3])` lost its title and plotted
    nothing.
14. **Comma statements after a declaration inside a function** (`var line l = na, line.delete(l)`)
    failed to parse.
15. **The shared `undefined` param-index node** was rewritten in place to `$.get(undefined, 0)` by a
    return-expression walker, corrupting every later param call.
16. **Nested field chains on a UDT parameter** (`math.floor(this.settings.depth / 2)`) read the
    Series instead of the instance → "Cannot read properties of undefined".
17. **`strategy.opentrades.size(0)` / `strategy.closedtrades.entry_time(0)`** in call arguments,
    operands and return values stayed bare → "… .size is not a function".
18. **`request.earnings` / `dividends` / `splits` / `financial` / `economic` / `quandl`** did not
    exist (the built-in VWAP's anchors call them on every bar). They return `na`, which is what
    TradingView returns for futures; `request.currency_rate` is 1 for the same currency.
19. **Bare `ta.vwap`** (the built-in variable: `src = ta.vwap`, `plot(ta.vwap)`) was lowered to
    `ta.vwap()` with no source, so every bar was NaN (VWAP-band scripts plotted nothing). It is now
    `ta.vwap(hlc3)`.
20. **`strategy.opentrades` / `strategy.closedtrades` read as a value** (`plot(strategy.closedtrades)`,
    `strategy.opentrades == 0`, `str.tostring(strategy.closedtrades)`): the runtime object was taken
    for plot()'s named-args bag (title lost, values null) and `==` was always false.
21. **VWAP and daily changes on the trading day**: `ta.vwap` (bare and `ta.vwap(src)`) reset at the
    calendar midnight of the exchange timezone and `timeframe.change("D"/"W"/"M")` at 00:00 UTC.
    TradingView uses the TRADING day: for CME futures (session `1700-1600` America/Chicago) that is
    17:00 CT. Both now derive it from `syminfo.session` + `syminfo.timezone` (an overnight session
    rolls at its open; same-day sessions such as `0930-1600` keep the calendar date).
    `ta.vwap(src, anchor[, stdev_mult])` now honours `anchor` and returns `[vwap, upper, lower]`.
    (Other higher-timeframe alignment — `time("D")`, `request.security` daily bars — is still UTC-based.)
22. **History of namespace variables and call results in arguments**: `strategy.closedtrades[1]`,
    `strategy.position_size[1]`, `ta.tr[1]` read the current value (`strategy.closedtrades >
    strategy.closedtrades[1]` never fired), and `plot(ta.sma(close, 3)[1])` plotted nothing.

**Performance**

23. **Timezone time helpers rebuilt `Intl.DateTimeFormat` on every call** (several per bar for scripts
    using `hour()` / `time(tf, session, tz)` in a timezone) and re-converted the same bar time
    repeatedly. One formatter per (site, timezone) plus a bounded memo of recent date parts:
    "ICT Time + Price Levels (TradeJorno)" went from ~21s to ~2.9s for 5,000 bars (90s on the
    production runner before). Results unchanged.

PineTS's own suite gives the same result with and without the patch (no new failures);
`test/pinets-patches.test.mjs` pins the cases here.

## Rebuild / drop

```bash
git clone https://github.com/LuxAlgo/PineTS && cd PineTS && git checkout 1f65fa2
git apply ../atomik-pine-runner/vendor/pinets/atomik.patch
npm ci && npm run build:prod:browser   # → dist/pinets.min.browser.js
```

When an upstream release contains these fixes, point `BUNDLE_PATH` back at
`node_modules/pinets/dist/pinets.min.browser.js`, bump `pinets` in `package.json`, and delete
this folder. `test/pinets-patches.test.mjs` must stay green on the new release.
