#!/usr/bin/env node
// @ts-check
// The corpus data the code parser reads, never built from the network.
//
// Per corpus (they follow the corpus, as the vocabulary and groups do):
//   prefixes.json        the letter parts of offered codes, with their module counts;
//   catalogue-codes.json the catalogue-only codes (in moduleInfo.json, no offering
//                        in the corpus's year), sorted: what the Worker bundles
//                        (`catalogue-codes-data`, `prefixes-data`);
//   catalogue-only.json  the same codes with their titles and descriptions (noMatch
//                        `not-offered`): the rows ingest loads into D1 `catalogue_only`.
// `--corpus production` builds them under data/ from `current` (data/corpus.json,
// scripts/corpus-manifest.mjs), what wrangler.jsonc ships. `--corpus pinned` builds the
// prefixes and catalogue codes under data/pinned/ from the pinned corpus
// (scripts/pinned-corpus.mjs, sha-checked): what the Worker tests, test/full and every eval
// run search with; the pinned catalogue-only.json is built in memory for test/full
// (pinnedCatalogueOnlyPath). The pinned build also writes the files that are no corpus's:
//   ge-pillars.json      the GE pillar table, from eval/query-rules/ge-pillars.json;
//   collision-list.json  the collision list and its exempt pillar prefixes,
//                        from eval/query-rules/collision-list.json (the Worker cannot read eval/);
//   constraint-phrases.json  the constraint phrase lists (no exam, S/U,
//                        workload, prerequisite), from eval/query-rules/intent-phrases.json
//                        `constraints`, for parse pass A;
//   cohort-only-prereq.json  the cohort-only prerequisite rule, from
//                        eval/query-rules/cohort-only-prereq.json (normalise() reads it, and
//                        the eval workspace has data/ but not eval/).
//
//   node scripts/build-catalogue-data.mjs --corpus production|pinned            write the corpus's files
//   node scripts/build-catalogue-data.mjs --corpus production|pinned --check    exit 1 if a committed one differs
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { productionCorpus } from './corpus-manifest.mjs';
import { catalogueOnlyRecords } from './lib.mjs';
import { loadPinnedCorpus, PINNED_RELEASE } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The per-corpus files, relative to the repo root. The pinned catalogue-only rows are never committed. */
export const CORPUS_OUTPUTS = Object.freeze({
  production: Object.freeze({ prefixes: 'data/prefixes.json', catalogueCodes: 'data/catalogue-codes.json', catalogueOnly: 'data/catalogue-only.json' }),
  pinned: Object.freeze({ prefixes: 'data/pinned/prefixes.json', catalogueCodes: 'data/pinned/catalogue-codes.json' }),
});

/** The files that are no corpus's (written by the pinned build), relative to the repo root. */
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

/**
 * A corpus's prefixes, catalogue codes and catalogue-only rows, as the bytes each file holds.
 * @param {{ records: import('./lib.mjs').NusModsRecord[], modules: { code: string }[], source: CorpusSource, label?: string }} c
 *   `label` names the corpus in the files' rule lines ('pinned' keeps the pinned files' wording).
 */
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
    // One row per line, so a catalogue change diffs by row.
    catalogueOnly: `{"schema":"vnm-3b-catalogue-only/1","source":${JSON.stringify(source)},"columns":["code","title","description"],"count":${catalogue.length},"rows":[\n${
      catalogue.map((r) => JSON.stringify([r.code, r.title, r.description])).join(',\n')}\n]}\n`,
  };
}

/**
 * The committed files, of `byPath` (repo-relative path -> the bytes it should hold), that differ
 * or are missing under `root`, in `byPath`'s order.
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
 * Every file a corpus's build owns, as repo-relative path -> bytes.
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

/**
 * The pinned catalogue-only rows as a file (.data/catalogue/, git-ignored), rebuilt if absent or
 * stale: what vitest.config.mjs aliases `catalogue-only-data` to for test/full.
 */
export async function pinnedCatalogueOnlyPath() {
  const { files } = await pinnedBuild();
  const path = join(ROOT, '.data/catalogue/catalogue-only-pinned.json');
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== files.catalogueOnly) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files.catalogueOnly);
  }
  return path;
}

/** The pinned corpus's files and the shared files. */
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
