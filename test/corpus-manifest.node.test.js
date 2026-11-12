// @ts-check
// Phase 7 7D, the corpus manifest (data/corpus.json, docs/plans/phase7.md 7D):
// each production corpus is a sha-checked release asset, `current` names the
// one ingest uses, and ingest, the bundle and every per-corpus file read only
// that one, never the .data/cache download. Everything here runs on temp
// directories with a fake download and upload: no network.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CORPUS_SCHEMA, checkCurrent, corpusDataVersion, corpusPath, currentEntry, loadCurrentCorpus, publishCorpus, readCorpusManifest,
  releaseName, restoreCurrent,
} from '../scripts/corpus-manifest.mjs';
import { main as ingestMain } from '../scripts/ingest.mjs';
import { DEFAULT_ACAD_YEAR, catalogueOnlyRecords, loadNgCourses } from '../scripts/lib.mjs';
import { catalogueKey } from '../src/rowhash.js';

const Y = DEFAULT_ACAD_YEAR;
/** @param {string} code @param {number[]} sems */
const record = (code, sems) => ({
  moduleCode: code, title: `Title ${code}`, description: `About ${code}.`, moduleCredit: '4', department: 'D', faculty: 'F',
  semesterData: sems.map((semester) => ({ semester })),
});
const RECORDS = [record('AA1001', [1]), record('AA1002', [2]), record('AA0999', []), record('AB0998', [])];
const BODY = JSON.stringify(RECORDS);
const SHA = createHash('sha256').update(BODY).digest('hex');
const FETCHED = '1999-11-04T06:29:36.369Z';
const RELEASE = releaseName(Y, FETCHED);

/** @type {string} */
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vnm-corpus-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A manifest with one entry for BODY, as `corpus publish` writes it. @param {Partial<{ sha256: string, year: string }>} [o] */
async function manifest(o = {}) {
  const path = join(dir, 'corpus.json');
  await writeFile(path, `${JSON.stringify({
    schema: CORPUS_SCHEMA, current: RELEASE,
    corpora: { [RELEASE]: { year: o.year ?? Y, release: RELEASE, asset: `${Y}-moduleInfo.json.gz`, sha256: o.sha256 ?? SHA, bytes: BODY.length, fetchedAt: FETCHED } },
  }, null, 2)}\n`);
  return path;
}

describe('the manifest', () => {
  it('names its release prod-<year>-<UTC yyyymmdd of the fetch>', () => {
    expect(releaseName('1998-1999', '1999-11-04T23:59:59Z')).toBe('prod-1998-1999-19991104');
  });

  it('current is the entry ingest uses; a current with no entry is refused', async () => {
    const m = await readCorpusManifest(await manifest());
    expect(currentEntry(m)).toMatchObject({ release: RELEASE, sha256: SHA, year: Y });
    expect(() => currentEntry({ ...m, current: 'prod-1990-1991-19900101' })).toThrow(/current/);
  });

  it('loads current from .data/prod/<sha>.json, and refuses a missing file (naming restore) or a wrong sha', async () => {
    const manifestPath = await manifest();
    const prod = join(dir, 'prod');
    await expect(loadCurrentCorpus({ manifestPath, dir: prod })).rejects.toThrow(/npm run corpus -- restore/);
    await mkdir(prod, { recursive: true });
    await writeFile(corpusPath({ sha256: SHA }, prod), BODY.replace('AA1002', 'AA1003'));
    await expect(loadCurrentCorpus({ manifestPath, dir: prod })).rejects.toThrow(/sha256/);
    await writeFile(corpusPath({ sha256: SHA }, prod), BODY);
    const c = await loadCurrentCorpus({ manifestPath, dir: prod });
    expect(c.records.map((r) => r.moduleCode)).toEqual(RECORDS.map((r) => r.moduleCode));
    expect(c.entry.sha256).toBe(SHA);
  });

  it('refuses a current entry for another year than DEFAULT_ACAD_YEAR (one year source)', async () => {
    const manifestPath = await manifest({ year: '1998-1999' });
    await mkdir(join(dir, 'prod'));
    await writeFile(corpusPath({ sha256: SHA }, join(dir, 'prod')), BODY);
    await expect(loadCurrentCorpus({ manifestPath, dir: join(dir, 'prod') })).rejects.toThrow(/1998-1999/);
  });
});

describe('npm run corpus -- restore', () => {
  /** A fake `gh release download`: writes `bytes` as the asset. @param {Buffer} bytes */
  const download = (bytes) => {
    /** @type {string[][]} */
    const calls = [];
    return {
      calls,
      /** @param {string} release @param {string} asset @param {string} dest */
      fn: async (release, asset, dest) => { calls.push([release, asset]); await writeFile(join(dest, asset), bytes); },
    };
  };

  it('downloads current, gunzips it, checks its raw sha256 and writes .data/prod/<sha>.json', async () => {
    const manifestPath = await manifest();
    const d = download(gzipSync(BODY));
    const path = await restoreCurrent({ manifestPath, dir: join(dir, 'prod'), download: d.fn, log: () => {} });
    expect(path).toBe(corpusPath({ sha256: SHA }, join(dir, 'prod')));
    expect(await readFile(path, 'utf8')).toBe(BODY);
    expect(d.calls).toEqual([[RELEASE, `${Y}-moduleInfo.json.gz`]]);
    // Present and right: nothing is downloaded again.
    await restoreCurrent({ manifestPath, dir: join(dir, 'prod'), download: d.fn, log: () => {} });
    expect(d.calls).toHaveLength(1);
  });

  it('refuses an asset whose sha256 is not the manifest\'s, and writes nothing', async () => {
    const manifestPath = await manifest();
    const d = download(gzipSync(BODY.replace('AA1002', 'AA1003')));
    await expect(restoreCurrent({ manifestPath, dir: join(dir, 'prod'), download: d.fn, log: () => {} })).rejects.toThrow(/sha256/);
    expect(existsSync(join(dir, 'prod')) ? await readdir(join(dir, 'prod')) : []).toEqual([]);
  });
});

describe('npm run corpus -- publish', () => {
  /** @returns {{ calls: { release: string, file: string, bytes: Buffer }[], fn: import('../scripts/corpus-manifest.mjs').Upload }} */
  const upload = () => {
    /** @type {{ release: string, file: string, bytes: Buffer }[]} */
    const calls = [];
    return { calls, fn: async (release, file) => { calls.push({ release, file, bytes: await readFile(file) }); } };
  };

  it('uploads the gz asset, writes its entry with the raw sha256 and fetch time, sets current, and leaves the file restored', async () => {
    const file = join(dir, `${Y}-moduleInfo.json`);
    await writeFile(file, BODY);
    const manifestPath = join(dir, 'corpus.json');
    const dataVersionPath = join(dir, 'data-version.json');
    await writeFile(dataVersionPath, JSON.stringify({ version: await corpusDataVersion(RECORDS, Y) }));
    const u = upload();
    const r = await publishCorpus({ file, fetchedAt: FETCHED, manifestPath, dataVersionPath, dir: join(dir, 'prod'), upload: u.fn, log: () => {}, runsDir: join(dir, 'runs') });
    expect(u.calls).toHaveLength(1);
    expect(u.calls[0].release).toBe(RELEASE);
    expect(gunzipSync(u.calls[0].bytes).toString('utf8')).toBe(BODY);
    const m = await readCorpusManifest(manifestPath);
    expect(m.current).toBe(RELEASE);
    expect(m.corpora[RELEASE]).toEqual({ year: Y, release: RELEASE, asset: `${Y}-moduleInfo.json.gz`, sha256: SHA, bytes: BODY.length, fetchedAt: FETCHED });
    expect(r.entry).toEqual(m.corpora[RELEASE]);
    expect(await readFile(corpusPath({ sha256: SHA }, join(dir, 'prod')), 'utf8')).toBe(BODY);
    expect(await readdir(join(dir, 'runs'))).toHaveLength(1);
  });

  it('refuses a corpus whose data version is not the committed one unless told it is new data, and a release already in the manifest', async () => {
    const file = join(dir, `${Y}-moduleInfo.json`);
    await writeFile(file, BODY);
    const dataVersionPath = join(dir, 'data-version.json');
    await writeFile(dataVersionPath, JSON.stringify({ version: 'ffffffffffff' }));
    const u = upload();
    const base = { file, fetchedAt: FETCHED, manifestPath: join(dir, 'corpus.json'), dataVersionPath, dir: join(dir, 'prod'), upload: u.fn, log: () => {}, runsDir: join(dir, 'runs') };
    await expect(publishCorpus(base)).rejects.toThrow(/data version/);
    expect(u.calls).toEqual([]);
    await publishCorpus({ ...base, newDataVersion: true });
    expect(u.calls).toHaveLength(1);
    await expect(publishCorpus({ ...base, newDataVersion: true })).rejects.toThrow(/already/);
    expect(u.calls).toHaveLength(1);
  });
});

describe('CI: npm run corpus -- check', () => {
  /** @param {string} version @param {string[]} codes */
  async function committed(version, codes) {
    const dataVersionPath = join(dir, 'data-version.json');
    await writeFile(dataVersionPath, JSON.stringify({ version }));
    const cataloguePath = join(dir, 'catalogue-codes.json');
    await writeFile(cataloguePath, JSON.stringify({ source: { moduleInfoSha256: SHA }, codes }));
    return { dataVersionPath, cataloguePath };
  }

  it('recomputes the data version from the asset and HEAD\'s NG files, and the catalogueKey from the asset', async () => {
    const manifestPath = await manifest();
    await mkdir(join(dir, 'prod'));
    await writeFile(corpusPath({ sha256: SHA }, join(dir, 'prod')), BODY);
    const codes = catalogueOnlyRecords(RECORDS).map((r) => r.code);
    expect(codes).toEqual(['AA0999', 'AB0998']);
    const ng = await loadNgCourses(Y);
    const files = await committed(await corpusDataVersion(RECORDS, Y, ng), codes);
    const ok = await checkCurrent({ manifestPath, dir: join(dir, 'prod'), ...files, ngCourses: ng });
    expect(ok).toMatchObject({ ok: true, catalogueKey: { asset: await catalogueKey(codes), file: await catalogueKey(codes) } });
    // The bundled catalogue misses a code: refused.
    const short = await committed(ok.dataVersion.asset, ['AA0999']);
    expect(await checkCurrent({ manifestPath, dir: join(dir, 'prod'), ...short, ngCourses: ng })).toMatchObject({ ok: false });
  });

  it('after an NG edit on the same asset, the recomputed data version moves, so a stale src/data-version.json fails', async () => {
    const manifestPath = await manifest();
    await mkdir(join(dir, 'prod'));
    await writeFile(corpusPath({ sha256: SHA }, join(dir, 'prod')), BODY);
    const ng = await loadNgCourses(Y);
    const before = await corpusDataVersion(RECORDS, Y, ng);
    const files = await committed(before, ['AA0999', 'AB0998']);
    // A Registrar revision that adds AA1001 to Sem 1's list.
    const revised = { ...ng, bySem: new Map([...ng.bySem, ['AA1001', [1]]]), total: ng.total + 1 };
    const r = await checkCurrent({ manifestPath, dir: join(dir, 'prod'), ...files, ngCourses: revised });
    expect(r.ok).toBe(false);
    expect(r.dataVersion.committed).toBe(before);
    expect(r.dataVersion.asset).not.toBe(before);
    expect(r.problems.join('\n')).toMatch(/data version/);
  });
});

describe('ingest reads only current', () => {
  it('refuses with a .data/cache download present and current not restored, and never fetches NUSMods', async () => {
    const cache = join(dir, 'cache');
    await mkdir(cache);
    await writeFile(join(cache, `${Y}-moduleInfo.json`), BODY);
    await writeFile(join(cache, `${Y}-moduleInfo.json.cache.json`), JSON.stringify({ url: 'x', etag: null, lastModified: null, fetchedAt: new Date().toISOString(), sha256: SHA }));
    /** @type {string[]} */
    const asked = [];
    /** @type {string[]} */
    const lines = [];
    const code = await ingestMain(['--url', 'http://127.0.0.1:51998', '--d1-only'], {
      fetchImpl: async (input) => { asked.push(String(input)); return new Response('{}', { status: 500 }); },
      log: (l) => lines.push(l), envVars: { INGEST_SECRET: 's' }, manifestPath: await manifest(), corpusDir: join(dir, 'prod'),
      statePath: join(dir, 'state.json'), dataVersionPath: join(dir, 'dv.json'), runsDir: join(dir, 'runs'),
    }).catch((err) => { lines.push(String(err.message)); return 1; });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/npm run corpus -- restore/);
    expect(asked.filter((u) => u.includes('nusmods'))).toEqual([]);
  });

  it('refuses a restored file whose sha256 is not current\'s', async () => {
    await mkdir(join(dir, 'prod'));
    await writeFile(corpusPath({ sha256: SHA }, join(dir, 'prod')), BODY.replace('AA1002', 'AA1003'));
    /** @type {string[]} */
    const lines = [];
    const code = await ingestMain(['--url', 'http://127.0.0.1:51998'], {
      fetchImpl: async () => new Response('{}', { status: 500 }),
      log: (l) => lines.push(l), envVars: { INGEST_SECRET: 's' }, manifestPath: await manifest(), corpusDir: join(dir, 'prod'),
      statePath: join(dir, 'state.json'), dataVersionPath: join(dir, 'dv.json'), runsDir: join(dir, 'runs'),
    }).catch((err) => { lines.push(String(err.message)); return 1; });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/sha256/);
  });
});

describe('data/corpus.json', () => {
  it('is a valid manifest whose current entry is for DEFAULT_ACAD_YEAR, a prod-* release with a gz asset', async () => {
    const m = await readCorpusManifest();
    const e = currentEntry(m);
    expect(e.year).toBe(Y);
    expect(e.release).toBe(releaseName(Y, e.fetchedAt));
    expect(e.asset).toBe(`${Y}-moduleInfo.json.gz`);
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
