// @ts-check
// Phase 3 3-0's ingest and re-embed runbook (docs/plans/phase3.md 3-0) against
// the real admin routes, local D1 and the fakes:
// - step 4, the D1-only mode (B3-5): /admin/ingest?d1Only=1, /admin/delete?d1Only=1
//   and ingest-core's d1Only make no Workers AI or Vectorize call;
// - step 5, `npm run verify -- --pre-deploy` (B2-1): D1 against the manifest
//   and the bundle, with no Vectorize read;
// - step 8, /admin/vectors and scripts/vectors-core.mjs runStandby (B2-1, B3-3):
//   every code upserted from the bundle with D1's full metadata, in batches of
//   at most 1,000, deletions after, the mutation awaited, then verify with a
//   values sample.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runIngest } from '../scripts/ingest-core.mjs';
import { runStandby } from '../scripts/vectors-core.mjs';
import { runPreDeployVerify, runVerify } from '../scripts/verify-core.mjs';
import { dataVersion, fieldsFromRow, rowHash, sha256Hex, storedVectorMetadata } from '../src/rowhash.js';
import { encodeBundle, float32ToBase64, parseBundle } from '../src/vector-bundle.js';
import manifest from '../data/vectors.json';
import { knownReason } from '../src/ng-reasons.js';
import ngReasons from '../data/ng-reasons.json';
import fixtureUnscheduled from './fixtures/ng-unscheduled.json';
import { hashEmbed } from './fakes.js';
import { adminCall, fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

const MODEL = '@cf/baai/bge-small-en-v1.5';
/** scripts/lib.mjs EMBEDDING_TEXT_VERSION. */
const EMBEDDING_TEXT_VERSION = 2;
const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };

/** @type {import('./fakes.js').Fakes} */
let fakes;
let clock = 0;
const sleep = async (/** @type {number} */ ms) => { clock += ms; };
const now = () => clock;
beforeEach(async () => {
  clock = 0;
  fakes = await seed();
});

const api = () => adminApi(() => fakes);
const noRemoteCalls = () => {
  expect(fakes.ai.calls).toEqual([]);
  expect(fakes.vectorize.calls).toEqual([]);
};

/** A module with a new text, as normalise() would give it. @param {NormalisedModule} m @param {string} text */
const withText = async (m, text) => ({
  ...m, text, description: `${m.description} (revised)`,
  textHash: (await sha256Hex(JSON.stringify([MODEL, EMBEDDING_TEXT_VERSION, text]))).slice(0, 32),
});

/** The bundle a corpus implies: the fake embedder's vectors, as scripts/vectors.mjs builds the fixture's. @param {NormalisedModule[]} modules */
const bundleFor = async (modules) => {
  const bytes = await encodeBundle({ corpus: 'production', embedding: 'fake-hash-embed', model: 'fake', modules, vectorOf: (m) => hashEmbed(/** @type {NormalisedModule} */ (m).text) });
  return parseBundle(/** @type {ArrayBuffer} */ (bytes.buffer));
};

/** @param {NormalisedModule[]} modules */
const versionOf = async (modules) => dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));

describe('runbook step 4: D1-only mode (B3-5)', () => {
  it('/admin/ingest?d1Only=1 writes the rows and hashes and calls neither Workers AI nor Vectorize', async () => {
    const m = await withText(fixture.modules[0], 'a wholly new embedded text');
    const res = await adminCall('/admin/ingest?d1Only=1', fakes, { modules: [m] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ upserted: 1, embedded: 0, reused: 0, mutationId: null, sentAt: null, d1Only: true });
    noRemoteCalls();
    const row = await env.DB.prepare('SELECT text_hash, row_hash, description FROM modules WHERE code = ?').bind(m.code).first();
    expect(row).toEqual({ text_hash: m.textHash, row_hash: await rowHash(m), description: m.description });
    // The standby keeps the old vector until step 8.
    expect(fakes.vectorize.vectors.get(m.code)?.metadata?.textHash).toBe(fixture.modules[0].textHash);
  });

  it('/admin/delete?d1Only=1 deletes the rows, returns their codes, and leaves Vectorize alone', async () => {
    const codes = fixture.modules.slice(0, 3).map((m) => m.code);
    const res = await adminCall('/admin/delete?d1Only=1', fakes, { codes });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 3, codes: expect.arrayContaining(codes), mutationId: null, d1Only: true });
    noRemoteCalls();
    expect(Number(await env.DB.prepare(`SELECT count(*) AS n FROM modules WHERE code IN (?, ?, ?)`).bind(...codes).first('n'))).toBe(0);
    for (const c of codes) expect(fakes.vectorize.vectors.has(c)).toBe(true);
  });

  it('ingest-core d1Only: text changes, row changes and deletes reach D1 with no AI or Vectorize call, and the pending store is untouched', async () => {
    const changed = await withText(fixture.modules[5], 'another new text');
    const rowOnly = { ...fixture.modules[6], credits: 99 };
    const kept = fixture.modules.slice(10);
    const corpus = [changed, rowOnly, ...fixture.modules.slice(7, 10), ...kept];
    const gone = fixture.modules.slice(0, 5).map((m) => m.code);
    let pendingTouched = false;
    const pending = { read: async () => { pendingTouched = true; return null; }, write: async () => { pendingTouched = true; } };
    const result = await runIngest({
      modules: corpus, facetsBody, api: api(), sleep, now, pending,
      options: { embeddingModel: MODEL, d1Only: true, expectedDataVersion: await versionOf(corpus) },
    });
    expect(result.status).toBe('done');
    expect(result.message).toMatch(/D1 only/);
    expect(result.plan).toMatchObject({ embed: 1, rowOnly: 1, deletes: 5 });
    expect(result.deletedCodes.sort()).toEqual(gone.sort());
    expect(result.dataVersion).toBe(await versionOf(corpus));
    expect(result.lastMutationId).toBeNull();
    noRemoteCalls();
    expect(pendingTouched).toBe(false);
    expect(await env.DB.prepare('SELECT credits FROM modules WHERE code = ?').bind(rowOnly.code).first('credits')).toBe(99);
    expect(await env.DB.prepare('SELECT text_hash FROM modules WHERE code = ?').bind(changed.code).first('text_hash')).toBe(changed.textHash);
  });

  it('ingest-core d1Only refuses, before any write, a corpus whose data version is not the committed one', async () => {
    const changed = await withText(fixture.modules[5], 'another new text');
    const corpus = [changed, ...fixture.modules.slice(6)];
    const before = await env.DB.prepare('SELECT count(*) AS n, group_concat(row_hash) AS h FROM modules').first();
    for (const expectedDataVersion of [await versionOf(fixture.modules), null]) {
      const result = await runIngest({
        modules: corpus, facetsBody, api: api(), sleep, now, options: { embeddingModel: MODEL, d1Only: true, expectedDataVersion },
      });
      expect(result.status).toBe('refused');
      expect(result.message).toMatch(/Nothing was written/);
      expect(result.upserted).toBe(0);
    }
    expect(await env.DB.prepare('SELECT count(*) AS n, group_concat(row_hash) AS h FROM modules').first()).toEqual(before);
    noRemoteCalls();
  });
});

describe('runbook step 5: verify --pre-deploy', () => {
  const fixtureEntry = /** @type {any} */ (manifest).bundles.fixture;
  const fixtureBundle = async () => bundleFor(fixture.modules);
  /**
   * 6A: the year files this deploy ships and the NG list, for the fixture: its NG codes plus the
   * fixture file's, so exactly the file's codes are NG codes with no D1 row.
   */
  const unscheduledCodes = fixtureUnscheduled.modules.map((e) => e.code);
  const dataFiles = {
    ngReasonsAcadYear: ngReasons.acadYear,
    unscheduled: { acadYear: fixtureUnscheduled.acadYear, codes: unscheduledCodes },
    ngCodes: [...fixture.modules.filter((m) => m.ng).map((m) => m.code), ...unscheduledCodes],
  };

  it('D1 as seeded agrees with the fixture bundle and its manifest entry, and Vectorize is not read', async () => {
    const bundle = await fixtureBundle();
    expect(bundle.header.rowsKey).toBe(fixtureEntry.rowsKey);
    const r = await runPreDeployVerify({ api: api(), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason, dataFiles });
    expect(r).toMatchObject({ ok: true, d1Rows: fixture.modules.length, bundleRows: fixture.modules.length, missingInBundle: [], extraInBundle: [], fieldDrift: [] });
    expect(new Set(Object.values(r.rowsKey)).size).toBe(1);
    expect(new Set(Object.values(r.dataVersion)).size).toBe(1);
    expect(r.rowsRead).toBe(fixture.modules.length);
    noRemoteCalls();
  });

  it('reports a text D1 changed, a filter field that drifted, a missing row and a stale committed data version', async () => {
    const bundle = await fixtureBundle();
    const [a, b, c] = fixture.modules;
    await env.DB.prepare("UPDATE modules SET text_hash = 'changed' WHERE code = ?").bind(a.code).run();
    await env.DB.prepare("UPDATE modules SET semesters = '[4]' WHERE code = ?").bind(b.code).run();
    await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind(c.code).run();
    const r = await runPreDeployVerify({ api: api(), bundle, manifest: fixtureEntry, committedDataVersion: '000000000000', knownReason, dataFiles });
    expect(r.ok).toBe(false);
    expect(r.rowsKey.d1).not.toBe(r.rowsKey.bundle);
    expect(r.dataVersion.committed).not.toBe(r.dataVersion.bundle);
    expect(r.fieldDrift.map((d) => d.code)).toEqual([b.code]);
    expect(r.extraInBundle).toEqual([c.code]);
    noRemoteCalls();
  });

  it('5A: reports exam dates D1 holds for semesters the bundle has no exam in, even under a consistent row_hash', async () => {
    const bundle = await fixtureBundle();
    const m = /** @type {NormalisedModule} */ (fixture.modules.find((x) => x.examDates.length === 1));
    const wrongSem = m.examDates[0].sem === 1 ? 2 : 1;
    const examDates = [{ ...m.examDates[0], sem: wrongSem }];
    // Rewritten as a stale ingest would have: the row's own hash agrees with its columns.
    await env.DB.prepare('UPDATE modules SET exam_dates = ?, row_hash = ? WHERE code = ?')
      .bind(JSON.stringify(examDates), await rowHash({ ...m, examDates }), m.code).run();
    const r = await runPreDeployVerify({ api: api(), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason, dataFiles });
    expect(r.ok).toBe(false);
    expect(r.rowHashDrift).toEqual([]);
    expect(r.fieldDrift).toEqual([{ code: m.code, d1: { examDates }, bundle: { examSemesters: m.examSemesters } }]);
    noRemoteCalls();
  });

  it('6A: both year files\' acadYear equal D1\'s acad_year, and the file\'s codes are exactly the NG codes with no row', async () => {
    const bundle = await fixtureBundle();
    const r = await runPreDeployVerify({ api: api(), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason, dataFiles });
    expect(r.ok).toBe(true);
    expect(r.acadYear).toEqual({ d1: '2026-2027', ngReasons: '2026-2027', ngUnscheduled: '2026-2027' });
    expect(r.unscheduled).toEqual({ missing: [], withRow: [], notNg: [] });

    const offered = /** @type {NormalisedModule} */ (fixture.modules.find((m) => m.ng));
    const stale = await runPreDeployVerify({
      api: api(), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason,
      dataFiles: {
        ngReasonsAcadYear: ngReasons.acadYear,
        // A file from last year, holding an offered code and a code off the NG list, and missing EE4407.
        unscheduled: { acadYear: '2025-2026', codes: [...unscheduledCodes.filter((c) => c !== 'EE4407'), offered.code, 'ZZ1000'] },
        ngCodes: dataFiles.ngCodes,
      },
    });
    expect(stale.ok).toBe(false);
    expect(stale.acadYear.ngUnscheduled).toBe('2025-2026');
    expect(stale.unscheduled).toEqual({ missing: ['EE4407'], withRow: [offered.code], notNg: ['ZZ1000'] });
  });

  it('6A: a D1 holding rows of two years agrees with no file', async () => {
    const bundle = await fixtureBundle();
    await env.DB.prepare("UPDATE modules SET acad_year = '2027-2028' WHERE code = ?").bind(fixture.modules[0].code).run();
    const r = await runPreDeployVerify({ api: api(), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason, dataFiles });
    expect(r.ok).toBe(false);
    expect(r.acadYear.d1).toBeNull();
  });

  it('Phase 4 (B3-5): refuses a stored rule id the Worker\'s reason texts don\'t know', async () => {
    const bundle = await fixtureBundle();
    const ng = /** @type {NormalisedModule} */ (fixture.modules.find((m) => m.ngRules && Object.keys(m.ngRules).length));
    const stored = JSON.stringify({ ...ng.ngRules, 0: ['no-such-rule'] });
    await env.DB.prepare('UPDATE modules SET ng_rules = ? WHERE code = ?').bind(stored, ng.code).run();
    const r = await runPreDeployVerify({ api: api(), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason, dataFiles });
    expect(r.ok).toBe(false);
    expect(r.unknownReasons).toEqual([{ code: ng.code, id: 'no-such-rule' }]);
  });
});

describe('runbook step 8: /admin/vectors and the standby run', () => {
  it('/admin/vectors upserts the posted values with D1\'s full metadata, and refuses ids D1 does not hold, writing nothing', async () => {
    const [a, b] = fixture.modules;
    const values = Float32Array.from([...hashEmbed('first'), ...hashEmbed('second')]);
    await env.DB.prepare('UPDATE modules SET credits = 12 WHERE code = ?').bind(a.code).run();
    const res = await adminCall('/admin/vectors', fakes, { ids: [a.code, b.code], values: float32ToBase64(values) });
    expect(res.status).toBe(200);
    const body = /** @type {any} */ (await res.json());
    expect(body).toMatchObject({ upserted: 2, mutationId: expect.any(String), sentAt: expect.any(Number) });
    const row = /** @type {import('../src/rowhash.js').ModuleRow} */ (await env.DB.prepare('SELECT * FROM modules WHERE code = ?').bind(a.code).first());
    const stored = fakes.vectorize.vectors.get(a.code);
    expect(stored?.metadata).toEqual(storedVectorMetadata(fieldsFromRow(row)));
    expect(stored?.metadata?.credits).toBe(12);
    expect(Float32Array.from(/** @type {number[]} */ (stored?.values))).toEqual(values.subarray(0, 384));
    expect(fakes.ai.calls).toEqual([]);

    const upserts = fakes.vectorize.calls.filter((c) => c.method === 'upsert').length;
    const unknown = await adminCall('/admin/vectors', fakes, { ids: [a.code, 'ZZ9999'], values: float32ToBase64(values) });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(await unknown.json())).toContain('ZZ9999');
    const short = await adminCall('/admin/vectors', fakes, { ids: [a.code, b.code], values: float32ToBase64(values.subarray(0, 384)) });
    expect(short.status).toBe(400);
    const many = await adminCall('/admin/vectors', fakes, { ids: Array.from({ length: 1001 }, (_, i) => `X${i}`), values: '' });
    expect(many.status).toBe(400);
    expect(fakes.vectorize.calls.filter((c) => c.method === 'upsert').length).toBe(upserts);
  });

  it('/admin/vectors deleteIds removes vectors D1 no longer holds, and refuses one it still holds', async () => {
    const [a, b] = fixture.modules;
    await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind(a.code).run();
    const held = await adminCall('/admin/vectors', fakes, { deleteIds: [a.code, b.code] });
    expect(held.status).toBe(400);
    expect(fakes.vectorize.vectors.has(a.code)).toBe(true);
    const res = await adminCall('/admin/vectors', fakes, { deleteIds: [a.code] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 1, mutationId: expect.any(String) });
    expect(fakes.vectorize.vectors.has(a.code)).toBe(false);
  });

  it('after a D1-only ingest, the standby run upserts every code in batches, deletes, waits, and verify then agrees, values included', async () => {
    // Step 4: a text change, a row change and two deletions reach D1 only.
    const changed = await withText(fixture.modules[5], 'standby run new text');
    const rowOnly = { ...fixture.modules[6], level: 7 };
    const corpus = [changed, rowOnly, ...fixture.modules.slice(7)];
    const step4 = await runIngest({
      modules: corpus, facetsBody, api: api(), sleep, now,
      options: { embeddingModel: MODEL, d1Only: true, expectedDataVersion: await versionOf(corpus), allowMassDelete: true },
    });
    expect(step4.status).toBe('done');
    // The standby now disagrees with D1: verify says so.
    const listVectorIds = async () => [...fakes.vectorize.vectors.keys()];
    expect((await runVerify({ api: api(), listVectorIds, sample: [changed.code, rowOnly.code] })).ok).toBe(false);

    // Step 8, with the bundle built for what D1 now holds.
    const bundle = await bundleFor(corpus);
    fakes.vectorize.processPerDescribe = 1;
    fakes.vectorize.calls.length = 0;
    const result = await runStandby({ api: api(), bundle, deletes: step4.deletedCodes, batchSize: 150, sleep, now, waitIntervalMs: 1000 });
    expect(result.status).toBe('done');
    expect(result.upserted).toBe(corpus.length);
    expect(result.deleted).toBe(step4.deletedCodes.length);
    const upserts = fakes.vectorize.calls.filter((c) => c.method === 'upsert');
    expect(upserts.map((c) => /** @type {unknown[]} */ (c.args[0]).length)).toEqual([150, 150, corpus.length - 300]);
    expect(fakes.vectorize.calls.filter((c) => c.method === 'deleteByIds')).toHaveLength(1);
    expect(result.mutations).toHaveLength(4);
    expect(fakes.ai.calls).toEqual([]);

    const report = await runVerify({ api: api(), listVectorIds, sampleSize: 100, bundle });
    expect(report).toMatchObject({ ok: true, missingVectors: [], extraVectors: [], metadataDrift: [], valueDrift: [], valuesChecked: 100 });
    expect(fakes.vectorize.vectors.get(changed.code)?.metadata?.textHash).toBe(changed.textHash);
    expect(fakes.vectorize.vectors.get(rowOnly.code)?.metadata?.level).toBe(7);
    // A sampled vector whose values differ from the bundle is drift.
    const v = /** @type {import('./fakes.js').StoredVector} */ (fakes.vectorize.vectors.get(changed.code));
    fakes.vectorize.vectors.set(changed.code, { ...v, values: hashEmbed('something else') });
    expect((await runVerify({ api: api(), listVectorIds, sample: [changed.code], bundle })).valueDrift).toEqual([changed.code]);
  });

  it('the standby deletes every index id D1 no longer holds, even when the deletions file lost some (resumed or retried step 4)', async () => {
    // Step 4 removed six codes from D1, but the file it left names none of them
    // (a budget stop then resume, a clean rerun, or a retried delete all lose codes).
    const corpus = fixture.modules.slice(6);
    const step4 = await runIngest({
      modules: corpus, facetsBody, api: api(), sleep, now,
      options: { embeddingModel: MODEL, d1Only: true, expectedDataVersion: await versionOf(corpus), allowMassDelete: true },
    });
    expect(step4.status).toBe('done');
    const listVectorIds = async () => [...fakes.vectorize.vectors.keys()];
    const bundle = await bundleFor(corpus);
    fakes.vectorize.processPerDescribe = 1;
    const result = await runStandby({ api: api(), bundle, deletes: [], listVectorIds, sleep, now, waitIntervalMs: 1000 });
    expect(result.status).toBe('done');
    expect(result.deleted).toBe(6);
    const report = await runVerify({ api: api(), listVectorIds, sampleSize: 100, bundle });
    expect(report).toMatchObject({ ok: true, missingVectors: [], extraVectors: [] });
  });

  it('the standby run refuses, sending nothing, a bundle that does not match D1\'s texts, or deletions D1 still holds', async () => {
    const changed = await withText(fixture.modules[5], 'never ingested');
    const wrong = await bundleFor([changed, ...fixture.modules.slice(0, 5), ...fixture.modules.slice(6)]);
    const r1 = await runStandby({ api: api(), bundle: wrong, sleep, now });
    expect(r1.status).toBe('refused');
    expect(r1.message).toMatch(/rowsKey/);
    const right = await bundleFor(fixture.modules);
    const r2 = await runStandby({ api: api(), bundle: right, deletes: [fixture.modules[0].code], sleep, now });
    expect(r2.status).toBe('refused');
    expect(fakes.vectorize.calls.filter((c) => c.method === 'upsert' || c.method === 'deleteByIds')).toEqual([]);
  });
});
