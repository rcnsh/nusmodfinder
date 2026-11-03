// @ts-check
// B1: the semester filter used to be applied in JS after the FTS query had
// already been cut to `LIMIT depth * 4`, so keyword matches ranked below that
// cut-off were silently dropped from a sem-filtered search. Since 0006 the
// filters run in SQL on generated columns (src/lexical.js runFts).
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
  // Was `[B1 known-bug] lexical sem=3 returns 0 results although 3 sem-3 modules match "management"`.
  it('[B1 fixed] lexical sem=3 returns the sem-3 "management" matches however many sem-1 matches outrank them', async () => {
    // topK=1 -> depth 3. The 20 sem-1 decoys outrank every target; the old
    // FTS LIMIT 12 + JS filter returned nothing.
    const { status, body } = await callJson('/search?q=management&sem=3&mode=lexical&topK=1', { fakes });
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.retrieval.lexical).toBe(3);

    const { results } = await env.DB.prepare(
      `SELECT m.code FROM modules_fts JOIN modules m ON m.rowid = modules_fts.rowid
        WHERE modules_fts MATCH '"management"' AND m.semesters LIKE '%3%' ORDER BY rank, m.rowid`).all();
    const expected = codes(/** @type {{ code: string }[]} */ (results));
    expect([...expected].sort()).toEqual(targets.map((t) => t.code));
    expect(body.results[0].code).toBe(expected[0]);

    const all = await callJson('/search?q=management&sem=3&mode=lexical&topK=10', { fakes });
    expect(codes(all.body.results)).toEqual(expected);
  });

  // Was `[B1 known-bug] hybrid sem=3 finds the targets only through the vector half`.
  it('[B1 fixed] hybrid sem=3 finds the targets through both halves', async () => {
    const { body } = await callJson('/search?q=management&sem=3&topK=1', { fakes });
    expect(body.retrieval.lexical).toBe(3);
    expect(body.retrieval.vector).toBe(3);
    expect(targets.map((t) => t.code)).toContain(body.results[0].code);
  });
});
