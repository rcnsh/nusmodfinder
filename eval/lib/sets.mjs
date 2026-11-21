// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, assertInManifest, decrypt, readKey } from './crypto.mjs';

export const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/**
 * @typedef {{
 *   name: string, dir: string, runsDir: string, encrypted: boolean,
 *   maxLooks: number, ledger: string | null, retiredLog: string | null, countLog: string | null, perQueryOutput: boolean, gate: 'dev' | 'holdout' | 'test',
 * }} SetLayout
 */

export const LEDGER = 'eval/holdout-ledger.md';
export const RETIRED_LOG = 'eval/retired-runs.md';
export const COUNT_LOG = 'eval/count-log.md';

/** @type {Record<string, Omit<SetLayout, 'name' | 'ledger' | 'retiredLog' | 'countLog'> & { ledger: string | null | 'in-dir' }>} */
const LAYOUTS = {
  dev: { dir: 'eval/dev', runsDir: 'eval/runs', encrypted: false, maxLooks: Infinity, ledger: null, perQueryOutput: true, gate: 'dev' },
  fixture: { dir: 'eval/fixtures', runsDir: '.eval-work/runs', encrypted: false, maxLooks: Infinity, ledger: null, perQueryOutput: true, gate: 'dev' },
  holdout: { dir: 'eval/holdout', runsDir: 'eval/holdout', encrypted: true, maxLooks: 12, ledger: LEDGER, perQueryOutput: false, gate: 'holdout' },
  test: { dir: 'eval/sealed', runsDir: 'eval/sealed', encrypted: true, maxLooks: 1, ledger: LEDGER, perQueryOutput: false, gate: 'test' },
  selftest: { dir: '.eval-work/selftest/holdout', runsDir: '.eval-work/selftest/holdout/runs', encrypted: true, maxLooks: 12, ledger: 'in-dir', perQueryOutput: false, gate: 'holdout' },
};

export const ENCRYPTED_SETS = Object.keys(LAYOUTS).filter((k) => LAYOUTS[k].encrypted);

export const SET_NAMES = Object.keys(LAYOUTS);

/**
 * @param {string} name
 * @param {string | undefined} [dirOverride]
 * @returns {SetLayout}
 */
export function layout(name, dirOverride) {
  const base = LAYOUTS[name];
  if (!base) throw new Error(`unknown set "${name}"; expected one of ${SET_NAMES.join(', ')}`);
  const dir = dirOverride ?? join(REPO, base.dir);
  const runsDir = dirOverride ? join(dirOverride, 'runs') : join(REPO, base.runsDir);
  /** @type {string | null} */
  let ledger = null;
  /** @type {string | null} */
  let retiredLog = null;
  /** @type {string | null} */
  let countLog = null;
  if (base.ledger === 'in-dir') {
    ledger = join(dir, 'ledger.md');
    retiredLog = join(dir, 'retired-runs.md');
    countLog = join(dir, 'count-log.md');
  } else if (base.ledger) {
    ledger = join(REPO, base.ledger);
    retiredLog = join(REPO, RETIRED_LOG);
    countLog = join(REPO, COUNT_LOG);
  }
  return { name, ...base, dir, runsDir, ledger, retiredLog, countLog };
}

/**
 * @param {SetLayout} set
 * @param {string} file
 */
export const setFile = (set, file) => join(set.dir, set.encrypted ? `${file}.enc` : file);

/** @param {SetLayout} set @param {string} variant */
export const runFile = (set, variant) => {
  if (!/^[A-Za-z0-9._-]+$/.test(variant)) throw new Error(`variant name "${variant}" may only use letters, digits, ".", "_" and "-"`);
  return join(set.runsDir, set.encrypted ? `run-${variant}.json.enc` : `${variant}.json`);
};

/** @type {Map<string, Buffer>} */
const keys = new Map();
export async function setKey() {
  const k = process.env.VNM_HOLDOUT_KEY_FILE ?? '';
  if (!keys.has(k)) keys.set(k, await readKey());
  return /** @type {Buffer} */ (keys.get(k));
}

/** @typedef {{ verify?: boolean }} ReadOptions */

/**
 * @param {SetLayout} set
 * @param {string} path
 * @param {ReadOptions} [options]
 */
export async function readSetJson(set, path, options = {}) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const bytes = await readFile(path);
  if (!set.encrypted) return JSON.parse(bytes.toString('utf8'));
  if (options.verify) await assertInManifest(set.dir, path, bytes);
  return JSON.parse(decrypt(bytes, await setKey(), path, set.name).toString('utf8'));
}

/**
 * @param {SetLayout} set
 * @param {string} path
 */
export async function assertPlainManifest(set, path) {
  if (set.encrypted || !existsSync(join(set.dir, MANIFEST))) return;
  await assertInManifest(set.dir, path);
}

/**
 * @param {SetLayout} set
 * @param {ReadOptions} [options]
 * @returns {Promise<import('./metrics.mjs').QuerySet>}
 */
export async function loadQueries(set, options = {}) {
  const path = setFile(set, 'queries.json');
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist: the ${set.name} query set has not been written yet`);
  }
  await assertPlainManifest(set, path);
  const qs = await readSetJson(set, path, options);
  validateQueries(qs, path);
  return qs;
}

/**
 * @param {SetLayout} set
 * @param {ReadOptions} [options]
 * @returns {Promise<import('./metrics.mjs').Qrels>}
 */
export async function loadQrels(set, options = {}) {
  const path = setFile(set, 'qrels.json');
  if (!existsSync(path)) throw new Error(`${path} does not exist: the ${set.name} set has not been judged yet`);
  await assertPlainManifest(set, path);
  return readSetJson(set, path, options);
}

/**
 * @param {any} qs
 * @param {string} where
 */
export function validateQueries(qs, where) {
  if (!qs || !Array.isArray(qs.queries) || typeof qs.version !== 'string') {
    throw new Error(`${where}: expected { version: string, queries: [...] }`);
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const q of qs.queries) {
    if (typeof q.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(q.id)) throw new Error(`${where}: query id ${JSON.stringify(q.id)} must be an opaque [A-Za-z0-9_-] id`);
    if (ids.has(q.id)) throw new Error(`${where}: duplicate query id ${q.id}`);
    ids.add(q.id);
    if (typeof q.text !== 'string' || q.text.trim() === '') throw new Error(`${where}: query ${q.id} has no text`);
    if (q.filters !== undefined && (typeof q.filters !== 'object' || q.filters === null || Array.isArray(q.filters))) {
      throw new Error(`${where}: query ${q.id} filters must be an object`);
    }
    for (const key of Object.keys(q.filters ?? {})) {
      if (!FILTER_PARAMS.includes(key)) throw new Error(`${where}: query ${q.id} has unknown filter "${key}" (allowed: ${FILTER_PARAMS.join(', ')})`);
    }
  }
}

export const FILTER_PARAMS = ['sem', 'ng', 'level', 'credits', 'faculty'];

export const MODES = ['hybrid', 'lexical', 'vector'];

/** @typedef {{ personas: Record<string, string>, noPersona: string }} StudyMap */
const STUDY_MAP_PATH = join(REPO, 'eval/study-map.json');
/** @returns {StudyMap} */
export const loadStudyMap = () => JSON.parse(readFileSync(STUDY_MAP_PATH, 'utf8'));
export const studyMapSha256 = () => createHash('sha256').update(readFileSync(STUDY_MAP_PATH)).digest('hex');

/**
 * @param {import('./metrics.mjs').EvalQuery} q
 * @param {{ unfiltered?: boolean, mode?: string, strip?: string[], studyMap?: StudyMap }} [options]
 */
export function searchParams(q, options = {}) {
  const mode = options.mode ?? 'hybrid';
  if (!MODES.includes(mode)) throw new Error(`mode must be hybrid, lexical or vector, got ${JSON.stringify(mode)}`);
  const strip = options.strip ?? [];
  for (const k of strip) if (!FILTER_PARAMS.includes(k)) throw new Error(`strip: unknown filter ${JSON.stringify(k)} (allowed: ${FILTER_PARAMS.join(', ')})`);
  /** @type {Record<string, string>} */
  const params = { q: q.text };
  if (!options.unfiltered) {
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (v === undefined || v === null || v === false || strip.includes(k)) continue;
      params[k] = v === true ? '1' : String(v);
    }
    if (params.ng !== undefined) {
      const map = options.studyMap ?? loadStudyMap();
      const persona = /** @type {{ persona?: string }} */ (q).persona;
      const study = persona === undefined || persona === null ? map.noPersona : map.personas[persona];
      if (!study) throw new Error(`query ${q.id}: persona ${JSON.stringify(persona)} has no study level in eval/study-map.json`);
      params.study = study;
    }
  }
  if (mode !== 'hybrid') params.mode = mode;
  return params;
}
