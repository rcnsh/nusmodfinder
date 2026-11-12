#!/usr/bin/env node
// @ts-check
// The vocabularies typo correction and prefix expansion read, built from the
// same corpus as the vectors bundle and bundled beside it, versioned the same
// way. Each records the data version of the corpus it was built
// from, as the bundle's manifest entry does (data/vectors.json):
//
//   node scripts/build-vocabulary.mjs --corpus production
//       data/vocabulary.json, the Worker's (src/intent-data.js): the corpus
//       `npm run ingest` writes, `current` in data/corpus.json
//       (`npm run corpus -- restore` first). Refused unless its row count and data
//       version are the production bundle's in data/vectors.json, so it can
//       only describe what production serves. `vectors.mjs build --corpus
//       production` rewrites it with the bundle.
//   node scripts/build-vocabulary.mjs --corpus fixture
//       test/fixtures/vocabulary.json, from the fixture corpus: what the
//       Worker tests search (vitest.config.mjs aliases it). Plus every
//       constraint-phrase word (data/constraint-phrases.json) the fixture's
//       434 texts lack, at df 1, so typo correction does not "correct" a
//       phrase the production vocabulary would leave alone (`hours` to
//       `tours`). Only here: buildVocabulary
//       builds every eval run's vocabulary and stays the corpus's alone.
//   add --check to rebuild in memory and exit 1 if the committed file differs.
//
// The pinned vocabulary is never committed: vitest.config.mjs builds it from
// the pinned corpus for test/full and the query suite (pinnedVocabularyPath),
// and every eval run builds its own from the run corpus with the ranker's own
// builder (eval/lib/corrected.mjs).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dataVersion, rowHash } from '../src/rowhash.js';
import { queryTokens } from '../src/fts-query.js';
import { ftsTerm } from '../src/porter.js';
import { buildVocabulary, serializeVocabulary } from '../src/vocabulary.js';
import { productionCorpus } from './corpus-manifest.mjs';
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
 * Every word of the constraint phrases, as queryTokens splits them, the N
 * placeholder (a number) left out.
 * @param {import('../src/intents.js').ConstraintPhrasesFile} phrases
 */
export function phraseWords(phrases) {
  const all = [phrases.exam, phrases.su, phrases.hoursBelow, phrases.prereq].flat();
  return [...new Set(all.flatMap((p) => queryTokens(p.replace(/\bN\b/g, ' '))))];
}

/**
 * The vocabulary with each of `words` it lacks added at df 1, its stems
 * recomputed and its rule saying so; unchanged when it lacks none.
 * @param {import('../src/vocabulary.js').VocabularyFile} file
 * @param {string[]} words
 * @returns {import('../src/vocabulary.js').VocabularyFile}
 */
export function withPhraseWords(file, words) {
  const terms = file.terms === '' ? [] : file.terms.split('\n');
  const have = new Set(terms);
  const added = [...new Set(words)].filter((w) => !have.has(w));
  if (added.length === 0) return file;
  const df = new Map(terms.map((t, i) => [t, file.df[i]]));
  for (const w of added) df.set(w, 1);
  const sorted = [...df.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const stems = [...new Set(sorted.map(ftsTerm))].filter((x) => x !== '').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ...file,
    rule: `${file.rule}; plus the words of data/constraint-phrases.json no document contains, each at df 1`,
    count: sorted.length, terms: sorted.join('\n'), df: sorted.map((t) => /** @type {number} */ (df.get(t))), stems: stems.join('\n'),
  };
}

/**
 * The production corpus as `npm run ingest` would write it: `current` (data/corpus.json), sha-checked.
 */
export async function productionModules() {
  return (await productionCorpus()).modules;
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
 */
export async function build(corpus) {
  if (corpus === 'fixture') {
    const { modules } = JSON.parse(await readFile(join(ROOT, 'test/fixtures/corpus.json'), 'utf8'));
    const phrases = JSON.parse(await readFile(join(ROOT, 'data/constraint-phrases.json'), 'utf8'));
    const file = buildVocabulary(modules, { corpus: 'fixture', dataVersion: await corpusDataVersion(modules) });
    return serializeVocabulary(withPhraseWords(file, phraseWords(phrases)));
  }
  if (corpus === 'pinned') return vocabularyBytes((await loadPinnedCorpus()).modules, 'pinned');
  const modules = await productionModules();
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
 * test/full and the query suite.
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
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, check: { type: 'boolean' } } });
  const corpus = values.corpus;
  if (corpus !== 'production' && corpus !== 'fixture') {
    console.error('usage: node scripts/build-vocabulary.mjs --corpus production|fixture [--check]');
    process.exit(1);
  }
  try {
    const bytes = await build(corpus);
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
