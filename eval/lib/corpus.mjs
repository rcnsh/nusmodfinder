// @ts-check
// The corpus a run seeds. Either a set's own committed corpus (the fixture
// set's corpus.json) or the pinned snapshot (release data-2026-2027-20260904,
// sha-checked, never fetched upstream) normalised by the *ranker's*
// scripts/lib.mjs, because the embedding text is part of the ranker.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULE_INFO_PATH, PINNED_ACAD_YEAR, PINNED_MODULE_INFO_SHA256, PINNED_RELEASE, sha256 } from '../../scripts/pinned-corpus.mjs';

/**
 * @typedef {{
 *   modules: NormalisedModule[],
 *   info: { source: string, release: string | null, moduleInfoSha256: string, ngSha256: string, modules: number, textSha256: string },
 * }} Corpus
 */

/** sha256 over every module's code and embedding text, in order. */
/** @param {NormalisedModule[]} modules */
export function textSha(modules) {
  const h = createHash('sha256');
  for (const m of modules) h.update(`${m.code}\t${m.text}\n`);
  return h.digest('hex');
}

/**
 * The pinned corpus normalised by `<root>/scripts/lib.mjs`.
 * @param {string} root a workspace (or the repo) holding scripts/lib.mjs and data/
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
  const lib = await import(pathToFileURL(join(root, 'scripts/lib.mjs')).href);
  const ngPath = join(root, `data/ng-courses-${PINNED_ACAD_YEAR}.json`);
  const ngSha256 = existsSync(ngPath) ? sha256(await readFile(ngPath)) : 'none';
  /** @type {{ modules: NormalisedModule[] }} */
  const { modules } = lib.offeredModules(JSON.parse(raw.toString('utf8')), PINNED_ACAD_YEAR, await lib.loadNgCourses(PINNED_ACAD_YEAR));
  return {
    modules,
    info: { source: 'pinned', release: PINNED_RELEASE, moduleInfoSha256: actual, ngSha256, modules: modules.length, textSha256: textSha(modules) },
  };
}

/**
 * A committed corpus file ({ source, modules }) such as eval/fixtures/corpus.json.
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
      modules: c.modules.length,
      textSha256: textSha(c.modules),
    },
  };
}
