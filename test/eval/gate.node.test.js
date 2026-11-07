// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSc5Allowed, assertTruncation, devGate, gateFor, holdoutGate, ruleOf, SC5_READING, sc5Gate } from '../../eval/lib/gate.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { compare, scoreRun, summarise } from '../../eval/lib/metrics.mjs';

/** @typedef {import('../../eval/lib/metrics.mjs').QueryScore} QueryScore */

/**
 * A synthetic per-query score.
 * @param {string} id
 * @param {number} ndcg
 * @param {Partial<QueryScore>} [extra]
 * @returns {QueryScore}
 */
const q = (id, ndcg, extra = {}) => ({
  id, shapes: ['topical'], persona: 'p', answerable: true, noAnswer: false, unscored: false, featureGap: false,
  ndcg, p5: ndcg, rr: ndcg, empty: false, error: false, status: 200, violations: 0, judged: 10, top: 10,
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

  it('dev also fails an exact-code regression (ADR 0003 v2.1)', () => {
    const base = [...many(30, 0.4, 0.4).base, q('x1', 1, { shapes: ['code', 'code-exact'], top1: 'CS2040', top1Grade: 2 })];
    const cand = [...spread(many(30, 0.4, 0.6).cand), q('x1', 0.6, { shapes: ['code', 'code-exact'], top1: 'CS2040S', top1Grade: 1 })];
    const v = devGate(compare(base, cand));
    expect(names(v)['ΔnDCG@10 BCa 95% lower bound > 0']).toBe(true);
    expect(names(v)['no exact-code regression']).toBe(false);
    expect(v.verdict).toBe('fail');
  });

  it('an exact-code improvement or an equal-grade swap is not a regression (PR #10 review round 2)', () => {
    const exact = (/** @type {string} */ id, /** @type {string} */ top1, /** @type {number} */ g) => q(id, g / 2, { shapes: ['code', 'code-exact'], top1, top1Grade: g });
    const base = [...many(30, 0.4, 0.4).base, exact('fix', 'CS2040S', 1), exact('swap', 'TR3202I', 2), exact('drop', 'CS1010', 2)];
    const cand = [...spread(many(30, 0.4, 0.6).cand), exact('fix', 'CS2040', 2), exact('swap', 'TR3202S', 2), exact('drop', 'CS1010S', 1)];
    expect(compare(base, cand).exactCodeRegressions).toEqual(['drop']);
    const ok = compare(base.filter((s) => s.id !== 'drop'), cand.filter((s) => s.id !== 'drop'));
    expect(ok.exactCodeRegressions).toEqual([]);
    expect(names(devGate(ok))['no exact-code regression']).toBe(true);
  });

  it('fails an exact-code regression', () => {
    const base = [q('c', 1, { shapes: ['code-exact'], top1: 'CS1010', top1Grade: 2 })];
    const cand = [q('c', 1, { shapes: ['code-exact'], top1: 'CS1010S', top1Grade: 1 })];
    expect(names(holdoutGate(compare(base, cand)))['no exact-code regression']).toBe(false);
  });

  it('cutoff changes use the no-answer trade-off rule instead', () => {
    const answerable = many(20, 0.5, 0.5);
    const noAnswer = (/** @type {boolean[]} */ empties) => empties.map((e, i) => q(`n${i}`, 0, { shapes: ['noanswer'], answerable: false, noAnswer: true, empty: e, judged: 0, top: e ? 0 : 1 }));
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

  it('a tripwire whose every query moved by exactly 0 passes (ADR 0003 amendment 2026-11-07)', () => {
    const core = many(30, 0.3, 0.3);
    const tw = 'tripwire: abbreviation not confidently regressed';
    const withShape = (/** @type {number[]} */ from, /** @type {number[]} */ to) => compare(
      [...core.base, ...from.map((x, i) => q(`a${i}`, x, { shapes: ['abbreviation'] }))],
      [...spread(core.cand), ...to.map((x, i) => q(`a${i}`, x, { shapes: ['abbreviation'] }))],
    );
    // Five queries, none moved: a degenerate interval, and no regression.
    const still = devGate(withShape([0.2, 0.4, 0.6, 0.8, 1], [0.2, 0.4, 0.6, 0.8, 1]), { targetShapes: ['abbreviation'] });
    expect(names(still)[tw]).toBe(true);
    expect(detail(still, tw)).toMatch(/every query's ΔnDCG@10 is 0/);
    // Every query down by the same amount is degenerate too, and still fails.
    const down = devGate(withShape([0.5, 0.5, 0.5], [0.4, 0.4, 0.4]), { targetShapes: ['abbreviation'] });
    expect(names(down)[tw]).toBe(false);
    // Every query up by the same amount stays degenerate and fails, as before: only a zero change passes.
    const up = devGate(withShape([0.5, 0.5, 0.5], [0.6, 0.6, 0.6]), { targetShapes: ['abbreviation'] });
    expect(names(up)[tw]).toBe(false);
  });
});

describe('errored queries (review finding 1)', () => {
  // 8 identical answerable queries plus 4 no-answer ones; the candidate
  // returns HTTP 500 with no codes on the 4 no-answer queries.
  const queries = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, text: 'x', shapes: ['topical'], persona: `p${i % 3}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, text: 'y', shapes: ['noanswer'], persona: 'p0' })),
  ];
  /** @type {import('../../eval/lib/metrics.mjs').Qrels} */
  const qrels = { version: 'r', queries: Object.fromEntries(queries.map((x) => [x.id, { judgments: /** @type {Record<string, number>} */ (x.id.startsWith('a') ? { A: 2 } : { N: 0 }) }])) };
  /** @param {{ status: number, codes: string[] }} noAnswer */
  const run = (noAnswer) => ({
    schema: 'vnm-eval-run/1', variant: 'v', set: 'dev', docs: {},
    results: Object.fromEntries(queries.map((x) => [x.id, x.id.startsWith('a') ? { status: 200, codes: ['A'] } : noAnswer])),
  });
  const base = scoreRun(run({ status: 200, codes: ['N'] }), queries, qrels);
  const cand = scoreRun(run({ status: 500, codes: [] }), queries, qrels);
  const cmp = compare(base, cand);

  it('an error is never correct-empty', () => {
    expect(cand.filter((s) => !s.answerable).every((s) => s.error && !s.empty)).toBe(true);
    expect(summarise(cand).noAnswer).toEqual({ n: 4, correctEmpty: 0, falsePositives: 0, errors: 4 });
    expect(summarise(cand).errors).toBe(4);
    expect(cmp.noAnswer.delta).toBe(0);
    expect(cmp.errors).toEqual({ base: 0, cand: 4 });
  });

  it('the cutoff gate fails on dev and holdout ("no new errors")', () => {
    for (const set of ['dev', 'holdout']) {
      const v = gateFor(set, cmp, { kind: 'cutoff' });
      expect(v.verdict).toBe('fail');
      expect(names(v)['no new errors']).toBe(false);
      expect(detail(v, 'no new errors')).toBe('non-200 responses: baseline 0, candidate 4');
    }
  });

  it('every gate has the check; equal error counts pass it', () => {
    for (const set of ['dev', 'holdout', 'test']) {
      expect(names(gateFor(set, cmp))['no new errors']).toBe(false);
      expect(names(gateFor(set, compare(cand, cand)))['no new errors']).toBe(true);
      expect(names(gateFor(set, compare(cand, base)))['no new errors']).toBe(true);
    }
  });

  it('nothing in an errored response is relevant', () => {
    const answerable = [{ id: 'a0', text: 'x', shapes: ['topical'] }];
    const r = (/** @type {number} */ status) => scoreRun({ schema: 'vnm-eval-run/1', variant: 'v', set: 'dev', docs: {}, results: { a0: { status, codes: ['A'] } } }, answerable, qrels)[0];
    expect(r(200)).toMatchObject({ ndcg: 1, p5: 0.2, rr: 1, error: false, top1: 'A' });
    expect(r(503)).toMatchObject({ ndcg: 0, p5: 0, rr: 0, error: true, empty: false, top1: null, top: 0 });
  });
});

describe('decisive-comparison floors (PR #6 review round 2, finding 5)', () => {
  const judgedAll = (/** @type {QueryScore[]} */ xs) => xs.map((s) => ({ ...s, judged: s.top }));
  const noAnswer = (/** @type {boolean[]} */ empties) => empties.map((e, i) => q(`n${i}`, 0, { shapes: ['noanswer'], answerable: false, noAnswer: true, empty: e, judged: 0, top: e ? 0 : 1 }));

  it('a cutoff verdict over fewer than 3 no-answer queries fails, on dev and holdout', () => {
    const answerable = many(10, 0.5, 0.5);
    const one = compare(judgedAll([...answerable.base, ...noAnswer([false])]), judgedAll([...answerable.cand, ...noAnswer([true])]));
    expect(one.noAnswer.delta).toBe(1);
    for (const gate of [holdoutGate, devGate]) {
      const v = gate(one, { kind: 'cutoff' });
      expect(v.verdict).toBe('fail');
      expect(names(v)['sufficient no-answer queries (>= 3)']).toBe(false);
      expect(detail(v, 'sufficient no-answer queries (>= 3)')).toBe('insufficient queries: 1 no-answer (tagged, no grade-≥1 document), need 3; a cutoff verdict cannot pass on this set');
    }
    const three = compare(judgedAll([...answerable.base, ...noAnswer([false, false, false])]), judgedAll([...answerable.cand, ...noAnswer([true, false, false])]));
    expect(holdoutGate(three, { kind: 'cutoff' }).verdict).toBe('pass');
  });

  it('the targeted dev route needs 3 distinct target-shape queries, counting a multi-shape query once', () => {
    const rest = many(10, 0.5, 0.5);
    // One target query gains +1 while a non-target query loses 1: overall Δ 0.
    const one = compare(
      [...rest.base, q('t0', 0, { shapes: ['t'] })],
      [...rest.cand.map((s, i) => (i === 0 ? { ...s, ndcg: s.ndcg - 0.5 } : s)), q('t0', 0.5, { shapes: ['t'] })],
    );
    const v = devGate(one, { targetShapes: ['t'] });
    expect(v.verdict).toBe('fail');
    expect(v.checks.find((c) => c.name.startsWith('ΔnDCG@10 CI lower > 0'))?.detail).toMatch(/\(n 1, insufficient queries for the targeted route: need 3\)/);

    // The same query under three target shapes is still one query.
    const shared = compare(
      [...rest.base, q('t0', 0, { shapes: ['a', 'b', 'c'] })],
      [...rest.cand, q('t0', 1, { shapes: ['a', 'b', 'c'] })],
    );
    expect(devGate(shared, { targetShapes: ['a', 'b', 'c'] }).verdict).toBe('fail');

    // Three distinct target queries are enough.
    const three = compare(
      [...rest.base, ...['x', 'y', 'z'].map((id) => q(id, 0.2, { shapes: ['t'] }))],
      [...rest.cand, q('x', 0.6, { shapes: ['t'] }), q('y', 0.2, { shapes: ['t'] }), q('z', 0.2, { shapes: ['t'] })],
    );
    expect(devGate(three, { targetShapes: ['t'] }).verdict).toBe('pass');
  });
});

describe('the rule a verdict applies (red-team gap 1)', () => {
  it('names general, targeted with its targets, cutoff and sc5', () => {
    expect(ruleOf('holdout')).toBe('general');
    expect(ruleOf('holdout', { targetShapes: ['typo', 'jargon'] })).toBe('targeted: typo,jargon');
    expect(ruleOf('dev', { kind: 'cutoff' })).toBe('cutoff');
    expect(ruleOf('test', { kind: 'cutoff' })).toBe('sc5');
    expect(ruleOf('holdout', { targetShapes: ['a|b\nc'] })).toBe('targeted: a?b?c');
  });

  it('gateFor carries the rule on the verdict', () => {
    const cmp = compare([q('a', 0.5)], [q('a', 0.5)]);
    expect(gateFor('holdout', cmp, { kind: 'cutoff' }).rule).toBe('cutoff');
    expect(gateFor('dev', cmp, { targetShapes: ['t'] }).rule).toBe('targeted: t');
    expect(gateFor('test', cmp).rule).toBe('sc5');
  });
});

describe('assertTruncation: a cutoff only shortens result lists (red-team gap 1)', () => {
  /** @param {Record<string, { status?: number, codes: string[] }>} results */
  const run = (results) => /** @type {any} */ ({ variant: 'r', results: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { status: 200, ...r }])) });
  const base = run({ a: { codes: ['X', 'Y', 'Z'] }, b: { codes: ['P'] }, c: { codes: [] } });

  it('accepts identical lists, prefixes and emptied lists', () => {
    expect(() => assertTruncation(base, run({ a: { codes: ['X', 'Y'] }, b: { codes: [] }, c: { codes: [] } }))).not.toThrow();
    expect(() => assertTruncation(base, base)).not.toThrow();
  });

  it.each([
    ['a reorder', { a: { codes: ['Y', 'X'] } }],
    ['an added code', { a: { codes: ['X', 'Y', 'Z', 'W'] } }],
    ['a swapped-in code', { a: { codes: ['X', 'W'] } }],
    ['a status change', { a: { status: 500, codes: [] } }],
  ])('refuses %s', (_, edit) => {
    const cand = run({ ...base.results, ...edit });
    expect(() => assertTruncation(base, cand)).toThrow(/is not a truncation of baseline r on 1 of 3 queries/);
  });

  it('refuses a query missing from either run', () => {
    expect(() => assertTruncation(base, run({ a: { codes: [] }, b: { codes: [] } }))).toThrow(/on 1 of 3 queries/);
    expect(() => assertTruncation(base, run({ ...base.results, d: { codes: [] } }))).toThrow(/on 1 of 4 queries/);
  });
});

describe('change kinds no-loss and answerable-floor (P-5b; dev screen only)', () => {
  const NOLOSS = 'ΔnDCG@10 >= 0 (no-loss)';
  const FLOOR = 'answerable ΔnDCG@10 >= -0.01';
  /** 20 answerable queries; the candidate moves each by `d`. */
  const shifted = (/** @type {number} */ d) => {
    const base = spread(many(20, 0.5, 0.5).base);
    return compare(base, base.map((s) => ({ ...s, ndcg: s.ndcg + d })));
  };

  it('no-loss passes an identical candidate, which the general dev rule fails', () => {
    const same = shifted(0);
    expect(devGate(same).verdict).toBe('fail');
    const v = devGate(same, { kind: 'no-loss' });
    expect(v.verdict).toBe('pass');
    expect(names(v)).toMatchObject({ [NOLOSS]: true, 'no exact-code regression': true, 'no new errors': true, [ENOUGH]: true });
  });

  it('no-loss fails any point-estimate loss, however small', () => {
    const v = devGate(shifted(-0.001), { kind: 'no-loss' });
    expect(v.verdict).toBe('fail');
    expect(names(v)[NOLOSS]).toBe(false);
    expect(detail(v, NOLOSS)).toMatch(/^ΔnDCG@10 -0\.0010 over 20 primary answerable queries$/);
  });

  it('no-loss names the exempt queries it left out of its comparison', () => {
    const v = devGate(shifted(0), { kind: 'no-loss', exempt: ['d-099', 'd-011'] });
    expect(detail(v, NOLOSS)).toBe('ΔnDCG@10 0.0000 over 20 primary answerable queries, 2 exempt left out');
  });

  it('answerable-floor passes a loss of 0.01 and fails a larger one', () => {
    expect(devGate(shifted(-0.01), { kind: 'answerable-floor' }).verdict).toBe('pass');
    const v = devGate(shifted(-0.0101), { kind: 'answerable-floor' });
    expect(v.verdict).toBe('fail');
    expect(names(v)[FLOOR]).toBe(false);
    // The other dev checks still apply.
    expect(names(v)).toMatchObject({ 'no exact-code regression': true, 'no new errors': true, 'judged@10 = 100%': true });
  });

  it('the rule is printed as the kind', () => {
    expect(ruleOf('dev', { kind: 'no-loss' })).toBe('no-loss');
    expect(ruleOf('dev', { kind: 'answerable-floor' })).toBe('answerable-floor');
    expect(gateFor('dev', shifted(0), { kind: 'no-loss' }).rule).toBe('no-loss');
  });

  it('the holdout and test gates refuse both kinds', () => {
    for (const set of ['holdout', 'test']) {
      for (const kind of /** @type {const} */ (['no-loss', 'answerable-floor'])) {
        expect(() => gateFor(set, shifted(0), { kind })).toThrow(/dev screen only/);
      }
    }
  });
});

describe('--gate sc5 on the holdout (P-5b)', () => {
  it('applies the SC5 rule to a holdout comparison and records rule sc5', () => {
    const { base } = many(40, 0.3, 0.4);
    const cand = spread(many(40, 0.3, 0.4).cand);
    expect(() => gateFor('holdout', compare(base, cand), { gate: 'sc5' })).toThrow(/sealed-test-set reading/);
    const holdoutReading = /** @type {const} */ ({ reading: 'holdout' });
    const v = gateFor('holdout', compare(base, cand), { gate: 'sc5' }, holdoutReading);
    expect(v).toMatchObject({ set: 'holdout', rule: 'sc5', verdict: 'pass' });
    expect(Object.keys(names(v))).toEqual(['no new errors', ENOUGH, 'judged@10 = 100%', 'ΔnDCG@10 BCa 95% lower bound > 0', 'ΔP@5 BCa 95% lower bound > 0']);
    // A point-estimate gain whose interval spans 0 passes the per-change rule and fails SC5.
    const noisy = base.map((s, i) => ({ ...s, ndcg: s.ndcg + (i % 2 ? 0.2 : -0.19), p5: s.p5 + (i % 2 ? 0.2 : -0.19) }));
    expect(gateFor('holdout', compare(base, noisy)).verdict).toBe('pass');
    expect(gateFor('holdout', compare(base, noisy), { gate: 'sc5' }, holdoutReading).verdict).toBe('fail');
  });

  it('SC5_READING is the reading ADR 0003 records', () => {
    const adr = readFileSync(join(REPO, 'docs/decisions/0003-eval-holdout-and-gate.md'), 'utf8');
    const section = adr.split(/^## /m).find((s) => s.startsWith('SC5 reading'));
    expect(section, 'ADR 0003 has an "SC5 reading" section').toBeDefined();
    const m = /** @type {string} */ (section).match(/\*\*(sealed test set|holdout)\*\*/);
    expect(m, 'the section names the reading in bold').not.toBeNull();
    expect(SC5_READING).toBe(/** @type {RegExpMatchArray} */ (m)[1] === 'holdout' ? 'holdout' : 'sealed');
  });

  it('is refused on the holdout unless the recorded reading is the holdout, and on dev always', () => {
    expect(() => assertSc5Allowed('holdout', 'sealed')).toThrow(/ADR 0003 records the sealed-test-set reading/);
    expect(() => assertSc5Allowed('holdout', 'holdout')).not.toThrow();
    expect(() => assertSc5Allowed('test', 'sealed')).not.toThrow();
    expect(() => assertSc5Allowed('dev', 'holdout')).toThrow(/dev/);
    expect(() => assertSc5Allowed('holdout')).toThrow(/sealed/); // the recorded reading by default
  });
});
