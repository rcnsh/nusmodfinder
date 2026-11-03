// @ts-check
// Rank comparison helpers for the Phase 2c analysis.

/** |top-k(a) ∩ top-k(b)|. @param {string[]} a @param {string[]} b @param {number} k */
export function overlap(a, b, k) {
  const s = new Set(a.slice(0, k));
  return b.slice(0, k).filter((x) => s.has(x)).length;
}

/**
 * Extrapolated rank-biased overlap (Webber et al. 2010, eq. 32) of the top-k
 * prefixes, p = 0.9. Two empty lists count as identical (1).
 * @param {string[]} a @param {string[]} b @param {number} k @param {number} [p]
 */
export function rbo(a, b, k, p = 0.9) {
  const A = a.slice(0, k), B = b.slice(0, k);
  const depth = Math.min(A.length, B.length);
  if (A.length === 0 && B.length === 0) return 1;
  if (depth === 0) return 0;
  const sa = new Set(), sb = new Set();
  let x = 0, sum = 0;
  for (let d = 1; d <= depth; d++) {
    const ai = A[d - 1], bi = B[d - 1];
    if (ai === bi) x++;
    else {
      if (sb.has(ai)) x++;
      if (sa.has(bi)) x++;
    }
    sa.add(ai); sb.add(bi);
    sum += (x / d) * p ** d;
  }
  return (x / depth) * p ** depth + ((1 - p) / p) * sum;
}
