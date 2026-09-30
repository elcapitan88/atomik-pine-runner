// Pine scripts name instruments the TradingView way ("CME_MINI:NQ1!",
// "NQ1!", "ES", "NQZ2026"). The warehouse stores continuous roots ("NQ").
// This maps the first to the second and refuses anything it doesn't recognise,
// so a typo can never silently backtest the wrong market.

const ROOT_RE = /^[A-Z][A-Z0-9]{0,7}$/;

/**
 * @param {string} ticker  TradingView-style ticker or bare root
 * @returns {string|null}  warehouse root, or null when unrecognisable
 */
export function tickerToRoot(ticker) {
  if (typeof ticker !== 'string') return null;
  let t = ticker.trim().toUpperCase();
  if (!t) return null;
  // Strip PineTS ticker modifiers ("NQ1!;heikinashi") and exchange prefixes.
  t = t.split(';')[0];
  if (t.includes(':')) t = t.slice(t.lastIndexOf(':') + 1);
  // Continuous-contract suffixes: NQ1!, NQ2!, NQ.c.0, NQ.v.0
  t = t.replace(/[0-9]!$/, '');
  t = t.replace(/\.[CNV]\.\d+$/, '');
  // Specific contract codes (NQZ2026, NQZ6, NQZ26): letter month + 1-4 digit year.
  const m = t.match(/^([A-Z][A-Z0-9]{0,5}?)([FGHJKMNQUVXZ])(\d{1,4})$/);
  if (m && m[1].length >= 1 && t.length > 3) t = m[1];
  return ROOT_RE.test(t) ? t : null;
}
