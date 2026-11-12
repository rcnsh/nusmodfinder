// @ts-check
// D1's catalogue against the bundled catalogue file. The Worker
// answers `not-offered` for the codes it bundles (`catalogue-codes-data`,
// which wrangler.jsonc aliases to data/catalogue-codes.json, built from
// `current`) and names the title D1's catalogue_only holds, so the two must
// hold the same codes. The deploy guard and `verify --pre-deploy` refuse a
// mismatch; each takes D1's side as catalogue_only rows (a SELECT's results)
// or as the catalogueKey /admin/hashes computed from them.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { catalogueKey } from '../src/rowhash.js';

/** The catalogue file the Worker bundles (wrangler.jsonc `catalogue-codes-data`). */
export const BUNDLED_CATALOGUE_PATH = fileURLToPath(new URL('../data/catalogue-codes.json', import.meta.url));

/**
 * @typedef {{ codes: string[] }} BundledCatalogue
 */

/**
 * The bundled catalogue file.
 * @param {string} [path]
 * @returns {Promise<BundledCatalogue & { path: string, source?: { release?: string, acadYear?: string, moduleInfoSha256?: string } }>}
 */
export async function readBundledCatalogue(path = BUNDLED_CATALOGUE_PATH) {
  const file = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(file.codes)) throw new Error(`${path} holds no codes array`);
  return { path, codes: file.codes, source: file.source };
}

/**
 * Why D1's catalogueKey is not the bundled file's, or null when it is.
 * @param {string | null | undefined} d1Key
 * @param {BundledCatalogue} bundled
 * @returns {Promise<string | null>}
 */
export async function catalogueKeyMismatch(d1Key, bundled) {
  const fileKey = await catalogueKey(bundled.codes);
  if (typeof d1Key !== 'string') {
    return `D1 reported no catalogueKey (a Worker without the catalogueKey check, or no catalogue_only table); the bundled file's is ${fileKey}.`;
  }
  if (d1Key === fileKey) return null;
  return `D1's catalogue_only (catalogueKey ${d1Key}) is not the bundled catalogue file's (catalogueKey ${fileKey}, ${bundled.codes.length} codes). `
    + 'Load the catalogue from `current` (the runbook\'s ingest) or rebuild the file (node scripts/build-catalogue-data.mjs --corpus production).';
}

/**
 * Why D1's catalogue_only rows are not the bundled file's codes, or null when they are: the same
 * comparison as catalogueKeyMismatch, from rows, naming a few codes on each side.
 * @param {{ code: string }[]} rows catalogue_only rows as a SELECT returns them
 * @param {BundledCatalogue} bundled
 * @returns {Promise<string | null>}
 */
export async function catalogueMismatch(rows, bundled) {
  const codes = rows.map((r) => r.code);
  const why = await catalogueKeyMismatch(await catalogueKey(codes), bundled);
  if (why === null) return null;
  const inD1 = new Set(codes);
  const inFile = new Set(bundled.codes);
  const few = (/** @type {string[]} */ xs) => `${xs.slice(0, 10).join(', ')}${xs.length > 10 ? `, … (${xs.length})` : ''}`;
  const d1Only = codes.filter((c) => !inFile.has(c)).sort();
  const fileOnly = bundled.codes.filter((c) => !inD1.has(c)).sort();
  return `${why}${d1Only.length ? ` Only in D1: ${few(d1Only)}.` : ''}${fileOnly.length ? ` Only in the file: ${few(fileOnly)}.` : ''}`;
}
