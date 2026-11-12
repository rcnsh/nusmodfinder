// @ts-check
// The D1 table `catalogue_only` (migrations/0008_catalogue.sql): the codes in
// the catalogue with no offering this year, with the title and description a
// noMatch `not-offered` response names and embeds. Loaded by ingest
// (scripts/ingest-core.mjs) through GET/POST /admin/catalogue, in D1-only mode
// too: the table is D1's alone, so no route touches Workers AI or Vectorize.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runIngest } from '../scripts/ingest-core.mjs';
import { catalogueRowHash, dataVersion, rowHash } from '../src/rowhash.js';
import { adminCall, call, fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };
const MODEL = '@cf/baai/bge-small-en-v1.5';
const YEAR = fixture.modules[0].acadYear;
const sleep = async () => {};

/** @type {import('./fakes.js').Fakes} */
let fakes;
/** @param {number} n @returns {{ code: string, title: string, description: string | null }[]} */
const rows = (n) => Array.from({ length: n }, (_, i) => ({
  code: `ZZ${String(1000 + i)}`, title: `Old module ${i}`, description: i % 7 === 0 ? null : `Description of old module ${i}.`,
}));
const stored = async () => (await env.DB.prepare('SELECT code, title, description, acad_year, row_hash FROM catalogue_only ORDER BY code').all()).results;
const aiAndVectorizeCalls = () => fakes.ai.calls.length + fakes.vectorize.calls.length;

/**
 * @param {{ code: string, title: string, description: string | null }[] | undefined} catalogue
 * @param {import('../scripts/ingest-core.mjs').IngestOptions} [options]
 */
const ingest = async (catalogue, options = {}) => runIngest({
  modules: fixture.modules, catalogue, facetsBody, api: adminApi(() => fakes), sleep, now: () => 0,
  options: { embeddingModel: MODEL, ...options },
});

beforeEach(async () => {
  fakes = await seed();
});

describe('migration 0008', () => {
  it('creates catalogue_only keyed by code', async () => {
    const cols = (await env.DB.prepare("SELECT name, pk, \"notnull\" FROM pragma_table_info('catalogue_only') ORDER BY cid").all()).results;
    expect(cols).toEqual([
      { name: 'code', pk: 1, notnull: 0 },
      { name: 'title', pk: 0, notnull: 1 },
      { name: 'description', pk: 0, notnull: 0 },
      { name: 'acad_year', pk: 0, notnull: 1 },
      { name: 'row_hash', pk: 0, notnull: 1 },
    ]);
  });
});

describe('/admin/catalogue', () => {
  it('does not exist without INGEST_SECRET', async () => {
    expect((await call('/admin/catalogue', { fakes })).status).toBe(404);
    expect((await call('/admin/catalogue', { fakes, init: { method: 'POST', body: '{}' } })).status).toBe(404);
  });

  it('upserts and deletes up to 100 rows, writing the row hash it computes; GET reports the hashes', async () => {
    const batch = rows(3).map((r) => ({ ...r, acadYear: YEAR }));
    const res = await adminCall('/admin/catalogue', fakes, { upsert: batch });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 3, deleted: 0 });
    const want = await Promise.all(batch.map((r) => catalogueRowHash(r)));
    expect((await stored()).map((r) => r.row_hash)).toEqual(want);
    const hashes = await (await adminCall('/admin/catalogue', fakes, undefined)).json();
    expect(hashes.rows).toEqual(Object.fromEntries(batch.map((r, i) => [r.code, want[i]])));

    const del = await adminCall('/admin/catalogue', fakes, { delete: [batch[0].code] });
    expect(await del.json()).toMatchObject({ upserted: 0, deleted: 1 });
    expect((await stored()).map((r) => r.code)).toEqual([batch[1].code, batch[2].code]);
    expect(aiAndVectorizeCalls()).toBe(0);
  });

  it('refuses a malformed body or a batch over 100', async () => {
    expect((await adminCall('/admin/catalogue', fakes, { upsert: rows(101).map((r) => ({ ...r, acadYear: YEAR })) })).status).toBe(400);
    expect((await adminCall('/admin/catalogue', fakes, { upsert: [{ code: 'ZZ1000' }] })).status).toBe(400);
    expect((await adminCall('/admin/catalogue', fakes, {})).status).toBe(400);
  });
});

describe('ingest loads catalogue_only', () => {
  it('writes every row, then a rerun writes nothing; changed rows are rewritten and dropped codes deleted', async () => {
    const first = await ingest(rows(250));
    expect(first.status).toBe('done');
    expect(first.catalogue).toEqual({ upserted: 250, deleted: 0 });
    expect(await stored()).toHaveLength(250);
    expect((await stored())[0]).toMatchObject({ code: 'ZZ1000', title: 'Old module 0', description: null, acad_year: YEAR });

    const again = await ingest(rows(250));
    expect(again.catalogue).toEqual({ upserted: 0, deleted: 0 });

    const next = rows(240);
    next[5] = { ...next[5], title: 'Renamed' };
    const changed = await ingest(next);
    expect(changed.catalogue).toEqual({ upserted: 1, deleted: 10 });
    expect(await stored()).toHaveLength(240);
    expect((await stored())[5].title).toBe('Renamed');
  });

  it('runs in D1-only mode with no Workers AI or Vectorize call', async () => {
    const modules = fixture.modules;
    const expected = await dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));
    const before = aiAndVectorizeCalls();
    const res = await ingest(rows(120), { d1Only: true, expectedDataVersion: expected });
    expect(res.status).toBe('done');
    expect(res.catalogue).toEqual({ upserted: 120, deleted: 0 });
    expect(aiAndVectorizeCalls()).toBe(before);
  });

  it('charges its writes to the write budget and stops cleanly before passing it', async () => {
    // The modules are already loaded (seed), so the catalogue is all this run writes.
    const res = await ingest(rows(300), { writeBudget: 250 });
    expect(res.status).toBe('budget');
    expect(res.rowsCharged).toBeLessThanOrEqual(250);
    expect((await stored()).length).toBeLessThan(300);
    const rerun = await ingest(rows(300));
    expect(rerun.status).toBe('done');
    expect(await stored()).toHaveLength(300);
  });

  it('leaves the table alone when the caller passes no catalogue', async () => {
    await ingest(rows(5));
    const res = await ingest(undefined);
    expect(res.status).toBe('done');
    expect(res.catalogue).toBeNull();
    expect(await stored()).toHaveLength(5);
  });
});
