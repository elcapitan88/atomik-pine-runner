// Three vocabularies for one thing:
//   Atomik  '1m' '5m' '1h' '1d'   (backend, warehouse, UI)
//   PineTS  '1'  '5'  '60' 'D'    (Pine's timeframe.period)
//   seconds  60   300  3600 86400
// Every conversion goes through this file so a mismatch can't hide in a caller.

const ATOMIK = {
  '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400,
};

export const SUPPORTED_TIMEFRAMES = Object.keys(ATOMIK);

export function atomikToSeconds(tf) {
  return ATOMIK[tf] ?? null;
}

export function atomikToPine(tf) {
  const s = ATOMIK[tf];
  if (!s) return null;
  if (s === 86400) return 'D';
  return String(s / 60);
}

/** Pine timeframe string -> seconds, or null when it isn't one we can serve. */
export function pineToSeconds(tf) {
  const v = String(tf ?? '').trim().toUpperCase();
  if (v === '' ) return null;
  if (v === 'D' || v === '1D') return 86400;
  if (v === 'W' || v === '1W') return 7 * 86400;
  if (v === 'M' || v === '1M') return 30 * 86400;
  if (/^\d+D$/.test(v)) return Number(v.slice(0, -1)) * 86400;
  if (/^\d+H$/.test(v)) return Number(v.slice(0, -1)) * 3600;
  if (/^\d+$/.test(v)) return Number(v) * 60;
  if (/^\d+S$/.test(v)) return Number(v.slice(0, -1));
  return null;
}

export function secondsToAtomik(seconds) {
  for (const [k, s] of Object.entries(ATOMIK)) if (s === seconds) return k;
  return null;
}
