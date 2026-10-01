// Script inputs (TradingView's settings dialog): the runner reports what a
// script declares, and runs it with the user's overrides — in one-shot runs,
// streams, and request.security's higher-timeframe copy alike.
import { describe, it, expect, afterEach } from 'vitest';
import { runPine, PineStream } from '../src/sandbox.mjs';
import { LiveManager } from '../src/live/manager.mjs';
import { fetchBars, symbolInfo } from './synthetic.mjs';
import { streamThrough, plotValues, trades } from './stream-harness.mjs';

const run = (source, inputs = null) => runPine({ source, tickerId: 'NQ', timeframe: '5', limit: 800, symbolInfo, fetchBars, timeoutMs: 30_000, memoryMb: 128, maxSeriesBars: 800, inputs });

const SCRIPT = `//@version=6
indicator("Inputs", overlay=true)
len = input.int(10, "Length", minval=1, maxval=200, group="Main", tooltip="Bars")
src = input.source(close, "Source")
mult = input.float(1.5, "Mult", step=0.5)
show = input.bool(true, "Show")
mode = input.string("EMA", "Mode", options=["EMA", "SMA"])
col = input.color(color.red, "Colour")
ma = mode == "EMA" ? ta.ema(src, len) : ta.sma(src, len)
plot(show ? ma * mult / mult : na, "ma", color=col)`;

const open = [];
afterEach(() => { for (const s of open.splice(0)) s?.dispose(); });

describe('script inputs', () => {
  it('reports every declared input with type, default, range and options', async () => {
    const r = await run(SCRIPT);
    expect(r.ok, r.error).toBe(true);
    const byTitle = Object.fromEntries(r.inputs.map((i) => [i.title, i]));
    expect(Object.keys(byTitle)).toEqual(['Length', 'Source', 'Mult', 'Show', 'Mode', 'Colour']);
    expect(byTitle.Length).toMatchObject({ id: 'in_0', type: 'int', defval: 10, minval: 1, maxval: 200, group: 'Main', tooltip: 'Bars' });
    expect(byTitle.Source).toMatchObject({ type: 'source', defval: 'close' });
    expect(byTitle.Source.options).toContain('hl2');
    expect(byTitle.Mult).toMatchObject({ type: 'float', defval: 1.5, step: 0.5 });
    expect(byTitle.Show).toMatchObject({ type: 'bool', defval: true });
    expect(byTitle.Mode).toMatchObject({ type: 'string', defval: 'EMA', options: ['EMA', 'SMA'] });
    expect(byTitle.Colour.type).toBe('color');
  });

  it('overrides change the result exactly like editing the defaults', async () => {
    const edited = SCRIPT.replace('input.int(10,', 'input.int(30,').replace('input.string("EMA",', 'input.string("SMA",').replace('input.source(close,', 'input.source(hl2,');
    const [a, b, base] = await Promise.all([
      run(SCRIPT, { in_0: 30, in_4: 'SMA', in_1: 'hl2' }),
      run(edited),
      run(SCRIPT),
    ]);
    expect(a.ok && b.ok && base.ok).toBe(true);
    expect(plotValues(a)).toEqual(plotValues(b));
    expect(plotValues(a)).not.toEqual(plotValues(base));
    // The reported defaults stay the script's own.
    expect(a.inputs.find((i) => i.id === 'in_0').defval).toBe(10);
  });

  it('a bool override can switch a plot off', async () => {
    const r = await run(SCRIPT, { in_3: false });
    expect(r.series.plots[0].values.every((v) => v == null)).toBe(true);
  });

  it('request.security uses the overrides on the higher timeframe too', async () => {
    const src = `//@version=6
indicator("MTF len")
len = input.int(5, "Length")
plot(request.security(syminfo.tickerid, "60", ta.ema(close, len)), "h1")`;
    const [a, b] = await Promise.all([run(src, { in_0: 40 }), run(src.replace('input.int(5,', 'input.int(40,'))]);
    expect(a.ok && b.ok).toBe(true);
    expect(plotValues(a)).toEqual(plotValues(b));
  });

  it('a stream runs with the overrides, same as a one-shot run', async () => {
    const strat = `//@version=6
strategy("S", overlay=true)
fast = input.int(9, "Fast")
slow = input.int(21, "Slow")
f = ta.ema(close, fast)
s = ta.ema(close, slow)
if ta.crossover(f, s)
    strategy.entry("L", strategy.long)
if ta.crossunder(f, s)
    strategy.close("L")
plot(f, "f")`;
    const inputs = { in_0: 5, in_1: 34 };
    const r = await streamThrough(strat, { history: 600, liveBars: 10, inputs });
    open.push(r.stream);
    expect(r.error).toBeUndefined();
    expect(trades(r.streamed)).toEqual(trades(r.oneShot));
    expect(plotValues(r.streamed)).toEqual(plotValues(r.oneShot));
    expect(r.first.inputs.map((i) => i.id)).toEqual(['in_0', 'in_1']);
    const defaults = await streamThrough(strat, { history: 600, liveBars: 10 });
    open.push(defaults.stream);
    expect(trades(r.streamed)).not.toEqual(trades(defaults.streamed));
  });
});

describe('live sessions and inputs', () => {
  it('a settings change rebuilds the session and runs it with the new inputs', async () => {
    const opens = [];
    let item = { strategy_code_id: 5, strategy_key: 'k', symbol: 'NQ', timeframe: '5m', source: '//@version=6\nindicator("x")', inputs: { in_0: 3 } };
    const m = new LiveManager({
      config: { redisUrl: '', datahubWsUrl: '', datahubApiKey: '', backendInternalUrl: 'http://b', serviceKey: 'k', liveWarmupBars: 100, liveSyncSeconds: 30, liveRunTimeoutMs: 1000, liveIntrabarSeconds: 60, liveHeartbeatSeconds: 60 },
      pool: { run: async () => ({ ok: true, live: { kind: 'indicator', bars: 1, lastTime: 0, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: null } }) },
      streams: { open: async (key, p) => { opens.push(p.inputs); return { ok: true, live: { kind: 'indicator', bars: p.bars.length, lastTime: 0, plots: {}, shapes: [], drawings: { boxes: [], lines: [], labels: [] }, series: null } }; }, update: async () => ({ ok: false, stream_missing: true }), closeStream() {}, stats: {} },
      log: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => ({ ok: true, json: async () => [item] }),
      warehouseImpl: { getBars: async () => [{ openTime: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 2 }] },
    });
    m.bus = { publishState: async () => true, getJson: async () => null, setJson: async () => true, del: async () => true, stats: {} };
    m.feed = { setSymbols() {}, stats: {} };
    await m.sync();
    await new Promise((r) => setTimeout(r, 20));
    const first = m.sessions.get('5:NQ');
    expect(first.inputs).toEqual({ in_0: 3 });
    expect(opens.at(-1)).toEqual({ in_0: 3 });

    await m.sync(); // nothing changed: same session
    expect(m.sessions.get('5:NQ')).toBe(first);

    item = { ...item, inputs: { in_0: 7 } };
    await m.sync();
    await new Promise((r) => setTimeout(r, 20));
    const second = m.sessions.get('5:NQ');
    expect(second).not.toBe(first);
    expect(opens.at(-1)).toEqual({ in_0: 7 });
  });
});
