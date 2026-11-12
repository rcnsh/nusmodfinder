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
//       [--embedding <version>] [--extra <cache.json> ...]
//       .data/vectors/vec-production-<dataVersion>-<embedding>.bin: the
//       corpus ingest will write, `current` in data/corpus.json (Phase 7 7D;
//       `npm run corpus -- restore` first), with the NG files of its year,
//       vectors reused by key from the eval asset and the --extra caches.
//       Texts in neither are written to .data/vectors/missing-production.json
//       and the build stops: embed them with
//       `npm run eval:embed -- --texts <that file> --out <cache.json>`, then
//       rebuild with --extra <cache.json>. Also writes src/data-version.json,
//       computed offline from the rows ingest will write (B3-4), and
//       data/vocabulary.json, 3C's vocabulary of the same corpus
//       (scripts/build-vocabulary.mjs), data/groups.json, 3F's duplicate
//       groups (scripts/build-groups.mjs), and data/ng-unscheduled.json, 6A's
//       NG-listed codes with no classes (scripts/build-ng-unscheduled.mjs).
//
// Each build records the bundle in data/vectors.json: data version, embedding
// version, count, sha256 and rowsKey, the sha256 of the sorted
// (code, textHash) pairs (B-2). A row with no textHash is refused (A-N6).
//
//   node scripts/vectors.mjs fetch --corpus pinned|production
//       Downloads the release asset into .data/vectors/ if absent (gh), checks
//       its sha256 against data/vectors.json, and writes the module the
//       `vectors-bundle` alias points at.
//   node scripts/vectors.mjs data-version
//       Prints the data version of the rows ingest would write (B3-4).
//   npm run remote -- vectors standby [--deletes <file>]
//   node scripts/vectors.mjs standby --url <a wrangler dev --remote> [--deletes <file>]
//       Runbook step 8: upsert every code with the production bundle's
//       values and D1's metadata, delete step 4's deletions, wait for the
//       mutation, then verify (metadata, the id list, and a getByIds sample
//       of values against the bundle). Needs INGEST_SECRET, as ingest does,
//       and --url or WORKER_URL (no default; ports 8787 and 8799 refused). Writes
//       a run record (scripts/run-record.mjs, Phase 7 7C).
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
import { build as build3b } from './build-3b-data.mjs';
import { writeProductionGroups } from './build-groups.mjs';
import { writeProductionNgUnscheduled } from './build-ng-unscheduled.mjs';
import { writeProductionVocabulary } from './build-vocabulary.mjs';
import { dataVersionFile, httpAdminApi, parseDuration, DATA_VERSION_PATH } from './ingest.mjs';
import { workerUrl } from './remote-session.mjs';
import { startRun } from './run-record.mjs';
import { productionCorpus } from './corpus-manifest.mjs';
import { loadPinnedCorpus } from './pinned-corpus.mjs';
import { runStandby } from './vectors-core.mjs';
import {
  D1_ONLY_DELETES_PATH, FIXTURE_BUNDLE, FIXTURE_CORPUS, FIXTURE_EMBEDDING, MISSING_PATH, PINNED_COUNT, ROOT, VECTORS_DIR,
  assetName, fetchBundle, loadCheckedBundle, readVectorsManifest, sha256, writeShim, writeVectorsManifest,
} from './vectors-manifest.mjs';
import { run } from './deploy.mjs';
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
 * The corpus `npm run ingest` would write, from the same source and normaliser: `current`
 * (data/corpus.json), sha-checked, with the NG files of its year.
 */
export async function productionModules() {
  return (await productionCorpus()).modules;
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
      'expect-count': { type: 'string' },
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
    modules = await productionModules();
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
    log(`then: node scripts/vectors.mjs build --corpus production --expect-count ${expected} --extra .data/vectors/extra-production.json`);
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
    log(`  ${await writeProductionVocabulary(modules)} -> the 3C vocabulary of the same corpus`);
    log(`  ${await writeProductionGroups(modules)} -> the 3F duplicate groups of the same corpus`);
    log(`  ${await writeProductionNgUnscheduled(modules)} -> 6A's NG-listed codes with no classes, from the same moduleInfo`);
    // Phase 7 7D: the catalogue codes, prefixes and catalogue-only rows of the same corpus.
    for (const [rel, bytes] of Object.entries(await build3b('production'))) {
      await writeFile(join(ROOT, rel), bytes);
      log(`  ${rel} -> 3B's per-corpus file, from the same moduleInfo`);
    }
  }
  log(`upload: gh release create ${asset.replace(/\.bin$/, '')} ${relative(ROOT, bin)} --title "${asset}" --notes "vectors bundle, sha256 ${manifest.bundles[corpus]?.sha256}"`);
  log('then commit data/vectors.json' + (corpus === 'production' ? ', src/data-version.json, data/vocabulary.json, data/groups.json, data/ng-unscheduled.json and the 3B files (runbook step 1)' : ''));
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
 * What standby reaches for, injectable for tests.
 * @typedef {{
 *   fetchImpl?: typeof fetch, envVars?: Record<string, string | undefined>, runsDir?: string,
 *   loadBundle?: () => Promise<{ entry: { asset?: string }, bundle: ReturnType<typeof parseBundle> }>,
 *   listIds?: () => Promise<string[]>, runStandby?: typeof runStandby, runVerify?: typeof runVerify, formatReport?: typeof formatReport,
 * }} StandbyDeps
 */

/** The production bundle, sha-checked. */
async function productionBundle() {
  const entry = (await readVectorsManifest()).bundles.production;
  if (!entry) throw new Error('data/vectors.json has no production bundle.');
  return { entry, bundle: (await loadCheckedBundle(entry)).bundle };
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} log
 * @param {StandbyDeps} [deps]
 */
async function standby(argv, log, deps = {}) {
  const {
    fetchImpl = fetch, envVars = process.env, runsDir, loadBundle = productionBundle, listIds: listIdsRaw,
    runStandby: standbyRun = runStandby, runVerify: verifyRun = runVerify, formatReport: format = formatReport,
  } = deps;
  const { values } = parseArgs({ args: argv, options: { url: { type: 'string' }, deletes: { type: 'string' }, 'wait-timeout': { type: 'string' } }, strict: true });
  const secret = envVars.INGEST_SECRET;
  if (!secret) { log('INGEST_SECRET is not set. Run it through `npm run remote -- vectors standby`.'); return 2; }
  const worker = workerUrl(values.url, envVars);
  if (worker.error !== undefined) { log(`standby: ${worker.error} Nothing was sent.`); return 2; }
  const base = worker.base;
  const record = startRun('vectors standby', { target: envVars.VNM_REMOTE_TARGET ? `${base} (${envVars.VNM_REMOTE_TARGET})` : base, args: argv, dir: runsDir });
  const unguard = record.guardExit();
  /** @param {number} code @param {import('./run-record.mjs').Outcome} outcome @param {string | null} message */
  const done = (code, outcome, message) => { unguard(); record.finish(outcome, { exitCode: code, message }); return code; };
  /** Each `wrangler vectorize list-vectors` page is a Cloudflare API call. @type {import('./deploy.mjs').Exec} */
  const countedExec = (cmd, args, opts) => {
    if (cmd === 'npx' && args[0] === 'wrangler') record.request(`wrangler ${args.slice(1, 3).join(' ')}`);
    return run(cmd, args, opts);
  };
  const listIds = listIdsRaw ?? (() => listVectorIds(DEFAULT_INDEX, countedExec));
  try {
    const { entry, bundle } = await loadBundle();
    const deletesPath = values.deletes ?? D1_ONLY_DELETES_PATH;
    /** @type {string[]} */
    const deletes = existsSync(deletesPath) ? JSON.parse(await readFile(deletesPath, 'utf8')).codes ?? [] : [];
    log(`standby: ${bundle.count} vectors from ${entry.asset} (sha256 ok), ${deletes.length} deletions${deletes.length ? ` from ${relative(ROOT, deletesPath)}` : ''}`);
    const api = httpAdminApi(base, secret, record.countingFetch(fetchImpl));
    const result = await standbyRun({
      api, bundle, deletes, log, listVectorIds: listIds,
      ...(values['wait-timeout'] ? { waitTimeoutMs: parseDuration(values['wait-timeout']) } : {}),
    });
    record.wrote('Vectorize vectors upserted', { estimate: bundle.count, actual: result.upserted ?? null });
    record.wrote('Vectorize vectors deleted', { estimate: deletes.length, actual: result.deleted ?? null });
    if (result.lastMutationId) record.version('lastMutationId', result.lastMutationId);
    if (result.status !== 'done') {
      return result.status === 'wait-timeout' ? done(3, 'partial', 'Vectorize did not confirm the last mutation in time')
        : done(1, result.status === 'refused' ? 'refused' : 'failed', result.message ?? result.status);
    }
    const report = await verifyRun({ api, listVectorIds: listIds, sampleSize: 100, bundle });
    for (const l of format(report)) log(l);
    if (typeof report.rowsRead === 'number') record.read('D1 rows (/admin/verify)', { actual: report.rowsRead });
    return report.ok ? done(0, 'ok', 'standby done; D1 and Vectorize agree') : done(1, 'failed', 'drift after the standby');
  } catch (err) {
    done(1, 'failed', String(/** @type {Error} */ (err).message).split('\n')[0]);
    throw err;
  }
}

/** @param {string[]} argv @param {(line: string) => void} log */
async function dataVersionCommand(argv, log) {
  parseArgs({ args: argv, options: {}, strict: true });
  const modules = await productionModules();
  log(`${modules.length} rows, data version ${await offlineDataVersion(modules)}`);
  return 0;
}

/**
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @param {StandbyDeps} [deps] for `standby`
 */
export async function main(argv, log = console.log, deps = {}) {
  const [command, ...rest] = argv;
  try {
    if (command === 'build') return await build(rest, log);
    if (command === 'fetch') {
      const { values } = parseArgs({ args: rest, options: { corpus: { type: 'string' } }, strict: true });
      if (values.corpus !== 'pinned' && values.corpus !== 'production') { log('fetch: --corpus must be pinned or production'); return 1; }
      await fetchBundle(values.corpus, { log });
      return 0;
    }
    if (command === 'standby') return await standby(rest, log, deps);
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
