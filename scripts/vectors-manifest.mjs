// @ts-check
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBundle } from '../src/vector-bundle.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MANIFEST_PATH = join(ROOT, 'data/vectors.json');
export const VECTORS_DIR = join(ROOT, '.data/vectors');
export const FIXTURE_BUNDLE = join(ROOT, 'test/fixtures/vectors.bin');
export const FIXTURE_CORPUS = join(ROOT, 'test/fixtures/corpus.json');
export const FIXTURE_EMBEDDING = 'fake-hash-embed';
export const MISSING_PATH = join(VECTORS_DIR, 'missing-production.json');
export const D1_ONLY_DELETES_PATH = join(ROOT, '.data/d1-only-deletes.json');
export const PINNED_COUNT = 6771;

/**
 * @typedef {'fixture' | 'pinned' | 'production'} ManifestCorpus
 * @typedef {{
 *   corpus: ManifestCorpus, embedding: string, model: string, count: number, dataVersion: string,
 *   rowsKey: string, sha256: string, bytes: number, path?: string, release?: string, asset?: string,
 * }} ManifestEntry
 * @typedef {{ schema: string, bundles: Partial<Record<ManifestCorpus, ManifestEntry | null>> }} VectorsManifest
 */

/** @param {Uint8Array | Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {string} [path] @returns {Promise<VectorsManifest>} */
export async function readVectorsManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) return { schema: 'vnm-vectors-manifest/1', bundles: {} };
  return JSON.parse(await readFile(path, 'utf8'));
}

/** @param {VectorsManifest} m @param {string} [path] */
export async function writeVectorsManifest(m, path = MANIFEST_PATH) {
  const ordered = { schema: m.schema, bundles: Object.fromEntries(['fixture', 'pinned', 'production'].map((k) => [k, m.bundles[/** @type {ManifestCorpus} */ (k)] ?? null])) };
  await writeFile(path, `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * @param {ManifestCorpus} corpus
 * @param {string} dv
 * @param {string} emb
 */
export const assetName = (corpus, dv, emb) => `vec-${corpus}-${dv}-${emb}.bin`;

/** @param {ManifestEntry} e */
export const localPath = (e) => (e.path ? join(ROOT, e.path) : join(VECTORS_DIR, /** @type {string} */ (e.asset)));

/** @param {string} bin */
export function shimPath(bin) {
  return join(dirname(bin), `${basename(bin, '.bin')}.js`);
}

/** @param {string} bin */
export async function writeShim(bin) {
  const shim = shimPath(bin);
  await writeFile(shim, `import vectors from './${basename(bin)}';\n\nexport default vectors;\n`);
  return shim;
}

/**
 * @param {ManifestEntry} entry
 * @param {string} [path]
 */
export async function loadCheckedBundle(entry, path = localPath(entry)) {
  const bytes = await readFile(path);
  const got = sha256(bytes);
  if (got !== entry.sha256) throw new Error(`${relative(ROOT, path)} has sha256 ${got}; data/vectors.json records ${entry.sha256}`);
  const bundle = parseBundle(/** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  for (const k of /** @type {const} */ (['corpus', 'count', 'rowsKey', 'dataVersion', 'embedding'])) {
    if (bundle.header[k] !== entry[k]) throw new Error(`${relative(ROOT, path)}: header ${k} ${bundle.header[k]} != manifest ${entry[k]}`);
  }
  return { bytes, bundle, path };
}

/**
 * @param {'pinned' | 'production'} corpus
 * @param {{ log?: (line: string) => void, download?: (e: ManifestEntry) => void }} [deps]
 */
export async function fetchBundle(corpus, { log = console.log, download = ghDownload } = {}) {
  const entry = (await readVectorsManifest()).bundles[corpus];
  if (!entry?.asset || !entry.release) throw new Error(`data/vectors.json has no ${corpus} bundle; build it first (node scripts/vectors.mjs build --corpus ${corpus})`);
  const bin = localPath(entry);
  if (!existsSync(bin)) download(entry);
  const { bundle } = await loadCheckedBundle(entry, bin);
  const shim = await writeShim(bin);
  log(`${corpus}: ${relative(ROOT, bin)} ok (${bundle.count} rows, sha256 ${entry.sha256.slice(0, 12)}); alias target ${relative(ROOT, shim)}`);
  return shim;
}

/** @param {ManifestEntry} e */
export function ghDownload(e) {
  const r = spawnSync('gh', ['release', 'download', /** @type {string} */ (e.release), '--pattern', /** @type {string} */ (e.asset), '--dir', VECTORS_DIR, '--clobber'],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`gh release download ${e.release} --pattern ${e.asset} failed (exit ${r.status})`);
}

