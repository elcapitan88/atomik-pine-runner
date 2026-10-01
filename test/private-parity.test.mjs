// Streaming parity on real scripts. The scripts live in the git-ignored
// private-fixtures/ folder (never committed to this public repo), so this
// file skips itself anywhere they are absent, CI included.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { streamThrough, trades, opens, pending, boxes, lines, labels, plotValues, median } from './stream-harness.mjs';

const DIR = new URL('../private-fixtures/', import.meta.url);
// A countdown label built from `timenow` ("(17:34:09)", "(2D 04:19:09)") reads
// the wall clock, so two runs a second apart differ: compare it as a countdown.
const clockless = (ls) => ls.map(([t, price, text]) => [t, price, typeof text === 'string' ? text.replace(/\((\d+D )?\d+(:\d+)*\)/g, '(countdown)') : text]);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.pine')) : [];

describe.skipIf(!files.length)('streaming parity on private scripts', () => {
  for (const f of files) {
    it(f, async () => {
      const source = readFileSync(new URL(f, DIR), 'utf8');
      const r = await streamThrough(source, { history: 3000, liveBars: 40 });
      try {
        if (r.error && /^open:/.test(r.error)) {
          // The script does not run in PineTS at all: not a streaming question.
          console.log(`${f}: skipped (${r.error.slice(0, 120)})`);
          return;
        }
        expect(r.error).toBeUndefined();
        expect(r.oneShot.ok, r.oneShot.error).toBe(true);
        expect(trades(r.streamed)).toEqual(trades(r.oneShot));
        expect(opens(r.streamed)).toEqual(opens(r.oneShot));
        expect(pending(r.streamed)).toEqual(pending(r.oneShot));
        expect(plotValues(r.streamed)).toEqual(plotValues(r.oneShot));
        expect(r.streamed.shapes).toEqual(r.oneShot.shapes);
        expect(boxes(r.streamed)).toEqual(boxes(r.oneShot));
        expect(lines(r.streamed)).toEqual(lines(r.oneShot));
        expect(clockless(labels(r.streamed))).toEqual(clockless(labels(r.oneShot)));
        console.log(`${f}: open ${r.first.ms}ms, one-shot ${r.oneShot.ms}ms, update median ${median(r.times)}ms max ${Math.max(...r.times)}ms, trades ${trades(r.oneShot).length}`);
      } finally {
        r.stream?.dispose();
      }
    }, 180_000);
  }
});
