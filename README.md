# atomik-pine-runner

The service that runs Pine Script® for [Atomik Trading](https://www.atomiktrading.io). It executes
scripts with [PineTS](https://github.com/LuxAlgo/PineTS) inside `isolated-vm` isolates, so a script
has no access to Node.js APIs, the network, the file system or the process environment.

This repository is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`),
the same license as PineTS. It is the complete source of the Pine runner that Atomik users
interact with.

## What it does

- `POST /v1/compile` — parses and dry-runs a script on a few hundred recent bars. Returns whether it
  is a strategy or an indicator, its title, and any errors with line numbers.
- `POST /v1/backtest` — runs a `strategy()` script over a date range of warehouse bars and returns
  trades, metrics, an equity curve and chart output, in the same shape as Atomik's Python backtests.
- `GET /health`
- Live chart indicators (`src/live/`): every Pine script the backend reports as "shown on a chart"
  gets a session that warms up from the warehouse, aggregates DataHub trades into bars, re-runs the
  script on each closed bar, and publishes its plots, markers, boxes and levels to Redis
  (`strategy_state:{strategy}:{symbol}`), where Atomik's WebSocket relay forwards them to the chart.

Both `/v1` routes need `X-API-Key: <PINE_RUNNER_KEY>`. The service is reached only over Fly's private
network; it never faces the internet.

## How a script runs

```
HTTP request ─▶ server.mjs (auth, validation) ─▶ pool.mjs ─▶ worker.mjs (child process)
                                                              │
                                              sandbox.mjs: isolated-vm isolate
                                              ├─ PineTS bundle (650KB, code-cached)
                                              ├─ the user's script
                                              └─ host bridge: bars in, JSON out
                                                              │
                                              warehouse.mjs (TimescaleDB, read-only)
```

- Each run gets a fresh isolate with a memory limit and a wall-clock limit. A runaway loop or a
  memory bomb ends that run only; the host process is unaffected.
- Sandbox jobs run in a small pool of child processes, so a native crash costs one worker, not the API.
- Market data enters the isolate as copied JSON through one host function. Scripts see the
  standard PineTS provider interface, so `request.security()` works for any timeframe the
  warehouse serves.
- `//@PineTS` JavaScript mode is refused; only Pine Script v5/v6 with a `//@version` header is accepted.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | listen port |
| `PINE_RUNNER_KEY` | — | shared secret (required in production) |
| `TIMESCALE_URL` | — | read-only TimescaleDB connection string |
| `PINE_WORKERS` | `2` | sandbox worker processes |
| `PINE_ISOLATE_MEMORY_MB` | `256` | heap limit per run |
| `PINE_COMPILE_TIMEOUT_MS` | `15000` | wall clock for `/v1/compile` |
| `PINE_BACKTEST_TIMEOUT_MS` | `90000` | wall clock for `/v1/backtest` |
| `PINE_COMPILE_BARS` | `500` | bars used by the compile dry-run |
| `DATAHUB_WS_URL` / `DATAHUB_API_KEY` | — | DataHub trade feed (live indicators) |
| `REDIS_URL` | — | where chart state is published (live indicators) |
| `BACKEND_INTERNAL_URL` | `http://atomik-backend.internal:8000` | lists the scripts to run live |
| `PINE_LIVE_WARMUP_BARS` | `5000` | history each live session keeps (and ships to the chart) |
| `PINE_LIVE_INTRABAR_SECONDS` | `2` | min seconds between forming-bar re-runs per session |
| `PINE_LIVE_HEARTBEAT_SECONDS` | `60` | full-state re-publish so open charts catch up |
| `PINE_TRADING_ENABLED` | `false` | send signals for activated strategies; unset = shadow mode (signals are only logged) |
| `EXECUTION_API_KEY` | `DATAHUB_API_KEY` | key for the backend's signal endpoint (the strategy engine's key) |

## Live trading

A `strategy()` script activated on a broker account runs like a live indicator, and after every
run the script's simulated ledger (open trades, closed trades, pending orders) is diffed against
what the session already signalled:

- a trade that appears open → `BUY`/`SELL` with the bracket taken from its `strategy.exit(...)`
  order (`stop`/`limit` as given, `profit`/`loss` converted from ticks with the symbol's tick size);
- a trade the session entered that shows up closed → `EXIT` (`EXIT_FINAL`, or `EXIT_{pct}` for a
  partial close), also when the script's own stop/target closed it — the backend does nothing if
  a native bracket already flattened the account, and gets flat if none was resting;
- a bracket that moved on a closed bar → bracket amend.

Trades are identified by their entry (id, fill time, direction), never by PineTS's `trade_N`
ordinals, which renumber as the history window slides. The first ledger of a session is a
baseline: nothing from history is ever signalled. Positions the session opened are kept in Redis
(`pine_trading:{code}:{symbol}`) so a restart still sends their exits. Quantity is never sent —
each activation's own quantity applies on the backend. Signals go to the backend's
`/api/v1/trades/execute` with the strategy engine's retry policy (entries give up fast, exits
retry hard) and a stable `signal_id` per logical signal.

With `PINE_TRADING_ENABLED` unset every signal is only logged (`trade[shadow] ...`) and listed
under `live.sessions[].trading.recent` on `/health` — run a strategy this way for a session and
compare against a backtest before letting it trade.

Latency: the first print of a new bar closes the previous one and triggers ONE run over the
closed history plus the forming bar, so an entry that fills at the bar's open is decided one run
after that print (the run's `latency_ms` is on each signal and `lastLatencyMs` on the session).
Trading sessions' runs go to the front of the worker queue, their intrabar cadence is 1s, intrabar
runs only ship the last bars' chart values, and `request.security` data is cached for 20s between
runs. A closed bar no print has followed yet (quiet symbol) is run on its own within a second.

## Development

Node.js 24+. `isolated-vm` needs `--no-node-snapshot` on Node 20 and later (the npm scripts pass it).

```bash
npm ci
npm test          # unit + sandbox + HTTP contract tests (synthetic bars, no database)
npm run spike     # readable go/no-go report of the sandbox
npm start         # needs TIMESCALE_URL and PINE_RUNNER_KEY
```

Private strategy scripts used for parity checks belong in the git-ignored `private-fixtures/`
directory. Never commit them.

---

Pine Script® and TradingView® are trademarks of TradingView, Inc. This project is not affiliated
with TradingView or LuxAlgo.
