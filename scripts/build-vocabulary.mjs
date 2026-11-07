#!/usr/bin/env node
// @ts-check
// The 3C vocabularies (docs/plans/phase3.md "3C Typos and prefixes": "built
// from the same corpus as the vectors bundle and ships beside it, versioned
// the same way"). Each records the data version of the corpus it was built
// from, as the bundle's manifest entry does (data/vectors.json):
//
//   node scripts/build-vocabulary.mjs --corpus production [--online]
//       data/vocabulary.json, the Worker's (src/intent-data.js): the corpus
//       `npm run ingest` writes, read from the .data/cache NUSMods download
//       (offline unless --online). Refused unless its row count and data
//       version are the production bundle's in data/vectors.json, so it can
//       only describe what production serves. `vectors.mjs build --corpus
//       production` rewrites it with the bundle.
//   node scripts/build-vocabulary.mjs --corpus fixture
//       test/fixtures/vocabulary.json, from the fixture corpus: what the
//       Worker tests search (vitest.config.mjs aliases it).
//   add --check to rebuild in memory and exit 1 if the committed file differs.
//
// The pinned vocabulary is never committed: vitest.config.mjs builds it from
// the pinned corpus for test/full and the SC4 suite (pinnedVocabularyPath),
// and every eval run builds its own from the run corpus with the ranker's own
// builder (eval/lib/corrected.mjs).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dataVersion, rowHash } from '../src/rowhash.js';
import { buildVocabulary, serializeVocabulary } from '../src/vocabulary.js';
import { DEFAULT_ACAD_YEAR, assertExpectedShape, fetchAcadYearFile, loadNgCourses, offeredModules } from './lib.mjs';
import { loadPinnedCorpus } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The committed vocabularies, repo-relative. */
export const OUTPUTS = Object.freeze({
  production: 'data/vocabulary.json',
  fixture: 'test/fixtures/vocabulary.json',
});

/** @param {NormalisedModule[]} modules */
export async function corpusDataVersion(modules) {
  return dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));
}

/**
 * The vocabulary file's bytes for modules of a corpus.
 * @param {NormalisedModule[]} modules
 * @param {import('../src/vocabulary.js').VocabularyCorpus} corpus
 */
export async function vocabularyBytes(modules, corpus) {
  return serializeVocabulary(buildVocabulary(modules, { corpus, dataVersion: await corpusDataVersion(modules) }));
}

/**
 * The production corpus as `npm run ingest` would write it, from the NUSMods
 * download cache (offline by default: no network).
 * @param {{ online?: boolean }} [o]
 */
async function productionModules({ online = false } = {}) {
  const info = await fetchAcadYearFile(DEFAULT_ACAD_YEAR, 'moduleInfo.json', { offline: !online });
  assertExpectedShape(info.data);
  return offeredModules(info.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR)).modules;
}

/**
 * Refuses a production vocabulary that is not for the production bundle's corpus.
 * @param {NormalisedModule[]} modules
 */
export async function assertProductionCorpus(modules) {
  const entry = JSON.parse(await readFile(join(ROOT, 'data/vectors.json'), 'utf8')).bundles.production;
  if (!entry) throw new Error('data/vectors.json has no production bundle to version the vocabulary with');
  const dv = await corpusDataVersion(modules);
  if (modules.length !== entry.count || dv !== entry.dataVersion) {
    throw new Error(`the production corpus here has ${modules.length} rows, data version ${dv}; the production bundle has `
      + `${entry.count}, ${entry.dataVersion}. Build the vocabulary from the corpus the bundle was built from.`);
  }
}

/**
 * @param {'production' | 'pinned' | 'fixture'} corpus
 * @param {{ online?: boolean }} [o]
 */
export async function build(corpus, o = {}) {
  if (corpus === 'fixture') {
    const { modules } = JSON.parse(await readFile(join(ROOT, 'test/fixtures/corpus.json'), 'utf8'));
    return vocabularyBytes(modules, 'fixture');
  }
  if (corpus === 'pinned') return vocabularyBytes((await loadPinnedCorpus()).modules, 'pinned');
  const modules = await productionModules(o);
  await assertProductionCorpus(modules);
  return vocabularyBytes(modules, 'production');
}

/**
 * Writes the production vocabulary for modules the production bundle was just
 * built from (scripts/vectors.mjs build --corpus production).
 * @param {NormalisedModule[]} modules
 */
export async function writeProductionVocabulary(modules) {
  await writeFile(join(ROOT, OUTPUTS.production), await vocabularyBytes(modules, 'production'));
  return OUTPUTS.production;
}

/**
 * The pinned vocabulary as a file (.data/vocabulary/, git-ignored), built from
 * the pinned corpus if absent or stale: what vitest.config.mjs aliases for
 * test/full and the SC4 suite.
 */
export async function pinnedVocabularyPath() {
  const bytes = await build('pinned');
  const path = join(ROOT, '.data/vocabulary/vocabulary-pinned.json');
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== bytes) {
    await mkdir(join(ROOT, '.data/vocabulary'), { recursive: true });
    await writeFile(path, bytes);
  }
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, check: { type: 'boolean' }, online: { type: 'boolean' } } });
  const corpus = values.corpus;
  if (corpus !== 'production' && corpus !== 'fixture') {
    console.error('usage: node scripts/build-vocabulary.mjs --corpus production|fixture [--check] [--online]');
    process.exit(1);
  }
  try {
    const bytes = await build(corpus, { online: values.online });
    const path = join(ROOT, OUTPUTS[corpus]);
    if (values.check) {
      const have = existsSync(path) ? await readFile(path, 'utf8') : null;
      if (have !== bytes) { console.error(`${OUTPUTS[corpus]} is out of date (node scripts/build-vocabulary.mjs --corpus ${corpus})`); process.exitCode = 1; }
      else console.log(`${OUTPUTS[corpus]} is up to date`);
    } else {
      await writeFile(path, bytes);
      const v = JSON.parse(bytes);
      console.log(`wrote ${OUTPUTS[corpus]}: ${v.count} terms, ${v.documents} documents, data version ${v.dataVersion}, ${Buffer.byteLength(bytes)} B`);
    }
  } catch (err) {
    console.error(`build-vocabulary: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}
