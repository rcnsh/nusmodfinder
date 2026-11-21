// @ts-check

/** @type {Readonly<Record<string, number | null>>} */
export const NO_SIGNAL_VARIANTS = Object.freeze({
  off: null,
  p90: 0.5693180883526313,
  p95: 0.5814376699800824,
  max: 0.6012585039510654,
});

export const NO_SIGNAL_VARIANT = 'max';

export const NO_SIGNAL_TAU = NO_SIGNAL_VARIANTS[NO_SIGNAL_VARIANT];

/**
 * @param {number[]} cosines
 * @returns {number[]}
 */
export function noSignalCandidates(cosines) {
  const xs = [...cosines].sort((a, b) => a - b);
  const rank = (/** @type {number} */ p) => xs[Math.ceil(p * xs.length) - 1];
  return [...new Set([rank(0.9), rank(0.95), xs[xs.length - 1]])].map((x) => x + 1e-6);
}
