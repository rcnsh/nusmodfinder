// @ts-check
// Shared helpers for probing, ingesting and evaluating the NUSMods corpus.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * The fields of a NUSMods v2 moduleInfo record this code reads.
 * @typedef {{
 *   moduleCode?: string, title?: string, description?: string, moduleCredit?: string | number,
 *   department?: string, faculty?: string, semesterData?: { semester?: unknown }[],
 *   workload?: unknown, prerequisite?: string, preclusion?: string,
 * }} NusModsRecord
 * @typedef {Awaited<ReturnType<typeof loadNgCourses>>} NgCourses
 */

export const DEFAULT_ACAD_YEAR = '2026-2027';
export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
/**
 * Bump when embeddingText() changes, so text_hash changes and every module is
 * re-embedded once (FINDINGS B2: text_hash = hash(model + this + text)).
 */
export const EMBEDDING_TEXT_VERSION = 2;
export { EMBEDDING_DIMS } from '../src/embedding.js';
// NUSMods downloads. Not .data/ itself: .data/<year>-moduleInfo.json is the
// pinned snapshot the eval and full-corpus tests read (scripts/pinned-corpus.mjs).
export const CACHE_DIR = new URL('../.data/cache/', import.meta.url);

// bge-small-en-v1.5 accepts 512 input tokens. ~4 chars/token, kept short of the
// ceiling so the tail of a long description is never silently dropped mid-run.
export const MAX_BLOB_CHARS = 1900;

// NUS codes are 1-4 letters, four digits, then an optional variant suffix of up
// to five alphanumerics. Widened from the plan's `[A-Z]?` after the Phase 1 probe
// found ACC1701XA, DMA1401L01, DMR1201GEQA and LC6009GRSII in the live corpus.
// A query only short-circuits if the code actually exists, so a loose match is safe.
export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

/** How long a .data/ entry is used without asking NUSMods whether it changed (`--max-age`). */
export const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;

/**
 * Sidecar stored next to each .data/ entry (`<entry>.cache.json`): the
 * validators NUSMods sent with it, when it was last fetched or revalidated,
 * and the sha256 of the body it vouches for.
 * @typedef {{ url: string, etag: string | null, lastModified: string | null, fetchedAt: string, sha256?: string }} CacheSidecar
 */

/** @param {string} body */
const bodySha256 = (body) => createHash('sha256').update(body).digest('hex');

/**
 * Fetches `https://api.nusmods.com/v2/<acadYear>/<file>` through the .data/
 * cache (FINDINGS B2: the cache used to be served however old it was).
 * - An entry younger than `maxAgeMs` (by its sidecar's `fetchedAt`) is used
 *   without a request.
 * - Otherwise it is revalidated: a conditional GET with `If-None-Match` /
 *   `If-Modified-Since` from the sidecar. 304 keeps the body and refreshes
 *   `fetchedAt`; 200 replaces body and sidecar. An entry with no sidecar
 *   (written before sidecars existed) is fetched unconditionally.
 * - `offline` uses the entry however old and never fetches.
 * - The sidecar's sha256 must match the body. If it does not (a truncated or
 *   edited file, or a sidecar from before the hash was recorded), the entry is
 *   ignored: a full GET with no validators, so a 304 cannot bless the bad
 *   body. `offline` refuses a mismatching body; with no sidecar hash at all
 *   it uses the body as it is.
 * A failed revalidation is an error, never a silent stale read; pass
 * `offline` to use the stale copy deliberately.
 * @param {string} acadYear
 * @param {string} file
 * @param {{ offline?: boolean, maxAgeMs?: number, cacheDir?: URL, fetchImpl?: typeof fetch, now?: () => number }} [options]
 */
export async function fetchAcadYearFile(acadYear, file, options = {}) {
  const { offline = false, maxAgeMs = DEFAULT_MAX_AGE_MS, cacheDir = CACHE_DIR, fetchImpl = fetch, now = Date.now } = options;
  const url = `https://api.nusmods.com/v2/${acadYear}/${file}`;
  await mkdir(cacheDir, { recursive: true });
  const cachePath = new URL(`${acadYear}-${file}`, cacheDir);
  const sidecarPath = new URL(`${acadYear}-${file}.cache.json`, cacheDir);
  /** @type {string | null} */
  const onDisk = await readFile(cachePath, 'utf8').catch(() => null);
  /** @type {CacheSidecar | null} */
  const sidecar = await readFile(sidecarPath, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const ageMs = sidecar ? now() - Date.parse(sidecar.fetchedAt) : null;
  /** @param {string} body @param {boolean} revalidated */
  const fromCache = (body, revalidated) =>
    ({ data: parseJson(body, cachePath.pathname), bytes: Buffer.byteLength(body), url, cached: true, revalidated, ageMs });
  const vouched = onDisk !== null && sidecar?.sha256 === bodySha256(onDisk);

  if (offline) {
    if (onDisk === null) throw new Error(`--offline: no cached copy of ${url} at ${cachePath.pathname}`);
    if (sidecar?.sha256 && !vouched) {
      throw new Error(`--offline: ${cachePath.pathname} does not match the sha256 its sidecar recorded (truncated or edited?). `
        + 'Rerun without --offline to download it again.');
    }
    return fromCache(onDisk, false);
  }
  // Only a body its sidecar vouches for is served or revalidated.
  const cached = vouched ? onDisk : null;
  if (cached !== null && ageMs !== null && ageMs >= 0 && ageMs < maxAgeMs) return fromCache(cached, false);

  /** @type {Record<string, string>} */
  const headers = {};
  if (cached !== null && sidecar?.etag) headers['if-none-match'] = sidecar.etag;
  if (cached !== null && sidecar?.lastModified) headers['if-modified-since'] = sidecar.lastModified;
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    throw new Error(`Could not revalidate ${url} (${/** @type {Error} */ (err).message}). Pass --offline to use the cached copy as it is.`, { cause: err });
  }
  const stamp = new Date(now()).toISOString();
  if (res.status === 304 && cached !== null) {
    /** @type {CacheSidecar} */
    const next = { url, etag: res.headers.get('etag') ?? sidecar?.etag ?? null,
      lastModified: res.headers.get('last-modified') ?? sidecar?.lastModified ?? null, fetchedAt: stamp, sha256: bodySha256(cached) };
    await writeFile(sidecarPath, `${JSON.stringify(next, null, 2)}\n`);
    return fromCache(cached, true);
  }
  if (!res.ok) {
    throw new Error(`NUSMods returned HTTP ${res.status} for ${url} — is "${acadYear}" a real acad year? Pass --offline to use the cached copy.`);
  }
  const body = await res.text();
  const data = parseJson(body, url);
  // Body first, then the sidecar that vouches for it, each replaced atomically.
  await writeFile(new URL(`${cachePath.href}.tmp`), body);
  await rename(new URL(`${cachePath.href}.tmp`), cachePath);
  /** @type {CacheSidecar} */
  const next = { url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetchedAt: stamp, sha256: bodySha256(body) };
  await writeFile(sidecarPath, `${JSON.stringify(next, null, 2)}\n`);
  return { data, bytes: Buffer.byteLength(body), url, cached: false, revalidated: cached !== null, ageMs: 0 };
}

/** @param {string} body @param {string} where */
function parseJson(body, where) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`non-JSON in ${where} (first 200 bytes: ${body.slice(0, 200)})`);
  }
}

const REQUIRED_KEYS = ['moduleCode', 'title', 'description', 'moduleCredit', 'faculty', 'semesterData'];

// Aborts rather than writing malformed rows if NUSMods changes shape (L6).
/** @param {unknown} records */
export function assertExpectedShape(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('moduleInfo.json was not a non-empty array');
  }
  const sample = records.slice(0, 50);
  for (const key of REQUIRED_KEYS) {
    if (!sample.some((r) => key in r)) {
      throw new Error(`None of the first 50 module records carry "${key}" — the NUSMods v2 shape has changed.`);
    }
  }
}

/** @param {string} moduleCode */
export function levelOf(moduleCode) {
  const digit = moduleCode.match(/\d/);
  return digit ? Number(digit[0]) : null;
}

/**
 * @param {NusModsRecord} record
 * @returns {number[]}
 */
export function semestersOf(record) {
  const sems = /** @type {number[]} */ ((record.semesterData ?? [])
    .map((s) => s.semester)
    .filter((s) => Number.isInteger(s)));
  return [...new Set(sems)].sort((a, b) => a - b);
}

/**
 * The level label in 3A-2's embedding text (docs/plans/phase3-prereg.md §2,
 * eval/prereg/grids.json `3A-2`.levelLabels; level 8 is choice C24). Levels
 * with no label (0, 9, none) get null and the Level field is left out.
 * @param {number | null} level
 */
export function levelLabel(level) {
  if (level === 1) return 'introductory';
  if (level === 2 || level === 3) return 'intermediate';
  if (level === 4) return 'advanced';
  if (level !== null && level >= 5 && level <= 8) return 'graduate';
  return null;
}

/**
 * 3A-2's pre-registered embedding texts (docs/plans/phase3.md 3A-2,
 * eval/prereg/grids.json `3A-2`.variants): the fields, in order.
 */
export const EMBEDDING_TEXT_VARIANTS = /** @type {const} */ ({
  v1: ['code', 'title', 'level', 'description', 'department', 'faculty'],
  v2: ['code', 'title', 'level', 'description'],
  v3: ['title', 'level', 'description', 'department', 'faculty'],
});
/** @typedef {keyof typeof EMBEDDING_TEXT_VARIANTS} EmbeddingTextVariant */

/**
 * The 3A-2 variant embeddingText() builds (EMBEDDING_TEXT_VERSION 2). Each
 * 3A-2 ref (tags 3a2-v1…v3) differs from the next only here, so the ranker
 * tree hash names the text the eval scored.
 * @type {EmbeddingTextVariant}
 */
export const EMBEDDING_TEXT_VARIANT = 'v1';

/**
 * A 3A-2 variant's text. Each field is whitespace-collapsed and ends with one
 * sentence mark: a "." is added unless it already ends in ".", "!" or "?", so
 * a description's own full stop is not doubled. Empty fields are skipped; the
 * whole is cut at MAX_BLOB_CHARS.
 * @param {NusModsRecord} record
 * @param {EmbeddingTextVariant} variant
 */
export function embeddingTextFor(record, variant) {
  const fields = EMBEDDING_TEXT_VARIANTS[variant];
  if (!fields) throw new Error(`unknown embedding text variant "${variant}"`);
  const level = typeof record.moduleCode === 'string' ? levelOf(record.moduleCode) : null;
  const label = levelLabel(level);
  /** @type {Record<(typeof fields)[number], unknown>} */
  const value = {
    code: record.moduleCode,
    title: record.title,
    level: label ? `Level ${level} (${label})` : null,
    description: record.description,
    department: record.department,
    faculty: record.faculty,
  };
  const blob = fields
    .map((f) => value[f])
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => {
      const s = /** @type {string} */ (part).replace(/\s+/g, ' ').trim();
      return /[.!?]$/.test(s) ? s : `${s}.`;
    })
    .join(' ');
  return blob.length > MAX_BLOB_CHARS ? blob.slice(0, MAX_BLOB_CHARS) : blob;
}

/** @param {NusModsRecord} record */
export function embeddingText(record) {
  return embeddingTextFor(record, EMBEDDING_TEXT_VARIANT);
}

/** @param {string} text */
export function hashOf(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

// Non-Graduating (exchange student) availability. NUS publishes this only as a
// PDF, so it is extracted by scripts/extract-ng.py into a committed artifact
// rather than fetched. Absent file => no NG data, and every module is marked
// unknown rather than silently false.
/** @param {string} acadYear */
export async function loadNgCourses(acadYear) {
  const path = new URL(`../data/ng-courses-${acadYear}.json`, import.meta.url);
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    /** @type {Map<string, number[]>} */
    const bySem = new Map();
    for (const [sem, codes] of /** @type {[string, string[]][]} */ (Object.entries(data.semesters ?? {}))) {
      for (const code of codes) {
        if (!bySem.has(code)) bySem.set(code, []);
        /** @type {number[]} */ (bySem.get(code)).push(Number(sem));
      }
    }
    for (const sems of bySem.values()) sems.sort((a, b) => a - b);
    return { available: true, bySem, updatedAsAt: data.updatedAsAt, source: data.source ?? null, total: bySem.size };
  } catch {
    return { available: false, bySem: /** @type {Map<string, number[]>} */ (new Map()), updatedAsAt: null, source: null, total: 0 };
  }
}

// One normalised module. `skipped` explains why a record was dropped (R2).
/**
 * @param {NusModsRecord} record
 * @param {string} acadYear
 * @returns {{ skipped: string, module?: undefined } | { module: NormalisedModule, skipped?: undefined }}
 */
export function normalise(record, acadYear) {
  const code = record.moduleCode;
  if (!code || typeof code !== 'string') return { skipped: 'missing moduleCode' };
  if (!record.title?.trim()) return { skipped: 'missing title' };
  if (!record.description?.trim()) return { skipped: 'missing description' };

  const semesters = semestersOf(record);
  const credits = Number(record.moduleCredit);
  const text = embeddingText(record);
  // The vector depends on the model and on how the text was built, not only
  // on the text: a model switch or embeddingText() change must re-embed.
  const textHash = hashOf(JSON.stringify([EMBEDDING_MODEL, EMBEDDING_TEXT_VERSION, text]));

  return {
    module: {
      code,
      title: record.title.trim(),
      description: record.description.trim(),
      credits: Number.isFinite(credits) ? credits : null,
      department: record.department ?? null,
      faculty: record.faculty ?? null,
      level: levelOf(code),
      semesters,
      workload: record.workload ? JSON.stringify(record.workload) : null,
      prerequisite: record.prerequisite ?? null,
      preclusion: record.preclusion ?? null,
      acadYear,
      text,
      textHash,
      // Filled in by offeredModules() when an NG list is present.
      ng: false,
      ngSemesters: [],
    },
  };
}

// Only modules actually offered this acad year are indexed. moduleInfo.json
// carries the whole historical catalogue; see PHASE1.md for the sizing reason.
/**
 * @param {NusModsRecord[]} records
 * @param {string} acadYear
 * @param {NgCourses | null} [ngCourses]
 */
export function offeredModules(records, acadYear, ngCourses = null) {
  /** @type {NormalisedModule[]} */
  const modules = [];
  /** @type {{ code: string, why: string }[]} */
  const skipped = [];
  for (const record of records) {
    if (semestersOf(record).length === 0) continue;
    // `skipped` is set exactly when `module` is not, which tsc cannot follow through the destructure.
    const { module, skipped: why } = /** @type {{ module: NormalisedModule, skipped?: string }} */ (normalise(record, acadYear));
    if (why) { skipped.push({ code: record.moduleCode ?? '<no code>', why }); continue; }
    if (ngCourses?.available) {
      const sems = ngCourses.bySem.get(module.code);
      if (sems) { module.ng = true; module.ngSemesters = sems; }
    }
    modules.push(module);
  }
  return { modules, skipped };
}

/**
 * The catalogue-only codes (3B, C-7): records in moduleInfo.json with no
 * offering this acad year, with their title and description, for noMatch
 * `not-offered` (D1 `catalogue_only`, migrations/0008_catalogue.sql). A record
 * without a code or title is left out; a missing description is null.
 * @param {NusModsRecord[]} records
 * @returns {{ code: string, title: string, description: string | null }[]}
 */
export function catalogueOnlyRecords(records) {
  /** @type {{ code: string, title: string, description: string | null }[]} */
  const out = [];
  for (const r of records) {
    if (semestersOf(r).length > 0) continue;
    if (typeof r.moduleCode !== 'string' || !r.moduleCode || !r.title?.trim()) continue;
    out.push({ code: r.moduleCode, title: r.title.trim(), description: r.description?.trim() || null });
  }
  return out;
}

// The Vectorize metadata and row hash are shared with the Worker.
export { vectorMetadata } from '../src/rowhash.js';

/**
 * The /admin/facets body. Always carries ngList, so an ingest without the NG
 * list overwrites a stale meta.ng_list instead of leaving its old date.
 * @param {{ available: boolean, updatedAsAt?: string | null, source?: string | null, total: number }} ngCourses
 */
export function facetsPayload(ngCourses) {
  return ngCourses.available
    ? { ngList: { updatedAsAt: ngCourses.updatedAsAt ?? null, source: ngCourses.source ?? null, count: ngCourses.total } }
    : { ngList: { updatedAsAt: null, source: null, count: 0 } };
}
