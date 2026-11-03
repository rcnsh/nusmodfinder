// @ts-check
// B1: the semester filter is applied in JS after the FTS query has already
// been cut to `LIMIT depth * 4` (src/lexical.js runFts), so keyword matches that
// rank below that cut-off are silently dropped from a sem-filtered search.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { callJson, seed } from '../helpers.js';
import { codes, syntheticModule } from './support.js';

// 20 strong "management" matches offered only in semester 1, and 3 weak
// matches (the word once, in the description) offered only in special term 1.
const decoys = Array.from({ length: 20 }, (_, i) => syntheticModule({
  code: `MGT${1000 + i}`, title: 'Management Management Management', semesters: [1],
}));
const targets = Array.from({ length: 3 }, (_, i) => syntheticModule({
  code: `ST${3100 + i}`, title: `Special Term Seminar ${i}`,
  description: 'A seminar that touches on management once.', semesters: [3],
}));

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed({ modules: [...decoys, ...targets] });
});

describe('B1', () => {
  it('[B1 known-bug] lexical sem=3 returns 0 results although 3 sem-3 modules match "management"', async () => {
    // topK=1 -> depth 3 -> FTS LIMIT 12: all 12 rows are semester-1 decoys,
    // the JS semester filter then removes every one of them.
    const { status, body } = await callJson('/search?q=management&sem=3&mode=lexical&topK=1', { fakes });
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.retrieval.lexical).toBe(0);

    const { results } = await env.DB.prepare(
      `SELECT m.code FROM modules_fts JOIN modules m ON m.code = modules_fts.code
        WHERE modules_fts MATCH '"management"' AND m.semesters LIKE '%3%'`).all();
    expect(codes(/** @type {{ code: string }[]} */ (results)).sort()).toEqual(targets.map((t) => t.code));
  });

  it('[B1 known-bug] hybrid sem=3 finds the targets only through the vector half', async () => {
    // Vectorize applies sem3 as a metadata filter before ranking, so the
    // vector half sees all three targets while the lexical half sees none.
    const { body } = await callJson('/search?q=management&sem=3&topK=1', { fakes });
    expect(body.retrieval.lexical).toBe(0);
    expect(body.retrieval.vector).toBe(3);
    expect(targets.map((t) => t.code)).toContain(body.results[0].code);
  });
});
