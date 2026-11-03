// @ts-check
// Inter-rater agreement for two raters grading the same units 0/1/2 (judge A
// vs judge B, a human vs a judge). Pure functions; no I/O.
// - raw agreement: share of units with equal grades;
// - Cohen's κ, generic weights; quadratic-weighted κ over {0,1,2}; binary κ
//   at grade ≥ 1 (relevant vs not);
// - Krippendorff's α with the ordinal metric, two coders, no missing values.
// A statistic whose chance term is zero (both raters use one and the same
// category, or every value is one category) is undefined: NaN with
// `degenerate: true`. Empty input gives NaN.

export const GRADES = [0, 1, 2];

/** Rounding noise can leave −0 (printed "-0.000"); report it as 0. */
const noNegativeZero = (/** @type {number} */ x) => (Math.abs(x) < 1e-15 ? 0 : x);

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function assertPaired(a, b) {
  if (a.length !== b.length) throw new Error(`agreement needs the same number of units from both raters (${a.length} vs ${b.length})`);
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
export function rawAgreement(a, b) {
  assertPaired(a, b);
  if (a.length === 0) return NaN;
  return a.filter((x, i) => x === b[i]).length / a.length;
}

/**
 * @typedef {{ value: number, degenerate: boolean }} Statistic
 */

/**
 * Weighted Cohen's κ = 1 − Σ w·O / Σ w·E, with O the observed and E the
 * chance-expected joint proportions.
 * @param {number[]} a
 * @param {number[]} b
 * @param {{ categories: number[], weight: (i: number, j: number) => number }} options
 * @returns {Statistic}
 */
export function cohenKappa(a, b, { categories, weight }) {
  assertPaired(a, b);
  const n = a.length;
  if (n === 0) return { value: NaN, degenerate: false };
  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const observed = Array.from({ length: k }, () => new Array(k).fill(0));
  const pa = new Array(k).fill(0), pb = new Array(k).fill(0);
  for (let u = 0; u < n; u++) {
    const i = index.get(a[u]), j = index.get(b[u]);
    if (i === undefined || j === undefined) throw new Error(`a grade outside the categories ${categories.join(', ')}`);
    observed[i][j] += 1 / n;
    pa[i] += 1 / n;
    pb[j] += 1 / n;
  }
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weight(categories[i], categories[j]);
      num += w * observed[i][j];
      den += w * pa[i] * pb[j];
    }
  }
  if (Math.abs(den) < 1e-12) return { value: NaN, degenerate: true };
  return { value: noNegativeZero(1 - num / den), degenerate: false };
}

/**
 * Quadratic-weighted κ over grades 0..2: weight (i − j)² / 4.
 * @param {number[]} a
 * @param {number[]} b
 */
export function quadraticKappa(a, b) {
  const span = GRADES[GRADES.length - 1] - GRADES[0];
  return cohenKappa(a, b, { categories: GRADES, weight: (i, j) => ((i - j) ** 2) / (span ** 2) });
}

/**
 * Unweighted κ on relevant (grade ≥ threshold) vs not.
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} [threshold]
 */
export function binaryKappa(a, b, threshold = 1) {
  const bin = (/** @type {number[]} */ xs) => xs.map((x) => (x >= threshold ? 1 : 0));
  return cohenKappa(bin(a), bin(b), { categories: [0, 1], weight: (i, j) => (i === j ? 0 : 1) });
}

/**
 * Krippendorff's α, ordinal metric, two coders and no missing values:
 * α = 1 − (n − 1)·Σ o_ck δ²_ck / Σ n_c n_k δ²_ck, with o the coincidence
 * matrix (each unit adds both ordered pairs), n_c its margins, n = Σ n_c and
 * δ²_ck = (Σ_{g=c..k} n_g − (n_c + n_k)/2)².
 * @param {number[]} a
 * @param {number[]} b
 * @param {number[]} [categories] ordered
 * @returns {Statistic}
 */
export function krippendorffOrdinal(a, b, categories = GRADES) {
  assertPaired(a, b);
  if (a.length === 0) return { value: NaN, degenerate: false };
  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const o = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let u = 0; u < a.length; u++) {
    const i = index.get(a[u]), j = index.get(b[u]);
    if (i === undefined || j === undefined) throw new Error(`a grade outside the categories ${categories.join(', ')}`);
    o[i][j] += 1;
    o[j][i] += 1;
  }
  const nc = o.map((row) => row.reduce((s, x) => s + x, 0));
  const n = nc.reduce((s, x) => s + x, 0);
  /** @param {number} c @param {number} d */
  const delta2 = (c, d) => {
    const lo = Math.min(c, d), hi = Math.max(c, d);
    let s = 0;
    for (let g = lo; g <= hi; g++) s += nc[g];
    return (s - (nc[c] + nc[d]) / 2) ** 2;
  };
  let observed = 0, expected = 0;
  for (let c = 0; c < k; c++) {
    for (let d = 0; d < k; d++) {
      if (c === d) continue;
      const w = delta2(c, d);
      observed += o[c][d] * w;
      expected += nc[c] * nc[d] * w;
    }
  }
  if (expected === 0) return { value: NaN, degenerate: true };
  return { value: noNegativeZero(1 - ((n - 1) * observed) / expected), degenerate: false };
}

/**
 * @typedef {{ n: number, raw: number, alpha: number, binaryKappa: number, quadraticKappa: number, degenerate: string[] }} AgreementBlock
 */

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {AgreementBlock}
 */
export function agreementBlock(a, b) {
  const alpha = krippendorffOrdinal(a, b), bin = binaryKappa(a, b), quad = quadraticKappa(a, b);
  return {
    n: a.length,
    raw: rawAgreement(a, b),
    alpha: alpha.value,
    binaryKappa: bin.value,
    quadraticKappa: quad.value,
    degenerate: [['alpha', alpha], ['binaryKappa', bin], ['quadraticKappa', quad]].filter(([, s]) => /** @type {Statistic} */ (s).degenerate).map(([name]) => /** @type {string} */ (name)),
  };
}

/**
 * Every metric overall and per shape (a unit counts in each of its query's shapes).
 * @param {{ a: number, b: number, shapes?: string[] }[]} units
 */
export function agreementReport(units) {
  const shapes = [...new Set(units.flatMap((u) => u.shapes ?? []))].sort();
  const of = (/** @type {typeof units} */ us) => agreementBlock(us.map((u) => u.a), us.map((u) => u.b));
  return {
    overall: of(units),
    shapes: /** @type {Record<string, AgreementBlock>} */ (Object.fromEntries(shapes.map((s) => [s, of(units.filter((u) => (u.shapes ?? []).includes(s)))]))),
  };
}
