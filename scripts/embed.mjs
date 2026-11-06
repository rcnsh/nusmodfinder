#!/usr/bin/env node
// @ts-check
// Embeds texts with Workers AI @cf/baai/bge-small-en-v1.5 over the REST API
// (default pooling, batches of 100). Local only, never CI. The OAuth token
// comes from `wrangler auth token` on every run and is never stored or
// printed; the account id from $CLOUDFLARE_ACCOUNT_ID or `wrangler whoami`.
// Every run estimates its cost from token counts first (1,841 neurons per
// million tokens), refuses to start above the cap, and logs the estimate to
// docs/evidence/neurons.tsv.
//
//   npm run eval:embed                        dev queries (+ texts a failed run reported missing)
//   npm run eval:embed -- --set holdout       same, encrypted cache (custodian only)
//   npm run eval:embed -- --set fixture       fixture corpus + queries (committed cache)
//   npm run eval:embed -- --corpus [--ref eval-v0] [--version emb-bge-small-v0]
//                                             full corpus pass -> .data/emb/<version>/ (cap 2,500)
//   npm run eval:embed -- --texts <file.json> --out <cache.json>
//                                             the texts a production vectors build lacks
//                                             (scripts/vectors.mjs writes the file) -> a cache
//                                             it reads with --extra (cap 2,500)
//   add --dry-run to print the estimate and stop.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { loadPinnedWith } from '../eval/lib/corpus.mjs';
import { readEncryptedJson, recordInManifest, sha256 } from '../eval/lib/crypto.mjs';
import {
  DIMS, EMB_DIR, MODEL, embeddingKey, estimateTokens, f32ToBase64, neuronsFor, readCache, writeCache, queryTextForms,
} from '../eval/lib/embeddings.mjs';
import { REPO, layout, loadQueries, setFile, setKey } from '../eval/lib/sets.mjs';
import { QUERY_INSTRUCTION } from '../src/embedding.js';
import { buildWorkspace } from '../eval/lib/workspace.mjs';

const BATCH = 100;
const QUERY_CAP = 500;
const CORPUS_CAP = 2500;
const LOG = join(REPO, 'docs/evidence/neurons.tsv');

const { values: a } = parseArgs({
  options: {
    set: { type: 'string', default: 'dev' },
    'set-dir': { type: 'string' },
    corpus: { type: 'boolean', default: false },
    ref: { type: 'string', default: 'eval-v0' },
    version: { type: 'string', default: 'emb-bge-small-v0' },
    'max-neurons': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    note: { type: 'string', default: '' },
    texts: { type: 'string' },
    out: { type: 'string' },
  },
});

/** @param {string} msg */
function fail(msg) {
  console.error(`embed: ${msg}`);
  process.exit(1);
}

const cap = Number(a['max-neurons'] ?? (a.corpus || a.texts ? CORPUS_CAP : QUERY_CAP));
if (!Number.isFinite(cap) || cap <= 0 || cap > CORPUS_CAP) fail(`--max-neurons must be in (0, ${CORPUS_CAP}]`);

/** @param {string[]} texts */
function estimate(texts) {
  const tokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
  return { texts: texts.length, tokens, neurons: neuronsFor(tokens), requests: Math.ceil(texts.length / BATCH) };
}

/**
 * @param {string} mode
 * @param {ReturnType<typeof estimate>} est
 * @param {string} note
 */
async function logSpend(mode, est, note) {
  if (!existsSync(LOG)) await writeFile(LOG, 'date\tmode\ttexts\test_tokens\test_neurons\trequests\tnote\n');
  await appendFile(LOG, `${new Date().toISOString()}\t${mode}\t${est.texts}\t${est.tokens}\t${est.neurons.toFixed(1)}\t${est.requests}\t${note}\n`);
}

/** Token and account, never printed. */
function credentials() {
  const bin = join(REPO, 'node_modules/.bin/wrangler');
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  // Run outside the repo so wrangler reads no project config or .dev.vars.
  const tok = spawnSync(bin, ['auth', 'token', '--json'], { cwd: tmpdir(), env, encoding: 'utf8' });
  if (tok.status !== 0) fail('`wrangler auth token` failed; run `npx wrangler login` first');
  const token = JSON.parse(tok.stdout).token;
  if (typeof token !== 'string' || !token) fail('`wrangler auth token --json` returned no token');
  let account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) {
    const who = spawnSync(bin, ['whoami', '--json'], { cwd: tmpdir(), env, encoding: 'utf8' });
    if (who.status !== 0) fail('`wrangler whoami` failed');
    const accounts = JSON.parse(who.stdout).accounts ?? [];
    if (accounts.length !== 1) fail(`${accounts.length} accounts visible; set CLOUDFLARE_ACCOUNT_ID`);
    account = accounts[0].id;
  }
  return { token, account: /** @type {string} */ (account) };
}

/**
 * @param {{ token: string, account: string }} cred
 * @param {string[]} texts at most BATCH
 * @returns {Promise<number[][]>}
 */
async function embedBatch(cred, texts) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cred.account}/ai/run/${MODEL}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cred.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: texts }),
    });
    const body = /** @type {any} */ (await res.json().catch(() => null));
    if (res.ok && body?.success) {
      const data = body.result?.data;
      if (!Array.isArray(data) || data.length !== texts.length || data.some((v) => !Array.isArray(v) || v.length !== DIMS)) {
        throw new Error(`Workers AI returned ${data?.length} vectors of ${data?.[0]?.length} dims for ${texts.length} texts`);
      }
      return data;
    }
    const retryable = res.status === 429 || res.status >= 500;
    const msg = `HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`;
    if (!retryable || attempt >= 4) throw new Error(`Workers AI ${msg}`);
    console.warn(`  retry ${attempt} after ${msg}`);
    // Backoff before a retry of a throttled or failed request (not a wait on work).
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

/**
 * Embeds texts in batches, reporting progress.
 * @param {string[]} texts
 */
async function embedAll(texts) {
  const cred = credentials();
  /** @type {number[][]} */
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await embedBatch(cred, texts.slice(i, i + BATCH))));
    if (texts.length > BATCH) process.stdout.write(`\r  embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  if (texts.length > BATCH) process.stdout.write('\n');
  return { vectors: out, cred };
}

/** @param {number[]} x @param {number[]} y */
function cosine(x, y) {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
  return d / Math.sqrt(nx * ny);
}

/**
 * @param {string} mode
 * @param {string[]} texts
 */
async function gate(mode, texts) {
  const est = estimate(texts);
  console.log(`${mode}: ${est.texts} texts, ~${est.tokens} tokens, ~${est.neurons.toFixed(1)} neurons (cap ${cap}), ${est.requests} requests`);
  if (est.neurons > cap) fail(`estimated ${est.neurons.toFixed(1)} neurons exceeds the cap of ${cap}`);
  if (a['dry-run']) { console.log('dry run: no calls made'); process.exit(0); }
  return est;
}

// ---------------------------------------------------------------------------

if (a.texts) {
  // Phase 3 3-0: the texts the production bundle has no vector for, into a
  // plaintext cache (the QueryCache format) that `scripts/vectors.mjs build
  // --extra` reads. Texts already in --out are not embedded again.
  if (!a.out) fail('--texts needs --out <cache.json>');
  const out = resolve(/** @type {string} */ (a.out));
  const { texts } = JSON.parse(await readFile(resolve(a.texts), 'utf8'));
  if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) fail(`${a.texts} has no "texts" array of strings`);
  const cache = await readCache(out, null, 'extra');
  const todo = [...new Set(/** @type {string[]} */ (texts))].filter((t) => !(embeddingKey(MODEL, t) in cache.entries));
  if (todo.length === 0) {
    console.log(`every text already has a vector in ${out}`);
    process.exit(0);
  }
  const est = await gate('production vectors (missing texts)', todo);
  const { vectors } = await embedAll(todo);
  await logSpend('vectors:production', est, a.note ?? '');
  todo.forEach((t, i) => { cache.entries[embeddingKey(MODEL, t)] = f32ToBase64(Float32Array.from(vectors[i])); });
  await writeCache(out, cache, null, 'extra');
  console.log(`added ${todo.length} vectors to ${out} (${Object.keys(cache.entries).length} total); rebuild with --extra ${a.out}`);
} else if (a.corpus) {
  const version = /** @type {string} */ (a.version);
  if (!/^[a-z0-9.-]+$/.test(version)) fail('--version must be lowercase letters, digits, "." and "-"');
  const dir = join(EMB_DIR, version);
  if (existsSync(join(dir, 'corpus.index.json'))) fail(`${dir} already holds a corpus pass; refusing to spend neurons on it again`);
  // The ranker at --ref decides the embedding text (its scripts/lib.mjs).
  const ws = await buildWorkspace({ ref: a.ref, name: `embed-${version}` });
  const corpus = await loadPinnedWith(ws.root);
  const texts = [...new Set(corpus.modules.map((m) => m.text))];
  // Checkpoint after every batch, so a failure part-way never re-spends
  // neurons on texts already embedded.
  await mkdir(dir, { recursive: true });
  const partialPath = join(dir, 'partial.json');
  /** @type {Record<string, number[]>} */
  const done = existsSync(partialPath) ? JSON.parse(await readFile(partialPath, 'utf8')) : {};
  const todo = texts.filter((t) => !(embeddingKey(MODEL, t) in done));
  await gate(`corpus ${version} (text from ${a.ref} ${ws.ranker.sha.slice(0, 7)}; ${texts.length - todo.length} already checkpointed)`, [...todo, ...texts.slice(0, 3)]);
  const cred = credentials();
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const vs = await embedBatch(cred, batch);
      batch.forEach((t, j) => { done[embeddingKey(MODEL, t)] = vs[j]; });
      await writeFile(partialPath, JSON.stringify(done));
      process.stdout.write(`\r  embedded ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    }
    process.stdout.write('\n');
  } finally {
    await logSpend('corpus', estimate(todo), `${version} from ${a.ref}${a.note ? `; ${a.note}` : ''}`);
  }
  const vectors = texts.map((t) => done[embeddingKey(MODEL, t)]);
  // Determinism: the same three texts again, compared with the first pass.
  const again = await embedBatch(cred, texts.slice(0, 3));
  const cosines = again.map((v, i) => cosine(v, vectors[i]));
  await logSpend('determinism', estimate(texts.slice(0, 3)), `cosines ${cosines.map((c) => c.toFixed(7)).join(',')}`);

  const f32 = new Float32Array(texts.length * DIMS);
  vectors.forEach((v, i) => f32.set(v, i * DIMS));
  const bin = gzipSync(Buffer.from(f32.buffer), { level: 9 });
  const index = {
    schema: 'vnm-eval-corpus-embeddings/1',
    version,
    model: MODEL,
    dims: DIMS,
    pooling: 'default (mean)',
    textRef: a.ref,
    textRefSha: ws.ranker.sha,
    corpus: { release: corpus.info.release, moduleInfoSha256: corpus.info.moduleInfoSha256, ngSha256: corpus.info.ngSha256, modules: corpus.info.modules, textSha256: corpus.info.textSha256 },
    createdAt: new Date().toISOString(),
    determinism: { texts: 3, cosines },
    keys: texts.map((t) => embeddingKey(MODEL, t)),
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  await writeFile(join(dir, 'corpus.f32.gz'), bin);
  await writeFile(join(dir, 'corpus.index.json'), indexBytes);
  console.log(`wrote ${dir}/corpus.f32.gz (${bin.length} bytes, sha256 ${sha256(bin)})`);
  console.log(`wrote ${dir}/corpus.index.json (sha256 ${sha256(indexBytes)})`);
  console.log(`determinism (same text, two REST calls): cosine ${cosines.map((c) => c.toFixed(7)).join(', ')}`);
  console.log('Next: upload both as a release and record the sha256s in eval/embeddings.json (see eval/README.md).');
} else {
  const set = layout(/** @type {string} */ (a.set), a['set-dir'] ? resolve(a['set-dir']) : undefined);
  const key = set.encrypted ? await setKey() : null;
  const cachePath = setFile(set, 'embeddings.json');
  const cache = await readCache(cachePath, key, set.name);
  const querySet = await loadQueries(set);
  /** @type {string[]} */
  // Every form a ranker may embed: raw (eval-v0), canonical (since PR #7), and
  // the working tree's query instruction + canonical (3A-1).
  const wanted = querySet.queries.flatMap((q) => queryTextForms(q.text, QUERY_INSTRUCTION));
  const corpusFile = join(set.dir, 'corpus.json');
  if (existsSync(corpusFile)) wanted.push(...JSON.parse(await readFile(corpusFile, 'utf8')).modules.map((/** @type {NormalisedModule} */ m) => m.text));
  const missingFile = join(REPO, '.eval-work', `missing-${set.name}.json${key ? '.enc' : ''}`);
  if (existsSync(missingFile)) {
    const m = key ? await readEncryptedJson(missingFile, key, set.name) : JSON.parse(await readFile(missingFile, 'utf8'));
    wanted.push(...m.texts);
  }
  const todo = [...new Set(wanted)].filter((t) => !(embeddingKey(MODEL, t) in cache.entries));
  if (todo.length === 0) {
    console.log(`${set.name}: every text already has an embedding (${Object.keys(cache.entries).length} cached)`);
    process.exit(0);
  }
  const est = await gate(`${set.name} queries`, todo);
  const { vectors } = await embedAll(todo);
  await logSpend(`set:${set.name}`, est, a.note ?? '');
  todo.forEach((t, i) => { cache.entries[embeddingKey(MODEL, t)] = f32ToBase64(Float32Array.from(vectors[i])); });
  await writeCache(cachePath, cache, key, set.name);
  // Only the cache joins the manifest: no other ciphertext is re-hashed.
  if (key) await recordInManifest(set.dir, [cachePath]);
  await rm(missingFile, { force: true });
  console.log(`added ${todo.length} vectors to ${cachePath} (${Object.keys(cache.entries).length} total)`);
}
