#!/usr/bin/env node
// @ts-check
// Phase 6 6A (docs/plans/phase6.md §3 "6A"): the NG-listed codes with no
// classes this year (src/ng-unscheduled-file.js), built per corpus the way the
// groups are (scripts/build-groups.mjs):
//
//   node scripts/build-ng-unscheduled.mjs --corpus production
//       data/ng-unscheduled.json, the Worker's (src/ng-unscheduled.js): every
//       code on data/ng-courses-<year>.json with no offered row, from
//       `current` (data/corpus.json, Phase 7 7D). Refused unless its
//       row count and data version are the production bundle's in
//       data/vectors.json. `vectors.mjs build --corpus production` rewrites it
//       with the bundle.
//   node scripts/build-ng-unscheduled.mjs --corpus fixture
//       test/fixtures/ng-unscheduled.json, from a small hand-kept source
//       (test/fixtures/ng-unscheduled-source.json: moduleInfo records copied from
//       a production corpus), its other codes matched against the fixture corpus.
//   add --check to rebuild in memory and exit 1 if the committed file differs.
//
// Each entry gets the fields a row has (scripts/lib.mjs normalise), its
// workload as /module/:code answers it, its group's other codes (groups-v1 run
// over the offered rows plus the file's codes, so FIN3701B joins FIN3701A, C
// and D), and the allow mask and rule ids ingest stores for a row
// (storedEligibility with the year's rules). The pinned file is never
// committed: vitest.config.mjs builds it for test/full and test/sc1
// (pinnedNgUnscheduledPath).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { storedEligibility } from '../src/eligibility.js';
import { GROUPS_VERSION, buildGroups } from '../src/groups.js';
import { NG_UNSCHEDULED_SCHEMA, serializeNgUnscheduled } from '../src/ng-unscheduled-file.js';
import { moduleWorkload } from '../src/workload.js';
import { assertProductionCorpus, corpusDataVersion } from './build-vocabulary.mjs';
import { CORPUS_MANIFEST_PATH, PROD_DIR, corpusPath, currentEntry, productionCorpus, readCorpusManifest } from './corpus-manifest.mjs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, normalise } from './lib.mjs';
import { loadPinnedCorpus } from './pinned-corpus.mjs';

export { NG_UNSCHEDULED_SCHEMA };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATOR = 'scripts/build-ng-unscheduled.mjs';

/** The committed files, repo-relative. */
export const OUTPUTS = Object.freeze({
  production: 'data/ng-unscheduled.json',
  fixture: 'test/fixtures/ng-unscheduled.json',
});
/** The fixture's hand-kept source, repo-relative. */
export const FIXTURE_SOURCE = 'test/fixtures/ng-unscheduled-source.json';

/** Where the production build reads `current` from (Phase 7 7D, `npm run corpus -- restore`). */
export const productionCorpusPath = async () => corpusPath(currentEntry(await readCorpusManifest(CORPUS_MANIFEST_PATH)), PROD_DIR);

/**
 * The file for `codes`, NG-listed codes with no offered row.
 * @param {{
 *   codes: string[], records: import('./lib.mjs').NusModsRecord[], offered: import('../src/groups.js').GroupInput[],
 *   ngCourses: import('./lib.mjs').NgCourses, acadYear: string, corpus: import('../src/ng-unscheduled-file.js').NgUnscheduledCorpus,
 *   dataVersion: string,
 * }} o
 * @returns {import('../src/ng-unscheduled-file.js').NgUnscheduledFile}
 */
export function unscheduledFile({ codes, records, offered, ngCourses, acadYear, corpus, dataVersion }) {
  if (!ngCourses.available || !ngCourses.rules) throw new Error(`no NG list or restrictions for ${acadYear}`);
  const rules = ngCourses.rules;
  const byCode = new Map(records.map((r) => [r.moduleCode, r]));
  const offeredCodes = new Set(offered.map((m) => m.code));
  const sorted = [...codes].sort();
  const modules = sorted.map((code) => {
    if (offeredCodes.has(code)) throw new Error(`${code} has an offered row`);
    const sems = ngCourses.bySem.get(code);
    if (!sems) throw new Error(`${code} is not on the ${acadYear} NG list`);
    const record = byCode.get(code);
    if (!record) throw new Error(`${code} is not in moduleInfo`);
    const { module, skipped } = normalise(record, acadYear);
    if (!module) throw new Error(`${code}: ${skipped}`);
    module.ng = true;
    module.ngSemesters = sems;
    return { module, ...storedEligibility(module, rules) };
  });
  const { groups } = buildGroups([...offered, ...modules.map(({ module: m }) => ({ code: m.code, title: m.title, description: m.description }))]);
  /** @type {Map<string, string[]>} */
  const groupOf = new Map();
  for (const g of groups) for (const code of g) groupOf.set(code, g);
  return {
    schema: NG_UNSCHEDULED_SCHEMA,
    generator: GENERATOR,
    corpus,
    acadYear,
    dataVersion,
    groups: GROUPS_VERSION,
    count: modules.length,
    modules: modules.map(({ module: m, ngAllow, ngRules }) => ({
      code: m.code, title: m.title, description: m.description, credits: m.credits, faculty: m.faculty,
      department: m.department, level: m.level, ngSemesters: m.ngSemesters, workload: moduleWorkload(m.workload),
      prerequisite: m.prerequisite, preclusion: m.preclusion, gradingBasis: m.gradingBasis,
      otherCodes: (groupOf.get(m.code) ?? []).filter((c) => c !== m.code), ngAllow, ngRules,
    })),
  };
}

/**
 * The NG-listed codes a corpus has no offered row for, and the file for them.
 * @param {import('./lib.mjs').NusModsRecord[]} records
 * @param {NormalisedModule[]} modules the corpus's offered rows
 * @param {import('../src/ng-unscheduled-file.js').NgUnscheduledCorpus} corpus
 * @param {string} acadYear
 */
async function corpusBytes(records, modules, corpus, acadYear) {
  const ngCourses = await loadNgCourses(acadYear);
  const offered = new Set(modules.map((m) => m.code));
  return serializeNgUnscheduled(unscheduledFile({
    codes: [...ngCourses.bySem.keys()].filter((c) => !offered.has(c)),
    records, offered: modules, ngCourses, acadYear, corpus, dataVersion: await corpusDataVersion(modules),
  }));
}

/** The production moduleInfo records: `current` (data/corpus.json), sha-checked. */
async function productionRecords() {
  return (await productionCorpus()).records;
}

/**
 * @param {'production' | 'pinned' | 'fixture'} corpus
 * @returns {Promise<string>}
 */
export async function build(corpus) {
  if (corpus === 'fixture') {
    const { modules } = JSON.parse(await readFile(join(ROOT, 'test/fixtures/corpus.json'), 'utf8'));
    const { records } = JSON.parse(await readFile(join(ROOT, FIXTURE_SOURCE), 'utf8'));
    return serializeNgUnscheduled(unscheduledFile({
      codes: records.map((/** @type {{ moduleCode: string }} */ r) => r.moduleCode), records, offered: modules,
      ngCourses: await loadNgCourses(DEFAULT_ACAD_YEAR), acadYear: DEFAULT_ACAD_YEAR, corpus: 'fixture',
      dataVersion: await corpusDataVersion(modules),
    }));
  }
  if (corpus === 'pinned') {
    const c = await loadPinnedCorpus();
    return corpusBytes(c.records, c.modules, 'pinned', c.acadYear);
  }
  const { records, modules, acadYear } = await productionCorpus();
  await assertProductionCorpus(modules);
  return corpusBytes(records, modules, 'production', acadYear);
}

/**
 * Writes the production file for the modules the production bundle was just
 * built from (scripts/vectors.mjs build --corpus production), reading the
 * records from `current`, which that build used.
 * @param {NormalisedModule[]} modules
 */
export async function writeProductionNgUnscheduled(modules) {
  await writeFile(join(ROOT, OUTPUTS.production), await corpusBytes(await productionRecords(), modules, 'production', DEFAULT_ACAD_YEAR));
  return OUTPUTS.production;
}

/** The pinned file as a file (.data/ng-unscheduled/, git-ignored), rebuilt if absent or stale. */
export async function pinnedNgUnscheduledPath() {
  const bytes = await build('pinned');
  const path = join(ROOT, '.data/ng-unscheduled/ng-unscheduled-pinned.json');
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== bytes) {
    await mkdir(join(ROOT, '.data/ng-unscheduled'), { recursive: true });
    await writeFile(path, bytes);
  }
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, check: { type: 'boolean' } } });
  const corpus = values.corpus;
  if (corpus !== 'production' && corpus !== 'fixture') {
    console.error('usage: node scripts/build-ng-unscheduled.mjs --corpus production|fixture [--check]');
    process.exit(1);
  }
  try {
    const bytes = await build(corpus);
    const path = join(ROOT, OUTPUTS[corpus]);
    if (values.check) {
      const have = existsSync(path) ? await readFile(path, 'utf8') : null;
      if (have !== bytes) { console.error(`${OUTPUTS[corpus]} is out of date (node scripts/build-ng-unscheduled.mjs --corpus ${corpus})`); process.exitCode = 1; }
      else console.log(`${OUTPUTS[corpus]} is up to date`);
    } else {
      await writeFile(path, bytes);
      const f = JSON.parse(bytes);
      console.log(`wrote ${OUTPUTS[corpus]}: ${f.count} NG-listed codes with no classes, ${f.acadYear}, data version ${f.dataVersion}`);
    }
  } catch (err) {
    console.error(`build-ng-unscheduled: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}
