// @ts-check
// The pinned upstream snapshot production was built from (release asset
// `data-2026-2027-20260904`). Read straight from .data/ and checked against
// the pinned hash; never via fetchAcadYearFile, which falls back to fetching
// api.nusmods.com when the file is missing.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadNgCourses, offeredModules } from './lib.mjs';

export const PINNED_ACAD_YEAR = '2026-2027';
export const PINNED_RELEASE = 'data-2026-2027-20260904';
export const PINNED_MODULE_INFO_SHA256 = '2d138795d387d133237669a7f5a22c7c4d30b4a26bf82dad0a982636e80857b1';
export const MODULE_INFO_PATH = fileURLToPath(new URL(`../.data/${PINNED_ACAD_YEAR}-moduleInfo.json`, import.meta.url));
export const NG_PATH = fileURLToPath(new URL(`../data/ng-courses-${PINNED_ACAD_YEAR}.json`, import.meta.url));

/** @param {Buffer | string} bytes */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @typedef {{
 *   acadYear: string,
 *   moduleInfoSha256: string,
 *   ngSha256: string,
 *   records: any[],
 *   modules: NormalisedModule[],
 *   skipped: { code: string, why: string }[],
 *   ng: { updatedAsAt: string | null, semesters: Record<string, string[]> },
 * }} PinnedCorpus
 */

/**
 * Loads and normalises the pinned snapshot. Throws if the file is missing or
 * its sha256 is not the pinned one.
 * @returns {Promise<PinnedCorpus>}
 */
export async function loadPinnedCorpus() {
  /** @type {Buffer} */
  let raw;
  try {
    raw = await readFile(MODULE_INFO_PATH);
  } catch (err) {
    throw new Error(
      `pinned corpus missing at ${MODULE_INFO_PATH} (${/** @type {Error} */ (err).message}). ` +
        `Get it from release ${PINNED_RELEASE}: gh release download ${PINNED_RELEASE} -D .data && gunzip .data/*.gz`,
      { cause: err },
    );
  }
  const actual = sha256(raw);
  if (actual !== PINNED_MODULE_INFO_SHA256) {
    throw new Error(`pinned corpus sha256 mismatch: ${MODULE_INFO_PATH} is ${actual}, expected ${PINNED_MODULE_INFO_SHA256}`);
  }
  const ngRaw = await readFile(NG_PATH);
  const ngJson = JSON.parse(ngRaw.toString('utf8'));
  const records = JSON.parse(raw.toString('utf8'));
  const { modules, skipped } = offeredModules(records, PINNED_ACAD_YEAR, await loadNgCourses(PINNED_ACAD_YEAR));
  return {
    acadYear: PINNED_ACAD_YEAR,
    moduleInfoSha256: actual,
    ngSha256: sha256(ngRaw),
    records,
    modules,
    skipped,
    ng: { updatedAsAt: ngJson.updatedAsAt ?? null, semesters: ngJson.semesters ?? {} },
  };
}
