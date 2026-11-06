// @ts-check
// Embedding storage. Every vector is keyed by sha256(model + "\n" + text), so
// a cache never serves a vector for a different model or a different text.
//
// - Corpus: a versioned GitHub release asset (eval/embeddings.json lists each
//   version's release, model, embedding-text ref and file sha256s):
//   corpus.f32.gz (N x dims little-endian Float32, gzipped) + corpus.index.json
//   (keys in row order). Downloaded into .data/emb/<version>/ and sha-checked.
// - Queries: a JSON cache per set ({ model, dims, entries: { key: base64 } }),
//   plaintext for dev and fixture, AES-256-GCM for holdout and test.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { readEncryptedJson, writeEncryptedJson } from './crypto.mjs';
import { REPO } from './sets.mjs';

export const MODEL = '@cf/baai/bge-small-en-v1.5';

export { queryTextForms } from './query-forms.mjs';

/**
 * The query instruction the ranker at `root` embeds in front of each query
 * (3A-1: its src/embedding.js QUERY_INSTRUCTION), or '' when it has none
 * (eval-v0 has no src/embedding.js; the 3-0 ranker's has no such export).
 * @param {string} root a ranker workspace (or the repo, for the working tree)
 * @returns {Promise<string>}
 */
export async function rankerQueryInstruction(root) {
  const file = join(root, 'src', 'embedding.js');
  if (!existsSync(file)) return '';
  const { QUERY_INSTRUCTION } = await import(pathToFileURL(file).href);
  if (QUERY_INSTRUCTION === undefined) return '';
  if (typeof QUERY_INSTRUCTION !== 'string') throw new Error(`${file}: QUERY_INSTRUCTION is ${typeof QUERY_INSTRUCTION}, not a string`);
  return QUERY_INSTRUCTION;
}
export const DIMS = 384;
/** Workers AI price for bge-small-en-v1.5: 1,841 neurons per million input tokens. */
export const NEURONS_PER_M_TOKENS = 1841;
export const MANIFEST_PATH = join(REPO, 'eval', 'embeddings.json');
export const EMB_DIR = join(REPO, '.data', 'emb');

/**
 * @param {string} model
 * @param {string} text
 */
export function embeddingKey(model, text) {
  return createHash('sha256').update(`${model}\n${text}`).digest('hex');
}

/**
 * Conservative token estimate for a BERT WordPiece model without its vocab:
 * [CLS] + [SEP], one token per punctuation mark, one per short word, more
 * for long words and digit runs; never below chars / 4. bge truncates at 512.
 * @param {string} text
 */
export function estimateTokens(text) {
  let n = 2;
  for (const m of text.toLowerCase().matchAll(/[a-z]+|[0-9]+|[^\sa-z0-9]/g)) {
    const w = m[0];
    if (/^[a-z]/.test(w)) n += w.length <= 8 ? 1 : Math.ceil(w.length / 4);
    else if (/^[0-9]/.test(w)) n += Math.ceil(w.length / 2);
    else n += 1;
  }
  return Math.min(Math.max(n, Math.ceil(text.length / 4) + 2), 512);
}

/** @param {number} tokens */
export const neuronsFor = (tokens) => (tokens * NEURONS_PER_M_TOKENS) / 1e6;

/** @param {Float32Array} v */
export const f32ToBase64 = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');

/** @param {string} b64 */
export function base64ToF32(b64) {
  const buf = Buffer.from(b64, 'base64');
  // Copy so the Float32Array is aligned regardless of the Buffer pool offset.
  const out = new Float32Array(buf.length / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

/**
 * @typedef {{ schema: string, model: string, dims: number, entries: Record<string, string> }} QueryCache
 */

/** @returns {QueryCache} */
export const emptyCache = () => ({ schema: 'vnm-eval-embeddings/1', model: MODEL, dims: DIMS, entries: {} });

/**
 * @param {string} path
 * @param {Buffer | null} key decryption key for encrypted sets
 * @param {string} set set name (bound into the ciphertext)
 * @returns {Promise<QueryCache>}
 */
export async function readCache(path, key, set) {
  if (!existsSync(path)) return emptyCache();
  const cache = key ? await readEncryptedJson(path, key, set) : JSON.parse(await readFile(path, 'utf8'));
  if (cache.model !== MODEL || cache.dims !== DIMS) throw new Error(`${path}: cache is for ${cache.model}/${cache.dims}, expected ${MODEL}/${DIMS}`);
  return cache;
}

/**
 * @param {string} path
 * @param {QueryCache} cache
 * @param {Buffer | null} key
 * @param {string} set
 */
export async function writeCache(path, cache, key, set) {
  const sorted = { ...cache, entries: Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b))) };
  if (key) return writeEncryptedJson(path, sorted, key, set);
  await writeFile(path, `${JSON.stringify(sorted, null, 1)}\n`);
}

/**
 * @typedef {{ release: string, model: string, dims: number, textRef: string, count: number, files: Record<string, string> }} CorpusVersion
 * @typedef {{ default: string, versions: Record<string, CorpusVersion> }} EmbeddingManifest
 */

/** @returns {Promise<EmbeddingManifest>} */
export async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
}

/** @param {Buffer} b */
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * The corpus embeddings for a version: downloads the release asset if it is
 * not in .data/emb/, verifies each file's sha256 against eval/embeddings.json.
 * @param {string} version
 * @returns {Promise<{ version: string, model: string, dims: number, keys: string[], vectors: Float32Array, textRef: string }>}
 */
export async function loadCorpusEmbeddings(version) {
  const manifest = await readManifest();
  const v = manifest.versions[version];
  if (!v) throw new Error(`unknown embedding version "${version}"; eval/embeddings.json lists ${Object.keys(manifest.versions).join(', ') || 'none'}`);
  const dir = join(EMB_DIR, version);
  const missing = Object.keys(v.files).filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    await mkdir(dir, { recursive: true });
    const args = ['release', 'download', v.release, '--dir', dir, '--clobber', ...missing.flatMap((f) => ['--pattern', f])];
    const r = spawnSync('gh', args, { cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`gh ${args.join(' ')} failed (exit ${r.status})`);
  }
  /** @type {Record<string, Buffer>} */
  const bytes = {};
  for (const [f, want] of Object.entries(v.files)) {
    bytes[f] = await readFile(join(dir, f));
    const got = sha(bytes[f]);
    if (got !== want) throw new Error(`${join(dir, f)} sha256 ${got} != ${want} recorded in eval/embeddings.json; delete it and re-run`);
  }
  const index = JSON.parse(bytes['corpus.index.json'].toString('utf8'));
  const raw = gunzipSync(bytes['corpus.f32.gz']);
  const vectors = new Float32Array(raw.length / 4);
  new Uint8Array(vectors.buffer).set(raw);
  if (index.model !== v.model || index.dims !== v.dims || vectors.length !== index.keys.length * index.dims) {
    throw new Error(`${version}: index (${index.keys.length} x ${index.dims}, ${index.model}) does not match ${vectors.length} floats`);
  }
  return { version, model: index.model, dims: index.dims, keys: index.keys, vectors, textRef: v.textRef };
}

/**
 * Packs vectors for workerd: one base64 Float32 string plus keys in row order
 * (nested arrays crash the Vitest pool's provide/inject transport).
 * @param {{ keys: string[], vectors: Float32Array }[]} parts
 * @param {number} dims
 */
export function packLookup(parts, dims) {
  /** @type {Map<string, Float32Array>} */
  const rows = new Map();
  for (const { keys, vectors } of parts) {
    keys.forEach((k, i) => rows.set(k, vectors.subarray(i * dims, (i + 1) * dims)));
  }
  const keys = [...rows.keys()];
  const all = new Float32Array(keys.length * dims);
  keys.forEach((k, i) => all.set(/** @type {Float32Array} */ (rows.get(k)), i * dims));
  return { model: MODEL, dims, keys, b64: f32ToBase64(all) };
}

/**
 * A query cache as a lookup part.
 * @param {QueryCache} cache
 */
export function cachePart(cache) {
  const keys = Object.keys(cache.entries);
  const vectors = new Float32Array(keys.length * cache.dims);
  keys.forEach((k, i) => vectors.set(base64ToF32(cache.entries[k]), i * cache.dims));
  return { keys, vectors };
}
