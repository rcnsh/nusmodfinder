// @ts-check
// B2, Worker side: /admin/hashes exposes only the embedded-text hash, which is
// all scripts/ingest.mjs compares, nothing deletes modules that disappear
// upstream, and /search never looks at acad_year. The hash rule itself
// (lib.mjs) is characterised in ingest.node.test.js.
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCall, callJson, seed } from '../helpers.js';
import { codes, syntheticModule } from './support.js';

const original = syntheticModule({
  code: 'XX2001', title: 'Quokka Ecology', semesters: [1], credits: 4, ng: false, ngSemesters: [],
  prerequisite: 'None', workload: '[2,1,0,3,4]',
});
// Upstream changed everything except the embedded text, so textHash is equal.
const changed = {
  ...original, semesters: [2], credits: 2, ng: true, ngSemesters: [2],
  prerequisite: 'XX1001', workload: '[3,0,0,3,4]',
};
const dropped = syntheticModule({ code: 'XX2002', title: 'Wombat Burrowing' });
const oldYear = syntheticModule({ code: 'XX2003', title: 'Zymurgy Practicum', acadYear: '2019-2020' });

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed({ modules: [original, dropped, oldYear] });
});

/** scripts/ingest.mjs line 61, verbatim apart from `force` being false. */
const ingestTodo = (/** @type {NormalisedModule[]} */ modules, /** @type {Record<string, string>} */ existing) =>
  modules.filter((m) => existing[m.code] !== m.textHash);

describe('B2', () => {
  it('[B2 known-bug] a module whose semesters, NG flags, credits, prereqs and workload changed is skipped by ingest', async () => {
    const existing = /** @type {Record<string, string>} */ (await (await adminCall('/admin/hashes', fakes)).json());
    expect(existing).toEqual({ XX2001: original.textHash, XX2002: dropped.textHash, XX2003: oldYear.textHash });
    expect(ingestTodo([changed], existing)).toEqual([]);

    // So D1 keeps serving the stale row.
    const { body } = await callJson('/module/XX2001');
    expect(body).toMatchObject({ semesters: [1], credits: 4, ng: false, ng_semesters: [], prerequisite: 'None' });
  });

  it('[B2 known-bug] re-ingesting a corpus without a module leaves that module in D1 and Vectorize', async () => {
    const res = await adminCall('/admin/ingest', fakes, { modules: [original, oldYear] });
    expect(res.status).toBe(200);
    const hashes = /** @type {Record<string, string>} */ (await (await adminCall('/admin/hashes', fakes)).json());
    expect(Object.keys(hashes)).toContain('XX2002');
    expect(fakes.vectorize.vectors.has('XX2002')).toBe(true);
    expect(fakes.vectorize.calls.filter((c) => c.method === 'deleteByIds')).toEqual([]);
    // And there is no route that could delete it.
    for (const path of ['/admin/delete', '/admin/prune']) {
      expect((await adminCall(path, fakes, { codes: ['XX2002'] })).status).toBe(404);
    }
  });

  it('[B2 known-bug] /search returns a module from another acad year', async () => {
    const { body } = await callJson('/search?q=zymurgy&mode=lexical', { fakes });
    expect(codes(body.results)).toEqual(['XX2003']);
    const { body: row } = await callJson('/module/XX2003');
    expect(row.acad_year).toBe('2019-2020');
  });
});
