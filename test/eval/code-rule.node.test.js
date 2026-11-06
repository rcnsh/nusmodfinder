// @ts-check
// The code-target rule grade (JUDGING.md rule 4, applied mechanically): the
// grades per code form, the hard-constraint override, variants and
// cross-listings, replacing judge A's grade, and the committed dev qrels.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_RULE, applyCodeRule, codeRuleGrades, withCodeRule } from '../../eval/lib/code-rule.mjs';
import { buildRound, mergeQrels, pairKey, poolCandidate } from '../../eval/lib/judging.mjs';
import { qrelsFor } from '../../eval/lib/metrics.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

/**
 * A corpus module with the fields the rule reads (public corpus fields only).
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 */
const mod = (code, extra = {}) => ({
  code, title: `Title of ${code}`, description: `About ${code}.`, level: Number(/\d/.exec(code)?.[0] ?? 1),
  credits: 4, semesters: [1, 2], ng: true, ngSemesters: [1, 2], faculty: 'Computing', department: 'CS', ...extra,
});

/**
 * A code-origin query.
 * @param {string} id
 * @param {'exact' | 'space' | 'partial'} codeForm
 * @param {string} target
 * @param {Record<string, unknown>} [filters]
 */
const codeQuery = (id, codeForm, target, filters = { ng: true }) => ({
  id, text: codeForm === 'space' ? target.replace(/^([A-Z]+)/, '$1 ').toLowerCase() : target,
  filters, shapes: ['code', `code-${codeForm}`], origin: 'code', codeForm, target,
});

const MODULES = [
  mod('CS2030'),
  mod('CS2030S', { title: 'Programming Methodology II (S)' }), // variant, other title: not in a group
  mod('CS2030DE'), // variant (two suffix letters)
  mod('CS20301'), // not a variant: five digits
  mod('CS2031'),
  mod('IT2030', { title: 'Title of CS2030', description: 'About CS2030.' }), // cross-listed with CS2030
  mod('MUL2107'), mod('MUL2109'), mod('MUL3101'), mod('XMUL2101'),
  mod('LL4541V'), mod('LL4541'), mod('LL4541X'),
];
const GROUPS = [['CS2030', 'CS2030DE', 'IT2030']];

/** @param {Map<string, { grade: number }>} m @param {string} qid */
const gradesOf = (m, qid) => Object.fromEntries([...m].filter(([k]) => k.startsWith(`${qid}\t`)).map(([k, v]) => [k.split('\t')[1], v.grade]));

describe('codeRuleGrades', () => {
  it('exact form: the target 2, its variants and cross-listings 1, nothing else', () => {
    const g = codeRuleGrades([codeQuery('q1', 'exact', 'CS2030')], MODULES, { groups: GROUPS });
    expect(gradesOf(g, 'q1')).toEqual({ CS2030: 2, CS2030S: 1, CS2030DE: 1, IT2030: 1 });
    expect(g.get(pairKey('q1', 'CS2030'))?.rationale).toMatch(/exact code/);
    expect(g.get(pairKey('q1', 'IT2030'))?.rationale).toMatch(/cross-list/);
    expect(g.get(pairKey('q1', 'CS2030S'))?.rationale).toMatch(/variant/);
  });

  it('space form grades like the exact form', () => {
    const g = codeRuleGrades([codeQuery('q2', 'space', 'CS2030')], MODULES, { groups: GROUPS });
    expect(gradesOf(g, 'q2')).toEqual({ CS2030: 2, CS2030S: 1, CS2030DE: 1, IT2030: 1 });
  });

  it('partial form: every offered module whose code starts with the target is 2', () => {
    const g = codeRuleGrades([codeQuery('q3', 'partial', 'MUL21')], MODULES, { groups: GROUPS });
    expect(gradesOf(g, 'q3')).toEqual({ MUL2107: 2, MUL2109: 2 });
  });

  it('variants at grade 1 when the target itself carries a suffix', () => {
    const g = codeRuleGrades([codeQuery('q4', 'exact', 'LL4541V')], MODULES, { groups: [] });
    expect(gradesOf(g, 'q4')).toEqual({ LL4541V: 2, LL4541: 1, LL4541X: 1 });
  });

  it('hard constraints win: a target or variant breaking the filters is 0, with the reason', () => {
    const modules = MODULES.map((m) => (m.code === 'CS2030' ? { ...m, ng: false, ngSemesters: [] }
      : m.code === 'CS2030S' ? { ...m, semesters: [2], ngSemesters: [2] }
        : m.code === 'MUL2109' ? { ...m, level: 2, credits: 2 } : m));
    const g = codeRuleGrades([codeQuery('q5', 'exact', 'CS2030', { ng: true, sem: 1 }), codeQuery('q6', 'partial', 'MUL21', { ng: true, credits: 4 })], modules, { groups: GROUPS });
    expect(gradesOf(g, 'q5')).toEqual({ CS2030: 0, CS2030S: 0, CS2030DE: 1, IT2030: 1 });
    expect(g.get(pairKey('q5', 'CS2030'))?.rationale).toBe('hard constraint: not open to non-graduating students');
    expect(g.get(pairKey('q5', 'CS2030S'))?.rationale).toBe('hard constraint: not offered in semester 1');
    expect(gradesOf(g, 'q6')).toEqual({ MUL2107: 2, MUL2109: 0 });
    // `constraints`, when a query has them, are the hard constraints (not `filters`).
    const withConstraints = { ...codeQuery('q7', 'exact', 'CS2030', { ng: true }), constraints: { level: [3] } };
    expect(gradesOf(codeRuleGrades([withConstraints], MODULES, { groups: GROUPS }), 'q7')).toEqual({ CS2030: 0, CS2030S: 0, CS2030DE: 0, IT2030: 0 });
  });

  it('leaves non-code queries and no-answer-by-rule codes alone, and refuses an unknown form', () => {
    const topical = { id: 't', text: 'CS2030', filters: {}, shapes: ['topical'] };
    const none = { ...codeQuery('n', 'exact', 'CS2030'), noAnswerByRule: true };
    expect(codeRuleGrades([topical, none], MODULES, { groups: GROUPS }).size).toBe(0);
    expect(() => codeRuleGrades([{ ...codeQuery('b', 'exact', 'CS2030'), codeForm: 'fuzzy' }], MODULES, { groups: GROUPS })).toThrow(/code form/);
  });
});

describe('applyCodeRule / withCodeRule', () => {
  const judged = (/** @type {number} */ grade) => ({ grade, source: 'judged', round: 'r1', judges: { 'claude-opus-5-5': { slot: 'A', grade, rationale: 'A says' } } });
  const base = () => ({
    schema: 'vnm-eval-qrels/1', set: 'dev', version: 'qrels-dev-v1', corpus: { moduleInfoSha256: 'mi' }, groups: [],
    judging: [{ round: 'r1' }],
    queries: {
      q1: { judgments: { CS2030: judged(1), CS2030S: judged(2), CS2031: judged(0), CS2030DE: judged(1) } },
      t: { judgments: { CS2030: judged(2) } },
    },
  });

  it('replaces A grades (counting the direction), adds unpooled pairs, keeps everything else', () => {
    const grades = codeRuleGrades([codeQuery('q1', 'exact', 'CS2030')], MODULES, { groups: GROUPS });
    const { queries, stats, changes } = applyCodeRule(base(), grades);
    expect(stats.overrides).toEqual({ total: 3, up: 1, down: 1, same: 1 });
    expect(stats.added).toEqual({ 0: 0, 1: 1, 2: 0 }); // IT2030 was never pooled
    expect(stats.queries).toBe(1);
    expect(queries.q1.judgments.CS2031).toEqual(judged(0)); // not a target, variant or cross-listing: A's grade stands
    expect(queries.t.judgments.CS2030).toEqual(judged(2));
    expect(queries.q1.judgments.CS2030).toMatchObject({ grade: 2, source: 'rule', round: CODE_RULE });
    // A's own grade rides along for provenance; the final grade is the rule's.
    expect(/** @type {any} */ (queries.q1.judgments.CS2030).judges).toMatchObject({ 'claude-opus-5-5': { slot: 'A', grade: 1 }, rule: { slot: 'rule', grade: 2 } });
    expect(changes).toContainEqual({ queryId: 'q1', code: 'CS2030', from: 1, fromSource: 'judged', to: 2 });
    expect(changes).toContainEqual({ queryId: 'q1', code: 'IT2030', from: null, fromSource: null, to: 1 });
  });

  it('bumps the version and records provenance; a second pass changes nothing', () => {
    const grades = codeRuleGrades([codeQuery('q1', 'exact', 'CS2030')], MODULES, { groups: GROUPS });
    const once = withCodeRule(base(), grades, { createdAt: 'now', groupsVersion: 'groups-v1', corpusSha256: 'mi' });
    expect(once.qrels.version).toBe('qrels-dev-v2');
    expect(once.qrels.judging.at(-1)).toEqual({
      round: CODE_RULE, mode: 'rule', rule: 'JUDGING.md rule 4 (code target), applied mechanically from public corpus fields',
      corpus: { moduleInfoSha256: 'mi' }, groups: 'groups-v1', pairs: 4,
      added: { 0: 0, 1: 1, 2: 0 }, changed: { '1->2': 1, '2->1': 1 }, overrides: { total: 3, up: 1, down: 1, same: 1 }, createdAt: 'now',
    });
    const twice = applyCodeRule(once.qrels, grades);
    expect(twice.changes).toEqual([]);
    expect(twice.stats.overrides.total).toBe(0);
  });
});

describe('merge applies the rule', () => {
  it('last: it replaces A\'s grade for the pairs it names and adds pairs nobody pooled', () => {
    const q = codeQuery('q1', 'exact', 'CS2030');
    const pool = {
      schema: 'vnm-eval-pool/1', set: 'dev', queriesVersion: 'x', corpus: { moduleInfoSha256: 'mi', ngSha256: 'ng' }, embedding: 'e', sourceRuns: 1, depth: 10,
      queries: [{ id: 'q1', text: q.text, filters: q.filters, constraints: q.filters, candidates: ['CS2030', 'CS2031'].map((c) => poolCandidate(MODULES.find((m) => m.code === c))) }],
    };
    const round = buildRound({ pool: /** @type {any} */ (pool), poolSha256: 'p', queries: [q], set: 'dev', round: 'r1', judges: { A: 'claude-opus-5-5' }, seed: 1, repeatRate: 0 });
    for (const id of Object.keys(round.items)) round.grades.A[id] = { grade: 0, rationale: 'A' };
    const merged = mergeQrels(round, { createdAt: 'now', codeRule: codeRuleGrades([q], MODULES, { groups: GROUPS }) });
    expect(merged.queries.q1.judgments.CS2030).toMatchObject({ grade: 2, source: 'rule', round: CODE_RULE });
    expect(merged.queries.q1.judgments.CS2031).toMatchObject({ grade: 0, source: 'judged' });
    expect(merged.queries.q1.judgments.IT2030).toMatchObject({ grade: 1, source: 'rule' });
    expect(/** @type {any} */ (merged.judging.at(-1)).codeRule).toEqual({
      rule: CODE_RULE, pairs: 4, queries: 1, added: { 0: 0, 1: 3, 2: 0 }, changed: { '0->2': 1 }, overrides: { total: 1, up: 1, down: 0, same: 0 },
    });
  });
});

describe('the committed dev qrels (qrels-dev-v2 and later)', () => {
  it('make the five red-team code queries answerable, with the rule grades', async () => {
    const qrels = JSON.parse(await readFile(join(REPO, 'eval/dev/qrels.json'), 'utf8'));
    expect(Number(/^qrels-dev-v(\d+)$/.exec(qrels.version)?.[1])).toBeGreaterThanOrEqual(2);
    expect(qrels.judging).toContainEqual(expect.objectContaining({ round: CODE_RULE, mode: 'rule', groups: 'groups-v1' }));
    const g = (/** @type {string} */ qid) => qrelsFor(qrels, qid, 0).grades;
    expect(g('d-087').get('CN2109')).toBe(2);
    expect(g('d-089').get('IS4246')).toBe(2);
    expect(g('d-090').get('MUL2107')).toBe(2);
    expect(g('d-090').get('MUL2109')).toBe(2);
    expect(g('d-091').get('DAO1704X')).toBe(2);
    expect([...g('d-092')].filter(([c, v]) => c.startsWith('GEC') && v === 2).length).toBeGreaterThanOrEqual(30);
    for (const id of ['d-082', 'd-083', 'd-084', 'd-085', 'd-086', 'd-087', 'd-088', 'd-089', 'd-090', 'd-091', 'd-092']) {
      expect([...g(id).values()].some((v) => v >= 1), id).toBe(true);
      const j = qrels.queries[id].judgments;
      expect(Object.values(j).some((x) => x.source === 'rule' && x.round === CODE_RULE), id).toBe(true);
    }
  });
});
