// @ts-check
// Semester filtering and corpus facts over the full pinned corpus: the same 6,771 modules production
// serves, loaded through /admin/ingest into local D1 and the fake index.
// Skipped without .data/; required (FULL_CORPUS=1) in the full-corpus CI job.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { callJson, seed } from '../helpers.js';

const corpus = inject('corpus');

describe.skipIf(!corpus)('search over the full pinned corpus', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  /** @type {import('../fakes.js').Fakes} */
  let fakes;
  beforeAll(async () => {
    fakes = await seed({ modules: c.modules });
  }, 120_000);

  // The semester filter runs before the depth cut, so all 31 come back,
  // including BMA5134, BMC5415, BME5042, BME5046, TCX2003 and TCX2005.
  it('lexical management&sem=3&topK=50 returns all 31 sem-3 keyword matches, in rank order', async () => {
    const { body } = await callJson('/search?q=management&sem=3&mode=lexical&topK=50', { fakes });
    const got = body.results.map((/** @type {{ code: string }} */ r) => r.code);

    const all = await env.DB.prepare(
      `SELECT m.code, m.semesters FROM modules_fts JOIN modules m ON m.rowid = modules_fts.rowid
        WHERE modules_fts MATCH '"management"' ORDER BY rank, m.rowid`).all();
    const sem3 = all.results.filter((r) => JSON.parse(String(r.semesters)).includes(3)).map((r) => r.code);
    expect(sem3).toHaveLength(31);
    expect(all.results.length).toBeGreaterThan(200);
    expect(got).toEqual(sem3);
    expect(got).toEqual(expect.arrayContaining(['BMA5134', 'BMC5415', 'BME5042', 'BME5046', 'TCX2003', 'TCX2005']));
  });

  it('46% of offered modules are level 5 or above', () => {
    const grad = c.modules.filter((m) => (m.level ?? 0) >= 5).length;
    expect(grad).toBe(3098);
    expect(Math.round((grad / c.modules.length) * 100)).toBe(46);
  });
});
