import { describe, it, expect } from 'vitest';
import { tickerToRoot } from '../src/symbols.mjs';
import { atomikToPine, pineToSeconds, secondsToAtomik, SUPPORTED_TIMEFRAMES } from '../src/timeframes.mjs';
import { keysMatch } from '../src/auth.mjs';

describe('tickerToRoot', () => {
  it.each([
    ['NQ', 'NQ'], ['nq', 'NQ'], ['CME_MINI:NQ1!', 'NQ'], ['NQ1!', 'NQ'], ['NQ2!', 'NQ'],
    ['CME_MINI:ES1!', 'ES'], ['COMEX:GC1!', 'GC'], ['NYMEX:CL1!', 'CL'], ['NQ.c.0', 'NQ'], ['NQ.v.0', 'NQ'],
    ['NQZ2026', 'NQ'], ['NQZ6', 'NQ'], ['ESH26', 'ES'], ['MNQ', 'MNQ'], ['CME_MINI:MNQ1!', 'MNQ'],
    ['NQ1!;heikinashi', 'NQ'], ['MGC', 'MGC'], ['M2K', 'M2K'],
  ])('%s -> %s', (input, expected) => {
    expect(tickerToRoot(input)).toBe(expected);
  });
  it.each([['', null], ['  ', null], ['NQ 1', null], ['../etc', null], [null, null], ['ABCDEFGHIJK', null], ["NQ'; DROP", null]])('rejects %s', (input, expected) => {
    expect(tickerToRoot(input)).toBe(expected);
  });
});

describe('timeframes', () => {
  it('atomik -> pine', () => {
    expect(atomikToPine('1m')).toBe('1');
    expect(atomikToPine('5m')).toBe('5');
    expect(atomikToPine('1h')).toBe('60');
    expect(atomikToPine('4h')).toBe('240');
    expect(atomikToPine('1d')).toBe('D');
    expect(atomikToPine('1s')).toBe(null);
  });
  it('pine -> seconds -> atomik', () => {
    expect(pineToSeconds('60')).toBe(3600);
    expect(pineToSeconds('D')).toBe(86400);
    expect(pineToSeconds('1D')).toBe(86400);
    expect(pineToSeconds('2H')).toBe(7200);
    expect(pineToSeconds('W')).toBe(7 * 86400);
    expect(pineToSeconds('nope')).toBe(null);
    expect(secondsToAtomik(pineToSeconds('240'))).toBe('4h');
    expect(secondsToAtomik(pineToSeconds('W'))).toBe(null);
    expect(SUPPORTED_TIMEFRAMES).toContain('30m');
  });
});

describe('keysMatch', () => {
  it('constant-time equality', () => {
    expect(keysMatch('abc', 'abc')).toBe(true);
    expect(keysMatch('abc', 'abd')).toBe(false);
    expect(keysMatch('ab', 'abc')).toBe(false);
    expect(keysMatch(undefined, 'abc')).toBe(false);
    expect(keysMatch('abc', '')).toBe(false);
  });
});
