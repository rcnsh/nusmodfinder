// @ts-check
// Phase 2d judging (eval/lib/judging.mjs): pre-grading, batches, repeats,
// packets, validation, collection, adjudication, merge, drift, calibration.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agreementBlock } from '../../eval/lib/agreement.mjs';
import {
  agreementUnits, allocate, buildAdjudication, buildRound, calibrationCsv, calibrationSample, chunkEvenly, collectOutputs,
  constraintText, driftReport, dropJudge, finalJudgments, gradeBy, humanAgreement, isRuleJudgment, isSingleJudge, judgeSlots,
  graderLabels, judgedPairKeys, mergeQrels, ndcgDelta, nextVersion, pairKey, parseCsv, poolCandidate, preGrade, qrelsSlots, qrelsUnder,
  readCalibration, renderAdjudicationPacket, renderJudgePacket, sampleDrift, selfConsistency, toCsv, validateSectionOutput,
  verbatimBlock,
} from '../../eval/lib/judging.mjs';
import { qrelsFor, scoreRun } from '../../eval/lib/metrics.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

const JUDGING = readFileSync(join(REPO, 'eval', 'JUDGING.md'), 'utf8');

/** @param {string} code @param {Partial<import('../../eval/lib/judging.mjs').Candidate>} [over] */
const mod = (code, over = {}) => poolCandidate({
  code, title: `Title of ${code}`, level: Number(code.match(/\d/)?.[0] ?? 1), credits: 4, semesters: [1, 2], ngSemesters: [1, 2],
  faculty: 'Computing', department: 'Computer Science', description: `About ${code}.`, prerequisite: 'SECRET-PREREQ', ...over,
});

/** @type {import('../../eval/lib/metrics.mjs').EvalQuery[]} */
const QUERIES = Array.from({ length: 14 }, (_, i) => ({
  id: `q-${String(i + 1).padStart(2, '0')}`,
  text: `query text ${i + 1}`,
  filters: i === 0 ? { sem: 1, ng: true } : { ng: true },
  shapes: i < 7 ? ['topical'] : ['code', 'code-exact'],
  persona: 'P-SECRET',
  narrative: { relevant: `rel ${i + 1}`, partial: `part ${i + 1}`, notRelevant: `not ${i + 1}` },
}));

/** A pool: q-01 (sem 1 + NG) has one sem-2-only and one non-NG candidate. */
function makePool() {
  return {
    schema: 'vnm-eval-pool/1', set: 'dev', queriesVersion: 'test-v1', seed: 1, depth: 10, sourceRuns: 3,
    corpus: { moduleInfoSha256: 'mi-sha', ngSha256: 'ng-sha' }, embedding: 'emb-test',
    queries: QUERIES.map((q, i) => ({
      id: q.id, text: q.text, narrative: q.narrative, filters: q.filters ?? {}, constraints: q.filters ?? {},
      candidates: [
        ...Array.from({ length: 8 }, (_, k) => mod(`CS${i + 1}0${k}`)),
        ...(i === 0 ? [mod('RUL9901', { semesters: [2] }), mod('RUL9902', { ngSemesters: [] })] : []),
      ],
    })),
  };
}

/** @param {Partial<import('../../eval/lib/judging.mjs').RoundOptions>} [over] */
const makeRound = (over = {}) => buildRound({
  pool: /** @type {any} */ (makePool()), poolSha256: 'pool-sha', queries: QUERIES, set: 'dev', round: 'r1',
  judges: { A: 'judge-a', B: 'judge-b' }, seed: 7, batchSize: 4, createdAt: '2026-11-04T00:00:00Z', ...over,
});

/** Grades for every item of a slot: f(queryId, code, kind) -> grade. */
function gradeAll(/** @type {any} */ round, /** @type {string} */ slot, /** @type {(q: string, c: string) => number} */ f) {
  for (const [id, it] of Object.entries(round.items)) {
    const item = /** @type {import('../../eval/lib/judging.mjs').Item} */ (it);
    if (item.slot === slot) round.grades[slot][id] = { grade: f(item.queryId, item.code), rationale: `r ${item.code}` };
  }
}

describe('preGrade', () => {
  it('grades hard-constraint violations 0 by rule, with the reason, and keeps them from judges', () => {
    const { rule, toJudge } = preGrade(/** @type {any} */ (makePool()));
    expect(rule).toEqual({
      [pairKey('q-01', 'RUL9901')]: { grade: 0, rationale: 'hard constraint: not offered in semester 1' },
      [pairKey('q-01', 'RUL9902')]: { grade: 0, rationale: 'hard constraint: not open to non-graduating students' },
    });
    expect(toJudge['q-01'].map((c) => c.code)).toHaveLength(8);
    expect(toJudge['q-02']).toHaveLength(8);
  });

  it('checks NG in the constraint semester, level, credits and faculty', () => {
    const pool = /** @type {any} */ ({
      queries: [{
        id: 'x', candidates: [mod('A1', { ngSemesters: [2] }), mod('B2', {}), mod('C3', { credits: 2 }), mod('D1', { faculty: 'Law' })],
        constraints: { sem: 1, ng: true, level: [1, 3], credits: 4, faculty: 'Computing' },
      }],
    });
    const { rule } = preGrade(pool);
    expect(Object.fromEntries(Object.entries(rule).map(([k, v]) => [k.split('\t')[1], v.rationale]))).toEqual({
      A1: 'hard constraint: not open to non-graduating students in semester 1',
      B2: 'hard constraint: level 2 is not 1 or 3',
      C3: 'hard constraint: 2 credits, not 4',
      D1: 'hard constraint: faculty Law, not Computing',
    });
  });
});

describe('chunkEvenly', () => {
  it('makes ceil(n / size) chunks differing by at most one', () => {
    expect(chunkEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 12).map((c) => c.length)).toEqual([7, 7]);
    expect(chunkEvenly([1, 2, 3], 12).map((c) => c.length)).toEqual([3]);
    expect(chunkEvenly([], 12)).toEqual([]);
  });
});

describe('buildRound', () => {
  const round = makeRound();
  const items = Object.values(round.items);

  it('shows every non-rule pair exactly once per judge as a new item, and no rule pair', () => {
    for (const slot of ['A', 'B']) {
      const fresh = items.filter((i) => i.slot === slot && i.kind === 'new').map((i) => pairKey(i.queryId, i.code)).sort();
      expect(fresh).toEqual(judgedPairKeys(round).sort());
      expect(fresh).toHaveLength(14 * 8);
    }
    expect(items.some((i) => i.code === 'RUL9901' || i.code === 'RUL9902')).toBe(false);
  });

  it('batches ~batchSize queries per judge run, every query once', () => {
    expect(round.batches.A.map((b) => new Set(b.sections.map((s) => s.queryId)).size)).toEqual([4, 4, 3, 3]);
    expect(round.batches.A.flatMap((b) => [...new Set(b.sections.map((s) => s.queryId))]).sort()).toEqual(QUERIES.map((q) => q.id));
  });

  it('plants ~5% repeats per batch (at least one) in a later section of the same query, under new ids', () => {
    for (const slot of /** @type {const} */ (['A', 'B'])) {
      for (const b of round.batches[slot]) {
        const ids = b.sections.flatMap((s) => s.items);
        const fresh = ids.filter((id) => round.items[id].kind === 'new');
        const repeats = ids.filter((id) => round.items[id].kind === 'repeat');
        expect(repeats.length).toBe(Math.max(1, Math.round(0.05 * fresh.length)));
        for (const id of repeats) {
          const rep = round.items[id], orig = round.items[/** @type {string} */ (rep.repeatOf)];
          expect([rep.queryId, rep.code, rep.batch]).toEqual([orig.queryId, orig.code, orig.batch]);
          expect(id).not.toBe(rep.repeatOf);
          const at = (/** @type {string} */ sec) => b.sections.findIndex((s) => s.id === sec);
          expect(at(rep.section)).toBeGreaterThan(at(orig.section));
        }
      }
    }
  });

  it('records a seed per section, uses unique opaque ids, and is reproducible from the round seed', () => {
    const all = Object.keys(round.items);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^i[0-9a-z]{6}$/);
    for (const s of round.batches.A.flatMap((b) => b.sections)) expect(Number.isInteger(s.seed)).toBe(true);
    expect(makeRound()).toEqual(round);
    // A and B see the same pairs in different orders.
    const orderOf = (/** @type {'A' | 'B'} */ slot) => round.batches[slot].flatMap((b) => b.sections.flatMap((s) => s.items.map((id) => round.items[id].code)));
    expect(orderOf('A')).not.toEqual(orderOf('B'));
    expect(makeRound({ seed: 8 }).batches.A).not.toEqual(round.batches.A);
  });

  it('carries no repeats when the rate is 0', () => {
    expect(Object.values(makeRound({ repeatRate: 0 }).items).some((i) => i.kind === 'repeat')).toBe(false);
  });

  it('refuses the reserved ids rule and adjudicator as judge ids', () => {
    expect(() => makeRound({ judges: { A: 'rule', B: 'gemini' } })).toThrow(/reserved/);
    expect(() => makeRound({ judges: { A: 'opus', B: 'adjudicator' } })).toThrow(/reserved/);
  });

  it('refuses a pool query that is not in the query set, and identical judges', () => {
    expect(() => makeRound({ queries: QUERIES.slice(1) })).toThrow(/not in the dev query set/);
    expect(() => makeRound({ judges: { A: 'same', B: 'same' } })).toThrow(/different judges/);
  });
});

describe('renderJudgePacket', () => {
  const round = makeRound();
  const packet = renderJudgePacket(round, 'A', 'b01', { judging: JUDGING, queries: QUERIES, outDir: '/tmp/vnm-out' });
  const batch = round.batches.A[0];

  it('starts with the judge instructions and examples from JUDGING.md, verbatim', () => {
    const instructions = verbatimBlock(JUDGING, 'judge-instructions');
    expect(instructions).toMatch(/^You are grading search results/);
    expect(packet).toContain(instructions);
    expect(packet).toContain(verbatimBlock(JUDGING, 'judge-examples'));
  });

  it('holds every item of the batch with its fields, output path and a fillable template', () => {
    for (const s of batch.sections) {
      expect(packet).toContain(`**Write to:** \`/tmp/vnm-out/A/b01/${s.id}.json\``);
      const tpl = packet.split(`**Template for ${s.id}:**`)[1].split('```json\n')[1].split('\n```')[0];
      const parsed = JSON.parse(tpl);
      expect(Object.keys(parsed)).toEqual(s.items);
      for (const v of Object.values(parsed)) expect(v).toEqual({ grade: null, rationale: null });
      for (const id of s.items) expect(packet).toContain(`#### Item ${id}`);
    }
    expect(packet).toContain('- Open to non-graduating (exchange) students: yes, in semester 1, semester 2');
  });

  it('shows no query id, shape, persona, prerequisite, rule-graded pair, rank, score or system', () => {
    for (const q of QUERIES) expect(packet).not.toContain(q.id);
    // The fixed instructions mention "variants" (of a course code); the rest of the packet must not.
    const body = packet.replace(verbatimBlock(JUDGING, 'judge-instructions'), '').replace(verbatimBlock(JUDGING, 'judge-examples'), '');
    for (const word of ['topical', 'code-exact', 'P-SECRET', 'SECRET-PREREQ', 'RUL9901', 'RUL9902', 'rank', 'score', 'variant', 'hybrid', 'lexical', 'vector', 'judge-a', 'judge-b']) {
      expect(body.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('says the constraints in words', () => {
    expect(constraintText({ sem: 1, ng: true })).toBe('offered in semester 1; open to non-graduating (exchange) students in semester 1');
    expect(constraintText({ ng: true, level: [1, 2] })).toBe('open to non-graduating (exchange) students; level 1000 or 2000');
    expect(constraintText({})).toBe('none');
  });
});

describe('validateSectionOutput', () => {
  const ids = ['iaaaaaa', 'ibbbbbb'];
  const good = { iaaaaaa: { grade: 2, rationale: 'exact topic' }, ibbbbbb: { grade: 0, rationale: 'unrelated' } };
  const v = (/** @type {unknown} */ out) => validateSectionOutput(ids, typeof out === 'string' || out === null ? out : JSON.stringify(out)).problems;

  it('accepts a complete output and returns its grades', () => {
    const r = validateSectionOutput(ids, JSON.stringify(good));
    expect(r.problems).toEqual([]);
    expect(r.grades.iaaaaaa).toEqual({ grade: 2, rationale: 'exact topic' });
  });
  it('a missing file', () => expect(v(null)).toEqual(['file missing']));
  it('invalid JSON, without quoting the text', () => expect(v('{ "iaaaaaa": SECRET')).toEqual(['not valid JSON']));
  it('an array or a scalar instead of an object', () => {
    expect(v([1, 2])).toEqual(['not a JSON object of item ids']);
    expect(v('3')).toEqual(['not a JSON object of item ids']);
  });
  it('an ungraded item', () => expect(v({ iaaaaaa: good.iaaaaaa })).toEqual(['item ibbbbbb not graded']));
  it('an unknown id, named only when it looks like an id', () => {
    expect(v({ ...good, izzzzzz: { grade: 1, rationale: 'x' } })).toEqual(['unknown item id "izzzzzz"']);
    expect(v({ ...good, 'SECRET text here': 1 })).toEqual(['unknown item id (a key that is not an item id)']);
    // Words a judge used as keys (they may quote an encrypted query) are never printed.
    expect(v({ ...good, management: 1, in: 2 })).toEqual(['unknown item id (a key that is not an item id)', 'unknown item id (a key that is not an item id)']);
  });
  it('grades outside {0,1,2}', () => {
    expect(v({ ...good, iaaaaaa: { grade: 3, rationale: 'x' } })).toEqual(['item iaaaaaa: grade 3, must be 0, 1 or 2']);
    expect(v({ ...good, iaaaaaa: { grade: 1.5, rationale: 'x' } })).toEqual(['item iaaaaaa: grade 1.5, must be 0, 1 or 2']);
    expect(v({ ...good, iaaaaaa: { grade: '2', rationale: 'x' } })).toEqual(['item iaaaaaa: grade is a string, must be 0, 1 or 2']);
    expect(v({ ...good, iaaaaaa: { grade: null, rationale: 'x' } })).toEqual(['item iaaaaaa: grade null, must be 0, 1 or 2']);
    expect(v({ ...good, iaaaaaa: { rationale: 'x' } })).toEqual(['item iaaaaaa: grade is a undefined, must be 0, 1 or 2']);
  });
  it('a missing or empty rationale', () => {
    expect(v({ ...good, iaaaaaa: { grade: 1 } })).toEqual(['item iaaaaaa: rationale missing or empty']);
    expect(v({ ...good, iaaaaaa: { grade: 1, rationale: '   ' } })).toEqual(['item iaaaaaa: rationale missing or empty']);
    expect(v({ ...good, iaaaaaa: { grade: 1, rationale: 7 } })).toEqual(['item iaaaaaa: rationale missing or empty']);
  });
  it('an entry that is not an object, or has extra keys', () => {
    expect(v({ ...good, iaaaaaa: 2 })).toEqual(['item iaaaaaa: entry is not an object']);
    expect(v({ ...good, iaaaaaa: { grade: 1, rationale: 'x', confidence: 0.9 } })).toEqual(['item iaaaaaa: 1 unexpected key']);
  });
  it('stores nothing from a section with any problem', () => {
    expect(validateSectionOutput(ids, JSON.stringify({ iaaaaaa: good.iaaaaaa })).grades).toEqual({});
  });
});

describe('collectOutputs', () => {
  it('stores valid sections, reports the rest, keeps earlier grades for missing files, and is idempotent', () => {
    const round = makeRound();
    const batches = round.batches.A.slice(0, 1);
    const [s1, s2] = batches[0].sections;
    const answer = (/** @type {string[]} */ ids) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { grade: 1, rationale: 'ok' }])));
    /** @type {Record<string, string | null>} */
    const files = { [s1.id]: answer(s1.items), [s2.id]: '{}' };
    const store = /** @type {Record<string, any>} */ ({});
    const r1 = collectOutputs(batches, store, (_b, s) => files[s] ?? null, 'A');
    expect(r1.problems[0]).toMatch(new RegExp(`^A b01/${s2.id}: item i[0-9a-z]{6} not graded$`));
    expect(r1.problems.some((p) => p.endsWith(': file missing'))).toBe(true);
    for (const id of s1.items) expect(store[id]).toEqual({ grade: 1, rationale: 'ok' });
    expect(s2.items.some((id) => store[id])).toBe(false);
    // The judge fixes S02; S01's file is gone (cleaned) but its grades stay.
    files[s2.id] = answer(s2.items);
    delete files[s1.id];
    collectOutputs(batches, store, (_b, s) => files[s] ?? null, 'A');
    for (const id of [...s1.items, ...s2.items]) expect(store[id]).toBeTruthy();
    // An invalid rewrite drops the section's grades.
    files[s1.id] = 'not json';
    const r3 = collectOutputs(batches, store, (_b, s) => files[s] ?? null, 'A');
    expect(r3.problems).toContain(`A b01/${s1.id}: not valid JSON`);
    expect(s1.items.some((id) => store[id])).toBe(false);
  });
});

describe('self-consistency, drift and agreement units', () => {
  it('compares each planted repeat with its original', () => {
    const round = makeRound();
    gradeAll(round, 'A', () => 1);
    expect(selfConsistency(round, 'A')).toMatchObject({ exact: 1, meanAbsDiff: 0 });
    const reps = Object.entries(round.items).filter(([, i]) => i.slot === 'A' && i.kind === 'repeat');
    round.grades.A[reps[0][0]].grade = 2;
    const sc = selfConsistency(round, 'A');
    expect(sc.n).toBe(reps.length);
    expect(sc.exact).toBeCloseTo((reps.length - 1) / reps.length, 12);
    expect(sc.meanAbsDiff).toBeCloseTo(1 / reps.length, 12);
  });

  it('re-judges a drift sample and reports agreement with the stored grade', () => {
    const drift = [
      { queryId: 'q-03', code: 'OLD1', grade: 2, candidate: mod('OLD1') },
      { queryId: 'q-04', code: 'OLD2', grade: 0, candidate: mod('OLD2') },
    ];
    const round = makeRound({ drift });
    const driftItems = Object.values(round.items).filter((i) => i.kind === 'drift');
    expect(driftItems.map((i) => `${i.slot}:${i.code}`).sort()).toEqual(['A:OLD1', 'A:OLD2', 'B:OLD1', 'B:OLD2']);
    expect(judgedPairKeys(round)).not.toContain(pairKey('q-03', 'OLD1'));
    gradeAll(round, 'A', (_q, c) => (c === 'OLD1' ? 1 : 0));
    expect(driftReport(round, 'A')).toEqual({ n: 2, exact: 0.5, meanDelta: -0.5 });
  });

  it('pairs A and B only on new items', () => {
    const round = makeRound();
    gradeAll(round, 'A', () => 1);
    gradeAll(round, 'B', (_q, c) => (c.endsWith('0') ? 2 : 1));
    const units = agreementUnits(round);
    expect(units).toHaveLength(14 * 8);
    expect(units.filter((u) => u.a !== u.b)).toHaveLength(14);
    expect(units[0].shapes).toEqual(['topical']);
  });
});

describe('adjudication', () => {
  const setup = () => {
    const round = makeRound();
    gradeAll(round, 'A', () => 1);
    gradeAll(round, 'B', (_q, c) => (c.endsWith('0') ? 2 : c.endsWith('1') ? 0 : 1));
    return round;
  };

  it('refuses until both judges are collected, and refuses a judge as adjudicator', () => {
    const round = makeRound();
    gradeAll(round, 'A', () => 1);
    expect(() => buildAdjudication(round, { adjudicator: 'adj' })).toThrow(/collect both judges first/);
    expect(() => buildAdjudication(setup(), { adjudicator: 'judge-a' })).toThrow(/must not be one of the judges/);
    expect(() => buildAdjudication(setup(), { adjudicator: 'rule' })).toThrow(/reserved/);
  });

  it('takes exactly the pairs where |A − B| ≥ 1, blind in pass 1, both grades in pass 2', () => {
    const round = setup();
    round.adjudication = buildAdjudication(round, { adjudicator: 'adj', batchSize: 12 });
    const adj = round.adjudication;
    expect(Object.keys(adj.items)).toHaveLength(28);
    const o = { judging: JUDGING, queries: QUERIES, outDir: '/tmp/vnm-out' };
    const p1 = renderAdjudicationPacket(round, 'b01', 1, o);
    expect(p1).toContain(verbatimBlock(JUDGING, 'adjudicator-pass1'));
    expect(p1).toContain(verbatimBlock(JUDGING, 'judge-instructions'));
    expect(p1).not.toMatch(/Grader 1|first-pass grade|r CS/);
    expect(p1).toContain('/tmp/vnm-out/adjudicator/p1/b01/S01.json');
    expect(() => renderAdjudicationPacket(round, 'b01', 2, o)).toThrow(/pass 2 needs every pass-1 grade/);
    for (const id of Object.keys(adj.items)) adj.pass1[id] = { grade: 1, rationale: 'blind view' };
    const p2 = renderAdjudicationPacket(round, 'b01', 2, o);
    expect(p2).toContain(verbatimBlock(JUDGING, 'adjudicator-pass2'));
    expect(p2).toContain('- Your first-pass grade 1: "blind view"');
    expect(p2).toMatch(/- Grader 1: grade [012]: "r CS/);
    expect(p2).toMatch(/- Grader 2: grade [012]: "r CS/);
    expect(p2).not.toMatch(/judge-a|judge-b|\bA\b:|\bB\b:/);
    // Both orders occur.
    expect(new Set(Object.values(adj.items).map((i) => i.first))).toEqual(new Set(['A', 'B']));
  });
});

describe('finalJudgments and mergeQrels', () => {
  const complete = () => {
    const round = makeRound();
    gradeAll(round, 'A', (_q, c) => (c.endsWith('0') ? 2 : 0));
    gradeAll(round, 'B', (_q, c) => (c.endsWith('0') ? 2 : c.endsWith('1') ? 1 : 0));
    round.adjudication = buildAdjudication(round, { adjudicator: 'adj' });
    for (const id of Object.keys(round.adjudication.items)) {
      round.adjudication.pass1[id] = { grade: 1, rationale: 'blind' };
      round.adjudication.pass2[id] = { grade: 1, rationale: 'final' };
    }
    return round;
  };

  it('final = rule, else agreed, else adjudicated', () => {
    const f = finalJudgments(complete());
    expect(f.get(pairKey('q-01', 'RUL9901'))).toMatchObject({ grade: 0, source: 'rule', judges: { rule: { grade: 0 } } });
    expect(f.get(pairKey('q-02', 'CS200'))).toMatchObject({ grade: 2, source: 'agreed', judges: { 'judge-a': { slot: 'A', grade: 2 }, 'judge-b': { slot: 'B', grade: 2 } } });
    expect(f.get(pairKey('q-02', 'CS201'))).toMatchObject({
      grade: 1, source: 'adjudicated',
      judges: { 'judge-a': { grade: 0 }, 'judge-b': { grade: 1 }, adj: { slot: 'adjudicator', grade: 1, rationale: 'final', blind: { grade: 1, rationale: 'blind' } } },
    });
    expect(f.size).toBe(14 * 8 + 2);
  });

  it('refuses while a disagreement has no pass-2 grade or a pair lacks a judge', () => {
    const round = complete();
    const first = Object.keys(/** @type {any} */ (round.adjudication).items)[0];
    delete /** @type {any} */ (round.adjudication).pass2[first];
    expect(() => finalJudgments(round)).toThrow(/0 without both judges' grades, 1 disagreement\(s\) without a pass-2 adjudication/);
    const r2 = makeRound();
    gradeAll(r2, 'A', () => 1);
    expect(() => finalJudgments(r2)).toThrow(/112 without both judges' grades/);
  });

  it('writes vnm-eval-qrels/1 the scorer accepts, with corpus, judges and a bumped version', () => {
    const round = complete();
    const q = mergeQrels(round, { createdAt: 'now' });
    expect(q).toMatchObject({ schema: 'vnm-eval-qrels/1', set: 'dev', version: 'qrels-dev-v1', corpus: { moduleInfoSha256: 'mi-sha', ngSha256: 'ng-sha' }, embedding: 'emb-test', groups: [] });
    expect(q.judging).toEqual([{ round: 'r1', judges: { A: 'judge-a', B: 'judge-b' }, adjudicator: 'adj', pairs: 114, pool: 'pool-sha', createdAt: 'now' }]);
    const { grades } = qrelsFor(q, 'q-02', 1);
    expect(grades.get('CS200')).toBe(2);
    expect(grades.get('CS201')).toBe(1);
    // Incremental: a second round merged onto the first bumps the version and keeps groups.
    const base = { ...q, groups: [['CS100', 'CS101']], version: 'qrels-dev-v3', queries: {} };
    const q2 = mergeQrels(round, { base });
    expect(q2.version).toBe('qrels-dev-v4');
    expect(q2.groups).toEqual([['CS100', 'CS101']]);
    expect(q2.judging).toHaveLength(2);
  });

  it('refuses pairs already in the base, another corpus, and a pool without a corpus', () => {
    const round = complete();
    const q = mergeQrels(round);
    expect(() => mergeQrels(round, { base: q })).toThrow(/already judged in the base qrels/);
    expect(() => mergeQrels(round, { base: { ...q, queries: {}, corpus: { moduleInfoSha256: 'other' } } })).toThrow(/another corpus/);
    round.pool.corpus = null;
    expect(() => mergeQrels(round)).toThrow(/no corpus.moduleInfoSha256/);
  });

  it('nextVersion', () => {
    expect(nextVersion(undefined, 'holdout')).toBe('qrels-holdout-v1');
    expect(nextVersion('qrels-dev-v9', 'dev')).toBe('qrels-dev-v10');
    expect(nextVersion('fixture-qrels-v1', 'fixture')).toBe('fixture-qrels-v2');
    expect(nextVersion('odd', 'dev')).toBe('odd-v2');
  });
});

describe('sampleDrift', () => {
  const qrels = /** @type {any} */ ({
    version: 'v', queries: {
      a: { judgments: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`C${i}`, { grade: i % 3, judges: {} }])) },
      b: { judgments: { R1: { grade: 0, source: 'rule', judges: { rule: { grade: 0 } } }, N1: 2 } },
    },
  });
  it('samples round(5%) of non-rule pairs, at least one, deterministically', () => {
    const s = sampleDrift(qrels, { seed: 1 });
    expect(s).toHaveLength(2); // round(0.05 × 31)
    expect(s.some((p) => p.code === 'R1')).toBe(false);
    expect(sampleDrift(qrels, { seed: 1 })).toEqual(s);
    expect(sampleDrift({ version: 'v', queries: { b: qrels.queries.b } }, { seed: 1 })).toEqual([{ queryId: 'b', code: 'N1', grade: 2 }]);
    expect(sampleDrift(qrels, { seed: 1, rate: 0 })).toEqual([]);
  });
});

describe('calibration', () => {
  it('allocate: equal targets water-fill around small strata; minEach covers every stratum', () => {
    expect(allocate([100, 10, 100], 150, [1, 1, 1])).toEqual([70, 10, 70]);
    expect(allocate([3, 3], 150, [1, 1])).toEqual([3, 3]);
    expect(allocate([90, 9, 1], 10, [90, 9, 1], 1)).toEqual([8, 1, 1]);
  });

  /** Qrels over QUERIES: grade = k % 3 for 8 codes each, plus a rule pair. */
  const qrels = /** @type {any} */ ({
    version: 'qrels-dev-v1',
    queries: Object.fromEntries(QUERIES.map((q, i) => [q.id, {
      judgments: {
        ...Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`CS${i + 1}0${k}`, {
          grade: k % 3, source: 'agreed',
          judges: { ja: { slot: 'A', grade: k % 3, rationale: 'a' }, jb: { slot: 'B', grade: Math.min(2, k % 3 + (k === 1 ? 1 : 0)), rationale: 'b' } },
        }])),
        RULE1: { grade: 0, source: 'rule', judges: { rule: { slot: 'rule', grade: 0, rationale: 'x' } } },
      },
    }])),
  });

  it('stratifies by grade and shape, excludes rule pairs, and is seeded', () => {
    const s = calibrationSample(qrels, QUERIES, { n: 30, seed: 3 });
    expect(s.available).toBe(14 * 8);
    expect(s.pairs).toHaveLength(30);
    expect(s.pairs.some((p) => p.code === 'RULE1')).toBe(false);
    const byGrade = [0, 1, 2].map((g) => s.pairs.filter((p) => p.grade === g).length);
    expect(byGrade).toEqual([10, 10, 10]);
    expect(Object.keys(s.strata).sort()).toEqual(['code/0', 'code/1', 'code/2', 'topical/0', 'topical/1', 'topical/2']);
    expect(calibrationSample(qrels, QUERIES, { n: 30, seed: 3 })).toEqual(s);
    expect(calibrationSample(qrels, QUERIES, { n: 1000, seed: 3 }).pairs).toHaveLength(112);
  });

  it('CSV round-trips commas, quotes, newlines; parses CRLF and a BOM', () => {
    const rows = [['a', 'b,c', 'say "hi"'], ['line\nbreak', '', 'x']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(parseCsv('\uFEFFh1,h2\r\n1,2\n3,"4"')).toEqual([['h1', 'h2'], ['1', '2'], ['3', '4']]);
    expect(() => parseCsv('a,"b')).toThrow(/inside a quoted field/);
  });

  it('exports a blind sheet and imports Jacob\'s grades with agreement per source', () => {
    const s = calibrationSample(qrels, QUERIES, { n: 9, seed: 3 });
    const modules = new Map(s.pairs.map((p) => [p.code, mod(p.code)]));
    const csv = calibrationCsv(s.pairs, QUERIES, modules);
    const [header, ...rows] = parseCsv(csv);
    expect(header).toContain('your_grade');
    expect(rows).toHaveLength(9);
    expect(csv).not.toMatch(/agreed|slot|rationale/);
    // Jacob agrees with A everywhere; leaves one row blank.
    const gi = header.indexOf('your_grade'), qi = header.indexOf('query_id'), ci = header.indexOf('code');
    rows.forEach((r, i) => { r[gi] = i === 0 ? '' : String(qrels.queries[r[qi]].judgments[r[ci]].grade); });
    const { graded, blank } = readCalibration(toCsv([header, ...rows]));
    expect(blank).toBe(1);
    expect(graded).toHaveLength(8);
    const h = humanAgreement(graded, qrels, agreementBlock);
    expect(/** @type {any} */ (h.bySource.A).raw).toBe(1);
    expect(/** @type {any} */ (h.bySource.final).raw).toBe(1);
    expect(/** @type {any} */ (h.bySource.A).n).toBe(8);
    rows[1][gi] = '3';
    expect(() => readCalibration(toCsv([header, ...rows]))).toThrow(/row 3: your_grade must be 0, 1 or 2/);
  });

  it('gradeBy reads a slot, the final grade, and 0 for rule pairs', () => {
    const j = qrels.queries['q-01'].judgments.CS101;
    expect(gradeBy(j, 'A')).toBe(1);
    expect(gradeBy(j, 'B')).toBe(2);
    expect(gradeBy(j, 'final')).toBe(1);
    expect(gradeBy(qrels.queries['q-01'].judgments.RULE1, 'A')).toBe(0);
    expect(gradeBy(2, 'A')).toBeNull();
  });

  it('Δ nDCG@10 under each source, and on a human subset', () => {
    const q = QUERIES.slice(0, 2);
    const run = (/** @type {Record<string, string[]>} */ r) => /** @type {any} */ ({ variant: 'x', results: Object.fromEntries(Object.entries(r).map(([k, codes]) => [k, { status: 200, codes }])), docs: {} });
    const base = run({ 'q-01': ['CS100', 'CS101'], 'q-02': ['CS200'] });
    const cand = run({ 'q-01': ['CS101', 'CS100'], 'q-02': ['CS201'] });
    // Under A: q-01 grades CS100 0, CS101 1 -> cand puts the 1 first: Δ > 0.
    const underA = ndcgDelta(base, cand, q, qrelsUnder(qrels, 'A'));
    expect(underA.delta).toBeGreaterThan(0);
    // A human who thinks CS100 is the 2 and CS101 a 0 reverses the sign on the subset.
    const subset = new Map([[pairKey('q-01', 'CS100'), 2], [pairKey('q-01', 'CS101'), 0]]);
    const human = ndcgDelta(base, cand, q, qrelsUnder(qrels, 'human', subset));
    expect(human.n).toBe(1);
    expect(human.delta).toBeLessThan(0);
    // The subset under A keeps only those pairs.
    expect(Object.keys(qrelsUnder(qrels, 'A', subset).queries['q-01'].judgments)).toEqual(['CS100', 'CS101']);
    // scoreRun accepts every re-graded qrels.
    expect(() => scoreRun(base, q, qrelsUnder(qrels, 'B'))).not.toThrow();
  });
});

describe('single-judge rounds', () => {
  const single = (/** @type {Partial<import('../../eval/lib/judging.mjs').RoundOptions>} */ over = {}) => makeRound({ judges: { A: 'judge-a' }, ...over });

  it('prepare with one judge: only A batches, items and grades; same A items as a two-judge round', () => {
    const round = single();
    expect(round.judges).toEqual({ A: 'judge-a' });
    expect(Object.keys(round.batches)).toEqual(['A']);
    expect(Object.keys(round.grades)).toEqual(['A']);
    expect(Object.values(round.items).every((i) => i.slot === 'A')).toBe(true);
    expect(judgeSlots(round)).toEqual(['A']);
    expect(isSingleJudge(round)).toBe(true);
    const pair = makeRound();
    expect(judgeSlots(pair)).toEqual(['A', 'B']);
    expect(isSingleJudge(pair)).toBe(false);
    expect(round.batches.A).toEqual(pair.batches.A);
    expect(Object.fromEntries(Object.entries(pair.items).filter(([, i]) => i.slot === 'A'))).toEqual(round.items);
    const packet = renderJudgePacket(round, 'A', 'b01', { judging: JUDGING, queries: QUERIES, outDir: '/tmp/vnm-out' });
    expect(packet).toContain('# Relevance judging packet r1-A-b01');
  });

  it('planted repeats and the drift sample go to A', () => {
    const round = single({ drift: [{ queryId: 'q-03', code: 'OLD1', grade: 2, candidate: mod('OLD1') }] });
    const items = Object.values(round.items);
    expect(items.filter((i) => i.kind === 'repeat').length).toBeGreaterThan(0);
    expect(items.filter((i) => i.kind === 'drift').map((i) => `${i.slot}:${i.code}`)).toEqual(['A:OLD1']);
  });

  it('refuses a round without judge A, and reserved ids', () => {
    expect(() => makeRound({ judges: /** @type {any} */ ({ B: 'judge-b' }) })).toThrow(/judge A/);
    expect(() => single({ judges: { A: 'adjudicator' } })).toThrow(/reserved/);
  });

  it('final = rule, else A (source "judged"); throws with counts while an A pair is ungraded', () => {
    const round = single();
    expect(() => finalJudgments(round)).toThrow(/^not every pair has a final grade: 112 without judge A's grade$/);
    gradeAll(round, 'A', (_q, c) => (c.endsWith('0') ? 2 : 1));
    const f = finalJudgments(round);
    expect(f.size).toBe(14 * 8 + 2);
    expect(f.get(pairKey('q-01', 'RUL9901'))).toMatchObject({ grade: 0, source: 'rule' });
    expect(f.get(pairKey('q-02', 'CS200'))).toEqual({ grade: 2, source: 'judged', judges: { 'judge-a': { slot: 'A', grade: 2, rationale: 'r CS200' } } });
    // An ungraded planted repeat does not block; an ungraded new item does.
    const rep = Object.entries(round.items).find(([, i]) => i.kind === 'repeat');
    delete round.grades.A[/** @type {any} */ (rep)[0]];
    expect(() => finalJudgments(round)).not.toThrow();
    const fresh = Object.entries(round.items).find(([, i]) => i.kind === 'new');
    delete round.grades.A[/** @type {any} */ (fresh)[0]];
    expect(() => finalJudgments(round)).toThrow(/: 1 without judge A's grade$/);
  });

  it('adjudication refuses a single-judge round', () => {
    const round = single();
    gradeAll(round, 'A', () => 1);
    expect(() => buildAdjudication(round, { adjudicator: 'adj' })).toThrow(/single-judge/);
    expect(agreementUnits(round)).toEqual([]);
  });

  it('merge records single-judge mode and writes qrels the scorer accepts', () => {
    const round = single();
    gradeAll(round, 'A', (_q, c) => (c.endsWith('0') ? 2 : 0));
    const q = mergeQrels(round, { createdAt: 'now' });
    expect(q.judging).toEqual([{ round: 'r1', mode: 'single', judges: { A: 'judge-a' }, adjudicator: null, pairs: 114, pool: 'pool-sha', createdAt: 'now' }]);
    expect(q.queries['q-02'].judgments.CS200).toMatchObject({ grade: 2, source: 'judged', round: 'r1' });
    expect(qrelsFor(q, 'q-02', 1).grades.get('CS201')).toBe(0);
    expect(isRuleJudgment(q.queries['q-02'].judgments.CS200)).toBe(false);
    expect(isRuleJudgment(q.queries['q-01'].judgments.RUL9901)).toBe(true);
    // Rule pairs stay out of the drift sample; judged pairs are in it.
    expect(sampleDrift(q, { seed: 1, rate: 1 })).toHaveLength(14 * 8);
  });
});

describe('dropJudge', () => {
  /** @returns {import('../../eval/lib/judging.mjs').Round} */
  const graded = () => {
    const round = makeRound();
    gradeAll(round, 'A', (_q, c) => (c.endsWith('0') ? 2 : 1));
    return round;
  };

  it('turns a two-judge round into a single-judge round, keeping A untouched', () => {
    const round = graded();
    const before = JSON.parse(JSON.stringify(round));
    const aItems = Object.fromEntries(Object.entries(before.items).filter(([, i]) => /** @type {any} */ (i).slot === 'A'));
    dropJudge(round, { slot: 'B', reason: 'owner decision: one judge', at: '2026-11-04T01:00:00Z' });
    expect(round.judges).toEqual({ A: 'judge-a' });
    expect(round.batches).toEqual({ A: before.batches.A });
    expect(round.grades).toEqual({ A: before.grades.A });
    expect(round.items).toEqual(aItems);
    expect(round.dropped).toEqual([{ slot: 'B', judge: 'judge-b', reason: 'owner decision: one judge', at: '2026-11-04T01:00:00Z' }]);
    expect(isSingleJudge(round)).toBe(true);
    // A's collected outputs still validate against the same item ids.
    const answer = (/** @type {string[]} */ ids) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { grade: 1, rationale: 'ok' }])));
    const r = collectOutputs(round.batches.A, round.grades.A, (b, s) => answer(/** @type {any} */ (round.batches.A.find((x) => x.id === b)).sections.find((/** @type {any} */ x) => x.id === s).items), 'A');
    expect(r.problems).toEqual([]);
    expect(finalJudgments(round).get(pairKey('q-02', 'CS200'))).toMatchObject({ source: 'judged' });
    const q = mergeQrels(round, { createdAt: 'now' });
    expect(q.judging[0]).toEqual({
      round: 'r1', mode: 'single', judges: { A: 'judge-a' }, adjudicator: null,
      dropped: [{ slot: 'B', judge: 'judge-b', reason: 'owner decision: one judge', at: '2026-11-04T01:00:00Z' }],
      pairs: 114, pool: 'pool-sha', createdAt: 'now',
    });
  });

  it('refuses an unknown slot, slot A, a slot with no judge, and an empty reason', () => {
    expect(() => dropJudge(graded(), { slot: 'C', reason: 'x' })).toThrow(/unknown judge slot/);
    expect(() => dropJudge(graded(), { slot: 'A', reason: 'x' })).toThrow(/cannot drop judge A/);
    const round = graded();
    dropJudge(round, { slot: 'B', reason: 'x' });
    expect(() => dropJudge(round, { slot: 'B', reason: 'x' })).toThrow(/no judge in slot B/);
    expect(() => dropJudge(graded(), { slot: 'B', reason: '  ' })).toThrow(/reason/);
  });

  it('refuses once adjudication has started, and when B has grades unless forced', () => {
    const adj = graded();
    gradeAll(adj, 'B', () => 1);
    adj.adjudication = buildAdjudication(adj, { adjudicator: 'adj' });
    expect(() => dropJudge(adj, { slot: 'B', reason: 'x', force: true })).toThrow(/adjudication/);
    const round = graded();
    const first = Object.entries(round.items).find(([, i]) => i.slot === 'B');
    round.grades.B[/** @type {any} */ (first)[0]] = { grade: 1, rationale: 'b' };
    expect(() => dropJudge(round, { slot: 'B', reason: 'x' })).toThrow(/judge B has 1 collected grade/);
    dropJudge(round, { slot: 'B', reason: 'x', force: true });
    expect(round.grades).toEqual({ A: expect.any(Object) });
  });
});

describe('calibration on single-judge qrels', () => {
  const round = makeRound({ judges: { A: 'judge-a' } });
  gradeAll(round, 'A', (_q, c) => (c.endsWith('0') ? 2 : c.endsWith('1') ? 1 : 0));
  const qrels = mergeQrels(round, { createdAt: 'now' });

  it('reports human vs A and final, and no B', () => {
    expect(qrelsSlots(qrels)).toEqual(['A']);
    const graded = [{ queryId: 'q-02', code: 'CS200', grade: 2 }, { queryId: 'q-02', code: 'CS201', grade: 0 }, { queryId: 'q-02', code: 'CS202', grade: 0 }];
    const h = humanAgreement(graded, qrels, agreementBlock);
    expect(Object.keys(h.bySource)).toEqual(['A', 'final']);
    expect(/** @type {any} */ (h.bySource.A).n).toBe(3);
    expect(gradeBy(qrels.queries['q-02'].judgments.CS201, 'A')).toBe(1);
    expect(gradeBy(qrels.queries['q-02'].judgments.CS201, 'B')).toBeNull();
    expect(gradeBy(qrels.queries['q-01'].judgments.RUL9901, 'A')).toBe(0);
  });

  it('refuses to re-grade the qrels under a judge they have no grades from', () => {
    expect(() => qrelsUnder(qrels, 'B')).toThrow(/no grades from judge B/);
    expect(Object.keys(qrelsUnder(qrels, 'A').queries['q-02'].judgments)).toHaveLength(8);
  });

  it('leaves out of a judge column the pairs that judge did not grade (mixed qrels), keeping rule pairs', () => {
    /** @type {any} */
    const mixed = JSON.parse(JSON.stringify(qrels));
    mixed.queries['q-02'].judgments.CS200.judges['judge-b'] = { slot: 'B', grade: 0, rationale: 'x' };
    expect(qrelsSlots(mixed)).toEqual(['A', 'B']);
    const underB = qrelsUnder(mixed, 'B');
    expect(underB.queries['q-02'].judgments).toEqual({ CS200: 0 });
    expect(underB.queries['q-01'].judgments.RUL9901).toBe(0);
    expect(Object.keys(qrelsUnder(mixed, 'A').queries['q-02'].judgments)).toHaveLength(8);
  });
});

describe('graderLabels', () => {
  it('names the final grade by what the qrels record', () => {
    expect(graderLabels(['A', 'B'])).toEqual({ note: '', final: 'final (adjudicated)' });
    expect(graderLabels(['A'])).toEqual({ note: '; single-judge qrels (judge A only)', final: 'final (rule, else A)' });
    expect(graderLabels([])).toEqual({ note: '; the qrels record no judge grades', final: 'final' });
    expect(graderLabels(['A', 'B'], true)).toEqual({ note: '; mixes single- and two-judge rounds', final: 'final (adjudicated, or rule, else A)' });
  });
});
