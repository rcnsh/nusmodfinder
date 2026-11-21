// @ts-check

export const RESAMPLES = 10_000;
export const SEED = 20261104;

/**
 * @param {number} seed
 * @returns {() => number}
 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number[]} xs */
export function mean(xs) {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** @param {number} x */
export function normCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** @param {number} x */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** @param {number} p */
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * @param {Float64Array | number[]} sorted
 * @param {number} q
 */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** @typedef {{ estimate: number, lower: number, upper: number, n: number, method: string, degenerate: boolean }} Interval */

/** @param {number[]} deltas */
export function zeroVariance(deltas) {
  if (deltas.length < 2) return true;
  let lo = Infinity, hi = -Infinity;
  for (const d of deltas) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return hi - lo <= 1e-12 * Math.max(1, Math.abs(lo), Math.abs(hi));
}

/**
 * @param {number[]} deltas
 * @param {{ resamples?: number, seed?: number, alpha?: number }} [options]
 * @returns {Interval}
 */
export function bcaInterval(deltas, options = {}) {
  const { resamples = RESAMPLES, seed = SEED, alpha = 0.05 } = options;
  const n = deltas.length;
  const estimate = mean(deltas);
  if (n === 0) return { estimate: NaN, lower: NaN, upper: NaN, n, method: 'bca', degenerate: true };
  if (zeroVariance(deltas)) return { estimate, lower: estimate, upper: estimate, n, method: 'bca', degenerate: true };

  const rand = rng(seed);
  const boot = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rand() * n)];
    boot[b] = s / n;
  }
  boot.sort();

  const eps = 1e-12 * Math.max(1, Math.abs(estimate));
  let below = 0, equal = 0;
  for (const v of boot) {
    if (v < estimate - eps) below++;
    else if (Math.abs(v - estimate) <= eps) equal++;
  }
  const share = Math.min(Math.max((below + 0.5 * equal) / resamples, 1 / (resamples + 1)), resamples / (resamples + 1));
  const z0 = normInv(share);

  const total = deltas.reduce((s, d) => s + d, 0);
  const jack = deltas.map((d) => (total - d) / (n - 1));
  const jackMean = mean(jack);
  let num = 0, den = 0;
  for (const j of jack) {
    const u = jackMean - j;
    num += u ** 3;
    den += u ** 2;
  }
  const a = den === 0 ? 0 : num / (6 * den ** 1.5);

  /** @param {number} q */
  const adjusted = (q) => {
    const z = normInv(q);
    return normCdf(z0 + (z0 + z) / (1 - a * (z0 + z)));
  };
  return {
    estimate,
    lower: quantile(boot, adjusted(alpha / 2)),
    upper: quantile(boot, adjusted(1 - alpha / 2)),
    n,
    method: 'bca',
    degenerate: false,
  };
}

/**
 * @param {number[]} deltas
 * @param {string[]} clusters
 * @param {{ resamples?: number, seed?: number, alpha?: number }} [options]
 * @returns {Interval & { clusters: number }}
 */
export function clusteredInterval(deltas, clusters, options = {}) {
  const { resamples = RESAMPLES, seed = SEED, alpha = 0.05 } = options;
  if (clusters.length !== deltas.length) throw new Error('clusteredInterval: one cluster label per delta');
  /** @type {Map<string, number[]>} */
  const byCluster = new Map();
  deltas.forEach((d, i) => {
    const k = clusters[i];
    if (!byCluster.has(k)) byCluster.set(k, []);
    /** @type {number[]} */ (byCluster.get(k)).push(d);
  });
  const groups = [...byCluster.values()].map((ds) => ({ sum: ds.reduce((s, d) => s + d, 0), n: ds.length }));
  const k = groups.length;
  const estimate = mean(deltas);
  if (deltas.length === 0) return { estimate: NaN, lower: NaN, upper: NaN, n: 0, clusters: 0, method: 'cluster-percentile', degenerate: true };
  const rand = rng(seed);
  const boot = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0, m = 0;
    for (let i = 0; i < k; i++) {
      const g = groups[Math.floor(rand() * k)];
      s += g.sum;
      m += g.n;
    }
    boot[b] = s / m;
  }
  boot.sort();
  return {
    estimate,
    lower: quantile(boot, alpha / 2),
    upper: quantile(boot, 1 - alpha / 2),
    n: deltas.length,
    clusters: k,
    method: 'cluster-percentile',
    degenerate: boot[resamples - 1] - boot[0] <= 1e-12 * Math.max(1, Math.abs(estimate)),
  };
}

export const EXACT_SIGN_FLIP_MAX = 16;

/**
 * @param {number[]} deltas
 * @param {{ resamples?: number, seed?: number }} [options]
 * @returns {{ p: number, exact: boolean, n: number }}
 */
export function signFlipP(deltas, options = {}) {
  const { resamples = RESAMPLES, seed = SEED } = options;
  const nz = deltas.filter((d) => d !== 0);
  const n = deltas.length;
  if (nz.length === 0) return { p: 1, exact: true, n };
  const observed = Math.abs(nz.reduce((s, d) => s + d, 0));
  const tol = 1e-12 * Math.max(1, observed);
  if (nz.length <= EXACT_SIGN_FLIP_MAX) {
    const m = nz.length;
    let count = 0;
    for (let mask = 0; mask < 2 ** m; mask++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += (mask >> i) & 1 ? -nz[i] : nz[i];
      if (Math.abs(s) >= observed - tol) count++;
    }
    return { p: count / 2 ** m, exact: true, n };
  }
  const rand = rng(seed);
  let count = 0;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (const d of nz) s += rand() < 0.5 ? -d : d;
    if (Math.abs(s) >= observed - tol) count++;
  }
  return { p: (count + 1) / (resamples + 1), exact: false, n };
}
