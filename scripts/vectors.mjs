#!/usr/bin/env node
// @ts-check
// The vectors bundles (docs/plans/phase3.md 3-0, B-2, B-9, B2-4, B2-5, A-N6)
// and runbook step 8. One builder, three bundles:
//
//   node scripts/vectors.mjs build --corpus fixture
//       test/fixtures/vectors.bin (committed): the fixture corpus
//       (test/fixtures/corpus.json, ~400 modules) embedded by the fake
//       embedder (test/fakes.js hashEmbed), so tests and `wrangler dev`
//       search the vectors the fake Vectorize would hold.
//   node scripts/vectors.mjs build --corpus pinned [--embedding <version>]
//       .data/vectors/vec-pinned-<dataVersion>-<embedding>.bin: the 6,771
//       modules of the pinned corpus, each vector looked up in the eval's
//       corpus asset by embeddingKey(model, embeddingText). For full-corpus
//       CI and the SC4 suite. Upload it as a release asset (it prints how).
//   node scripts/vectors.mjs build --corpus production --expect-count <D1 rows>
//       [--year <y>] [--offline] [--max-age <dur>] [--embedding <version>] [--extra <cache.json> ...]
//       .data/vectors/vec-production-<dataVersion>-<embedding>.bin: the
//       corpus ingest will write (fetched as `npm run ingest` fetches it),
//       vectors reused by key from the eval asset and the --extra caches.
//       Texts in neither are written to .data/vectors/missing-production.json
//       and the build stops: embed them with
//       `npm run eval:embed -- --texts <that file> --out <cache.json>`, then
//       rebuild with --extra <cache.json>. Also writes src/data-version.json,
//       computed offline from the rows ingest will write (B3-4).
//
// Each build records the bundle in data/vectors.json: data version, embedding
// version, count, sha256 and rowsKey, the sha256 of the sorted
// (code, textHash) pairs (B-2). A row with no textHash is refused (A-N6).
//
//   node scripts/vectors.mjs fetch --corpus pinned|production
//       Downloads the release asset into .data/vectors/ if absent (gh), checks
//       its sha256 against data/vectors.json, and writes the module the
//       `vectors-bundle` alias points at.
//   node scripts/vectors.mjs data-version [--year <y>] [--offline]
//       Prints the data version of the rows ingest would write (B3-4).
//   node scripts/vectors.mjs standby --url <wrangler dev --remote> [--deletes <file>]
//       Runbook step 8: upsert every code with the production bundle's
//       values and D1's metadata, delete step 4's deletions, wait for the
//       mutation, then verify (metadata, the id list, and a getByIds sample
//       of values against the bundle). Needs INGEST_SECRET, as ingest does.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cachePart, embeddingKey, loadCorpusEmbeddings, readCache, readManifest, DIMS, MODEL } from '../eval/lib/embeddings.mjs';
import { hashEmbed } from '../test/fakes.js';
import { encodeBundle, parseBundle } from '../src/vector-bundle.js';
import { dataVersion, rowHash } from '../src/rowhash.js';
import { dataVersionFile, httpAdminApi, parseDuration, DATA_VERSION_PATH } from './ingest.mjs';
import {
  DEFAULT_ACAD_YEAR, DEFAULT_MAX_AGE_MS, assertExpectedShape, fetchAcadYearFile, loadNgCourses, offeredModules,
} from './lib.mjs';
import { loadPinnedCorpus } from './pinned-corpus.mjs';
import { runStandby } from './vectors-core.mjs';
import {
  D1_ONLY_DELETES_PATH, FIXTURE_BUNDLE, FIXTURE_CORPUS, FIXTURE_EMBEDDING, MISSING_PATH, PINNED_COUNT, ROOT, VECTORS_DIR,
  assetName, fetchBundle, loadCheckedBundle, readVectorsManifest, sha256, writeShim, writeVectorsManifest,
} from './vectors-manifest.mjs';
import { DEFAULT_INDEX, listVectorIds } from './verify.mjs';
import { formatReport, runVerify } from './verify-core.mjs';

/**
 * Vectors by embeddingKey, from the eval corpus asset and any extra caches.
 * @param {string} version
 * @param {string[]} extras
 */
async function vectorSource(version, extras) {
  const emb = await loadCorpusEmbeddings(version);
  if (emb.model !== MODEL || emb.dims !== DIMS) throw new Error(`${version} is ${emb.model}/${emb.dims}, expected ${MODEL}/${DIMS}`);
  /** @type {Map<string, Float32Array>} */
  const byKey = new Map();
  emb.keys.forEach((k, i) => byKey.set(k, emb.vectors.subarray(i * DIMS, (i + 1) * DIMS)));
  const extraHash = createHash('sha256');
  for (const path of extras) {
    const part = cachePart(await readCache(path, null, 'extra'));
    part.keys.forEach((k, i) => {
      if (!byKey.has(k)) {
        byKey.set(k, part.vectors.subarray(i * DIMS, (i + 1) * DIMS));
        extraHash.update(k);
      }
    });
  }
  return { byKey, label: extras.length ? `${version}-x${extraHash.digest('hex').slice(0, 8)}` : version };
}

/**
 * The corpus `npm run ingest` would write, from the same source and normaliser.
 * @param {{ year: string, offline: boolean, maxAgeMs: number }} o
 */
export async function productionModules(o) {
  const info = await fetchAcadYearFile(o.year, 'moduleInfo.json', { offline: o.offline, maxAgeMs: o.maxAgeMs });
  assertExpectedShape(info.data);
  const { modules } = offeredModules(info.data, o.year, await loadNgCourses(o.year));
  return modules;
}

/** @param {NormalisedModule[]} modules */
export async function offlineDataVersion(modules) {
  return dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));
}

/**
 * Looks up each module's vector by embeddingKey(model, text); shared texts
 * share one vector (B2-5).
 * @param {NormalisedModule[]} modules
 * @param {Map<string, Float32Array>} byKey
 */
export function keyedVectors(modules, byKey) {
  /** @type {Map<string, Float32Array>} */
  const out = new Map();
  /** @type {string[]} */
  const missing = [];
  for (const m of modules) {
    const v = byKey.get(embeddingKey(MODEL, m.text));
    if (v) out.set(m.code, v);
    else missing.push(m.text);
  }
  return { out, missing: [...new Set(missing)] };
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} log
 */
async function build(argv, log) {
  const { values } = parseArgs({
    args: argv,
    options: {
      corpus: { type: 'string' }, embedding: { type: 'string' }, extra: { type: 'string', multiple: true },
      'expect-count': { type: 'string' }, year: { type: 'string' }, offline: { type: 'boolean' }, 'max-age': { type: 'string' },
    },
    strict: true,
  });
  const corpus = values.corpus;
  const manifest = await readVectorsManifest();

  if (corpus === 'fixture') {
    const modules = /** @type {NormalisedModule[]} */ (JSON.parse(await readFile(FIXTURE_CORPUS, 'utf8')).modules);
    const bytes = await encodeBundle({ corpus: 'fixture', embedding: FIXTURE_EMBEDDING, model: 'fake', modules, vectorOf: (m) => hashEmbed(/** @type {NormalisedModule} */ (m).text) });
    await writeFile(FIXTURE_BUNDLE, bytes);
    await writeShim(FIXTURE_BUNDLE);
    const entry = await entryFor(bytes, { path: relative(ROOT, FIXTURE_BUNDLE) });
    manifest.bundles.fixture = entry;
    await writeVectorsManifest(manifest);
    log(`fixture: ${modules.length} rows, ${bytes.length} B -> ${relative(ROOT, FIXTURE_BUNDLE)} (sha256 ${entry.sha256})`);
    return 0;
  }
  if (corpus !== 'pinned' && corpus !== 'production') {
    log('build: --corpus must be fixture, pinned or production');
    return 1;
  }

  const version = values.embedding ?? (await readManifest()).default;
  /** @type {NormalisedModule[]} */
  let modules;
  /** @type {number} */
  let expected;
  if (corpus === 'pinned') {
    modules = (await loadPinnedCorpus()).modules;
    expected = PINNED_COUNT;
  } else {
    if (!values['expect-count']) {
      log('build --corpus production needs --expect-count <n>: the row count D1 will hold (6,778 at the 3-0 cutover).');
      return 1;
    }
    expected = Number(values['expect-count']);
    modules = await productionModules({
      year: values.year ?? DEFAULT_ACAD_YEAR, offline: values.offline ?? false,
      maxAgeMs: values['max-age'] ? parseDuration(values['max-age']) : DEFAULT_MAX_AGE_MS,
    });
  }
  if (modules.length !== expected) {
    log(`build: the ${corpus} corpus has ${modules.length} rows, expected ${expected}. Nothing was written.`);
    return 1;
  }
  const source = await vectorSource(version, corpus === 'production' ? values.extra ?? [] : []);
  const { out, missing } = keyedVectors(modules, source.byKey);
  if (missing.length) {
    if (corpus === 'pinned') {
      log(`build: ${missing.length} pinned texts have no vector in ${version}; the eval asset must cover the pinned corpus. Nothing was written.`);
      return 1;
    }
    await mkdir(VECTORS_DIR, { recursive: true });
    await writeFile(MISSING_PATH, `${JSON.stringify({ model: MODEL, texts: missing }, null, 1)}\n`);
    log(`build: ${missing.length} texts have no vector in ${version}${values.extra?.length ? ' or the --extra caches' : ''}. Wrote ${relative(ROOT, MISSING_PATH)}. Nothing else was written.`);
    log(`next: npm run eval:embed -- --texts ${relative(ROOT, MISSING_PATH)} --out .data/vectors/extra-production.json`);
    log(`then: node scripts/vectors.mjs build --corpus production --expect-count ${expected}${values.offline ? ' --offline' : ''} --extra .data/vectors/extra-production.json`);
    return 1;
  }
  const bytes = await encodeBundle({ corpus, embedding: source.label, model: MODEL, modules, vectorOf: (m) => out.get(m.code) });
  const dv = await offlineDataVersion(modules);
  const asset = assetName(corpus, dv, source.label);
  await mkdir(VECTORS_DIR, { recursive: true });
  const bin = join(VECTORS_DIR, asset);
  await writeFile(bin, bytes);
  await writeShim(bin);
  manifest.bundles[corpus] = await entryFor(bytes, { release: asset.replace(/\.bin$/, ''), asset });
  await writeVectorsManifest(manifest);
  log(`${corpus}: ${modules.length} rows (${new Set(modules.map((m) => m.text)).size} distinct texts), ${bytes.length} B -> ${relative(ROOT, bin)}`);
  log(`  data version ${dv}, embedding ${source.label}, sha256 ${manifest.bundles[corpus]?.sha256}`);
  if (corpus === 'production') {
    await writeFile(DATA_VERSION_PATH, dataVersionFile(dv));
    log(`  src/data-version.json -> ${dv} (offline, from the rows ingest will write)`);
  }
  log(`upload: gh release create ${asset.replace(/\.bin$/, '')} ${relative(ROOT, bin)} --title "${asset}" --notes "vectors bundle, sha256 ${manifest.bundles[corpus]?.sha256}"`);
  log('then commit data/vectors.json' + (corpus === 'production' ? ' and src/data-version.json (runbook step 1)' : ''));
  return 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {{ path?: string, release?: string, asset?: string }} where
 * @returns {Promise<import('./vectors-manifest.mjs').ManifestEntry>}
 */
async function entryFor(bytes, where) {
  const { header } = parseBundle(/** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  return {
    corpus: /** @type {import('./vectors-manifest.mjs').ManifestCorpus} */ (header.corpus), embedding: header.embedding, model: header.model, count: header.count,
    dataVersion: header.dataVersion, rowsKey: header.rowsKey, sha256: sha256(bytes), bytes: bytes.length, ...where,
  };
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} log
 */
async function standby(argv, log) {
  const { values } = parseArgs({ args: argv, options: { url: { type: 'string' }, deletes: { type: 'string' }, 'wait-timeout': { type: 'string' } }, strict: true });
  const secret = process.env.INGEST_SECRET;
  if (!secret) { log('INGEST_SECRET is not set. Export the same value the dev session is bound to.'); return 2; }
  const base = (values.url ?? process.env.WORKER_URL ?? 'http://localhost:8787').replace(/\/$/, '');
  const entry = (await readVectorsManifest()).bundles.production;
  if (!entry) { log('data/vectors.json has no production bundle.'); return 1; }
  const { bundle } = await loadCheckedBundle(entry);
  const deletesPath = values.deletes ?? D1_ONLY_DELETES_PATH;
  /** @type {string[]} */
  const deletes = existsSync(deletesPath) ? JSON.parse(await readFile(deletesPath, 'utf8')).codes ?? [] : [];
  log(`standby: ${bundle.count} vectors from ${entry.asset} (sha256 ok), ${deletes.length} deletions${deletes.length ? ` from ${relative(ROOT, deletesPath)}` : ''}`);
  const api = httpAdminApi(base, secret);
  const result = await runStandby({
    api, bundle, deletes, log, listVectorIds: () => listVectorIds(DEFAULT_INDEX),
    ...(values['wait-timeout'] ? { waitTimeoutMs: parseDuration(values['wait-timeout']) } : {}),
  });
  if (result.status !== 'done') return result.status === 'wait-timeout' ? 3 : 1;
  const report = await runVerify({ api, listVectorIds: () => listVectorIds(DEFAULT_INDEX), sampleSize: 100, bundle });
  for (const l of formatReport(report)) log(l);
  return report.ok ? 0 : 1;
}

/** @param {string[]} argv @param {(line: string) => void} log */
async function dataVersionCommand(argv, log) {
  const { values } = parseArgs({ args: argv, options: { year: { type: 'string' }, offline: { type: 'boolean' }, 'max-age': { type: 'string' } }, strict: true });
  const modules = await productionModules({
    year: values.year ?? DEFAULT_ACAD_YEAR, offline: values.offline ?? false,
    maxAgeMs: values['max-age'] ? parseDuration(values['max-age']) : DEFAULT_MAX_AGE_MS,
  });
  log(`${modules.length} rows, data version ${await offlineDataVersion(modules)}`);
  return 0;
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 */
export async function main(argv, log = console.log) {
  const [command, ...rest] = argv;
  try {
    if (command === 'build') return await build(rest, log);
    if (command === 'fetch') {
      const { values } = parseArgs({ args: rest, options: { corpus: { type: 'string' } }, strict: true });
      if (values.corpus !== 'pinned' && values.corpus !== 'production') { log('fetch: --corpus must be pinned or production'); return 1; }
      await fetchBundle(values.corpus, { log });
      return 0;
    }
    if (command === 'standby') return await standby(rest, log);
    if (command === 'data-version') return await dataVersionCommand(rest, log);
  } catch (err) {
    log(`vectors: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
  log('usage: node scripts/vectors.mjs build|fetch|standby|data-version … (see the header of scripts/vectors.mjs)');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
