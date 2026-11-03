// @ts-check
// Paired statistics for comparing two runs query by query. Pure, seeded,
// dependency-free. Every function takes per-query deltas d_i = candidate_i -
// baseline_i over the same queries.

/** Default number of resamples (plan: 10,000). */
export const RESAMPLES = 10_000;
/** Default seed, so a report is reproducible byte for byte. */
export const SEED = 20261104;

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
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

/**
 * Standard normal CDF via erfc (fractional error < 1.2e-7, far below the
 * Monte Carlo error of a 10k-resample bootstrap).
 * @param {number} x
 */
export function normCdf(x) {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  return 0.5 * erfc(-x / Math.SQRT2);
}

/**
 * Complementary error function, Numerical Recipes `erfcc` (Chebyshev fit,
 * fractional error < 1.2e-7 everywhere).
 * @param {number} x
 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/**
 * Inverse standard normal CDF (Acklam's algorithm, relative error < 1.2e-9).
 * @param {number} p in (0, 1)
 */
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
 * Quantile of a sorted array, linear interpolation between order statistics
 * (Hyndman-Fan type 7, the R/NumPy default).
 * @param {Float64Array | number[]} sorted
 * @param {number} q in [0, 1]
 */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * @typedef {{ estimate: number, lower: number, upper: number, n: number, method: string }} Interval
 */

/**
 * Paired BCa bootstrap confidence interval for the mean delta (Efron 1987):
 * bias correction z0 from the share of resampled means below the estimate,
 * acceleration from the jackknife.
 * @param {number[]} deltas
 * @param {{ resamples?: number, seed?: number, alpha?: number }} [options] alpha is two-sided (0.05 → 95%).
 * @returns {Interval}
 */
export function bcaInterval(deltas, options = {}) {
  const { resamples = RESAMPLES, seed = SEED, alpha = 0.05 } = options;
  const n = deltas.length;
  const estimate = mean(deltas);
  if (n === 0) return { estimate: NaN, lower: NaN, upper: NaN, n, method: 'bca' };
  if (deltas.every((d) => d === deltas[0])) return { estimate, lower: estimate, upper: estimate, n, method: 'bca' };

  const rand = rng(seed);
  const boot = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rand() * n)];
    boot[b] = s / n;
  }
  boot.sort();

  // Bias correction. Ties with the estimate count half, so a statistic with a
  // discrete bootstrap distribution is not pushed to one side.
  const eps = 1e-12 * Math.max(1, Math.abs(estimate));
  let below = 0, equal = 0;
  for (const v of boot) {
    if (v < estimate - eps) below++;
    else if (Math.abs(v - estimate) <= eps) equal++;
  }
  const share = Math.min(Math.max((below + 0.5 * equal) / resamples, 1 / (resamples + 1)), resamples / (resamples + 1));
  const z0 = normInv(share);

  // Acceleration from the jackknife of the mean.
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
  };
}

/**
 * Persona-clustered bootstrap: resample whole clusters (personas) with
 * replacement, keep every query of each drawn cluster, take the mean delta of
 * the pooled queries. Percentile interval; reported alongside BCa because
 * queries from one persona are not independent.
 * @param {number[]} deltas
 * @param {string[]} clusters cluster label per delta
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
  if (deltas.length === 0) return { estimate: NaN, lower: NaN, upper: NaN, n: 0, clusters: 0, method: 'cluster-percentile' };
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
  };
}

/** Exact enumeration below this many non-zero deltas; Monte Carlo above. */
export const EXACT_SIGN_FLIP_MAX = 16;

/**
 * Two-sided paired sign-flip randomisation test of mean delta = 0. Under the
 * null each delta's sign is exchangeable; p is the share of sign assignments
 * whose |sum| is at least the observed |sum|. Exact for small n, otherwise
 * Monte Carlo with the (count + 1) / (R + 1) correction.
 * @param {number[]} deltas
 * @param {{ resamples?: number, seed?: number }} [options]
 * @returns {{ p: number, exact: boolean, n: number }}
 */
export function signFlipP(deltas, options = {}) {
  const { resamples = RESAMPLES, seed = SEED } = options;
  const nz = deltas.filter((d) => d !== 0); // zero deltas contribute nothing under any flip
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
