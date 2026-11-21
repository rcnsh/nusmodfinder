// @ts-check
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isCohortOnly } from '../src/cohort-only.js';
import { storedEligibility } from '../src/eligibility.js';

const COHORT_ONLY = JSON.parse(readFileSync(new URL('../data/cohort-only-prereq.json', import.meta.url), 'utf8'));

/**
 * @typedef {{
 *   moduleCode?: string, title?: string, description?: string, moduleCredit?: string | number,
 *   department?: string, faculty?: string, semesterData?: { semester?: unknown, examDate?: string, examDuration?: unknown }[],
 *   workload?: unknown, prerequisite?: string, preclusion?: string,
 *   attributes?: { su?: boolean }, gradingBasisDescription?: string,
 * }} NusModsRecord
 * @typedef {Omit<Awaited<ReturnType<typeof loadNgCourses>>, 'stub' | 'unpublished'> & { stub?: boolean, unpublished?: number[] }} NgCourses
 */

export const DEFAULT_ACAD_YEAR = '2026-2027';
export const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
import { EMBEDDING_TEXT_VERSION } from '../src/embedding-text-version.js';

export { EMBEDDING_TEXT_VERSION };
export { EMBEDDING_DIMS } from '../src/embedding.js';
export const CACHE_DIR = new URL('../.data/cache/', import.meta.url);

export const MAX_BLOB_CHARS = 1900;

export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

export const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;

/** @typedef {{ url: string, etag: string | null, lastModified: string | null, fetchedAt: string, sha256?: string }} CacheSidecar */

/** @param {string} body */
const bodySha256 = (body) => createHash('sha256').update(body).digest('hex');

/**
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

/** @param {number | null} level */
export function levelLabel(level) {
  if (level === 1) return 'introductory';
  if (level === 2 || level === 3) return 'intermediate';
  if (level === 4) return 'advanced';
  if (level !== null && level >= 5 && level <= 8) return 'graduate';
  return null;
}

export const EMBEDDING_TEXT_VARIANTS = /** @type {const} */ ({
  v1: ['code', 'title', 'level', 'description', 'department', 'faculty'],
  v2: ['code', 'title', 'level', 'description'],
  v3: ['title', 'level', 'description', 'department', 'faculty'],
});
/** @typedef {keyof typeof EMBEDDING_TEXT_VARIANTS} EmbeddingTextVariant */

/** @type {EmbeddingTextVariant} */
export const EMBEDDING_TEXT_VARIANT = 'v1';

/**
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

/**
 * @param {string} acadYear
 * @param {{ dataDir?: URL }} [o]
 */
export async function loadNgCourses(acadYear, { dataDir = new URL('../data/', import.meta.url) } = {}) {
  const path = new URL(`ng-courses-${acadYear}.json`, dataDir);
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.stub === true) {
      return { available: false, stub: true, bySem: /** @type {Map<string, number[]>} */ (new Map()), updatedAsAt: null, source: null, total: 0, rules: null, unpublished: /** @type {number[]} */ ([]) };
    }
    /** @type {Map<string, number[]>} */
    const bySem = new Map();
    /** @param {string} sem @param {string[]} codes */
    const add = (sem, codes) => {
      for (const code of codes) {
        if (!bySem.has(code)) bySem.set(code, []);
        /** @type {number[]} */ (bySem.get(code)).push(Number(sem));
      }
    };
    for (const [sem, codes] of /** @type {[string, string[]][]} */ (Object.entries(data.semesters ?? {}))) add(sem, codes);
    const unpublished = unpublishedSemesters(acadYear, dataDir);
    if (unpublished.length) {
      const [a, b] = acadYear.split('-').map(Number);
      const last = `${a - 1}-${b - 1}`;
      /** @type {any} */
      let previous;
      try { previous = JSON.parse(readFileSync(new URL(`ng-courses-${last}.json`, dataDir), 'utf8')); } catch (err) {
        throw new NgRestrictionsMissing(`data/ng-sources-${acadYear}.json marks Sem ${unpublished.join(', ')} unpublished, so exchange mode shows ${last}'s list for it, but data/ng-courses-${last}.json can't be read: ${/** @type {Error} */ (err).message}`);
      }
      for (const s of unpublished) {
        if (data.semesters?.[String(s)]) throw new NgRestrictionsMissing(`data/ng-courses-${acadYear}.json has a Sem ${s} list, but data/ng-sources-${acadYear}.json marks Sem ${s} unpublished`);
        add(String(s), previous.semesters?.[String(s)] ?? []);
      }
    }
    for (const sems of bySem.values()) sems.sort((x, y) => x - y);
    return { available: true, stub: false, bySem, updatedAsAt: data.updatedAsAt, source: data.source ?? null, total: bySem.size, rules: loadNgRestrictions(acadYear, { dataDir }), unpublished };
  } catch (err) {
    if (err instanceof NgRestrictionsMissing) throw err;
    return { available: false, stub: false, bySem: /** @type {Map<string, number[]>} */ (new Map()), updatedAsAt: null, source: null, total: 0, rules: null, unpublished: /** @type {number[]} */ ([]) };
  }
}

/**
 * @param {string} acadYear
 * @param {URL} dataDir
 * @returns {number[]}
 */
function unpublishedSemesters(acadYear, dataDir) {
  /** @type {any} */
  let manifest;
  try { manifest = JSON.parse(readFileSync(new URL(`ng-sources-${acadYear}.json`, dataDir), 'utf8')); } catch { return []; }
  if (manifest.stub === true) return [];
  return [1, 2].filter((s) => manifest.published?.ngList?.[String(s)] === false);
}

class NgRestrictionsMissing extends Error {}

/**
 * @param {string} acadYear
 * @param {{ dataDir?: URL }} [o]
 * @returns {import('../src/eligibility.js').Rules & { updatedAsAt?: Record<string, string> }}
 */
export function loadNgRestrictions(acadYear, { dataDir = new URL('../data/', import.meta.url) } = {}) {
  const path = new URL(`ng-restrictions-${acadYear}.json`, dataDir);
  /** @type {any} */
  let rules;
  try {
    rules = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new NgRestrictionsMissing(`data/ng-restrictions-${acadYear}.json: ${/** @type {Error} */ (err).message}`);
  }
  if (rules.stub === true) throw new NgRestrictionsMissing(`data/ng-restrictions-${acadYear}.json is a stub (year next): build the year's rules first (docs/year-refresh/README.md)`);
  return rules;
}

/**
 * @param {unknown} workload
 * @returns {number | null}
 */
export function workloadHours(workload) {
  if (!Array.isArray(workload) || workload.length === 0) return null;
  let sum = 0;
  for (const x of workload) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) return null;
    sum += x;
  }
  return sum > 0 ? sum : null;
}

/** @param {{ examDate?: unknown }} d */
const hasExam = (d) => typeof d.examDate === 'string' && d.examDate !== '';

/**
 * @param {NusModsRecord} record
 * @param {number[]} semesters
 * @returns {{ sem: number, date: string, durationMins: number | null }[]}
 */
export function examDatesOf(record, semesters) {
  const out = [];
  for (const sem of semesters) {
    const d = (record.semesterData ?? []).find((x) => x.semester === sem && hasExam(x));
    if (!d) continue;
    const mins = d.examDuration;
    out.push({ sem, date: /** @type {string} */ (d.examDate), durationMins: typeof mins === 'number' && Number.isFinite(mins) ? mins : null });
  }
  return out;
}

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
      ng: false,
      ngSemesters: [],
      ngAllow: 0,
      ngRules: null,
      examSemesters: semesters.filter((s) => (record.semesterData ?? []).some((d) => d.semester === s && hasExam(d))),
      examDates: examDatesOf(record, semesters),
      su: record.attributes?.su === true,
      gradingBasis: record.gradingBasisDescription ?? null,
      workloadHours: workloadHours(record.workload),
      prereqNone: record.prerequisite === undefined || record.prerequisite === null,
      prereqCohortOnly: isCohortOnly(record.prerequisite, COHORT_ONLY),
    },
  };
}

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
    const normalised = normalise(record, acadYear);
    if (normalised.skipped !== undefined) { skipped.push({ code: record.moduleCode ?? '<no code>', why: normalised.skipped }); continue; }
    const { module } = normalised;
    if (ngCourses?.available) {
      const sems = ngCourses.bySem.get(module.code);
      if (sems) { module.ng = true; module.ngSemesters = sems; }
      if (ngCourses.unpublished?.length) module.ngUnpublished = ngCourses.unpublished;
      if (!ngCourses.rules) throw new Error('offeredModules: an NG list without restrictions data (loadNgRestrictions)');
      Object.assign(module, storedEligibility(module, ngCourses.rules));
    }
    modules.push(module);
  }
  return { modules, skipped };
}

/**
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

export { vectorMetadata } from '../src/rowhash.js';

/** @param {{ available: boolean, updatedAsAt?: string | null, source?: string | null, total: number }} ngCourses */
export function facetsPayload(ngCourses) {
  return ngCourses.available
    ? { ngList: { updatedAsAt: ngCourses.updatedAsAt ?? null, source: ngCourses.source ?? null, count: ngCourses.total } }
    : { ngList: { updatedAsAt: null, source: null, count: 0 } };
}
