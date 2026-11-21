// @ts-check
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { callJson, seed } from '../helpers.js';
import { codes, syntheticModule } from './support.js';

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
    const { body } = await callJson('/search?q=management&sem=3&topK=1', { fakes, env: { COLLAPSE_GROUPS: 'off' } });
    expect(body.retrieval.lexical).toBe(3);
    expect(body.retrieval.vector).toBe(3);
    expect(targets.map((t) => t.code)).toContain(body.results[0].code);
  });
});
