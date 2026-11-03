// @ts-check
// Where each query set lives and how it is read. dev is plaintext; holdout
// and test (sealed) are AES-256-GCM ciphertext only (crypto.mjs) and are
// decrypted in memory. `fixture` is the tiny synthetic set CI runs
// end-to-end, and `selftest` is its encrypted twin for the custody self-test.
//
// `--set-dir` points a set name at another directory. The look ledger of a
// custody set (holdout, test) stays at its one fixed repo path whatever
// --set-dir says, so pointing --set-dir at the real ciphertexts, or a copy of
// them, cannot start a fresh count. Only `selftest` keeps its ledger in its
// directory; its ciphertexts are bound to the name "selftest" (crypto.mjs), so
// real holdout files cannot be read through it.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEncryptedJson, readKey } from './crypto.mjs';

export const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

/**
 * `gate` is the gate the set's verdicts use (gate.mjs `gateFor`).
 * @typedef {{
 *   name: string, dir: string, runsDir: string, encrypted: boolean,
 *   maxLooks: number, ledger: string | null, perQueryOutput: boolean, gate: 'dev' | 'holdout' | 'test',
 * }} SetLayout
 */

/** The fixed look ledger of the custody sets (repo-relative). */
export const LEDGER = 'eval/holdout-ledger.md';

/** @type {Record<string, Omit<SetLayout, 'name' | 'ledger'> & { ledger: string | null | 'in-dir' }>} */
const LAYOUTS = {
  dev: { dir: 'eval/dev', runsDir: 'eval/runs', encrypted: false, maxLooks: Infinity, ledger: null, perQueryOutput: true, gate: 'dev' },
  fixture: { dir: 'eval/fixtures', runsDir: '.eval-work/runs', encrypted: false, maxLooks: Infinity, ledger: null, perQueryOutput: true, gate: 'dev' },
  holdout: { dir: 'eval/holdout', runsDir: 'eval/holdout', encrypted: true, maxLooks: 12, ledger: LEDGER, perQueryOutput: false, gate: 'holdout' },
  test: { dir: 'eval/sealed', runsDir: 'eval/sealed', encrypted: true, maxLooks: 1, ledger: LEDGER, perQueryOutput: false, gate: 'test' },
  selftest: { dir: '.eval-work/selftest/holdout', runsDir: '.eval-work/selftest/holdout/runs', encrypted: true, maxLooks: 12, ledger: 'in-dir', perQueryOutput: false, gate: 'holdout' },
};

/** Encrypted sets, whose ciphertexts are bound to these names. */
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
  if (base.ledger === 'in-dir') ledger = join(dir, 'ledger.md');
  else if (base.ledger) ledger = join(REPO, base.ledger); // fixed, whatever --set-dir says
  return { name, ...base, dir, runsDir, ledger };
}

/** @param {SetLayout} set @param {string} file e.g. "queries.json" */
export const setFile = (set, file) => join(set.dir, set.encrypted ? `${file}.enc` : file);

/** @param {SetLayout} set @param {string} variant */
export const runFile = (set, variant) => {
  if (!/^[A-Za-z0-9._-]+$/.test(variant)) throw new Error(`variant name "${variant}" may only use letters, digits, ".", "_" and "-"`);
  return join(set.runsDir, set.encrypted ? `run-${variant}.json.enc` : `${variant}.json`);
};

/** @type {Map<string, Buffer>} */
const keys = new Map();
/** The key, read once per process. */
export async function setKey() {
  const k = process.env.VNM_HOLDOUT_KEY_FILE ?? '';
  if (!keys.has(k)) keys.set(k, await readKey());
  return /** @type {Buffer} */ (keys.get(k));
}

/**
 * Reads a JSON file of a set, decrypting when the set is encrypted.
 * @param {SetLayout} set
 * @param {string} path
 */
export async function readSetJson(set, path) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (set.encrypted) return readEncryptedJson(path, await setKey(), set.name);
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * @param {SetLayout} set
 * @returns {Promise<import('./metrics.mjs').QuerySet>}
 */
export async function loadQueries(set) {
  const path = setFile(set, 'queries.json');
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist: the ${set.name} query set has not been written yet (workstream 2b)`);
  }
  const qs = await readSetJson(set, path);
  validateQueries(qs, path);
  return qs;
}

/**
 * @param {SetLayout} set
 * @returns {Promise<import('./metrics.mjs').Qrels>}
 */
export async function loadQrels(set) {
  const path = setFile(set, 'qrels.json');
  if (!existsSync(path)) throw new Error(`${path} does not exist: the ${set.name} set has not been judged yet (workstream 2d)`);
  return readSetJson(set, path);
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

/** The /search parameters a query's `filters` may set (the UI state). */
export const FILTER_PARAMS = ['sem', 'ng', 'level', 'credits', 'faculty'];

/** Retrieval modes the Worker's /search takes (eval-v0 and later); `hybrid` ships. */
export const MODES = ['hybrid', 'lexical', 'vector'];

/**
 * The query string for one query: production defaults (no topK, no mode) plus
 * the query's filters as API params. `mode` (lexical, vector) is for pool
 * variants only; hybrid, the shipped mode, sends no parameter.
 * @param {import('./metrics.mjs').EvalQuery} q
 * @param {{ unfiltered?: boolean, mode?: string }} [options]
 */
export function searchParams(q, options = {}) {
  const mode = options.mode ?? 'hybrid';
  if (!MODES.includes(mode)) throw new Error(`mode must be hybrid, lexical or vector, got ${JSON.stringify(mode)}`);
  /** @type {Record<string, string>} */
  const params = { q: q.text };
  if (!options.unfiltered) {
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      params[k] = v === true ? '1' : String(v);
    }
  }
  if (mode !== 'hybrid') params.mode = mode;
  return params;
}
