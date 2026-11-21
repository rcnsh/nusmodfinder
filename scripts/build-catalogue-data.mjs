#!/usr/bin/env node
// @ts-check
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { productionCorpus } from './corpus-manifest.mjs';
import { catalogueOnlyRecords } from './lib.mjs';
import { loadPinnedCorpus, PINNED_RELEASE } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const CORPUS_OUTPUTS = Object.freeze({
  production: Object.freeze({ prefixes: 'data/prefixes.json', catalogueCodes: 'data/catalogue-codes.json', catalogueOnly: 'data/catalogue-only.json' }),
  pinned: Object.freeze({ prefixes: 'data/pinned/prefixes.json', catalogueCodes: 'data/pinned/catalogue-codes.json' }),
});

export const SHARED_OUTPUTS = Object.freeze({
  gePillars: 'data/ge-pillars.json',
  collisionList: 'data/collision-list.json',
  cohortOnly: 'data/cohort-only-prereq.json',
  constraintPhrases: 'data/constraint-phrases.json',
});

/**
 * @typedef {{ release: string, acadYear: string, moduleInfoSha256: string }} CorpusSource
 */

/** @param {string} rel */
const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
/** @param {string} code */
const lettersOf = (code) => /** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(code))[0];
const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {{ records: import('./lib.mjs').NusModsRecord[], modules: { code: string }[], source: CorpusSource, label?: string }} c */
export function corpusFiles({ records, modules, source, label = 'production' }) {
  const offered = modules.map((m) => m.code).sort(byCode);
  /** @type {Record<string, number>} */
  const prefixCounts = {};
  for (const c of offered) prefixCounts[lettersOf(c)] = (prefixCounts[lettersOf(c)] ?? 0) + 1;
  const prefixes = Object.keys(prefixCounts).sort(byCode);
  const catalogue = catalogueOnlyRecords(records).sort((a, b) => byCode(a.code, b.code));
  const year = label === 'pinned' ? 'the pinned year' : 'the corpus\'s year';
  return {
    prefixes: `${JSON.stringify({
      schema: 'vnm-3b-prefixes/1', source, rule: `the letter part of every offered code in the ${label} corpus, with its offered-module count`,
      count: prefixes.length, prefixes: Object.fromEntries(prefixes.map((p) => [p, prefixCounts[p]])),
    }, null, 1)}\n`,
    catalogueCodes: `${JSON.stringify({
      schema: 'vnm-3b-catalogue-codes/1', source, rule: `codes in moduleInfo.json with no offering in ${year} (catalogue-only), sorted`,
      count: catalogue.length, codes: catalogue.map((r) => r.code),
    })}\n`,
    catalogueOnly: `{"schema":"vnm-3b-catalogue-only/1","source":${JSON.stringify(source)},"columns":["code","title","description"],"count":${catalogue.length},"rows":[\n${
      catalogue.map((r) => JSON.stringify([r.code, r.title, r.description])).join(',\n')}\n]}\n`,
  };
}

/**
 * @param {Record<string, string>} byPath
 * @param {string} [root]
 */
export async function staleFiles(byPath, root = ROOT) {
  const stale = [];
  for (const [rel, want] of Object.entries(byPath)) {
    const have = await readFile(join(root, rel), 'utf8').catch(() => null);
    if (have !== want) stale.push(rel);
  }
  return stale;
}

/**
 * @param {'production' | 'pinned'} corpus
 * @returns {Promise<Record<string, string>>}
 */
export async function build(corpus) {
  if (corpus === 'production') {
    const c = await productionCorpus();
    const out = corpusFiles({ records: c.records, modules: c.modules, source: { release: c.entry.release, acadYear: c.acadYear, moduleInfoSha256: c.entry.sha256 } });
    return Object.fromEntries(Object.entries(CORPUS_OUTPUTS.production).map(([k, rel]) => [rel, out[/** @type {keyof typeof out} */ (k)]]));
  }
  const { files, shared } = await pinnedBuild();
  return {
    ...Object.fromEntries(Object.entries(CORPUS_OUTPUTS.pinned).map(([k, rel]) => [rel, files[/** @type {keyof typeof files} */ (k)]])),
    ...Object.fromEntries(Object.entries(SHARED_OUTPUTS).map(([k, rel]) => [rel, shared[/** @type {keyof typeof shared} */ (k)]])),
  };
}

export async function pinnedCatalogueOnlyPath() {
  const { files } = await pinnedBuild();
  const path = join(ROOT, '.data/catalogue/catalogue-only-pinned.json');
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== files.catalogueOnly) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files.catalogueOnly);
  }
  return path;
}

async function pinnedBuild() {
  const corpus = await loadPinnedCorpus();
  const source = { release: PINNED_RELEASE, acadYear: corpus.acadYear, moduleInfoSha256: corpus.moduleInfoSha256 };
  const ge = await readJson('eval/query-rules/ge-pillars.json');
  const collision = await readJson('eval/query-rules/collision-list.json');
  const cohort = await readJson('eval/query-rules/cohort-only-prereq.json');
  const phrases = await readJson('eval/query-rules/intent-phrases.json');

  const json = (/** @type {unknown} */ v) => `${JSON.stringify(v, null, 1)}\n`;
  return {
    files: corpusFiles({ records: corpus.records, modules: corpus.modules, source, label: 'pinned' }),
    shared: {
      gePillars: json({
        schema: 'vnm-3b-ge-pillars/1', from: 'eval/query-rules/ge-pillars.json (copied unchanged)',
        source: { url: ge.source.url, check: 'one fetch returned an empty body, so the URL and pillar names are unconfirmed; each prefix matches the pinned corpus' },
        prefixes: ge.prefixes, genericPhrases: ge.genericPhrases, pillars: ge.pillars,
      }),
      collisionList: json({
        schema: 'vnm-3b-collision-list/1', from: 'eval/query-rules/collision-list.json (copied unchanged)',
        list: collision.list, exempt: collision.exempt,
      }),
      cohortOnly: json({
        schema: 'vnm-3h-cohort-only/1', from: 'eval/query-rules/cohort-only-prereq.json (copied unchanged)',
        normalise: cohort.normalise, remove: cohort.remove, remainder: cohort.remainder, remainderFlags: cohort.remainderFlags,
      }),
      constraintPhrases: json({
        schema: 'vnm-3h-constraint-phrases/1', from: 'eval/query-rules/intent-phrases.json `constraints` (copied unchanged)',
        exam: phrases.constraints.exam.phrases, su: phrases.constraints.su.phrases,
        hoursBelow: phrases.constraints.hoursBelow.phrases, light: phrases.constraints.hoursBelow.light,
        prereq: phrases.constraints.prereq.phrases,
      }),
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, corpus: { type: 'string' } } });
  const corpus = values.corpus;
  if (corpus !== 'production' && corpus !== 'pinned') {
    console.error('usage: node scripts/build-catalogue-data.mjs --corpus production|pinned [--check]');
    process.exit(1);
  }
  try {
    const out = await build(corpus);
    if (values.check) {
      const stale = await staleFiles(out);
      if (stale.length) { console.error(`out of date: ${stale.join(', ')} (node scripts/build-catalogue-data.mjs --corpus ${corpus})`); process.exitCode = 1; }
      else console.log(`catalogue data (${corpus}) up to date`);
    } else {
      for (const [rel, bytes] of Object.entries(out)) {
        await mkdir(dirname(join(ROOT, rel)), { recursive: true });
        await writeFile(join(ROOT, rel), bytes);
        console.log(`wrote ${rel}`);
      }
    }
  } catch (err) {
    console.error(`build-catalogue-data: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}
