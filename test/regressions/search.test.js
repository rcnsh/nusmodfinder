// @ts-check
// Query handling and exchange-mode filtering in /search over the fixture corpus.
// Ranking quality needs the real embedding model, so the eval (eval/) measures
// it, not these tests.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { callJson, fixture, seed } from '../helpers.js';
import { codes, ftsCalls, recordingDb, shownCodes } from './support.js';

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

/** The FTS MATCH expression the Worker builds for `q`. */
async function matchExpression(/** @type {string} */ q) {
  /** @type {import('./support.js').DbCall[]} */
  const log = [];
  await callJson(`/search?q=${encodeURIComponent(q)}&mode=lexical`, { fakes, env: { DB: recordingDb(log) } });
  return ftsCalls(log)[0]?.binds[0];
}

describe('query embedding', () => {
  it('the query is embedded verbatim, with no bge query instruction prefix', async () => {
    const before = fakes.ai.calls.length;
    await callJson('/search?q=machine%20learning%20prefix', { fakes });
    const [model, input] = /** @type {[string, { text: string[] }]} */ (fakes.ai.calls[before].args);
    expect(model).toBe('@cf/baai/bge-small-en-v1.5');
    expect(input).toEqual({ text: ['machine learning prefix'] });
  });
});

describe('partial codes and keywords', () => {
  // `code` stays UNINDEXED (see migrations/0006); the partial-code route covers prefix queries.
  it.each(['CS32', 'GEA'])('"%s" routes to the modules with that prefix, though the code column stays UNINDEXED', async (q) => {
    const { body } = await callJson(`/search?q=${q}&mode=lexical&topK=50`, { fakes });
    const members = fixture.modules.map((m) => m.code).filter((c) => c >= (/\d$/.test(q) ? q : `${q}0`) && c < `${q}:`).sort();
    expect(members.length).toBeGreaterThan(0);
    expect(body.interpreted.prefix).toBe(q);
    // One result per duplicate group; the other members ride along as its variants.
    expect(shownCodes(body.results).sort()).toEqual(members);
  });

  it('"modules", "intro", "teach" and "something" are not stopwords', async () => {
    // The typo step writes a df-0 token as a prefix term (`"modules"*` in the fixture); the stopword list is unchanged.
    expect(String(await matchExpression('intro to modules that teach something')).replace(/\*/g, '')).toBe(
      '"intro" OR "modules" OR "that" OR "teach" OR "something"');
  });

  it.each([
    ['machne', '"machine" OR "machne"*'],
    ['progr', '"progr"*'],
  ])('"%s" gets lexical hits, as a correction or a prefix term', async (q, expr) => {
    expect(await matchExpression(q)).toBe(expr);
    const { body } = await callJson(`/search?q=${q}&mode=lexical`, { fakes });
    expect(body.retrieval.lexical).toBeGreaterThan(0);
  });
});

describe('codes', () => {
  it('"cs 1010s" is joined into the code CS1010S and pinned at rank 1', async () => {
    for (const mode of ['hybrid', 'lexical']) {
      const { body } = await callJson(`/search?q=cs%201010s&mode=${mode}`, { fakes });
      expect(body.interpreted.pin, mode).toEqual(['CS1010S']);
      expect(body.results[0], mode).toMatchObject({ code: 'CS1010S', score: 1 });
    }
  });

  it('the partial code "CS101" routes to its members, and only them', async () => {
    const { body } = await callJson('/search?q=CS101&mode=lexical', { fakes });
    const members = fixture.modules.map((m) => m.code).filter((c) => c.startsWith('CS101')).sort();
    expect(members.length).toBeGreaterThan(1);
    expect(body.interpreted.prefix).toBe('CS101');
    expect(shownCodes(body.results).sort()).toEqual(members);
  });
});

describe('constraints', () => {
  it('the schema has exam, S/U, grading-basis, workload-hours and prerequisite columns', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('modules') ORDER BY cid").all();
    expect(results.map((r) => r.name)).toEqual([
      'code', 'title', 'description', 'credits', 'department', 'faculty', 'level', 'semesters', 'workload',
      // row_hash: 0006. The generated sem/ng_sem/exam_sem columns
      // are hidden from table_info.
      'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters', 'row_hash',
      // 0007.
      'exam_semesters', 'su', 'grading_basis', 'workload_hours', 'prereq_none', 'prereq_cohort_only',
      // ng_allow, ng_rules: 0009.
      'ng_allow', 'ng_rules',
      // exam_dates: 0010.
      'exam_dates',
    ]);
  });

  it('/search filters on no exam, S/U, workload and prerequisite params', async () => {
    const plain = await callJson('/search?q=introduction&mode=lexical&topK=50', { fakes });
    const filtered = await callJson('/search?q=introduction&mode=lexical&topK=50&exam=0&su=1&hoursBelow=10&prereq=none', { fakes });
    expect(filtered.body.filters).toEqual({ exam: 0, su: 1, hoursBelow: 10, prereq: 'none' });
    expect(filtered.body.count).toBeLessThan(plain.body.count);
  });
});

describe('no-signal queries and duplicates', () => {
  it('gibberish answers count 0 with noMatch no-signal', async () => {
    const { body } = await callJson('/search?q=xqzvbnm%20flurble', { fakes });
    expect(body.retrieval.lexical).toBe(0);
    expect(body).toMatchObject({ count: 0, results: [], noMatch: { reason: 'no-signal' } });
  });

  it('near-duplicate variants (TR3202*) collapse to one result, the others listed as its variants', async () => {
    const { body } = await callJson('/search?q=start-up%20internship&mode=lexical&topK=10', { fakes });
    const tr = body.results.filter((/** @type {any} */ r) => r.code.startsWith('TR3202'));
    expect(tr).toHaveLength(1);
    expect(tr[0].variants.every((/** @type {any} */ v) => v.code.startsWith('TR3202'))).toBe(true);
    expect(tr[0].variants.length).toBeGreaterThanOrEqual(3);
  });
});

describe('exchange mode by semester', () => {
  // CS3244 and CG3201 are on the NG list for Sem 2 only (NUSMods offers them in both).
  it('ng=1&sem=1 shows only modules open to exchange students in Sem 1 (D1 path)', async () => {
    const sem1 = await callJson('/search?q=machine%20learning&ng=1&sem=1&study=ug3&mode=lexical', { fakes });
    expect(sem1.body.results.length).toBeGreaterThan(0);
    expect(sem1.body.results.filter((/** @type {any} */ r) => !r.ngSemesters.includes(1))).toEqual([]);
    expect(codes(sem1.body.results)).not.toContain('CS3244');
    const sem2 = await callJson('/search?q=machine%20learning&ng=1&sem=2&study=ug3&mode=lexical', { fakes });
    expect(codes(sem2.body.results)).toContain('CS3244');
  });

  it('the Vectorize standby filters on the yearly ng flag only, reads 100 deep and rechecks the semester in D1', async () => {
    const before = fakes.vectorize.calls.length;
    const { body } = await callJson('/search?q=machine%20learning%20vecfilter&ng=1&sem=1&study=ug3', { fakes, env: { DENSE_BACKEND: 'vectorize' } });
    expect(fakes.vectorize.calls[before].args[1]).toEqual({ topK: 100, filter: { ng: true } });
    expect(body.results.filter((/** @type {any} */ r) => !r.ngSemesters.includes(1))).toEqual([]);
  });

  it('the bundle\'s filter mask tests the allow-mask bit for (sem, study)', async () => {
    const { body } = await callJson('/search?q=machine%20learning&ng=1&sem=1&study=ug3&mode=vector&topK=50', { fakes });
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.filter((/** @type {any} */ r) => !r.ngSemesters.includes(1))).toEqual([]);
  });
});

describe('exchange mode by study level', () => {
  it('ng=1 shows no level-5 module to an undergraduate exchange student; LI5202 is closed to graduates too', async () => {
    for (const study of ['ug2', 'ug4']) {
      const { body } = await callJson(`/search?q=supply%20chain%20management&ng=1&study=${study}&mode=lexical`, { fakes });
      expect(body.results.filter((/** @type {any} */ r) => r.level >= 5), study).toEqual([]);
    }
    // A self-funded programme (rule A), closed to exchange graduates too.
    const grad = await callJson('/search?q=supply%20chain%20management&ng=1&study=grad&mode=lexical', { fakes });
    expect(codes(grad.body.results)).not.toContain('LI5202');
  });
});
