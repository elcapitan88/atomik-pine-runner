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
| `PINE_LIVE_WARMUP_BARS` | `1500` | history each live session keeps |

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
