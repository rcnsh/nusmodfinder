// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULE_INFO_PATH, PINNED_ACAD_YEAR, PINNED_MODULE_INFO_SHA256, PINNED_RELEASE, sha256 } from '../../scripts/pinned-corpus.mjs';
import { REPO } from './sets.mjs';

export const PINNED_NG_FILES = Object.freeze({
  courses: `eval/pinned/ng-courses-${PINNED_ACAD_YEAR}.json`,
  restrictions: `eval/pinned/ng-restrictions-${PINNED_ACAD_YEAR}.json`,
});

export function pinnedNgRestrictionsSha256() {
  return sha256(readFileSync(join(REPO, PINNED_NG_FILES.restrictions)));
}

/**
 * @returns {Promise<{ ngCourses: { available: true, bySem: Map<string, number[]>, updatedAsAt: string, source: string | null, total: number,
 *   rules: unknown }, ngSha256: string, ngRestrictionsSha256: string }>}
 */
async function pinnedNg() {
  const coursesRaw = await readFile(join(REPO, PINNED_NG_FILES.courses));
  const rulesRaw = await readFile(join(REPO, PINNED_NG_FILES.restrictions));
  const data = JSON.parse(coursesRaw.toString('utf8'));
  /** @type {Map<string, number[]>} */
  const bySem = new Map();
  for (const [sem, codes] of /** @type {[string, string[]][]} */ (Object.entries(data.semesters ?? {}))) {
    for (const code of codes) {
      if (!bySem.has(code)) bySem.set(code, []);
      /** @type {number[]} */ (bySem.get(code)).push(Number(sem));
    }
  }
  for (const sems of bySem.values()) sems.sort((a, b) => a - b);
  return {
    ngCourses: { available: true, bySem, updatedAsAt: data.updatedAsAt, source: data.source ?? null, total: bySem.size, rules: JSON.parse(rulesRaw.toString('utf8')) },
    ngSha256: sha256(coursesRaw),
    ngRestrictionsSha256: sha256(rulesRaw),
  };
}

/**
 * @param {string} root
 * @param {any[]} records
 * @returns {Promise<{ modules: NormalisedModule[], ngSha256: string, ngRestrictionsSha256: string }>}
 */
export async function pinnedModulesWith(root, records) {
  const lib = await import(pathToFileURL(join(root, 'scripts/lib.mjs')).href);
  const { ngCourses, ngSha256, ngRestrictionsSha256 } = await pinnedNg();
  /** @type {{ modules: NormalisedModule[] }} */
  const { modules } = lib.offeredModules(records, PINNED_ACAD_YEAR, ngCourses);
  return { modules, ngSha256, ngRestrictionsSha256 };
}

/**
 * @typedef {{
 *   modules: NormalisedModule[],
 *   info: { source: string, release: string | null, moduleInfoSha256: string, ngSha256: string, ngRestrictionsSha256: string, modules: number,
 *     textSha256: string },
 * }} Corpus
 */

/** @param {string} root */
export async function writeRunCatalogue(root) {
  await mkdir(join(root, 'data'), { recursive: true });
  for (const f of ['catalogue-codes.json', 'prefixes.json']) await copyFile(join(REPO, 'data/pinned', f), join(root, 'data', f));
}

/** @param {NormalisedModule[]} modules */
export function textSha(modules) {
  const h = createHash('sha256');
  for (const m of modules) h.update(`${m.code}\t${m.text}\n`);
  return h.digest('hex');
}

/**
 * @param {string} root
 * @returns {Promise<Corpus>}
 */
export async function loadPinnedWith(root) {
  if (!existsSync(MODULE_INFO_PATH)) {
    throw new Error(`pinned corpus missing at ${MODULE_INFO_PATH}. Get it from the release: `
      + `gh release download ${PINNED_RELEASE} -p '${PINNED_ACAD_YEAR}-moduleInfo.json.gz' -D .data && gunzip .data/${PINNED_ACAD_YEAR}-moduleInfo.json.gz`);
  }
  const raw = await readFile(MODULE_INFO_PATH);
  const actual = sha256(raw);
  if (actual !== PINNED_MODULE_INFO_SHA256) throw new Error(`pinned corpus sha256 ${actual} != ${PINNED_MODULE_INFO_SHA256}`);
  const { modules, ngSha256, ngRestrictionsSha256 } = await pinnedModulesWith(root, JSON.parse(raw.toString('utf8')));
  return {
    modules,
    info: { source: 'pinned', release: PINNED_RELEASE, moduleInfoSha256: actual, ngSha256, ngRestrictionsSha256, modules: modules.length, textSha256: textSha(modules) },
  };
}

/**
 * @param {string} path
 * @returns {Promise<Corpus>}
 */
export async function loadCorpusFile(path) {
  const c = JSON.parse(await readFile(path, 'utf8'));
  return {
    modules: c.modules,
    info: {
      source: path.replace(/^.*\/eval\//, 'eval/'),
      release: c.source?.release ?? null,
      moduleInfoSha256: c.source?.moduleInfoSha256 ?? 'n/a',
      ngSha256: c.source?.ngSha256 ?? 'n/a',
      ngRestrictionsSha256: c.source?.ngRestrictionsSha256 ?? 'n/a',
      modules: c.modules.length,
      textSha256: textSha(c.modules),
    },
  };
}
