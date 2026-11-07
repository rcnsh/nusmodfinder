// @ts-check
// 3G's τ (docs/plans/phase3.md 3G, A2-9, C2-10, A3-6): /search answers
// `noMatch: { reason: "no-signal" }` when parsed.noSignal holds and the top
// exact cosine of the query as typed is below τ. The candidates come from the
// gibberish set's derivation half (noSignalCandidates); the variant in force
// is the largest candidate that passes every dev condition, the next smaller
// one its fallback. `off` never fires.

/**
 * τ per variant (null: off). Filled from 3G-1's measurement
 * (docs/evidence/phase3/3g-1-cosines.json).
 * @type {Readonly<Record<string, number | null>>}
 */
export const NO_SIGNAL_VARIANTS = Object.freeze({
  off: null,
  p90: 0.5693180883526313,
  p95: 0.5814376699800824,
  max: 0.6012585039510654,
});

/** The variant in force. */
export const NO_SIGNAL_VARIANT = 'max';

/** τ in force (null: 3G never fires). */
export const NO_SIGNAL_TAU = NO_SIGNAL_VARIANTS[NO_SIGNAL_VARIANT];

/**
 * The τ candidates from the derivation half's top-1 cosines: the 90th and
 * 95th percentiles by nearest rank (the ⌈p·n⌉-th smallest) and the maximum,
 * each + 1e-6, as distinct values, ascending.
 * @param {number[]} cosines
 * @returns {number[]}
 */
export function noSignalCandidates(cosines) {
  const xs = [...cosines].sort((a, b) => a - b);
  const rank = (/** @type {number} */ p) => xs[Math.ceil(p * xs.length) - 1];
  return [...new Set([rank(0.9), rank(0.95), xs[xs.length - 1]])].map((x) => x + 1e-6);
}
