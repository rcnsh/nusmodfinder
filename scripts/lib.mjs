// @ts-check
// Shared helpers for probing, ingesting and evaluating the NUSMods corpus.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
export const EMBEDDING_DIMS = 384;
export const CACHE_DIR = new URL('../.data/', import.meta.url);

// bge-small-en-v1.5 accepts 512 input tokens. ~4 chars/token, kept short of the
// ceiling so the tail of a long description is never silently dropped mid-run.
export const MAX_BLOB_CHARS = 1900;

// NUS codes are 1-4 letters, four digits, then an optional variant suffix of up
// to five alphanumerics. Widened from the plan's `[A-Z]?` after the Phase 1 probe
// found ACC1701XA, DMA1401L01, DMR1201GEQA and LC6009GRSII in the live corpus.
// A query only short-circuits if the code actually exists, so a loose match is safe.
export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

/**
 * @param {string} acadYear
 * @param {string} file
 */
export async function fetchAcadYearFile(acadYear, file) {
  const url = `https://api.nusmods.com/v2/${acadYear}/${file}`;
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = new URL(`${acadYear}-${file}`, CACHE_DIR);
  try {
    const cached = await readFile(cachePath, 'utf8');
    return { data: JSON.parse(cached), bytes: Buffer.byteLength(cached), url, cached: true };
  } catch {
    // not cached yet
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NUSMods returned HTTP ${res.status} for ${url} — is "${acadYear}" a real acad year?`);
  }
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`NUSMods returned non-JSON for ${url} (first 200 bytes: ${body.slice(0, 200)})`);
  }
  await writeFile(cachePath, body);
  return { data, bytes: Buffer.byteLength(body), url, cached: false };
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

/** @param {NusModsRecord} record */
export function embeddingText(record) {
  const blob = [record.title, record.department, record.faculty, record.description]
    .filter((part) => typeof part === 'string' && part.trim())
    .join('. ')
    .replace(/\s+/g, ' ')
    .trim();
  return blob.length > MAX_BLOB_CHARS ? blob.slice(0, MAX_BLOB_CHARS) : blob;
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
    return { available: true, bySem, updatedAsAt: data.updatedAsAt, total: bySem.size };
  } catch {
    return { available: false, bySem: /** @type {Map<string, number[]>} */ (new Map()), updatedAsAt: null, total: 0 };
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
      textHash: hashOf(text),
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

/** @param {NormalisedModule} module */
export function vectorMetadata(module) {
  return {
    code: module.code,
    sem1: module.semesters.includes(1),
    sem2: module.semesters.includes(2),
    sem3: module.semesters.includes(3),
    sem4: module.semesters.includes(4),
    level: module.level,
    credits: module.credits,
    faculty: module.faculty ?? '',
    ng: module.ng === true,
  };
}
