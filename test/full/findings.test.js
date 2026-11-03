// @ts-check
// B1 and S6 over the full pinned corpus: the same 6,771 modules production
// serves, loaded through /admin/ingest into local D1 and the fake index.
// Skipped without .data/; required (FULL_CORPUS=1) in the full-corpus CI job.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { callJson, seed } from '../helpers.js';

const corpus = inject('corpus');

describe.skipIf(!corpus)('findings over the full pinned corpus', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  /** @type {import('../fakes.js').Fakes} */
  let fakes;
  beforeAll(async () => {
    fakes = await seed({ modules: c.modules });
  }, 120_000);

  it('[B1 known-bug] lexical management&sem=3&topK=50 returns 6 of the 31 sem-3 keyword matches (as live)', async () => {
    const { body } = await callJson('/search?q=management&sem=3&mode=lexical&topK=50', { fakes });
    // docs/evidence/phase0/raw/B1_sem3.body: the live Worker returned the same 6.
    expect(body.results.map((/** @type {{ code: string }} */ r) => r.code).sort())
      .toEqual(['BMA5134', 'BMC5415', 'BME5042', 'BME5046', 'TCX2003', 'TCX2005']);

    const all = await env.DB.prepare(
      `SELECT m.semesters FROM modules_fts JOIN modules m ON m.code = modules_fts.code
        WHERE modules_fts MATCH '"management"'`).all();
    const sem3 = all.results.filter((r) => JSON.parse(String(r.semesters)).includes(3));
    expect(sem3).toHaveLength(31);
    // FTS LIMIT is depth * 4 = 200 of the matches; only 6 of those are sem 3.
    expect(all.results.length).toBeGreaterThan(200);
  });

  it('[S6 evidence] 46% of offered modules are level 5 or above', () => {
    const grad = c.modules.filter((m) => (m.level ?? 0) >= 5).length;
    expect(grad).toBe(3098);
    expect(Math.round((grad / c.modules.length) * 100)).toBe(46);
  });
});
