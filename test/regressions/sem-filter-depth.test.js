// @ts-check
// The semester filter runs in SQL on generated columns (migrations/0006,
// src/lexical.js runFts), before the FTS query's `LIMIT depth * 4` cut-off, so
// a sem-filtered search keeps keyword matches that rank below that cut-off.
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

describe('semester filter depth', () => {
  it('lexical sem=3 returns the sem-3 "management" matches however many sem-1 matches outrank them', async () => {
    // topK=1 -> depth 3. The 20 sem-1 decoys outrank every target, so a JS
    // filter after FTS LIMIT 12 would return nothing.
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

  it('hybrid sem=3 finds the targets through both halves', async () => {
    // Uncollapsed: the group collapse's hybrid lists are 50 deep at any topK (src/search.js depth).
    const { body } = await callJson('/search?q=management&sem=3&topK=1', { fakes, env: { COLLAPSE_GROUPS: 'off' } });
    expect(body.retrieval.lexical).toBe(3);
    expect(body.retrieval.vector).toBe(3);
    expect(targets.map((t) => t.code)).toContain(body.results[0].code);
  });
});
