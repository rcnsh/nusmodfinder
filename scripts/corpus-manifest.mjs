// @ts-check
// The corpus manifest (data/corpus.json).
// Each production corpus is a GitHub release asset, `prod-<year>-<yyyymmdd>`,
// holding NUSMods' moduleInfo.json gzipped. The manifest records the asset,
// the raw file's sha256 and when NUSMods served it; `current` names the entry
// ingest, the vectors bundle and every per-corpus file (the vocabulary,
// groups, ng-unscheduled, catalogue and prefix files) read. They read it from
// `.data/prod/<sha256>.json`, sha-checked, never from the `.data/cache`
// download, so a refetch can never split D1 from what the repo records. The
// manifest stores no data version: that depends on the NG files too
// (src/rowhash.js), so it is always recomputed (`checkCurrent`, CI's `corpus
// check`).
//
//   npm run corpus -- fetch [<year>]   NUSMods' moduleInfo.json into .data/staging/
//   npm run corpus -- publish          upload a staged (or --file) corpus, write its entry, set current
//   npm run corpus -- restore          download and sha-check current into .data/prod/<sha256>.json
//   npm run corpus -- check            CI: the data version and catalogueKey of current against HEAD
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { catalogueKey, dataVersion, rowHash } from '../src/rowhash.js';
import { DEFAULT_ACAD_YEAR, assertExpectedShape, catalogueOnlyRecords, loadNgCourses, offeredModules } from './lib.mjs';
import { startRun } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CORPUS_SCHEMA = 'vnm-corpus-manifest/1';
export const CORPUS_MANIFEST_PATH = join(ROOT, 'data/corpus.json');
/** Restored corpora, by raw sha256 (git-ignored). */
export const PROD_DIR = join(ROOT, '.data/prod');
/** `corpus fetch` downloads (git-ignored). */
export const STAGING_DIR = join(ROOT, '.data/staging');
const DATA_VERSION_PATH = join(ROOT, 'src/data-version.json');
const BUNDLED_CATALOGUE = join(ROOT, 'data/catalogue-codes.json');

/**
 * @typedef {{ year: string, release: string, asset: string, sha256: string, bytes: number, fetchedAt: string }} CorpusEntry
 * @typedef {{ schema: string, current: string, corpora: Record<string, CorpusEntry> }} CorpusManifest
 * @typedef {(release: string, asset: string, destDir: string) => Promise<void>} Download
 *   Writes the release's asset into destDir (as `gh release download` does).
 * @typedef {(release: string, file: string, o: { title: string, notes: string }) => Promise<void>} Upload
 *   Creates the release with the file as its asset (as `gh release create` does).
 */

/** @param {Buffer | string} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** `prod-<year>-<UTC yyyymmdd of the fetch>`. @param {string} year @param {string} fetchedAt */
export function releaseName(year, fetchedAt) {
  const t = new Date(fetchedAt);
  if (Number.isNaN(t.getTime())) throw new Error(`not a time: "${fetchedAt}"`);
  return `prod-${year}-${t.toISOString().slice(0, 10).replaceAll('-', '')}`;
}

/** The asset's file name in its release. @param {string} year */
export const assetName = (year) => `${year}-moduleInfo.json.gz`;

/** Where a restored corpus lives. @param {{ sha256: string }} entry @param {string} [dir] */
export const corpusPath = (entry, dir = PROD_DIR) => join(dir, `${entry.sha256}.json`);

/**
 * @param {string} [path]
 * @returns {Promise<CorpusManifest>}
 */
export async function readCorpusManifest(path = CORPUS_MANIFEST_PATH) {
  const m = JSON.parse(await readFile(path, 'utf8'));
  if (m?.schema !== CORPUS_SCHEMA || typeof m.corpora !== 'object' || m.corpora === null) {
    throw new Error(`${path} is not a ${CORPUS_SCHEMA} manifest`);
  }
  return m;
}

/** @param {CorpusManifest} m @returns {CorpusEntry} */
export function currentEntry(m) {
  const e = m.corpora[m.current];
  if (!e) throw new Error(`the corpus manifest's current, "${m.current}", has no entry`);
  for (const k of /** @type {const} */ (['year', 'release', 'asset', 'sha256', 'fetchedAt'])) {
    if (typeof e[k] !== 'string' || !e[k]) throw new Error(`the corpus manifest's current entry has no ${k}`);
  }
  if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`the corpus manifest's current sha256 is not a sha256: ${e.sha256}`);
  return e;
}

/**
 * `current`, read from `.data/prod/<sha256>.json` and sha-checked. Refuses a missing file (naming
 * `corpus restore`), a sha256 that is not current's, and a current entry for another year than
 * DEFAULT_ACAD_YEAR (one year source).
 * @param {{ manifestPath?: string, dir?: string, year?: string }} [o]
 * @returns {Promise<{ entry: CorpusEntry, records: import('./lib.mjs').NusModsRecord[], path: string }>}
 */
export async function loadCurrentCorpus({ manifestPath = CORPUS_MANIFEST_PATH, dir = PROD_DIR, year = DEFAULT_ACAD_YEAR } = {}) {
  const entry = currentEntry(await readCorpusManifest(manifestPath));
  if (entry.year !== year) {
    throw new Error(`the corpus manifest's current corpus (${entry.release}) is for ${entry.year}, but DEFAULT_ACAD_YEAR is ${year}. `
      + 'Publish a corpus for this year (npm run corpus -- fetch, then publish) or fix the manifest.');
  }
  const path = corpusPath(entry, dir);
  /** @type {Buffer} */
  let raw;
  try {
    raw = await readFile(path);
  } catch {
    throw new Error(`the current corpus (${entry.release}) is not restored at ${path}. Run: npm run corpus -- restore`);
  }
  const got = sha256(raw);
  if (got !== entry.sha256) {
    throw new Error(`${path} has sha256 ${got}, not current's ${entry.sha256} (${entry.release}). Delete it and run: npm run corpus -- restore`);
  }
  const records = JSON.parse(raw.toString('utf8'));
  assertExpectedShape(records);
  return { entry, records, path };
}

/**
 * The data version of the rows ingest would write from these records, with HEAD's NG files for
 * the year unless `ngCourses` is given.
 * @param {import('./lib.mjs').NusModsRecord[]} records
 * @param {string} year
 * @param {import('./lib.mjs').NgCourses} [ngCourses]
 */
export async function corpusDataVersion(records, year, ngCourses) {
  const { modules } = offeredModules(records, year, ngCourses ?? await loadNgCourses(year));
  return dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));
}

/**
 * `current`, normalised as ingest normalises it: HEAD's NG files for its year.
 * @param {{ manifestPath?: string, dir?: string }} [o]
 */
export async function productionCorpus(o = {}) {
  const { entry, records, path } = await loadCurrentCorpus(o);
  const ngCourses = await loadNgCourses(entry.year);
  const { modules, skipped } = offeredModules(records, entry.year, ngCourses);
  return { entry, path, acadYear: entry.year, records, modules, skipped, ngCourses };
}

/** @type {Download} */
async function ghDownload(release, asset, destDir) {
  const r = spawnSync('gh', ['release', 'download', release, '--pattern', asset, '--dir', destDir, '--clobber'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`gh release download ${release} --pattern ${asset} failed (exit ${r.status})`);
}

/** @type {Upload} */
async function ghUpload(release, file, { title, notes }) {
  const r = spawnSync('gh', ['release', 'create', release, file, '--title', title, '--notes', notes], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`gh release create ${release} failed (exit ${r.status})`);
}

/**
 * Makes `current` available in this worktree: downloads its asset (unless the restored file is
 * already there and right), gunzips it, checks the raw sha256 and writes `.data/prod/<sha256>.json`.
 * A wrong sha256 writes nothing.
 * @param {{ manifestPath?: string, dir?: string, download?: Download, log?: (line: string) => void }} [o]
 * @returns {Promise<string>} the restored file
 */
export async function restoreCurrent({ manifestPath = CORPUS_MANIFEST_PATH, dir = PROD_DIR, download = ghDownload, log = console.log } = {}) {
  return restoreEntry(currentEntry(await readCorpusManifest(manifestPath)), { dir, download, log });
}

/**
 * Any manifest entry (smoke's: the expected commit's `current`) into `<dir>/<sha256>.json`,
 * sha-checked; a no-op when it is already there.
 * @param {CorpusEntry} entry
 * @param {{ dir?: string, download?: Download, log?: (line: string) => void }} [o]
 * @returns {Promise<string>} the restored file's path
 */
export async function restoreEntry(entry, { dir = PROD_DIR, download = ghDownload, log = console.log } = {}) {
  const path = corpusPath(entry, dir);
  if (existsSync(path) && sha256(await readFile(path)) === entry.sha256) {
    log(`corpus: ${entry.release} is restored at ${path}`);
    return path;
  }
  const tmp = await mkdtemp(join(tmpdir(), 'vnm-corpus-'));
  try {
    log(`corpus: downloading ${entry.release} (${entry.asset})`);
    await download(entry.release, entry.asset, tmp);
    const raw = gunzipSync(await readFile(join(tmp, entry.asset)));
    const got = sha256(raw);
    if (got !== entry.sha256) throw new Error(`${entry.release}/${entry.asset} unpacks to sha256 ${got}, not the manifest's ${entry.sha256}; nothing written`);
    await mkdir(dir, { recursive: true });
    await writeFile(`${path}.tmp`, raw);
    await rename(`${path}.tmp`, path);
    log(`corpus: restored ${entry.release} to ${path} (sha256 ${got.slice(0, 12)}, ${raw.length} bytes)`);
    return path;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * NUSMods' moduleInfo.json for a year into `.data/staging/`, with a sidecar recording when it
 * was served and its sha256 (what `publish` reads). The only command that contacts NUSMods.
 * @param {string} year
 * @param {{ fetchImpl?: typeof fetch, dir?: string, now?: () => Date, log?: (line: string) => void }} [o]
 */
export async function fetchStaging(year, { fetchImpl = fetch, dir = STAGING_DIR, now = () => new Date(), log = console.log } = {}) {
  if (!/^\d{4}-\d{4}$/.test(year)) throw new Error(`not an acad year: "${year}" (e.g. ${DEFAULT_ACAD_YEAR})`);
  const url = `https://api.nusmods.com/v2/${year}/moduleInfo.json`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`NUSMods returned HTTP ${res.status} for ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  assertExpectedShape(JSON.parse(body.toString('utf8')));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${year}-moduleInfo.json`);
  await writeFile(path, body);
  const sidecar = { url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetchedAt: now().toISOString(), sha256: sha256(body) };
  await writeFile(`${path}.cache.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
  log(`corpus: fetched ${url} to ${path} (${body.length} bytes, sha256 ${sidecar.sha256.slice(0, 12)})`);
  return { path, ...sidecar };
}

/**
 * Publishes a corpus: refuses one whose data version (with HEAD's NG files) is not the committed
 * src/data-version.json unless `newDataVersion` (a refresh whose data moves; ingest and the bundle
 * follow), and a release the manifest already has. Uploads the gz asset, writes the entry, sets
 * `current`, and leaves the corpus restored here. Writes a run record.
 * @param {{ file?: string, fetchedAt?: string, year?: string, manifestPath?: string, dataVersionPath?: string, dir?: string,
 *   upload?: Upload, log?: (line: string) => void, runsDir?: string, newDataVersion?: boolean, args?: string[] }} [o]
 * @returns {Promise<{ entry: CorpusEntry, dataVersion: string }>}
 */
export async function publishCorpus(o = {}) {
  const {
    year = DEFAULT_ACAD_YEAR, manifestPath = CORPUS_MANIFEST_PATH, dataVersionPath = DATA_VERSION_PATH, dir = PROD_DIR,
    upload = ghUpload, log = console.log, runsDir, newDataVersion = false, args = [],
  } = o;
  const file = o.file ?? join(STAGING_DIR, `${year}-moduleInfo.json`);
  const raw = await readFile(file);
  const records = JSON.parse(raw.toString('utf8'));
  assertExpectedShape(records);
  const sidecar = JSON.parse(await readFile(`${file}.cache.json`, 'utf8').catch(() => '{}'));
  // The file's own year, from the URL `corpus fetch` recorded or its name: a corpus is never
  // published under another year (ingest would write its rows as that year).
  const ownYear = /\/v2\/(\d{4}-\d{4})\//.exec(String(sidecar.url ?? ''))?.[1] ?? /(?:^|[^\d])(\d{4}-\d{4})-moduleInfo\.json$/.exec(basename(file))?.[1];
  if (ownYear && ownYear !== year) {
    throw new Error(`${basename(file)} is NUSMods' ${ownYear} corpus, not ${year}'s. Nothing published. For a new acad year, change DEFAULT_ACAD_YEAR `
      + '(scripts/lib.mjs, the one year source) first, then fetch and publish.');
  }
  const fetchedAt = o.fetchedAt ?? sidecar.fetchedAt;
  if (typeof fetchedAt !== 'string') throw new Error(`no fetch time for ${file}: pass --fetched-at <ISO time>, or publish a file \`corpus fetch\` staged (its .cache.json records it)`);
  const release = releaseName(year, fetchedAt);
  /** @type {CorpusManifest} */
  const manifest = existsSync(manifestPath) ? await readCorpusManifest(manifestPath) : { schema: CORPUS_SCHEMA, current: '', corpora: {} };
  if (manifest.corpora[release]) throw new Error(`the corpus manifest already has ${release}; a release is never replaced`);
  const dv = await corpusDataVersion(records, year);
  const committed = String(JSON.parse(await readFile(dataVersionPath, 'utf8')).version);
  log(`corpus: ${basename(file)} -> ${release}: data version ${dv} with HEAD's NG files; src/data-version.json says ${committed}`);
  if (dv !== committed && !newDataVersion) {
    throw new Error(`the corpus's data version ${dv} is not the committed ${committed}. Nothing published. Pass --new-data-version for a refresh whose `
      + 'data moves (then rebuild the bundle and the per-corpus files from it, and ingest it).');
  }
  const entry = { year, release, asset: assetName(year), sha256: sha256(raw), bytes: raw.length, fetchedAt };
  const record = startRun('corpus publish', { target: `GitHub release ${release}`, args, dir: runsDir });
  const tmp = await mkdtemp(join(tmpdir(), 'vnm-publish-'));
  try {
    const gz = join(tmp, entry.asset);
    await writeFile(gz, gzipSync(raw, { level: 9 }));
    record.request('gh release create');
    await upload(release, gz, {
      title: `Production corpus ${year}, fetched ${fetchedAt}`,
      notes: `NUSMods moduleInfo.json for ${year}, as api.nusmods.com served it at ${fetchedAt}. Raw sha256 ${entry.sha256}. `
        + 'Recorded in data/corpus.json. The data is NUSMods\'; see ADR 0014 "Republishing NUSMods data".',
    });
    record.wrote('GitHub release asset', { actual: 1 });
    record.version('release', release);
    record.version('dataVersion', dv);
    manifest.corpora[release] = entry;
    manifest.current = release;
    manifest.corpora = Object.fromEntries(Object.entries(manifest.corpora).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(manifestPath, `${JSON.stringify({ schema: CORPUS_SCHEMA, current: manifest.current, corpora: manifest.corpora }, null, 2)}\n`);
    await mkdir(dir, { recursive: true });
    await writeFile(corpusPath(entry, dir), raw);
    record.finish('ok', { exitCode: 0 });
    log(`corpus: published ${release} (${entry.asset}); data/corpus.json current is ${release}. Commit data/corpus.json.`);
    return { entry, dataVersion: dv };
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * CI's check of `current` against HEAD: the data version of the rows ingest would write from the
 * asset with HEAD's NG files must be src/data-version.json, and the catalogueKey of the asset's
 * catalogue-only codes must be the bundled catalogue file's, built from this asset. A mid-year NG
 * revision on the same asset moves the data version, so it fails until src/data-version.json follows.
 * @param {{ manifestPath?: string, dir?: string, dataVersionPath?: string, cataloguePath?: string,
 *   ngCourses?: import('./lib.mjs').NgCourses }} [o]
 */
export async function checkCurrent(o = {}) {
  const { manifestPath, dir, dataVersionPath = DATA_VERSION_PATH, cataloguePath = BUNDLED_CATALOGUE } = o;
  const { entry, records } = await loadCurrentCorpus({ ...(manifestPath ? { manifestPath } : {}), ...(dir ? { dir } : {}) });
  const asset = await corpusDataVersion(records, entry.year, o.ngCourses);
  const committed = String(JSON.parse(await readFile(dataVersionPath, 'utf8')).version);
  const file = JSON.parse(await readFile(cataloguePath, 'utf8'));
  const keys = { asset: await catalogueKey(catalogueOnlyRecords(records).map((r) => r.code)), file: await catalogueKey(file.codes ?? []) };
  /** @type {string[]} */
  const problems = [];
  if (asset !== committed) problems.push(`data version: ${entry.release} with HEAD's NG files gives ${asset}, src/data-version.json says ${committed}`);
  if (keys.asset !== keys.file) problems.push(`catalogueKey: ${entry.release}'s catalogue-only codes give ${keys.asset}, the bundled catalogue file's ${keys.file}`);
  const fileSha = file.source?.moduleInfoSha256;
  if (fileSha !== undefined && fileSha !== entry.sha256) problems.push(`the bundled catalogue file was built from corpus ${String(fileSha).slice(0, 12)}…, not current's ${entry.sha256.slice(0, 12)}…`);
  return { ok: problems.length === 0, release: entry.release, dataVersion: { asset, committed }, catalogueKey: keys, problems };
}
