// @ts-check
// B2, Worker side: scripts/ingest-core.mjs runIngest driven straight into the
// real Worker (local D1 + fake Vectorize), so these tests exercise the same
// skip rules, deletes and routes `npm run ingest` uses. The hash rules and the
// download cache are covered in ingest.node.test.js; budget, guards and the
// mutation wait in test/ingest.test.js.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runIngest } from '../../scripts/ingest-core.mjs';
import { ftsHash, rowHash } from '../../src/rowhash.js';
import { adminCall, callJson, fixture, seed } from '../helpers.js';
import { adminApi } from '../ingest-support.js';
import { codes, syntheticModule } from './support.js';

const original = syntheticModule({
  code: 'XX2001', title: 'Quokka Ecology', semesters: [1], credits: 4, ng: false, ngSemesters: [],
  prerequisite: 'None', workload: '[2,1,0,3,4]',
});
// Upstream changed everything except the embedded text, so textHash is equal.
const changed = {
  ...original, semesters: [2], credits: 2, ng: true, ngSemesters: [2],
  prerequisite: 'XX1001', preclusion: 'XX2901', workload: '[3,0,0,3,4]',
};
const dropped = syntheticModule({ code: 'XX2002', title: 'Wombat Burrowing' });
const oldYear = syntheticModule({ code: 'XX2003', title: 'Zymurgy Practicum', acadYear: '2019-2020' });
const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeEach(async () => {
  // The fixture keeps the corpus large enough that dropping two modules stays
  // inside the 95% mass-delete guard, as in a real run.
  fakes = await seed({ modules: [...fixture.modules, original, dropped, oldYear] });
});

/** @param {NormalisedModule[]} modules */
const ingest = (modules) => runIngest({ modules, facetsBody, api: adminApi(() => fakes), sleep: async () => {} });

describe('B2', () => {
  it('[B2 fixed] /admin/hashes returns text_hash, row_hash and the FTS-column hash for every module', async () => {
    const res = await callJson('/admin/hashes', {
      fakes, env: { INGEST_SECRET: 'test-ingest-secret' }, init: { headers: { authorization: 'Bearer test-ingest-secret' } },
    });
    expect(res.body.schema).toMatchObject({ ok: true, version: 6 });
    expect(res.body.modules.XX2001).toEqual({ textHash: original.textHash, rowHash: await rowHash(original), ftsHash: await ftsHash(original) });
    expect(Object.keys(res.body.modules)).toHaveLength(fixture.modules.length + 3);
  });

  it('[B2 fixed] a field-only change (semesters, NG flags, credits, prereqs, workload) lands in D1 and the Vectorize metadata, without re-embedding', async () => {
    const before = /** @type {number[]} */ (fakes.vectorize.vectors.get('XX2001')?.values);
    const result = await ingest([...fixture.modules, changed]);
    expect(result).toMatchObject({ status: 'done', plan: { embed: 0, rowOnly: 1, unchanged: fixture.modules.length, deletes: 2 } });

    const { body } = await callJson('/module/XX2001');
    expect(body).toMatchObject({
      semesters: [2], credits: 2, ng: true, ng_semesters: [2], prerequisite: 'XX1001', preclusion: 'XX2901', workload: [3, 0, 0, 3, 4],
    });
    // The vector keeps its values (re-upserted from getByIds) under new metadata.
    const v = fakes.vectorize.vectors.get('XX2001');
    expect(v?.metadata).toMatchObject({ sem1: false, sem2: true, credits: 2, ng: true });
    expect(v?.values).toEqual(before);
    expect(fakes.ai.calls).toEqual([]);
    // /search filters see it too.
    expect(codes((await callJson('/search?q=quokka&mode=lexical&sem=2', { fakes })).body.results)).toEqual(['XX2001']);
    expect((await callJson('/search?q=quokka&mode=lexical&sem=1', { fakes })).body.results).toEqual([]);

    // A rerun sends nothing: every row hash now matches.
    const again = await ingest([...fixture.modules, changed]);
    expect(again.plan).toMatchObject({ embed: 0, rowOnly: 0, deletes: 0 });
    expect(again.upserted).toBe(0);
  });

  it('[B2 fixed] a module dropped from the corpus is deleted from Vectorize, then D1', async () => {
    const result = await ingest([...fixture.modules, original]);
    expect(result).toMatchObject({ status: 'done', deleted: 2 });
    const del = fakes.vectorize.calls.filter((c) => c.method === 'deleteByIds');
    expect(del.map((c) => c.args[0])).toEqual([['XX2002', 'XX2003']]);
    expect(fakes.vectorize.vectors.has('XX2002')).toBe(false);
    expect((await callJson('/module/XX2002')).status).toBe(404);
    // Deletes ran after every upsert: the deleteByIds call is the last mutation.
    const mutating = fakes.vectorize.calls.filter((c) => c.method === 'upsert' || c.method === 'deleteByIds');
    expect(mutating.at(-1)?.method).toBe('deleteByIds');
    // And a delete route exists only behind the secret.
    expect((await callJson('/admin/delete', { init: { method: 'POST', body: '{"codes":["XX2001"]}' } })).status).toBe(404);
  });

  it('[B2 fixed] acad_year: rows are keyed by code, so a run leaves only the current year (stale rows deleted or rewritten)', async () => {
    // Before: a 2019-2020 row is served.
    expect(codes((await callJson('/search?q=zymurgy&mode=lexical', { fakes })).body.results)).toEqual(['XX2003']);
    // Next year's corpus no longer has XX2003 and still has XX2001.
    const year = fixture.source.acadYear;
    const result = await ingest([...fixture.modules, original]);
    expect(result.status).toBe('done');
    expect((await callJson('/search?q=zymurgy&mode=lexical', { fakes })).body.results).toEqual([]);
    const { results } = await env.DB.prepare('SELECT DISTINCT acad_year FROM modules').all();
    expect(results).toEqual([{ acad_year: year }]);

    // A code offered in both years is one row: the acad year is in row_hash,
    // so the old-year row is rewritten in place.
    await adminCall('/admin/ingest', fakes, { modules: [{ ...original, acadYear: '2019-2020' }] });
    await ingest([...fixture.modules, original]);
    expect((await callJson('/module/XX2001')).body.acad_year).toBe(year);
  });
});
