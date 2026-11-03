// @ts-check
// Inter-rater agreement (eval/lib/agreement.mjs) against hand-computed values.
// The exact fractions below were derived by hand (shown for EX1) and checked
// with an independent fractions-only script, not with this implementation.
import { describe, expect, it } from 'vitest';
import { agreementReport, binaryKappa, cohenKappa, krippendorffOrdinal, quadraticKappa, rawAgreement } from '../../eval/lib/agreement.mjs';

// EX1: 8 units, grades 0..2.
//   A = 0 0 1 2 2 1 0 2
//   B = 0 1 1 2 1 1 0 2
const A1 = [0, 0, 1, 2, 2, 1, 0, 2];
const B1 = [0, 1, 1, 2, 1, 1, 0, 2];

describe('rawAgreement', () => {
  it('is the share of units with equal grades', () => {
    expect(rawAgreement(A1, B1)).toBe(6 / 8);
    expect(rawAgreement([0, 2], [2, 0])).toBe(0);
  });
  it('is NaN on empty input', () => {
    expect(rawAgreement([], [])).toBeNaN();
  });
  it('refuses unequal lengths', () => {
    expect(() => rawAgreement([0], [0, 1])).toThrow(/same number of units/);
  });
});

describe('quadraticKappa', () => {
  it('EX1: 4/5', () => {
    // Observed joint p (rows A, cols B), /8: [[2,1,0],[0,2,0],[0,1,2]].
    // Marginals A (3,2,3)/8, B (2,4,2)/8. Weights (i-j)^2/4.
    // Observed weighted disagreement: (1·1/4 + 1·1/4)/8 = 1/16.
    // Expected: Σ w·pA·pB = [3·4·¼ + 3·2·1 + 2·2·¼ + 2·2·¼ + 3·2·1 + 3·4·¼]/64 = 20/64 = 5/16.
    // κ = 1 − (1/16)/(5/16) = 4/5.
    expect(quadraticKappa(A1, B1).value).toBeCloseTo(0.8, 12);
  });
  it('perfect reversal of three grades is −1', () => {
    expect(quadraticKappa([0, 1, 2], [2, 1, 0]).value).toBeCloseTo(-1, 12);
  });
  it('is 1 for perfect agreement over two categories', () => {
    expect(quadraticKappa([0, 0, 2, 2], [0, 0, 2, 2]).value).toBe(1);
  });
  it('is 0 (never −0) when one rater uses a single category and the other does not', () => {
    expect(Object.is(quadraticKappa([1, 1, 1, 0], [1, 1, 1, 1]).value, 0)).toBe(true);
    expect(Object.is(binaryKappa([1, 1, 1, 0], [1, 1, 1, 1]).value, 0)).toBe(true);
    expect(Object.is(krippendorffOrdinal([0, 0, 0, 1], [0, 0, 0, 0]).value, 0)).toBe(true); // exactly 0 by hand
  });
  it('is undefined (NaN, degenerate) when both raters use one and the same category', () => {
    const k = quadraticKappa([0, 0, 0, 0], [0, 0, 0, 0]);
    expect(k.value).toBeNaN();
    expect(k.degenerate).toBe(true);
  });
  it('is NaN on empty input', () => {
    expect(quadraticKappa([], []).value).toBeNaN();
  });
});

describe('binaryKappa (grade ≥ 1)', () => {
  it('EX1: 5/7', () => {
    // Binarised A = 0 0 1 1 1 1 0 1, B = 0 1 1 1 1 1 0 1.
    // po = 7/8; pA(1) = 5/8, pB(1) = 6/8; pe = 5/8·6/8 + 3/8·2/8 = 36/64.
    // κ = (56/64 − 36/64)/(1 − 36/64) = 20/28 = 5/7.
    expect(binaryKappa(A1, B1).value).toBeCloseTo(5 / 7, 12);
  });
  it('[0,1,2] vs [2,1,0] is −1/2', () => {
    expect(binaryKappa([0, 1, 2], [2, 1, 0]).value).toBeCloseTo(-0.5, 12);
  });
  it('treats 1 and 2 as the same category', () => {
    expect(binaryKappa([1, 2, 0, 0], [2, 1, 0, 0]).value).toBe(1);
  });
  it('is degenerate when every grade falls on one side of the threshold', () => {
    const k = binaryKappa([1, 2, 1], [2, 2, 1]);
    expect(k.value).toBeNaN();
    expect(k.degenerate).toBe(true);
  });
  it('is NaN on empty input', () => {
    expect(binaryKappa([], []).value).toBeNaN();
  });
});

describe('cohenKappa', () => {
  it('unweighted 3-category κ on EX1', () => {
    // po = 6/8; pe = (3·2 + 2·4 + 3·2)/64 = 20/64; κ = (48 − 20)/(64 − 20) = 28/44 = 7/11.
    expect(cohenKappa(A1, B1, { categories: [0, 1, 2], weight: (i, j) => (i === j ? 0 : 1) }).value).toBeCloseTo(7 / 11, 12);
  });
  it('rejects grades outside the categories', () => {
    expect(() => cohenKappa([0, 3], [0, 1], { categories: [0, 1, 2], weight: () => 1 })).toThrow(/outside the categories/);
  });
});

describe('krippendorffOrdinal', () => {
  it('EX1: 13/16', () => {
    // Coincidences (each unit adds both ordered pairs): o00 4, o01 = o10 1, o11 4,
    // o12 = o21 1, o22 4. n0 5, n1 6, n2 5, n 16.
    // Ordinal δ²: (0,1) = (n0 + n1 − (n0 + n1)/2)² = 5.5² = 30.25; (1,2) = 30.25;
    // (0,2) = (n0 + n1 + n2 − (n0 + n2)/2)² = 11² = 121.
    // Do = Σ o·δ² = 2·30.25 + 2·30.25 = 121.
    // De = Σ nc·nk·δ² = 2·(5·6·30.25 + 6·5·30.25 + 5·5·121) = 9680.
    // α = 1 − (n − 1)·Do/De = 1 − 15·121/9680 = 13/16.
    expect(krippendorffOrdinal(A1, B1).value).toBeCloseTo(13 / 16, 12);
  });
  it('[0,1,2] vs [2,1,0] is −2/3; [0,2] vs [2,0] is −1/2', () => {
    expect(krippendorffOrdinal([0, 1, 2], [2, 1, 0]).value).toBeCloseTo(-2 / 3, 12);
    expect(krippendorffOrdinal([0, 2], [2, 0]).value).toBeCloseTo(-0.5, 12);
  });
  it('is 1 for perfect agreement and 0 for [1,1,1,0] vs all 1s', () => {
    expect(krippendorffOrdinal([0, 0, 2, 2], [0, 0, 2, 2]).value).toBe(1);
    expect(krippendorffOrdinal([1, 1, 1, 0], [1, 1, 1, 1]).value).toBeCloseTo(0, 12);
  });
  it('is undefined (NaN, degenerate) when every value is one category', () => {
    const a = krippendorffOrdinal([2, 2, 2], [2, 2, 2]);
    expect(a.value).toBeNaN();
    expect(a.degenerate).toBe(true);
  });
  it('is NaN on empty input', () => {
    expect(krippendorffOrdinal([], []).value).toBeNaN();
  });
});

describe('agreementReport', () => {
  it('reports every metric overall and per shape, with n', () => {
    const units = A1.map((a, i) => ({ a, b: B1[i], shapes: i < 4 ? ['topical'] : ['code', 'code-exact'] }));
    const r = agreementReport(units);
    expect(r.overall.n).toBe(8);
    expect(r.overall.raw).toBe(0.75);
    expect(r.overall.alpha).toBeCloseTo(13 / 16, 12);
    expect(r.overall.binaryKappa).toBeCloseTo(5 / 7, 12);
    expect(r.overall.quadraticKappa).toBeCloseTo(0.8, 12);
    expect(Object.keys(r.shapes)).toEqual(['code', 'code-exact', 'topical']);
    expect(r.shapes.topical.n).toBe(4);
    // topical: A 0 0 1 2, B 0 1 1 2.
    expect(r.shapes.topical.raw).toBe(0.75);
    expect(r.shapes['code-exact'].n).toBe(4);
  });
  it('is all-NaN with n 0 for no units', () => {
    const r = agreementReport([]);
    expect(r.overall).toMatchObject({ n: 0 });
    for (const k of ['raw', 'alpha', 'binaryKappa', 'quadraticKappa']) expect(r.overall[/** @type {'raw'} */ (k)]).toBeNaN();
    expect(r.shapes).toEqual({});
  });
});
