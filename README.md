# atomik-pine-runner

The service that runs Pine Script® for [Atomik Trading](https://www.atomiktrading.io). It executes
scripts with [PineTS](https://github.com/LuxAlgo/PineTS) inside `isolated-vm` isolates, so a script
has no access to Node.js APIs, the network, the file system or the process environment.

This repository is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`),
the same license as PineTS. It is the complete source of the Pine runner that Atomik users
interact with.

## Status

Early development. `npm run spike` checks that PineTS runs inside the sandbox and that the
sandbox holds against escape attempts, runaway loops and memory exhaustion.

## Requirements

Node.js 24+. `isolated-vm` needs `--no-node-snapshot` on Node 20 and later.

---

Pine Script® and TradingView® are trademarks of TradingView, Inc. This project is not affiliated
with TradingView or LuxAlgo.
