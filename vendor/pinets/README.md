# Vendored PineTS (patched)

`pinets.min.browser.js` is the browser bundle of [LuxAlgo/PineTS](https://github.com/LuxAlgo/PineTS)
**0.10.0** (commit `1f65fa2`), built with `npm run build:prod:browser` after applying
`udt-globals.patch`. The sandbox (`src/sandbox.mjs`) loads this file instead of
`node_modules/pinets`. PineTS is AGPL-3.0 (`LICENSE`); the patch plus the upstream commit are
the corresponding source.

## Why

PineTS 0.10.0 leaves some identifiers unscoped when it compiles Pine to JavaScript, so scripts
that are valid on TradingView die with `ReferenceError: <name> is not defined`. It shows up in
community indicators built on user-defined types (e.g. "ICT HTF Candles"):

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

PineTS's own suite gives the same result with and without the patch (no new failures);
`test/pinets-patches.test.mjs` pins each case here.

## Rebuild / drop

```bash
git clone https://github.com/LuxAlgo/PineTS && cd PineTS && git checkout 1f65fa2
git apply ../atomik-pine-runner/vendor/pinets/udt-globals.patch
npm ci && npm run build:prod:browser   # → dist/pinets.min.browser.js
```

When an upstream release contains these fixes, point `BUNDLE_PATH` back at
`node_modules/pinets/dist/pinets.min.browser.js`, bump `pinets` in `package.json`, and delete
this folder. `test/pinets-patches.test.mjs` must stay green on the new release.
