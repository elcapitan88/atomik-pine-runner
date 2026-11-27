// Pine `import <owner>/<Library>/<version> [as <alias>]` for PineTS, which has
// no library support: its parser stops at the `import` keyword, and it has no
// `export` or `library()` either.
//
// The libraries Atomik can run live in pine-libs/<owner>/<Library>/<version>.pine
// (pine-libs/README.md: where each came from and its license). They are never
// fetched from TradingView at run time.
//
// expandImports() turns a script with imports into one PineTS can run:
//   - each `import` line becomes an empty line (the user's lines keep their count);
//   - each imported library's declarations (functions, methods, types, enums and
//     the top-level variables they use) are inserted right after the script's
//     `//@version` line, without `export` and with every name prefixed per
//     library (`__lib_jdehorty_KernelFunctions_v2__gaussian`), so two libraries,
//     or a library and the script, never clash. The rest of a library's
//     top-level code (its own example plots) is dropped, as TradingView does for
//     an imported library;
//   - `alias.name` in the script becomes the prefixed name.
// Error positions ("at L:C") and prefixed names in PineTS's messages are mapped
// back to what the user wrote (mapMessage).
//
// Known limits: a library's own //@version is not honoured (it runs under the
// script's version), and exported methods keep their name (called as
// `obj.method()`, which needs no alias).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_LIB_DIR = fileURLToPath(new URL('../pine-libs/', import.meta.url));

export class ImportError extends Error {
  constructor(message, line, col = 1) {
    // "(at L:C)" is how the worker finds the line of a script error.
    super(`${message} (at ${line}:${col})`);
    this.line = line;
  }
}

const IMPORT_LINE = /^\s*import\b/;
const IMPORT_RE = /^\s*import\s+([A-Za-z0-9_]+)\s*\/\s*([A-Za-z0-9_]+)\s*\/\s*(\d+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*(?:\/\/.*)?$/;
const VERSION_LINE = /^\s*\/\/\s*@version\s*=/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Scanner: walks Pine source, skipping comments, strings and #hex colours, and
// lets `visit` replace identifiers. visit(name, ctx) returns null (keep), a
// string, or {text, end} to also consume source up to `end`.
// ctx: {start, end, prev, next, nextIndex, depth, line, col}
// ---------------------------------------------------------------------------
function rewrite(code, visit) {
  let out = '';
  let i = 0;
  let depth = 0;
  let line = 1;
  let lineStart = 0;
  const n = code.length;
  const prevSignificant = (k) => {
    for (let j = k - 1; j >= 0; j--) {
      const ch = code[j];
      if (ch === ' ' || ch === '\t') continue;
      return ch;
    }
    return '';
  };
  const nextSignificant = (k) => {
    for (let j = k; j < n; j++) {
      const ch = code[j];
      if (ch === ' ' || ch === '\t') continue;
      return j;
    }
    return n;
  };
  while (i < n) {
    const c = code[i];
    if (c === '\n') {
      out += c; i++; line++; lineStart = i;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      const j = code.indexOf('\n', i);
      const e = j < 0 ? n : j;
      out += code.slice(i, e); i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      if (j < n && code[j] === c) j++;
      out += code.slice(i, j); i = j;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < n && /[0-9A-Fa-f]/.test(code[j])) j++;
      out += code.slice(i, j); i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(code[j])) {
        if ((code[j] === 'e' || code[j] === 'E') && (code[j + 1] === '-' || code[j + 1] === '+')) j++;
        j++;
      }
      out += code.slice(i, j); i = j;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(code[j])) j++;
      const name = code.slice(i, j);
      const nextIndex = nextSignificant(j);
      const r = visit(name, { start: i, end: j, prev: prevSignificant(i), next: code[nextIndex] || '', nextIndex, depth, line, col: i - lineStart + 1 });
      if (r == null) { out += name; i = j; }
      else if (typeof r === 'string') { out += r; i = j; }
      else { out += r.text; i = r.end; }
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    out += c; i++;
  }
  return out;
}

/** The identifier that follows `alias.` at `dot` (index of the dot), or null. */
function memberAfter(code, dot) {
  let j = dot + 1;
  while (code[j] === ' ' || code[j] === '\t') j++;
  if (!IDENT_START.test(code[j] || '')) return null;
  const s = j;
  while (j < code.length && IDENT_CHAR.test(code[j])) j++;
  return { name: code.slice(s, j), end: j };
}

/** Bracket depth change over one line, ignoring strings and comments. */
function depthDelta(text) {
  let d = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') break;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (c === '(' || c === '[') d++;
    else if (c === ')' || c === ']') d--;
  }
  return d;
}

// ---------------------------------------------------------------------------
// The library folder
// ---------------------------------------------------------------------------
const indexes = new Map();

function libraryIndex(dir) {
  if (indexes.has(dir)) return indexes.get(dir);
  const index = new Map();
  let owners = [];
  try { owners = readdirSync(dir); } catch { owners = []; }
  for (const owner of owners) {
    const ownerDir = path.join(dir, owner);
    if (!/^[A-Za-z0-9_]+$/.test(owner) || !statSync(ownerDir).isDirectory()) continue;
    for (const name of readdirSync(ownerDir)) {
      const libDir = path.join(ownerDir, name);
      if (!/^[A-Za-z0-9_]+$/.test(name) || !statSync(libDir).isDirectory()) continue;
      const versions = new Map();
      for (const f of readdirSync(libDir)) {
        const m = /^(\d+)\.pine$/.exec(f);
        if (m) versions.set(Number(m[1]), path.join(libDir, f));
      }
      if (versions.size) index.set(`${owner}/${name}`.toLowerCase(), { owner, name, versions });
    }
  }
  indexes.set(dir, index);
  return index;
}

/** Libraries in the folder, as `owner/Name/version` strings. */
export function availableLibraries(dir = DEFAULT_LIB_DIR) {
  const out = [];
  for (const { owner, name, versions } of libraryIndex(dir).values()) {
    for (const v of [...versions.keys()].sort((a, b) => a - b)) out.push(`${owner}/${name}/${v}`);
  }
  return out.sort();
}

function parseImport(text, line) {
  const m = IMPORT_RE.exec(text);
  if (!m) throw new ImportError('Cannot read this import. Expected: import <user>/<library>/<version> as <alias>', line);
  return { owner: m[1], name: m[2], version: Number(m[3]), alias: m[4] || m[2], line };
}

function locate(dir, imp) {
  const entry = libraryIndex(dir).get(`${imp.owner}/${imp.name}`.toLowerCase());
  const label = `${imp.owner}/${imp.name}/${imp.version}`;
  if (!entry) throw new ImportError(`The Pine library ${label} is not available on Atomik yet`, imp.line);
  const file = entry.versions.get(imp.version);
  if (!file) {
    const have = [...entry.versions.keys()].sort((a, b) => a - b).join(', ');
    throw new ImportError(`The Pine library ${label} is not available on Atomik yet (Atomik has version ${have})`, imp.line);
  }
  return { key: `${entry.owner}/${entry.name}/${imp.version}`, owner: entry.owner, name: entry.name, version: imp.version, file };
}

// ---------------------------------------------------------------------------
// One library -> its declarations, prefixed (cached per file)
// ---------------------------------------------------------------------------
const libCache = new Map();

/** Top-level statements of a library: [{start, end}] line ranges (0-based, inclusive). */
function statements(lines) {
  const out = [];
  let cur = null;
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    const text = lines[k];
    const trimmed = text.trim();
    const blank = trimmed === '' || trimmed.startsWith('//');
    const indented = /^[ \t]/.test(text);
    if (depth <= 0 && !blank && !indented) {
      cur = { start: k, end: k };
      out.push(cur);
    } else if (cur && !blank) {
      cur.end = k;
    }
    if (!blank) depth = Math.max(0, depth + depthDelta(text));
  }
  return out;
}

const DECL_PREFIX = /^(export\s+)?/;

function classify(text) {
  // `text` = the statement's lines joined.
  const exported = /^export\s/.test(text);
  const body = text.replace(DECL_PREFIX, '');
  let m;
  if (/^import\s/.test(text)) return { kind: 'import' };
  if (/^library\s*\(/.test(text)) return { kind: 'library' };
  if ((m = /^method\s+([A-Za-z_]\w*)\s*\(/.exec(body))) return { kind: 'method', name: m[1], exported };
  if ((m = /^type\s+([A-Za-z_]\w*)\s*(?:\n|$)/.exec(body))) return { kind: 'type', name: m[1], exported };
  if ((m = /^enum\s+([A-Za-z_]\w*)\s*(?:\n|$)/.exec(body))) return { kind: 'enum', name: m[1], exported };
  if ((m = /^([A-Za-z_]\w*)\s*\(/.exec(body))) {
    // A function declaration is `name(...) =>`; `name(...)` alone is a call.
    let depth = 0;
    let i = m[0].length - 1;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
        i = j;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (/^\s*=>/.test(body.slice(i + 1))) return { kind: 'function', name: m[1], exported };
    return { kind: 'other' };
  }
  const names = [];
  if ((m = /^\[([^\]]*)\]\s*=(?!=)/.exec(body))) {
    for (const p of m[1].split(',')) if (/^\s*[A-Za-z_]\w*\s*$/.test(p)) names.push(p.trim());
  } else if ((m = /^(?:var\s+|varip\s+)?(?:const\s+|simple\s+|series\s+)?(?:[A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])?\s+)?([A-Za-z_]\w*)\s*=(?!=)/.exec(body))) {
    names.push(m[1]);
  }
  return names.length ? { kind: 'variable', names } : { kind: 'other' };
}

function loadLibrary(dir, lib, stack) {
  if (libCache.has(lib.file)) return libCache.get(lib.file);
  if (stack.includes(lib.key)) throw new Error(`Pine library import cycle: ${[...stack, lib.key].join(' -> ')}`);
  if (stack.length >= MAX_DEPTH) throw new Error(`Pine library imports nest deeper than ${MAX_DEPTH}`);

  const raw = readFileSync(lib.file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const prefix = `__lib_${lib.owner}_${lib.name}_v${lib.version}__`;
  const stmts = statements(lines).map((s) => ({ ...s, ...classify(lines.slice(s.start, s.end + 1).join('\n')) }));

  // The library's own imports.
  const deps = [];
  const aliases = new Map();
  for (const s of stmts.filter((x) => x.kind === 'import')) {
    const imp = parseImport(lines[s.start], s.start + 1);
    const dep = locate(dir, imp);
    deps.push(dep);
    aliases.set(imp.alias, loadLibrary(dir, dep, [...stack, lib.key]));
  }

  const functions = new Set();
  const types = new Set();
  const methods = new Set();
  const exports = new Map(); // exported name -> name in the expanded script
  for (const s of stmts) {
    if (s.kind === 'function') functions.add(s.name);
    else if (s.kind === 'type' || s.kind === 'enum') types.add(s.name);
    else if (s.kind === 'method') methods.add(s.name);
    if (s.exported) exports.set(s.name, s.kind === 'method' ? s.name : prefix + s.name);
  }

  // Top-level variables are kept only when kept code uses them.
  const declText = stmts.filter((s) => ['function', 'method', 'type', 'enum'].includes(s.kind))
    .map((s) => lines.slice(s.start, s.end + 1).join('\n'));
  const varStmts = stmts.filter((s) => s.kind === 'variable');
  const variables = new Set();
  const uses = (text, name) => {
    let hit = false;
    rewrite(text, (id, ctx) => {
      if (id === name && ctx.prev !== '.' && ctx.next !== '(') hit = true;
      return null;
    });
    return hit;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of varStmts) {
      if (s.names.every((v) => variables.has(v))) continue;
      const used = s.names.some((v) => declText.some((t) => uses(t, v)) || varStmts.some((o) => o !== s && o.names.some((x) => variables.has(x)) && uses(lines.slice(o.start, o.end + 1).join('\n'), v)));
      if (used) { s.names.forEach((v) => variables.add(v)); grew = true; }
    }
  }

  const keep = new Set(['function', 'method', 'type', 'enum']);
  const out = lines.map(() => '');
  for (const s of stmts) {
    const kept = keep.has(s.kind) || (s.kind === 'variable' && s.names.some((v) => variables.has(v)));
    if (!kept) continue;
    for (let k = s.start; k <= s.end; k++) out[k] = lines[k];
    out[s.start] = out[s.start].replace(/^export\s+/, '');
  }
  // Comment lines inside kept declarations stay (harmless); the rest of the
  // library's top level, //@version and library(...) included, is blank.

  const visit = (name, ctx) => {
    if (ctx.prev === '.') return null;
    if (ctx.next === '.' && aliases.has(name)) {
      const member = memberAfter(code, ctx.nextIndex);
      const dep = aliases.get(name);
      if (!member || !dep.exports.has(member.name)) {
        throw new Error(`${lib.key}: ${dep.key} has no export named "${member ? member.name : ''}"`);
      }
      return { text: dep.exports.get(member.name), end: member.end };
    }
    if (functions.has(name) && ctx.next === '(') return prefix + name;
    if (types.has(name)) return prefix + name;
    if (variables.has(name) && ctx.next !== '(') {
      const namedArg = ctx.depth > 0 && ctx.next === '=' && code[ctx.nextIndex + 1] !== '=';
      return namedArg ? null : prefix + name;
    }
    return null;
  };
  const code = out.join('\n');
  const body = rewrite(code, visit).split('\n');

  const loaded = { key: lib.key, prefix, exports, body, deps: deps.map((d) => d.file) };
  libCache.set(lib.file, loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// A script with imports -> one script
// ---------------------------------------------------------------------------
const identity = (m) => m;

/**
 * @param {string} source  the user's Pine
 * @param {{dir?: string}} [opts]  library folder (tests)
 * @returns {{source: string, imports: object[], mapMessage: (msg: string) => string, mapLine: (line: number) => object}}
 * @throws {ImportError} an import line that can't be read or resolved (with its line)
 */
export function expandImports(source, { dir = DEFAULT_LIB_DIR } = {}) {
  if (typeof source !== 'string' || !/^\s*import\b/m.test(source)) {
    return { source, imports: [], mapMessage: identity, mapLine: (line) => ({ where: 'script', line }) };
  }
  const lines = source.split(/\r\n|\r|\n/);
  const imports = [];
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    const text = lines[k];
    if (depth <= 0 && IMPORT_LINE.test(text)) {
      const imp = parseImport(text, k + 1);
      if (imports.some((x) => x.alias === imp.alias)) throw new ImportError(`Two imports use the alias "${imp.alias}"`, k + 1);
      imports.push({ ...imp, lib: locate(dir, imp) });
      lines[k] = '';
      continue;
    }
    const t = text.trim();
    if (t && !t.startsWith('//')) depth = Math.max(0, depth + depthDelta(text));
  }
  if (!imports.length) {
    return { source, imports: [], mapMessage: identity, mapLine: (line) => ({ where: 'script', line }) };
  }

  // Libraries in dependency order, each once.
  const ordered = [];
  const seen = new Set();
  const visitLib = (file) => {
    if (seen.has(file)) return;
    const loaded = libCache.get(file);
    for (const d of loaded.deps) visitLib(d);
    seen.add(file);
    ordered.push(loaded);
  };
  for (const imp of imports) {
    try {
      loadLibrary(dir, imp.lib, []);
    } catch (err) {
      // Anything wrong inside a library is reported on the user's import line.
      const why = String(err.message || err).replace(/ \(at \d+:\d+\)$/, '');
      throw new ImportError(`Cannot load the Pine library ${imp.lib.key}: ${why}`, imp.line);
    }
    visitLib(imp.lib.file);
  }

  // The user's `alias.name` -> the library's prefixed name.
  const byAlias = new Map(imports.map((imp) => [imp.alias, { imp, loaded: libCache.get(imp.lib.file) }]));
  const joined = lines.join('\n');
  const script = rewrite(joined, (name, ctx) => {
    if (ctx.prev === '.' || ctx.next !== '.' || !byAlias.has(name)) return null;
    const { imp, loaded } = byAlias.get(name);
    const member = memberAfter(joined, ctx.nextIndex);
    if (!member) return null;
    if (!loaded.exports.has(member.name)) {
      throw new ImportError(`${imp.lib.key} has no exported function or type named "${member.name}"`, ctx.line, ctx.col);
    }
    return { text: loaded.exports.get(member.name), end: member.end };
  }).split('\n');

  // Insert the libraries right after `//@version` (the user's own lines then
  // shift by a fixed amount; an error at the end of the script stays there).
  let at = script.findIndex((l) => VERSION_LINE.test(l));
  at = at < 0 ? 0 : at + 1;
  const blocks = [];
  const libLines = [];
  for (const l of ordered) {
    blocks.push({ start: at + libLines.length + 1, end: at + libLines.length + l.body.length, key: l.key });
    libLines.push(...l.body);
  }
  const expanded = [...script.slice(0, at), ...libLines, ...script.slice(at)].join('\n');
  const shift = libLines.length;

  const mapLine = (line) => {
    if (line <= at) return { where: 'script', line };
    const b = blocks.find((x) => line >= x.start && line <= x.end);
    if (b) return { where: 'library', library: b.key, line: line - b.start + 1 };
    return { where: 'script', line: line - shift };
  };
  // Prefixed names read as the user wrote them (`ml.normalize`); a library the
  // user didn't import directly reads as its path.
  const names = ordered.map((l) => {
    const imp = imports.find((x) => x.lib.file && libCache.get(x.lib.file) === l);
    return [l.prefix, imp ? `${imp.alias}.` : `${l.key}.`];
  });
  const mapMessage = (msg) => {
    let text = String(msg ?? '').replace(/\bat (\d+):(\d+)\b/g, (whole, l, c) => {
      const m = mapLine(Number(l));
      return m.where === 'script' ? `at ${m.line}:${c}` : `at line ${m.line} of library ${m.library}`;
    });
    for (const [prefix, shown] of names) text = text.split(prefix).join(shown);
    return text;
  };

  return {
    source: expanded,
    imports: imports.map(({ lib, alias, line }) => ({ library: lib.key, alias, line })),
    mapMessage,
    mapLine,
  };
}
