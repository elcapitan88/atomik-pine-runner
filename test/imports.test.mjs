// Pine `import` -> inlined libraries (src/imports.mjs). No isolate: these check
// the text transform; test/libraries.test.mjs runs the result in PineTS.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expandImports, availableLibraries, ImportError } from '../src/imports.mjs';

const dir = fileURLToPath(new URL('./fixtures/pine-libs/', import.meta.url));
const expand = (src) => expandImports(src, { dir });
const errorOf = (fn) => { try { fn(); } catch (e) { return e; } return null; };

const SCRIPT = `//@version=6
indicator("uses Util")
import acme/Util/1 as u
x = u.scaled(close)
plot(x, "x")
plot(u.twice(close), "twice")
`;

describe('expandImports', () => {
  it('leaves a script without imports untouched', () => {
    const src = '//@version=6\nindicator("t")\nplot(close)\n';
    const r = expand(src);
    expect(r.source).toBe(src);
    expect(r.imports).toEqual([]);
    expect(r.mapMessage('x at 3:1')).toBe('x at 3:1');
  });

  it('inlines the library after //@version and rewrites alias.name', () => {
    const r = expand(SCRIPT);
    expect(r.imports).toEqual([{ library: 'acme/Util/1', alias: 'u', line: 3 }]);
    const lines = r.source.split('\n');
    expect(lines[0]).toBe('//@version=6');
    expect(r.source).toContain('x = __lib_acme_Util_v1__scaled(close)');
    expect(r.source).toContain('plot(__lib_acme_Util_v1__twice(close), "twice")');
    // The user's import line is gone, the library's `export`, `library()`,
    // //@version and example plot are not in the output.
    expect(r.source).not.toMatch(/^\s*import\b/m);
    expect(r.source).not.toMatch(/\bexport\b/);
    expect(r.source).not.toMatch(/library\(/);
    expect(r.source.match(/\/\/@version/g)).toHaveLength(1);
    expect(r.source).not.toContain('"example"');
    // Library names are prefixed, its own calls included.
    expect(r.source).toContain('__lib_acme_Util_v1__scaled(float x) =>\n    __lib_acme_Util_v1__helper(x)');
    expect(r.source).toContain('x * __lib_acme_Util_v1__SCALE');
    expect(r.source).toContain('__lib_acme_Util_v1__SCALE = 3.0');
    expect(r.source).not.toContain('UNUSED');
    // A nested import is inlined once, before the library that uses it.
    expect(r.source).toContain('__lib_acme_Util_v1__twice(float x) =>\n    __lib_acme_Base_v1__double(x)');
    expect(r.source.indexOf('__lib_acme_Base_v1__double(float x)')).toBeLessThan(r.source.indexOf('__lib_acme_Util_v1__twice(float x)'));
  });

  it('prefixes types and enums, keeps exported method names', () => {
    const r = expand(`//@version=6
indicator("t")
import acme/Util/1 as u
p = u.Point.new(1.0, 2)
u.Point q = p.bump(2.0)
s = u.Side.long
plot(q.price)
`);
    expect(r.source).toContain('p = __lib_acme_Util_v1__Point.new(1.0, 2)');
    expect(r.source).toContain('__lib_acme_Util_v1__Point q = p.bump(2.0)');
    expect(r.source).toContain('s = __lib_acme_Util_v1__Side.long');
    expect(r.source).toContain('type __lib_acme_Util_v1__Point\n    float price');
    expect(r.source).toContain('enum __lib_acme_Util_v1__Side');
    expect(r.source).toContain('method bump(__lib_acme_Util_v1__Point p, float amount) =>');
  });

  it('does not touch strings or comments', () => {
    const r = expand(`//@version=6
indicator("t")
import acme/Util/1 as u
// u.scaled in a comment
label.new(bar_index, close, "u.scaled in a string")
plot(u.scaled(close))
`);
    expect(r.source).toContain('// u.scaled in a comment');
    expect(r.source).toContain('"u.scaled in a string"');
    expect(r.source).toContain('plot(__lib_acme_Util_v1__scaled(close))');
  });

  it('an alias defaults to the library name; owner and name match case-insensitively', () => {
    const r = expand('//@version=6\nindicator("t")\nimport ACME/util/1\nplot(util.scaled(close))\n');
    expect(r.imports[0]).toMatchObject({ library: 'acme/Util/1', alias: 'util' });
    expect(r.source).toContain('plot(__lib_acme_Util_v1__scaled(close))');
  });

  it('two versions of a library can be imported side by side', () => {
    const r = expand('//@version=6\nindicator("t")\nimport acme/Util/1 as a\nimport acme/Util/2 as b\nplot(a.scaled(close) + b.scaled(close))\n');
    expect(r.source).toContain('plot(__lib_acme_Util_v1__scaled(close) + __lib_acme_Util_v2__scaled(close))');
  });

  it('maps error positions and names back to the script', () => {
    const r = expand(SCRIPT);
    const out = r.source.split('\n');
    const at = (needle) => out.findIndex((l) => l.includes(needle)) + 1;
    // The user's line 5 (`plot(x, "x")`) is further down in the expanded script.
    const l5 = at('plot(x, "x")');
    expect(l5).toBeGreaterThan(5);
    expect(r.mapLine(l5)).toEqual({ where: 'script', line: 5 });
    expect(r.mapMessage(`Unexpected token at ${l5}:7`)).toBe('Unexpected token at 5:7');
    // A position inside a library names the library and its own line.
    const libLine = at('__lib_acme_Util_v1__helper(float x) =>');
    expect(r.mapLine(libLine)).toEqual({ where: 'library', library: 'acme/Util/1', line: 17 });
    expect(r.mapMessage(`bad at ${libLine}:1`)).toBe('bad at line 17 of library acme/Util/1');
    // Prefixed names read as the user wrote them.
    expect(r.mapMessage('__lib_acme_Util_v1__scaled is not a function')).toBe('u.scaled is not a function');
    expect(r.mapMessage('__lib_acme_Base_v1__double failed')).toBe('acme/Base/1.double failed');
  });

  it('an unknown library is a script error on its line', () => {
    const e = errorOf(() => expand('//@version=6\nindicator("t")\nimport someone/Missing/4 as m\nplot(close)\n'));
    expect(e).toBeInstanceOf(ImportError);
    expect(e.line).toBe(3);
    expect(e.message).toBe('The Pine library someone/Missing/4 is not available on Atomik yet (at 3:1)');
  });

  it('an unknown version names the versions Atomik has', () => {
    const e = errorOf(() => expand('//@version=6\nindicator("t")\n\nimport acme/Util/7 as u\n'));
    expect(e.line).toBe(4);
    expect(e.message).toBe('The Pine library acme/Util/7 is not available on Atomik yet (Atomik has version 1, 2) (at 4:1)');
  });

  it('an unreadable import line, a duplicate alias and a missing export are errors with lines', () => {
    expect(errorOf(() => expand('//@version=6\nimport acme/Util as u\n')).message)
      .toBe('Cannot read this import. Expected: import <user>/<library>/<version> as <alias> (at 2:1)');
    expect(errorOf(() => expand('//@version=6\nimport acme/Util/1 as u\nimport acme/Base/1 as u\n')).message)
      .toBe('Two imports use the alias "u" (at 3:1)');
    const e = errorOf(() => expand('//@version=6\nindicator("t")\nimport acme/Util/1 as u\nplot(u.nope(close))\n'));
    expect(e.message).toBe('acme/Util/1 has no exported function or type named "nope" (at 4:6)');
    expect(e.line).toBe(4);
  });

  it('a non-exported helper is not reachable through the alias', () => {
    const e = errorOf(() => expand('//@version=6\nindicator("t")\nimport acme/Util/1 as u\nplot(u.helper(close))\n'));
    expect(e.message).toMatch(/has no exported function or type named "helper"/);
  });

  it('a library that imports itself is refused on the user\'s import line', () => {
    const e = errorOf(() => expand('//@version=6\nindicator("t")\nimport acme/Loop/1 as l\nplot(l.f(close))\n'));
    expect(e.line).toBe(3);
    expect(e.message).toMatch(/^Cannot load the Pine library acme\/Loop\/1: Pine library import cycle/);
  });
});

describe('pine-libs/', () => {
  it('lists the libraries Atomik ships', () => {
    expect(availableLibraries()).toEqual(['LuxSignals/FormattingUtils/3', 'jdehorty/KernelFunctions/2', 'jdehorty/MLExtensions/2'].sort());
  });

  // The jdehorty files are byte-for-byte what TradingView published
  // (pine-libs/README.md). Any edit to them must be deliberate.
  it.each([
    ['jdehorty/KernelFunctions/2.pine', '789b9405059a1ef3d306b18fe78b948344334559bcd56881b8f86caa31c90fce'],
    ['jdehorty/MLExtensions/2.pine', 'e3e6ea0f030b6ee9c3742ba6e17ce9002ea8062c4b4ee618acfd58ba6c80a855'],
  ])('%s is unmodified and keeps its MPL 2.0 header', (file, sha) => {
    const bytes = readFileSync(new URL(`../pine-libs/${file}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha);
    expect(bytes.toString('utf8').split('\n')[0]).toBe('// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/');
  });

  it('every shipped library expands', () => {
    for (const lib of availableLibraries()) {
      const r = expandImports(`//@version=6\nindicator("t")\nimport ${lib} as x\nplot(close)\n`);
      expect(r.imports[0].library).toBe(lib);
      expect(r.source).not.toMatch(/\bexport\b|library\(/);
    }
  });
});
