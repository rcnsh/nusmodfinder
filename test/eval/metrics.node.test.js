// @ts-check
import { describe, expect, it } from 'vitest';
import { assertSameCorpus, byShape, compare, qrelsFor, scoreRanking, scoreRun, summarise, violates } from '../../eval/lib/metrics.mjs';

/** @typedef {import('../../eval/lib/metrics.mjs').RunFile} RunFile */

const L = Math.log2;

describe('scoreRanking', () => {
  const grades = new Map([['A', 2], ['B', 1], ['C', 0], ['D', 2]]);

  it('computes nDCG@10 with gain 2^g - 1 and log2(rank + 1) discount', () => {
    // B(1) at rank 1, X unjudged at 2, A(2) at 3, C(0) at 4.
    const dcg = (2 ** 1 - 1) / L(2) + 0 + (2 ** 2 - 1) / L(4) + 0;
    // Ideal: A, D, B, C.
    const idcg = 3 / L(2) + 3 / L(3) + 1 / L(4);
    const s = scoreRanking(['B', 'X', 'A', 'C'], grades);
    expect(s.dcg).toBeCloseTo(2.5, 12);
    expect(s.idcg).toBeCloseTo(idcg, 12);
    expect(s.ndcg).toBeCloseTo(dcg / idcg, 12);
    expect(s.ndcg).toBeCloseTo(0.463582, 6);
    expect(s.p5).toBe(2 / 5); // B and A; divisor is always 5
    expect(s.rr).toBe(1);
  });

  it('only counts the top 10 and divides P@5 by 5 even for short lists', () => {
    const s = scoreRanking(['A'], grades);
    expect(s.p5).toBe(1 / 5);
    const deep = scoreRanking([...'EFGHIJKLMN'.split(''), 'A'], grades);
    expect(deep.ndcg).toBe(0);
    expect(deep.rr).toBe(0);
  });

  it('is 0 everywhere for an empty ranking', () => {
    expect(scoreRanking([], grades)).toMatchObject({ ndcg: 0, p5: 0, rr: 0 });
  });

  it('is duplicate-group aware: only the first group member earns gain; ideal has one per group', () => {
    const groupOf = new Map([['A', 'g'], ['D', 'g']]);
    // Ideal is one doc per group: g (2), B (1), C (0).
    const idcg = 3 / L(2) + 1 / L(3);
    const s = scoreRanking(['D', 'A', 'B'], grades, groupOf);
    expect(s.idcg).toBeCloseTo(idcg, 12);
    expect(s.ndcg).toBeCloseTo((3 / L(2) + 0 + 1 / L(4)) / idcg, 12);
    expect(s.ndcg).toBeCloseTo(0.9639402, 6);
    expect(s.p5).toBe(2 / 5); // D and B; A is a duplicate of D

    // The first member is the one that appears first, whatever its grade.
    const late = scoreRanking(['C', 'A', 'D'], grades, groupOf);
    expect(late.ndcg).toBeCloseTo((3 / L(3)) / idcg, 12);
    expect(late.rr).toBe(1 / 2);
  });

  it('a duplicate never counts for MRR', () => {
    const grades2 = new Map([['A', 0], ['D', 2], ['B', 1]]);
    const groupOf = new Map([['A', 'g'], ['D', 'g']]);
    // A (grade 0) takes the group's slot; D is a duplicate; B at rank 3 is the first hit.
    expect(scoreRanking(['A', 'D', 'B'], grades2, groupOf).rr).toBe(1 / 3);
  });
});

describe('qrelsFor', () => {
  it('merges global and per-query groups and accepts object judgments', () => {
    const { grades, groupOf } = qrelsFor({
      version: 'v',
      groups: [['TR3202I', 'TR3202S']],
      queries: { q1: { judgments: { TR3202I: { grade: 2, judges: {} }, X: 1 }, groups: [['X', 'Y']] } },
    }, 'q1');
    expect(grades).toEqual(new Map([['TR3202I', 2], ['X', 1]]));
    expect(groupOf.get('TR3202S')).toBe(groupOf.get('TR3202I'));
    expect(groupOf.get('Y')).toBe(groupOf.get('X'));
  });

  it('joins overlapping groups (qrels groups plus the corpus groups) into one', () => {
    const { groupOf } = qrelsFor({
      version: 'v',
      groups: [['A', 'B'], ['C', 'D']],
      queries: { q1: { judgments: { A: 2 }, groups: [['B', 'C']] } },
    }, 'q1');
    expect(new Set(['A', 'B', 'C', 'D'].map((c) => groupOf.get(c))).size).toBe(1);
  });

  it('rejects grades outside 0..2', () => {
    expect(() => qrelsFor({ version: 'v', queries: { q: { judgments: { A: 3 } } } }, 'q')).toThrow(/has grade 3; grades must be 0, 1 or 2/);
    expect(() => qrelsFor(/** @type {any} */ ({ version: 'v', queries: { q: { judgments: { A: { grade: 'two', note: 'x' } } } } }), 'q', 0)).toThrow(/^qrels: query #1, judgment #1 has grade a string;/);
  });
});

describe('violates', () => {
  const doc = { level: 2, semesters: [1, 2], ng: true, ngSemesters: [2], credits: 4, faculty: 'Computing' };
  it('checks semester, NG-in-semester, level, credits and faculty', () => {
    expect(violates(doc, {})).toBe(false);
    expect(violates(doc, { sem: 1 })).toBe(false);
    expect(violates(doc, { sem: 3 })).toBe(true);
    // NG, offered in sem 1, but NG only in sem 2: an exchange student cannot take it in sem 1.
    expect(violates(doc, { ng: true, sem: 1 })).toBe(true);
    expect(violates(doc, { ng: '1', sem: '2' })).toBe(false);
    expect(violates({ ...doc, ng: false }, { ng: 1 })).toBe(true);
    expect(violates(doc, { level: [1, 2] })).toBe(false);
    expect(violates(doc, { level: 3 })).toBe(true);
    expect(violates(doc, { credits: '4' })).toBe(false);
    expect(violates(doc, { faculty: 'Science' })).toBe(true);
    expect(violates(undefined, { sem: 1 })).toBe(false);
  });
});

/** Two queries with answers, one no-answer, one feature-gap. */
const queries = [
  { id: 'q1', text: 'a', shapes: ['topical'], persona: 'p1', filters: { sem: 1 } },
  { id: 'q2', text: 'b', shapes: ['code-exact'], persona: 'p2' },
  { id: 'q3', text: 'c', shapes: ['no-answer'], persona: 'p1' },
  { id: 'q4', text: 'd', shapes: ['constraint'], persona: 'p2' },
  { id: 'q5', text: 'ZZZ9999', shapes: ['code-exact'], persona: 'p2', noAnswerByRule: true },
];
const qrels = {
  version: 'qrels-test',
  queries: {
    q1: { judgments: { A: 2, B: 0, C: 1 } },
    q2: { judgments: { CS1010: 2, CS1010S: 1 } },
    q3: { judgments: { N: 0 } },
    q4: { judgments: { F: 1 } },
    // Graded >= 1 but excluded by rule: a non-existent code is never answerable.
    q5: { judgments: { ZZZ: 1 } },
  },
};
const docs = {
  A: { level: 1, semesters: [1], ng: false, ngSemesters: [], credits: 4, faculty: 'X' },
  B: { level: 1, semesters: [2], ng: false, ngSemesters: [], credits: 4, faculty: 'X' },
  C: { level: 1, semesters: [1, 2], ng: false, ngSemesters: [], credits: 4, faculty: 'X' },
};

/** @param {Record<string, string[]>} codes @returns {RunFile} */
const run = (codes) => ({
  schema: 'vnm-eval-run/1', variant: 'v', set: 'dev', docs,
  results: Object.fromEntries(Object.entries(codes).map(([id, c]) => [id, { status: 200, codes: c }])),
});

describe('scoreRun / summarise', () => {
  const r = run({ q1: ['B', 'A'], q2: ['CS1010'], q3: [], q4: ['F'], q5: ['ZZZ'] });
  const scores = scoreRun(r, queries, qrels);

  it('classifies answerable, no-answer, feature-gap and by-rule queries', () => {
    expect(scores.map((s) => [s.id, s.answerable, s.featureGap])).toEqual([
      ['q1', true, false], ['q2', true, false], ['q3', false, false], ['q4', true, true], ['q5', false, false],
    ]);
  });

  it('summarises the primary block, feature-gap block, no-answer, violations and coverage', () => {
    const s = summarise(scores);
    // q1: B(0) then A(2): dcg 3/log2(3); ideal A, C: 3 + 1/log2(3).
    const q1 = (3 / L(3)) / (3 + 1 / L(3));
    // q2: CS1010(2) alone; ideal CS1010, CS1010S(1).
    const q2 = 3 / (3 + 1 / L(3));
    expect(s.primary.n).toBe(2);
    expect(s.primary.ndcg).toBeCloseTo((q1 + q2) / 2, 12);
    expect(s.primary.p5).toBeCloseTo((1 / 5 + 1 / 5) / 2, 12);
    expect(s.primary.mrr).toBeCloseTo((1 / 2 + 1) / 2, 12);
    expect(s.featureGap).toMatchObject({ n: 1, ndcg: 1 });
    // q3 returned nothing (correct); q5 returned a result (false positive).
    expect(s.noAnswer).toEqual({ n: 2, correctEmpty: 0.5, falsePositives: 1, errors: 0 });
    // q1 is sem 1: B is not offered in sem 1.
    expect(s.violationsAt10).toEqual({ total: 1, perQuery: 1 / 5 });
    expect(s.judgedAt10).toEqual({ judged: 5, top: 5, coverage: 1 });
  });

  it('counts unjudged documents against coverage', () => {
    const s = summarise(scoreRun(run({ q1: ['A', 'U1'], q2: [], q3: ['U2'], q4: [], q5: [] }), queries, qrels));
    expect(s.judgedAt10).toEqual({ judged: 1, top: 3, coverage: 1 / 3 });
  });

  it('breaks down by shape', () => {
    const shapes = byShape(scores);
    expect(Object.keys(shapes)).toEqual(['code-exact', 'constraint', 'no-answer', 'topical']);
    expect(shapes['code-exact']).toMatchObject({ n: 1, ndcg: 3 / (3 + 1 / L(3)), noAnswer: 1, correctEmpty: 0 });
    expect(shapes.topical.violationsAt10).toBe(1);
  });

  it('fails loudly when a query has no result, naming its position, not its id', () => {
    expect(() => scoreRun(run({ q1: [] }), queries, qrels)).toThrow(/^run v has no result for query #2 of 5$/);
  });

  it('a bad grade error carries the value and position, never the judgment (review finding 4)', () => {
    const secret = { version: 'r', queries: { ...qrels.queries, q2: { judgments: { CS1010: 2, CS1010S: { grade: 7, rationale: 'SECRET-RATIONALE about q2' } } } } };
    /** @type {unknown} */
    let err;
    try { scoreRun(run({ q1: [], q2: [], q3: [], q4: [], q5: [] }), queries, secret); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    const msg = /** @type {Error} */ (err).message;
    expect(msg).toBe('qrels: query #2, judgment #2 has grade 7; grades must be 0, 1 or 2');
    expect(msg).not.toMatch(/SECRET|rationale|q2|CS1010/);
    expect(/** @type {Error} */ (err).name).toBe('QrelsError');
  });
});

describe('compare', () => {
  const base = scoreRun(run({ q1: ['B', 'A'], q2: ['CS1010'], q3: ['N'], q4: ['F'], q5: [] }), queries, qrels);
  const cand = scoreRun(run({ q1: ['A', 'C'], q2: ['CS1010S', 'CS1010'], q3: [], q4: [], q5: [] }), queries, qrels);
  const cmp = compare(base, cand);

  it('pairs deltas on the primary answerable set only', () => {
    expect(cmp.n).toBe(2);
    const idcg = 3 + 1 / L(3); // both q1 and q2 have one grade-2 and one grade-1 doc
    const q1Base = (3 / L(3)) / idcg; // B(0), A(2)
    const q1Cand = 1; // A(2), C(1)
    const q2Base = 3 / idcg; // CS1010(2)
    const q2Cand = (1 + 3 / L(3)) / idcg; // CS1010S(1), CS1010(2)
    expect(cmp.overall.ndcg.delta).toBeCloseTo(((q1Cand - q1Base) + (q2Cand - q2Base)) / 2, 12);
    expect(cmp.overall.ndcg.bca.n).toBe(2);
  });

  it('reports the no-answer correct-empty change', () => {
    expect(cmp.noAnswer).toEqual({ n: 2, base: 0.5, cand: 1, delta: 0.5 });
  });

  it('flags an exact-code query whose relevant rank-1 hit moved', () => {
    expect(cmp.exactCodeRegressions).toEqual(['q2']);
  });

  it('refuses runs over different queries', () => {
    expect(() => compare(base, cand.slice(1))).toThrow(/same queries/);
  });
});

describe('assertSameCorpus (review finding 7)', () => {
  const MI = 'a'.repeat(64), NG = 'b'.repeat(64);
  /** @param {Record<string, unknown>} corpus @returns {RunFile} */
  const runOn = (corpus) => ({ schema: 'vnm-eval-run/1', variant: 'cand', set: 'dev', corpus, results: {}, docs: {} });

  it('passes when moduleInfo (and NG, when the qrels record it) match', () => {
    expect(() => assertSameCorpus({ version: 'q1', corpus: { moduleInfoSha256: MI, ngSha256: NG }, queries: {} }, [runOn({ moduleInfoSha256: MI, ngSha256: NG })])).not.toThrow();
    // No NG recorded in the qrels: NG is not compared.
    expect(() => assertSameCorpus({ version: 'q1', corpus: { moduleInfoSha256: MI }, queries: {} }, [runOn({ moduleInfoSha256: MI, ngSha256: 'other' })])).not.toThrow();
  });

  it('refuses a different moduleInfo or NG corpus, naming the qrels version', () => {
    const qrels = { version: 'qrels-dev-v3', corpus: { moduleInfoSha256: MI, ngSha256: NG }, queries: {} };
    expect(() => assertSameCorpus(qrels, [runOn({ moduleInfoSha256: 'c'.repeat(64), ngSha256: NG })]))
      .toThrow(/^qrels qrels-dev-v3 were judged on a corpus with moduleInfoSha256 aaaaaaaaaaaa…, but run cand used cccccccccccc…/);
    expect(() => assertSameCorpus(qrels, [runOn({ moduleInfoSha256: MI, ngSha256: 'd'.repeat(64) })])).toThrow(/with ngSha256 bbbbbbbbbbbb…/);
    expect(() => assertSameCorpus(qrels, [runOn({ moduleInfoSha256: MI })])).toThrow(/ngSha256/);
  });

  it('refuses qrels that record no corpus', () => {
    expect(() => assertSameCorpus({ version: 'q0', queries: {} }, [runOn({ moduleInfoSha256: MI })])).toThrow(/qrels q0 record no corpus\.moduleInfoSha256/);
  });
});
