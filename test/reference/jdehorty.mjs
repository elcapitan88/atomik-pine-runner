// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// © jdehorty (MLExtensions v2, KernelFunctions v2)
//
// A plain JavaScript port of the two libraries in pine-libs/jdehorty/, used only
// by test/libraries.test.mjs to check that PineTS runs the vendored Pine code
// correctly. Each function walks the bars once, bar by bar, the way Pine does;
// `NaN` plays Pine's `na`. The ta.* helpers follow TradingView's documented
// definitions (ta.rma / ta.ema seeded as TradingView documents them).

export const na = (x) => x === null || x === undefined || Number.isNaN(x);
export const nz = (x, y = 0) => (na(x) ? y : x);

// --- built-ins ------------------------------------------------------------
export function sma(src, n) {
  return src.map((_, i) => {
    if (i < n - 1) return NaN;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) { if (na(src[k])) return NaN; s += src[k]; }
    return s / n;
  });
}
export const sum = (src, n) => sma(src, n).map((v) => v * n);

/** ta.rma: seeded with the SMA of the first `n` values. */
export function rma(src, n) {
  const out = []; const alpha = 1 / n; const s = sma(src, n);
  for (let i = 0; i < src.length; i++) {
    const prev = i > 0 ? out[i - 1] : NaN;
    out.push(na(prev) ? s[i] : alpha * src[i] + (1 - alpha) * nz(prev));
  }
  return out;
}

/** ta.ema: seeded with the SMA of the first `n` values. */
export function ema(src, n) {
  const out = []; const alpha = 2 / (n + 1); const s = sma(src, n);
  for (let i = 0; i < src.length; i++) {
    const prev = i > 0 ? out[i - 1] : NaN;
    out.push(na(prev) ? s[i] : alpha * src[i] + (1 - alpha) * nz(prev));
  }
  return out;
}

export function rsi(src, n) {
  const up = src.map((v, i) => (i === 0 || na(v) || na(src[i - 1]) ? NaN : Math.max(v - src[i - 1], 0)));
  const dn = src.map((v, i) => (i === 0 || na(v) || na(src[i - 1]) ? NaN : Math.max(src[i - 1] - v, 0)));
  const u = rma(up, n); const d = rma(dn, n);
  return u.map((uv, i) => (na(uv) || na(d[i]) ? NaN : d[i] === 0 ? 100 : uv === 0 ? 0 : 100 - 100 / (1 + uv / d[i])));
}

export function cci(src, n) {
  const m = sma(src, n);
  return src.map((v, i) => {
    if (na(m[i])) return NaN;
    let dev = 0;
    for (let k = i - n + 1; k <= i; k++) dev += Math.abs(src[k] - m[i]);
    dev /= n;
    return (v - m[i]) / (0.015 * dev);
  });
}

export function tr(bars) {
  return bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
}
export const atr = (bars, n) => rma(tr(bars), n);
export const cum = (src) => { let s = 0; return src.map((v) => (s += nz(v))); };
const at = (a, i, k) => (i - k >= 0 ? a[i - k] : NaN);

// --- MLExtensions v2 ------------------------------------------------------
export const rescale = (src, oldMin, oldMax, newMin, newMax) => src.map((v) => newMin + (newMax - newMin) * (v - oldMin) / Math.max(oldMax - oldMin, 10e-10));

export function normalize(src, min, max) {
  let lo = 10e10; let hi = -10e10;
  return src.map((v) => {
    lo = Math.min(nz(v, lo), lo);
    hi = Math.max(nz(v, hi), hi);
    return min + (max - min) * (v - lo) / Math.max(hi - lo, 10e-10);
  });
}

export function normalizeDeriv(src, len) {
  const deriv = src.map((v, i) => v - at(src, i, 2));
  const s = sum(deriv.map((d) => d * d), len);
  return deriv.map((d, i) => d / Math.sqrt(nz(s[i] / len)));
}

export const tanh = (src) => src.map((v) => -1 + 2 / (1 + Math.exp(-2 * v)));

export function dualPoleFilter(src, lookback) {
  const omega = -99 * Math.PI / (70 * lookback);
  const alpha = Math.exp(omega);
  const beta = -(alpha ** 2);
  const gamma = Math.cos(omega) * 2 * alpha;
  const delta = 1 - gamma - beta;
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const sliding = 0.5 * (src[i] + nz(at(src, i, 1), src[i]));
    out.push(delta * sliding + gamma * nz(at(out, i, 1)) + beta * nz(at(out, i, 2)));
  }
  return out;
}

export const tanhTransform = (src, smoothing, qmLen) => dualPoleFilter(tanh(normalizeDeriv(src, qmLen)), smoothing);
export const n_rsi = (src, n1, n2) => rescale(ema(rsi(src, n1), n2), 0, 100, 0, 1);
export const n_cci = (src, n1, n2) => normalize(ema(cci(src, n1), n2), 0, 1);

export function n_wt(src, n1 = 10, n2 = 11) {
  const ema1 = ema(src, n1);
  const ema2 = ema(src.map((v, i) => Math.abs(v - ema1[i])), n1);
  const ci = src.map((v, i) => (v - ema1[i]) / (0.015 * ema2[i]));
  const wt1 = ema(ci, n2);
  const wt2 = sma(wt1, 4);
  return normalize(wt1.map((v, i) => v - wt2[i]), 0, 1);
}

function adxCore(h, l, c, length) {
  const n = h.length;
  const trs = []; const dmp = []; const dmm = [];
  for (let i = 0; i < n; i++) {
    const pc = nz(at(c, i, 1)); const ph = nz(at(h, i, 1)); const pl = nz(at(l, i, 1));
    trs.push(Math.max(Math.max(h[i] - l[i], Math.abs(h[i] - pc)), Math.abs(l[i] - pc)));
    dmp.push(h[i] - ph > pl - l[i] ? Math.max(h[i] - ph, 0) : 0);
    dmm.push(pl - l[i] > h[i] - ph ? Math.max(pl - l[i], 0) : 0);
  }
  const smooth = (x) => { const o = []; for (let i = 0; i < n; i++) { const p = nz(at(o, i, 1)); o.push(p - p / length + x[i]); } return o; };
  const ts = smooth(trs); const sp = smooth(dmp); const sm = smooth(dmm);
  const dx = ts.map((t, i) => { const dp = sp[i] / t * 100; const dm = sm[i] / t * 100; return Math.abs(dp - dm) / (dp + dm) * 100; });
  return rma(dx, length);
}
export const n_adx = (h, l, c, n1) => rescale(adxCore(h, l, c, n1), 0, 100, 0, 1);

export function regime_filter(src, bars, threshold, use) {
  const n = src.length;
  const v1 = []; const v2 = []; const k = [];
  for (let i = 0; i < n; i++) {
    v1.push(0.2 * (src[i] - at(src, i, 1)) + 0.8 * nz(at(v1, i, 1)));
    v2.push(0.1 * (bars[i].high - bars[i].low) + 0.8 * nz(at(v2, i, 1)));
    const omega = Math.abs(v1[i] / v2[i]);
    const alpha = (-(omega ** 2) + Math.sqrt(omega ** 4 + 16 * omega ** 2)) / 8;
    k.push(alpha * src[i] + (1 - alpha) * nz(at(k, i, 1)));
  }
  const slope = k.map((v, i) => Math.abs(v - at(k, i, 1)));
  const avg = ema(slope, 200);
  return slope.map((s, i) => (use ? (s - avg[i]) / avg[i] >= threshold : true));
}

export function filter_adx(src, bars, length, threshold, use) {
  const adx = adxCore(bars.map((b) => b.high), bars.map((b) => b.low), src, length);
  return adx.map((a) => (use ? a > threshold : true));
}

export function filter_volatility(bars, minLength, maxLength, use) {
  const recent = atr(bars, minLength); const hist = atr(bars, maxLength);
  return recent.map((r, i) => (use ? r > hist[i] : true));
}

/** Returns per-bar [totalWins, totalLosses, totalEarlySignalFlips, totalTrades, winLossRatio, winRate]. */
export function backtest(bars, startLong, endLong, startShort, endShort, isEarlySignalFlip, maxBarsBackIndex, src, useWorstCase) {
  let startLongTrade = NaN; let startShortTrade = NaN;
  let totalShort = 0; let totalLong = 0; let wins = 0; let losses = 0; let flips = 0;
  const cl = []; const cs = []; const cf = []; const cw = []; const cL = [];
  let sl = 0; let ss = 0; let sf = 0; let sw = 0; let sL = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const price = useWorstCase ? src[i] : (b.high + b.low + b.open + b.open) / 4;
    if (i === 0) { startLongTrade = price; startShortTrade = price; }
    if (i > maxBarsBackIndex) {
      wins = 0; losses = 0; flips = 0;
      if (startLong[i]) { startShortTrade = 0; flips = isEarlySignalFlip[i] ? 1 : 0; startLongTrade = price; }
      if (endLong[i]) { const d = price - startLongTrade; wins = d > 0 ? 1 : 0; losses = d < 0 ? 1 : 0; totalLong = d; }
      if (startShort[i]) { startLongTrade = 0; startShortTrade = price; }
      if (endShort[i]) { flips = isEarlySignalFlip[i] ? 1 : 0; const d = startShortTrade - price; wins = d > 0 ? 1 : 0; losses = d < 0 ? 1 : 0; totalShort = d; }
    }
    sl += totalLong; ss += totalShort; sf += flips; sw += wins; sL += losses;
    cl.push(sl); cs.push(ss); cf.push(sf); cw.push(sw); cL.push(sL);
  }
  return bars.map((_, i) => {
    const tt = cw[i] + cL[i];
    return [cw[i], cL[i], cf[i], tt, cw[i] / tt, cw[i] / (cw[i] + cL[i])];
  });
}

// --- KernelFunctions v2 ----------------------------------------------------
// `array.size(array.from(_src))` is 1, so each kernel sums startAtBar + 2 bars.
function kernel(src, startAtBar, weight) {
  return src.map((_, i) => {
    let num = 0; let den = 0;
    for (let k = 0; k <= 1 + startAtBar; k++) {
      const y = at(src, i, k); const w = weight(k);
      num += y * w; den += w;
    }
    return num / den;
  });
}
export const rationalQuadratic = (src, lookback, rw, startAtBar) => kernel(src, startAtBar, (k) => (1 + (k ** 2) / ((lookback ** 2) * 2 * rw)) ** -rw);
export const gaussian = (src, lookback, startAtBar) => kernel(src, startAtBar, (k) => Math.exp(-(k ** 2) / (2 * lookback ** 2)));
export const periodic = (src, lookback, period, startAtBar) => kernel(src, startAtBar, (k) => Math.exp(-2 * Math.sin(Math.PI * k / period) ** 2 / lookback ** 2));
export const locallyPeriodic = (src, lookback, period, startAtBar) => kernel(src, startAtBar, (k) => Math.exp(-2 * Math.sin(Math.PI * k / period) ** 2 / lookback ** 2) * Math.exp(-(k ** 2) / (2 * lookback ** 2)));
