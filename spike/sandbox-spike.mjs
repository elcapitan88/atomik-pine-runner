// Go/no-go check: does PineTS run inside an isolated-vm isolate, and does the
// sandbox hold? Uses synthetic bars and generic scripts only (no private strategies).
// Sets a non-zero exit code if any check fails. `npm test` covers the same ground
// as assertions; this prints a readable report for CI logs.
import { runPine } from '../src/sandbox.mjs';
import { fetchBars, symbolInfo, SCRIPTS, BASE_1M } from '../test/synthetic.mjs';

const S = { ...SCRIPTS };
delete S.bad_syntax;
delete S.bad_function;
delete S.short_strategy;
delete S.levels;

// SPIKE_KILL selects which force-kill probes run: both (default) | timeout | memory | none.
const KILL = process.env.SPIKE_KILL || 'both';
if (!['both', 'timeout'].includes(KILL)) delete S.probe_pine_nested_loops;
if (!['both', 'memory'].includes(KILL)) delete S.probe_memory_bomb;
console.log(`SPIKE_KILL=${KILL}`);

const run = (source, extra = {}) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: 2000, symbolInfo, fetchBars, ...extra });
const count = (x, k) => x.plots?.[k]?.points?.length ?? 0;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const r = {};
for (const [name, src] of Object.entries(S)) {
  const timeoutMs = name.startsWith('probe_') ? 5_000 : 30_000;
  r[name] = await run(src, { timeoutMs });
  const x = r[name];
  console.log(`  ${name}: ok=${x.ok} ms=${x.ms}${x.setupMs != null ? ` setup=${x.setupMs}` : ''} ${x.ok ? `plots=${Object.keys(x.plots).join('|')} boxes=${x.drawings.boxes.length} trades=${x.strategy ? x.strategy.closedtrades.length : '-'}` : `reason=${x.reason} error=${x.error}`}`);
}

check('ema_cross_strategy runs + trades', r.ema_cross_strategy.ok && r.ema_cross_strategy.strategy.closedtrades.length > 0, `trades=${r.ema_cross_strategy.strategy?.closedtrades.length}`);
check('request.security 60 + 240 via host provider', r.mtf_security.ok && count(r.mtf_security, 'h1') > 0 && count(r.mtf_security, 'h4') > 0, `h1=${count(r.mtf_security, 'h1')} h4=${count(r.mtf_security, 'h4')}`);
check('box drawings come back', r.fvg_boxes.ok && r.fvg_boxes.drawings.boxes.length > 0, `boxes=${r.fvg_boxes.drawings?.boxes.length}`);
check('v6 types/maps/while', r.v6_types_maps_while.ok, r.v6_types_maps_while.error || 'ok');
check('process.env NOT readable', !r.probe_env_read.ok, r.probe_env_read.error || 'readable!');
check('no Node/web globals in isolate', r.probe_js_mode.ok && r.probe_js_mode.probe === 'undefined,undefined,undefined,undefined,undefined', `probe=${r.probe_js_mode.probe} ${r.probe_js_mode.error || ''}`);
check('raw JS infinite loop stopped', !r.probe_js_infinite_loop.ok && r.probe_js_infinite_loop.ms < 8_000, `reason=${r.probe_js_infinite_loop.reason} ms=${r.probe_js_infinite_loop.ms}`);
if (r.probe_pine_nested_loops) {
  check('Pine nested loops killed by wall-clock timeout', r.probe_pine_nested_loops.reason === 'timeout' && r.probe_pine_nested_loops.ms < 8_000, `reason=${r.probe_pine_nested_loops.reason} ms=${r.probe_pine_nested_loops.ms}`);
}
if (r.probe_memory_bomb) {
  check('memory bomb contained', !r.probe_memory_bomb.ok, `reason=${r.probe_memory_bomb.reason}`);
}

const after = await run(S.ema_cross_strategy);
check('host healthy after probes', after.ok && after.strategy.closedtrades.length === r.ema_cross_strategy.strategy.closedtrades.length, `trades=${after.strategy?.closedtrades.length} ms=${after.ms} setup=${after.setupMs}`);

const perf = await runPine({ source: S.ema_cross_strategy, tickerId: 'NQ', timeframe: '1', limit: BASE_1M.length, symbolInfo, fetchBars, timeoutMs: 60_000, memoryMb: 256 });
check('throughput 28.8k 1m bars', perf.ok, `ms=${perf.ms} setup=${perf.setupMs} bars=${perf.bars} (${perf.ok ? ((perf.ms - perf.setupMs) / perf.bars * 1000).toFixed(1) : '-'} us/bar) trades=${perf.strategy?.closedtrades.length}`);

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
// Let the event loop drain instead of process.exit(), so isolated-vm tears down normally.
process.exitCode = failed.length ? 1 : 0;
