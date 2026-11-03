// @ts-check
import { describe, expect, it } from 'vitest';
import { devGate, gateFor, holdoutGate, sc5Gate } from '../../eval/lib/gate.mjs';
import { compare } from '../../eval/lib/metrics.mjs';

/** @typedef {import('../../eval/lib/metrics.mjs').QueryScore} QueryScore */

/**
 * A synthetic per-query score.
 * @param {string} id
 * @param {number} ndcg
 * @param {Partial<QueryScore>} [extra]
 * @returns {QueryScore}
 */
const q = (id, ndcg, extra = {}) => ({
  id, shapes: ['topical'], persona: 'p', answerable: true, featureGap: false,
  ndcg, p5: ndcg, rr: ndcg, empty: false, status: 200, violations: 0, judged: 10, top: 10,
  top1: 'X', top1Grade: 2, ...extra,
});

/** n queries whose score moves from `from` to `to`. */
const many = (/** @type {number} */ n, /** @type {number} */ from, /** @type {number} */ to, /** @type {Partial<QueryScore>} */ extra = {}) => ({
  base: Array.from({ length: n }, (_, i) => q(`q${i}`, from + (i % 3) * 0.01, extra)),
  cand: Array.from({ length: n }, (_, i) => q(`q${i}`, to + (i % 3) * 0.01, extra)),
});

const names = (/** @type {{ checks: { name: string, pass: boolean }[] }} */ v) => Object.fromEntries(v.checks.map((c) => [c.name, c.pass]));
const detail = (/** @type {{ checks: { name: string, detail: string }[] }} */ v, /** @type {string} */ name) => v.checks.find((c) => c.name === name)?.detail ?? '';

/** Per-query variation, so the deltas have variance and the interval is not degenerate. */
const spread = (/** @type {QueryScore[]} */ scores) => scores.map((s, i) => ({ ...s, ndcg: s.ndcg + (i % 4) * 0.01, p5: s.p5 + (i % 4) * 0.01, rr: s.rr + (i % 4) * 0.01 }));
const ENOUGH = 'sufficient queries (>= 10 answerable)';

describe('devGate', () => {
  it('passes a change whose BCa lower bound is above 0', () => {
    const { base, cand } = many(30, 0.4, 0.5);
    const v = devGate(compare(base, spread(cand)));
    expect(v.verdict).toBe('pass');
  });

  it('fails a change with no improvement (identical runs)', () => {
    const { base } = many(30, 0.4, 0.4);
    const v = devGate(compare(base, base));
    expect(v.verdict).toBe('fail');
    expect(names(v)['ΔnDCG@10 BCa 95% lower bound > 0']).toBe(false);
  });

  it('passes a targeted change: target shape improves and overall Δ >= 0, CI not required', () => {
    const base = [...many(30, 0.5, 0.5).base, ...Array.from({ length: 5 }, (_, i) => q(`t${i}`, 0.2, { shapes: ['typo'] }))];
    const cand = [...many(30, 0.5, 0.5).cand, q('t0', 0.6, { shapes: ['typo'] }), ...base.slice(31)];
    const cmp = compare(base, cand);
    expect(cmp.overall.ndcg.bca.lower).toBeLessThanOrEqual(0);
    expect(devGate(cmp).verdict).toBe('fail');
    expect(devGate(cmp, { targetShapes: ['typo'] }).verdict).toBe('pass');
  });

  it('the tripwire fails a target shape that confidently regressed', () => {
    const base = [...many(40, 0.3, 0.3).base, ...Array.from({ length: 12 }, (_, i) => q(`c${i}`, 0.9, { shapes: ['code-partial'] }))];
    const cand = [...many(40, 0.3, 0.3).cand.map((s) => ({ ...s, ndcg: s.ndcg + 0.3 })), ...Array.from({ length: 12 }, (_, i) => q(`c${i}`, 0.5 + (i % 2) * 0.05, { shapes: ['code-partial'] }))];
    const cmp = compare(base, cand);
    expect(cmp.overall.ndcg.bca.lower).toBeGreaterThan(0);
    const v = devGate(cmp, { targetShapes: ['code-partial'] });
    expect(names(v)['tripwire: code-partial not confidently regressed']).toBe(false);
    expect(v.verdict).toBe('fail');
  });

  it('requires 100% judged@10', () => {
    const { base, cand } = many(30, 0.4, 0.5);
    const v = devGate(compare(base, cand.map((s, i) => (i === 0 ? { ...s, judged: 9 } : s))));
    expect(names(v)['judged@10 = 100%']).toBe(false);
    expect(v.verdict).toBe('fail');
  });
});

describe('holdoutGate', () => {
  it('passes on point estimates >= 0 (no CI needed)', () => {
    const { base, cand } = many(20, 0.4, 0.4);
    const v = holdoutGate(compare(base, cand.map((s, i) => (i === 0 ? { ...s, ndcg: s.ndcg + 0.01, p5: s.p5 + 0.01 } : s))));
    expect(v.verdict).toBe('pass');
  });

  it('fails on a P@5 drop even when nDCG rises', () => {
    const { base, cand } = many(20, 0.4, 0.4);
    const v = holdoutGate(compare(base, cand.map((s) => ({ ...s, ndcg: s.ndcg + 0.1, p5: s.p5 - 0.01 }))));
    expect(names(v)).toMatchObject({ 'ΔnDCG@10 >= 0': true, 'ΔP@5 >= 0': false });
    expect(v.verdict).toBe('fail');
  });

  it('fails an exact-code regression', () => {
    const base = [q('c', 1, { shapes: ['code-exact'], top1: 'CS1010', top1Grade: 2 })];
    const cand = [q('c', 1, { shapes: ['code-exact'], top1: 'CS1010S', top1Grade: 1 })];
    expect(names(holdoutGate(compare(base, cand)))['no exact-code regression']).toBe(false);
  });

  it('cutoff changes use the no-answer trade-off rule instead', () => {
    const answerable = many(20, 0.5, 0.5);
    const noAnswer = (/** @type {boolean[]} */ empties) => empties.map((e, i) => q(`n${i}`, 0, { answerable: false, empty: e, judged: 0, top: e ? 0 : 1 }));
    const base = [...answerable.base, ...noAnswer([false, false, false, false, false])];
    // Correct-empty 0 -> 0.4 (+0.4); answerable nDCG down 0.005 (allowed, <= 0.01).
    const cand = [...answerable.cand.map((s) => ({ ...s, ndcg: s.ndcg - 0.005, p5: s.p5 - 0.05 })), ...noAnswer([true, true, false, false, false])];
    const cmp = compare(base, cand.map((s) => ({ ...s, judged: s.top })));
    const fixed = compare(base.map((s) => ({ ...s, judged: s.top })), cand.map((s) => ({ ...s, judged: s.top })));
    expect(holdoutGate(fixed).verdict).toBe('fail'); // general rule: ΔP@5 < 0
    expect(holdoutGate(fixed, { kind: 'cutoff' }).verdict).toBe('pass');
    expect(devGate(fixed, { kind: 'cutoff' }).verdict).toBe('pass');
    expect(cmp.noAnswer.delta).toBe(0.4);

    // A no-answer gain of 0.2 (< 0.25) fails.
    const small = compare(base.map((s) => ({ ...s, judged: s.top })), [...answerable.cand, ...noAnswer([true, false, false, false, false])].map((s) => ({ ...s, judged: s.top })));
    expect(holdoutGate(small, { kind: 'cutoff' }).verdict).toBe('fail');
    // Too large an answerable loss fails.
    const lossy = compare(base.map((s) => ({ ...s, judged: s.top })), [...answerable.cand.map((s) => ({ ...s, ndcg: s.ndcg - 0.02 })), ...noAnswer([true, true, true, true, true])].map((s) => ({ ...s, judged: s.top })));
    expect(names(holdoutGate(lossy, { kind: 'cutoff' }))['answerable nDCG@10 loss <= 0.01']).toBe(false);
  });
});

describe('sc5Gate', () => {
  it('needs both lower bounds above 0', () => {
    const { base } = many(40, 0.3, 0.4);
    const cand = spread(many(40, 0.3, 0.4).cand);
    expect(sc5Gate(compare(base, cand)).verdict).toBe('pass');
    const flatP5 = cand.map((s, i) => ({ ...s, p5: base[i].p5 }));
    expect(sc5Gate(compare(base, flatP5)).verdict).toBe('fail');
  });

  it('gateFor routes by set', () => {
    const { base, cand } = many(40, 0.3, 0.4);
    const cmp = compare(base, cand);
    expect(gateFor('holdout', cmp).set).toBe('holdout');
    expect(gateFor('test', cmp).set).toBe('test');
    expect(gateFor('dev', cmp).set).toBe('dev');
  });
});

describe('small samples and degenerate intervals (review finding 6)', () => {
  it('every gate fails with "insufficient queries" below 10 answerable queries, however large the gain', () => {
    const one = compare([q('a', 0.2)], [q('a', 0.5)]);
    for (const set of ['dev', 'holdout', 'test']) {
      const v = gateFor(set, one);
      expect(v.verdict).toBe('fail');
      expect(names(v)[ENOUGH]).toBe(false);
      expect(detail(v, ENOUGH)).toMatch(/^insufficient queries: 1 primary answerable, need 10$/);
    }
    expect(gateFor('dev', one, { kind: 'cutoff' }).verdict).toBe('fail');
    expect(gateFor('holdout', one, { kind: 'cutoff' }).verdict).toBe('fail');
  });

  it('10 answerable queries are enough; 9 are not', () => {
    const at = (/** @type {number} */ n) => {
      const { base, cand } = many(n, 0.3, 0.6);
      return devGate(compare(base, spread(cand)));
    };
    expect(names(at(9))[ENOUGH]).toBe(false);
    expect(at(9).verdict).toBe('fail');
    expect(at(10).verdict).toBe('pass');
  });

  it('a CI-based check never passes on a degenerate (zero-variance) interval', () => {
    // 30 queries that all move by exactly +0.2: the BCa interval has no width.
    const base = Array.from({ length: 30 }, (_, i) => q(`q${i}`, 0.3));
    const cand = Array.from({ length: 30 }, (_, i) => q(`q${i}`, 0.5));
    const cmp = compare(base, cand);
    expect(cmp.overall.ndcg.bca).toMatchObject({ degenerate: true });
    expect(cmp.overall.ndcg.bca.lower).toBeGreaterThan(0);
    const dev = devGate(cmp);
    expect(names(dev)['ΔnDCG@10 BCa 95% lower bound > 0']).toBe(false);
    expect(detail(dev, 'ΔnDCG@10 BCa 95% lower bound > 0')).toMatch(/degenerate/);
    expect(sc5Gate(cmp).verdict).toBe('fail');
    // The holdout gate uses point estimates only, so it is unaffected.
    expect(holdoutGate(cmp).verdict).toBe('pass');
  });

  it('a tripwire over fewer than 3 queries uses "point estimate >= 0"', () => {
    const core = many(30, 0.3, 0.3);
    const tw = 'tripwire: typo not confidently regressed';
    const withTypo = (/** @type {number[]} */ from, /** @type {number[]} */ to) => compare(
      [...core.base, ...from.map((x, i) => q(`t${i}`, x, { shapes: ['typo'] }))],
      [...spread(core.cand), ...to.map((x, i) => q(`t${i}`, x, { shapes: ['typo'] }))],
    );
    const down = devGate(withTypo([0.5, 0.5], [0.3, 0.6]), { targetShapes: ['typo'] });
    expect(names(down)[tw]).toBe(false);
    expect(detail(down, tw)).toMatch(/^n 2 < 3: point estimate/);
    const up = devGate(withTypo([0.5, 0.5], [0.5, 0.7]), { targetShapes: ['typo'] });
    expect(names(up)[tw]).toBe(true);
    // One query that did not move is not a confident regression either.
    expect(names(devGate(withTypo([0.5], [0.5]), { targetShapes: ['typo'] }))[tw]).toBe(true);
  });
});
