# Vendored PineTS (patched)

`pinets.min.browser.js` is the browser bundle of [LuxAlgo/PineTS](https://github.com/LuxAlgo/PineTS)
**0.14.0** (tag `v0.14.0`, commit `d65a16c`), built with `npm run build:prod:browser` after applying
`atomik.patch`. The sandbox (`src/sandbox.mjs`) loads this file instead of `node_modules/pinets`.
PineTS is AGPL-3.0 (`LICENSE`); the patch plus the upstream tag are the corresponding source.

A clean rebuild (fresh clone at `v0.14.0`, `git apply atomik.patch`, build) is byte-identical to the
vendored bundle.

## What we still patch (0.14.0)

Valid TradingView scripts that PineTS 0.14.0 still gets wrong, plus what the sandbox needs. Each has a
case in `test/pinets-patches.test.mjs` (or the test named).

1. **A timezone in the session slot of `time()`** (`time("60", "America/New_York")`): accepted by
   TradingView, halted PineTS ("Invalid session specification"). Ignored as a session filter.
2. **A function parameter named like a global** (`f(kz kz)` with a UDT type `kz`): `kz.store` in a
   namespace call's arguments resolved to the global type. Parameters are declared in the function
   scope under their own name (`ScopeManager.declareFunctionParam`).
3. **A method call on an `na` loop element** (`for b in boxes` → `b.delete()` over `array.new_box(3)`):
   threw; a no-op on TradingView. Loop elements count as possibly-na receivers.
4. **A variable named like a built-in function** (`indicator = ""`, `barcolor = …`): collided with the
   built-in ("Undeclared identifier"). Added to the rename list.
5. **`ta.vwap` resets on the trading day** (17:00 CT for CME's `1700-1600`), the same key PineTS's own
   `timeframe.change("D")` uses, not the calendar date.
6. **Timezone formatters are cached** and recent date parts remembered (`src/utils/intlCache.ts`):
   0.14 still builds an `Intl.DateTimeFormat` per call (several per bar for `hour()` / `time(tf, s, tz)`).
7. **A `var` initializer that calls a user function runs once** (`var tbl = ml.init_table()` made a
   table per bar). The call and the hoisted statements feeding it move into the thunk `initVar` runs on
   the first bar. Test: `tests/transpiler/var-init-user-function-once.test.ts` (in the patch).
8. **Execution budget**: `ExecutionBudget` is exported, and its bar and function-call limits (fixed
   100,000 / 500,000 in 0.14) are options. A run's budget is shared by the whole run, and a live stream
   is one run that lasts for days; the sandbox lifts every limit (`__budget()` in `sandbox.mjs`): the
   isolate's memory limit and the host's wall clock bound a run, as before.
9. **Drawing id counters** are readable / settable (`snapshotDrawingIds` / `restoreDrawingIds`): 0.14
   numbers drawings from module-level counters, so a stream rolls them back with a discarded tick and
   keeps them out of a `request.security` rebuild; ids then match a one-shot run.

Sandbox-side for 0.14 (`src/sandbox.mjs`): `AbortController` / `AbortSignal` / `TextEncoder` /
`TextDecoder` for the isolate, deadline timers (> 1s) never fire, drawing stores read through
`values()`, and the stream's deep restore runs children first (0.14 guards a matrix with a Proxy that
copies an assigned row).

## Fixed upstream since 0.10 (patches dropped)

UDT field chains in function returns / `if` conditions / `switch` assignments, `str.tostring(9, "00")`,
user methods named like built-ins on typed array elements, `request.security` from several call sites
and by named argument, `time` / `time_close` in security tuples, UDT field history in call arguments,
comma statements after declarations, the shared param-index node, `strategy.opentrades` /
`closedtrades` members and history, `request.earnings` & co., bare `ta.vwap`, call-result history in
arguments, the one-off breakeven stop. Their regression tests in `test/pinets-patches.test.mjs` stay.

## Behaviour that changed with 0.14 (vs 0.10)

Checked on every private fixture and on the live sessions' scripts, one-shot, 0.10 vs 0.14:

- **`when=`** (Pine v5 `strategy.entry(..., when=cond)`) is honoured. 0.10 ignored it and entered on
  every bar: a script built on it traded every bar instead of when its condition held.
- **Broker prices on the tick grid** (TradingView parity): fills, limit / stop prices are moved to the
  nearest tick. A take-profit computed off the grid fills a tick differently than on 0.10.
- **Exit orders of a flat position are cancelled** (as on TradingView); 0.10 left them pending.
- **`process` and other unknown identifiers** are refused at compile time ("Undeclared identifier").

## Rebuild / drop

```bash
git clone https://github.com/LuxAlgo/PineTS && cd PineTS && git checkout v0.14.0
git apply ../atomik-pine-runner/vendor/pinets/atomik.patch
npm ci && npm run build:prod:browser   # → dist/pinets.min.browser.js
```

When an upstream release contains these fixes, point `BUNDLE_PATH` back at
`node_modules/pinets/dist/pinets.min.browser.js`, bump `pinets` in `package.json`, and delete this
folder. `test/pinets-patches.test.mjs` must stay green on the new release.
