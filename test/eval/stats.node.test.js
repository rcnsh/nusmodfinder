// @ts-check
import { describe, expect, it } from 'vitest';
import { bcaInterval, clusteredInterval, normCdf, normInv, quantile, rng, signFlipP } from '../../eval/lib/stats.mjs';

// Reference intervals from scipy 1.x `scipy.stats.bootstrap((d,), np.mean,
// method="BCa", n_resamples=200_000, random_state=1)`. Ours uses 10k
// resamples, so agreement is to Monte Carlo error (~0.003 here).
const D1 = [0.12, -0.05, 0.30, 0.0, 0.08, 0.22, -0.10, 0.15, 0.05, 0.40, -0.02, 0.18, 0.0, 0.07, 0.25, -0.15, 0.11, 0.09, 0.33, 0.02];
const D1_SCIPY = { lower: 0.044, upper: 0.1685 };
const D2 = [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const D2_SCIPY = { lower: 0.008, upper: 0.228 };

describe('normal distribution helpers', () => {
  it('invert each other at the usual critical values', () => {
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normInv(0.5)).toBe(0);
    expect(normInv(0.001)).toBeCloseTo(-3.090232, 5);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(-Infinity)).toBe(0);
  });

  it('quantile interpolates between order statistics (type 7)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([10, 20], 0.25)).toBe(12.5);
  });

  it('rng is deterministic per seed', () => {
    const a = rng(42), b = rng(42), c = rng(43);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('bcaInterval', () => {
  it('matches scipy BCa on a skewed sample', () => {
    const ci = bcaInterval(D1);
    expect(ci.estimate).toBeCloseTo(0.1025, 10);
    expect(Math.abs(ci.lower - D1_SCIPY.lower)).toBeLessThan(0.004);
    expect(Math.abs(ci.upper - D1_SCIPY.upper)).toBeLessThan(0.004);
  });

  it('matches scipy BCa on a sparse, mostly-zero sample', () => {
    const ci = bcaInterval(D2);
    expect(Math.abs(ci.lower - D2_SCIPY.lower)).toBeLessThan(0.004);
    expect(Math.abs(ci.upper - D2_SCIPY.upper)).toBeLessThan(0.006);
  });

  it('is reproducible for a seed', () => {
    expect(bcaInterval(D1, { seed: 9 })).toEqual(bcaInterval(D1, { seed: 9 }));
  });

  it('collapses to the point when every delta is equal (including all zero)', () => {
    expect(bcaInterval([0, 0, 0])).toMatchObject({ estimate: 0, lower: 0, upper: 0 });
    expect(bcaInterval([0.2, 0.2])).toMatchObject({ lower: 0.2, upper: 0.2 });
  });

  it('flags a zero-variance interval as degenerate (review finding 6)', () => {
    expect(bcaInterval([0.3])).toMatchObject({ estimate: 0.3, lower: 0.3, upper: 0.3, degenerate: true });
    expect(bcaInterval([0.1, 0.1, 0.1]).degenerate).toBe(true);
    expect(bcaInterval([]).degenerate).toBe(true);
    // Equal up to float noise is still no variance.
    expect(bcaInterval([0.4 - 0.3, 0.41 - 0.31, 0.42 - 0.32]).degenerate).toBe(true);
    expect(bcaInterval(D1).degenerate).toBe(false);
    expect(bcaInterval([0, 0, 0.01]).degenerate).toBe(false);
  });

  it('narrows as alpha grows', () => {
    const wide = bcaInterval(D1, { alpha: 0.05 });
    const narrow = bcaInterval(D1, { alpha: 0.1 });
    expect(narrow.lower).toBeGreaterThan(wide.lower);
    expect(narrow.upper).toBeLessThan(wide.upper);
  });
});

describe('signFlipP', () => {
  it('enumerates small samples exactly', () => {
    // ±1 ±2 ±3 → sums 6, 4, 2, 0, 0, -2, -4, -6; |sum| >= 6 in 2 of 8.
    expect(signFlipP([1, 2, 3])).toEqual({ p: 0.25, exact: true, n: 3 });
    // ±1 ±1 with observed sum 0: every assignment is at least as extreme.
    expect(signFlipP([1, -1]).p).toBe(1);
    // Zero deltas are ignored; [1, 0, 2, 0, 3] is the same test as [1, 2, 3].
    expect(signFlipP([1, 0, 2, 0, 3]).p).toBe(0.25);
  });

  it('returns 1 when nothing changed', () => {
    expect(signFlipP([0, 0, 0]).p).toBe(1);
  });

  it('uses Monte Carlo with the +1 correction above the exact limit', () => {
    // 30 identical +1s: only the two all-same assignments reach |30|, so the
    // true p is 2^-29; Monte Carlo floors at 1 / (R + 1).
    const r = signFlipP(new Array(30).fill(1));
    expect(r.exact).toBe(false);
    expect(r.p).toBeCloseTo(1 / 10001, 10);
  });
});

describe('clusteredInterval', () => {
  it('resamples whole clusters', () => {
    const ci = clusteredInterval(D1, D1.map((_, i) => `p${i % 4}`));
    expect(ci.clusters).toBe(4);
    expect(ci.estimate).toBeCloseTo(0.1025, 10);
    expect(ci.lower).toBeLessThan(ci.estimate);
    expect(ci.upper).toBeGreaterThan(ci.estimate);
  });

  it('with one cluster has no between-cluster variance', () => {
    const ci = clusteredInterval([0.1, 0.3], ['a', 'a']);
    expect(ci.lower).toBeCloseTo(0.2, 12);
    expect(ci.upper).toBeCloseTo(0.2, 12);
  });

  it('needs a label per delta', () => {
    expect(() => clusteredInterval([1, 2], ['a'])).toThrow(/one cluster label per delta/);
  });
});
