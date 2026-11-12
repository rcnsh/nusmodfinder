// @ts-check
// Re-ingest, Node side: what scripts/lib.mjs and src/rowhash.js hash, the
// ingest skip rule (scripts/ingest-core.mjs planIngest), what is embedded, and
// how the download cache revalidates. Runs in Node (vitest project "node").
// The cache tests use a temporary directory and a stubbed fetch: no request
// ever reaches api.nusmods.com.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planIngest } from '../../scripts/ingest-core.mjs';
import {
  DEFAULT_ACAD_YEAR, EMBEDDING_MODEL, EMBEDDING_TEXT_VARIANT, EMBEDDING_TEXT_VERSION, embeddingText, fetchAcadYearFile, hashOf, loadNgRestrictions, offeredModules,
} from '../../scripts/lib.mjs';
import {
  NORMALISER_VERSION, ROW_COLUMNS, boundTuple, fieldsFromRow, rowHash, sha256Hex, vectorMetadata,
} from '../../src/rowhash.js';

/** A NUSMods v2 moduleInfo record. */
const record = {
  moduleCode: 'CS1010S', title: 'Programming Methodology', department: 'Computer Science', faculty: 'Computing',
  description: 'This course introduces the fundamental concepts of problem solving by computing.',
  moduleCredit: '4', semesterData: [{ semester: 1 }, { semester: 2 }],
  workload: [2, 1, 1, 3, 3], prerequisite: 'None', preclusion: 'CS1010',
};
const ng = (/** @type {Record<string, number[]>} */ bySem) =>
  ({ available: true, bySem: new Map(Object.entries(bySem)), updatedAsAt: '01 Sep 1999', source: null, total: Object.keys(bySem).length, rules: loadNgRestrictions(DEFAULT_ACAD_YEAR) });

describe('row and text hashes', () => {
  const Y = DEFAULT_ACAD_YEAR;
  /** @param {Partial<import('../../scripts/lib.mjs').NusModsRecord>} over @param {Record<string, number[]>} [ngSems] */
  const one = (over, ngSems = {}) => offeredModules([{ ...record, ...over }], Y, ng(ngSems)).modules[0];

  it('row_hash changes with semesters, credits, workload, prerequisite, preclusion, NG flags and acad year; text_hash does not', async () => {
    const before = one({});
    const variants = {
      semesters: one({ semesterData: [{ semester: 2 }, { semester: 3 }] }),
      credits: one({ moduleCredit: '2' }),
      workload: one({ workload: [0, 0, 0, 5, 5] }),
      prerequisite: one({ prerequisite: 'CS1231' }),
      preclusion: one({ preclusion: 'None' }),
      ng: one({}, { CS1010S: [1] }),
      ngSemesters: offeredModules([record], Y, ng({ CS1010S: [2] })).modules[0],
      acadYear: offeredModules([record], '1998-1999', ng({})).modules[0],
    };
    const base = await rowHash(before);
    for (const [field, after] of Object.entries(variants)) {
      expect(after.textHash, field).toBe(before.textHash);
      expect(await rowHash(after), field).not.toBe(base);
    }
    // The embedded text changes both.
    const retitled = one({ title: 'Programming Methodology I' });
    expect(retitled.textHash).not.toBe(before.textHash);
    expect(await rowHash(retitled)).not.toBe(base);
  });

  it('text_hash is the hash of the model id, the embedded-text version and the text', () => {
    const m = one({});
    expect(m.textHash).toBe(hashOf(JSON.stringify([EMBEDDING_MODEL, EMBEDDING_TEXT_VERSION, m.text])));
    expect(m.textHash).not.toBe(hashOf(m.text));
  });

  it('row_hash is the hash of the normaliser version, the exact bound tuple and the vector metadata, and is recomputable from the stored row', async () => {
    const m = one({}, { CS1010S: [1, 2] });
    const expected = (await sha256Hex(JSON.stringify([NORMALISER_VERSION, boundTuple(m), vectorMetadata(m)]))).slice(0, 32);
    expect(await rowHash(m)).toBe(expected);
    // The row as D1 stores it (columns named as in the table) hashes the same.
    const row = /** @type {import('../../src/rowhash.js').ModuleRow} */ (/** @type {unknown} */ (
      Object.fromEntries(ROW_COLUMNS.map((c, i) => [c, boundTuple(m)[i]]))));
    expect(await rowHash(fieldsFromRow(row))).toBe(expected);
  });

  it('the skip rule: text changed re-embeds, only the row changed re-upserts without embedding, unchanged is skipped', async () => {
    const same = await withHash(one({}));
    const rowOnly = await withHash(one({ moduleCredit: '2' }));
    const textToo = await withHash(one({ title: 'Programming Methodology I' }));
    const stored = { CS1010S: { textHash: same.textHash, rowHash: same.rowHash } };
    expect(planIngest([same], stored, { force: false })).toMatchObject({ embed: [], rowOnly: [], unchanged: 1 });
    expect(planIngest([rowOnly], stored, { force: false })).toMatchObject({ embed: [], rowOnly: [rowOnly], unchanged: 0 });
    expect(planIngest([textToo], stored, { force: false })).toMatchObject({ embed: [textToo], rowOnly: [], unchanged: 0 });
    // New codes embed; --force embeds everything; codes only D1 has are deleted.
    const plan = planIngest([same], { XX9999: { textHash: 'x', rowHash: 'y' } }, { force: false });
    expect(plan).toMatchObject({ embed: [same], deletes: ['XX9999'] });
    expect(planIngest([same], stored, { force: true })).toMatchObject({ embed: [same], unchanged: 0 });
  });

  describe('download cache', () => {
    /** @type {URL} */
    let dir;
    const FILE = 'moduleInfo.json';
    const HOUR = 3_600_000;
    beforeEach(async () => {
      dir = new URL(`file://${await mkdtemp(join(tmpdir(), 'vnm-cache-'))}/`);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const BODY = '{"v":1}';
    /** Writes a cached body and its sidecar (vouching for `vouchFor`), fetched `age` ms ago. */
    const prime = async (/** @type {number} */ age, sidecar = true, vouchFor = BODY) => {
      await writeFile(new URL(`${Y}-${FILE}`, dir), BODY);
      if (sidecar) {
        await writeFile(new URL(`${Y}-${FILE}.cache.json`, dir), JSON.stringify({
          url: `https://api.nusmods.com/v2/${Y}/${FILE}`, etag: '"v1"', lastModified: 'Wed, 01 Sep 1999 00:00:00 GMT',
          fetchedAt: new Date(Date.now() - age).toISOString(), sha256: createHash('sha256').update(vouchFor).digest('hex'),
        }));
      }
    };
    /** NUSMods: 304 to a conditional GET, else the body. */
    const nusmods = (/** @type {string} */ body) => vi.fn(async (/** @type {any} */ _url, /** @type {any} */ init) =>
      (init?.headers?.['if-none-match'] || init?.headers?.['if-modified-since']
        ? new Response(null, { status: 304, headers: { etag: '"v1"' } })
        : new Response(body, { status: 200, headers: { etag: '"v9"' } })));

    it('a fresh entry whose body does not match its sidecar sha256 is refetched in full, without validators', async () => {
      await prime(1 * HOUR, true, '{"v":"what was really downloaded"}');
      const fetchImpl = nusmods('{"v":9}');
      const got = await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(/** @type {any[]} */ (fetchImpl.mock.calls[0])[1].headers).toEqual({});
      expect(got).toMatchObject({ data: { v: 9 }, cached: false });
      expect(await readFile(new URL(`${Y}-${FILE}`, dir), 'utf8')).toBe('{"v":9}');
    });

    it('a stale entry whose body does not match is never revalidated into a 304', async () => {
      await prime(25 * HOUR, true, '{"v":"other"}');
      const fetchImpl = nusmods('{"v":9}');
      const got = await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl });
      expect(/** @type {any[]} */ (fetchImpl.mock.calls[0])[1].headers).toEqual({});
      expect(got).toMatchObject({ data: { v: 9 } });
    });

    it('the sidecar records the body sha256; --offline refuses a body that does not match it', async () => {
      await prime(0, false);
      await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl: nusmods('{"v":9}') });
      expect((await sidecar()).sha256).toBe(createHash('sha256').update('{"v":9}').digest('hex'));
      await writeFile(new URL(`${Y}-${FILE}`, dir), '{"v":9');
      await expect(fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl: nusmods('{}'), offline: true })).rejects.toThrow(/sha256/);
    });

    it('a sidecar without sha256 cannot vouch for its body: full GET', async () => {
      await prime(1 * HOUR, true);
      const side = await sidecar();
      delete side.sha256;
      await writeFile(new URL(`${Y}-${FILE}.cache.json`, dir), JSON.stringify(side));
      const fetchImpl = nusmods('{"v":9}');
      expect(await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl })).toMatchObject({ data: { v: 9 } });
      expect(/** @type {any[]} */ (fetchImpl.mock.calls[0])[1].headers).toEqual({});
    });
    const sidecar = async () => JSON.parse(await readFile(new URL(`${Y}-${FILE}.cache.json`, dir), 'utf8'));

    it('an entry older than --max-age is revalidated with If-None-Match, and a 304 keeps the cached body', async () => {
      await prime(25 * HOUR);
      const fetchImpl = vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"v1"' } }));
      const got = await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [, init] = /** @type {any[]} */ (fetchImpl.mock.calls[0]);
      expect(init.headers).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Wed, 01 Sep 1999 00:00:00 GMT' });
      expect(got).toMatchObject({ data: { v: 1 }, cached: true, revalidated: true });
      expect(Date.now() - Date.parse((await sidecar()).fetchedAt)).toBeLessThan(60_000);
    });

    it('a 200 on revalidation replaces the body and records the new ETag and Last-Modified', async () => {
      await prime(25 * HOUR);
      const fetchImpl = vi.fn(async () => new Response('{"v":2}', {
        status: 200, headers: { etag: '"v2"', 'last-modified': 'Thu, 02 Sep 1999 00:00:00 GMT' },
      }));
      const got = await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl });
      expect(got).toMatchObject({ data: { v: 2 }, cached: false });
      expect(await readFile(new URL(`${Y}-${FILE}`, dir), 'utf8')).toBe('{"v":2}');
      expect(await sidecar()).toMatchObject({ etag: '"v2"', lastModified: 'Thu, 02 Sep 1999 00:00:00 GMT' });
    });

    it('an entry younger than --max-age (default 24 h) is used without a request', async () => {
      await prime(23 * HOUR);
      const fetchImpl = vi.fn(async () => { throw new Error('no network'); });
      expect(await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl })).toMatchObject({ cached: true, revalidated: false });
      // A shorter --max-age makes the same entry stale.
      await expect(fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl, maxAgeMs: HOUR })).rejects.toThrow(/--offline/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('--offline uses the cache however old and never fetches; with no cache it fails', async () => {
      await prime(1000 * HOUR, false);
      const fetchImpl = vi.fn(async () => new Response('{}'));
      expect(await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl, offline: true })).toMatchObject({ data: { v: 1 }, cached: true });
      await expect(fetchAcadYearFile('1998-1999', FILE, { cacheDir: dir, fetchImpl, offline: true })).rejects.toThrow(/offline/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('an entry with no sidecar is stale: fetched unconditionally, then given one', async () => {
      await prime(0, false);
      const fetchImpl = vi.fn(async () => new Response('{"v":3}', { headers: { etag: '"v3"' } }));
      expect(await fetchAcadYearFile(Y, FILE, { cacheDir: dir, fetchImpl })).toMatchObject({ data: { v: 3 } });
      const [, init] = /** @type {any[]} */ (fetchImpl.mock.calls[0]);
      expect(init.headers).toEqual({});
      expect(await sidecar()).toMatchObject({ etag: '"v3"' });
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });
});

/** @param {NormalisedModule} m */
const withHash = async (m) => ({ ...m, rowHash: await rowHash(m) });

describe('embedded text', () => {
  it('the embedded text is the selected variant, with the code\'s level and its label', () => {
    expect(EMBEDDING_TEXT_VARIANT).toBe('v1');
    expect(embeddingText(record)).toBe(
      'CS1010S. Programming Methodology. Level 1 (introductory). This course introduces the fundamental concepts of problem solving by computing. Computer Science. Computing.');
  });
});
