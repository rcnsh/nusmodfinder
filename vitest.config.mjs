// @ts-check
// Tests run inside workerd via @cloudflare/vitest-plugin, against
// test/wrangler.test.jsonc: the production config minus AI, Vectorize and the
// rate limiter, with remoteBindings off, so nothing can reach a metered
// Cloudflare service. Fakes for those bindings live in test/fakes.js.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { pinnedCatalogueOnlyPath } from './scripts/build-catalogue-data.mjs';
import { productionCorpus } from './scripts/corpus-manifest.mjs';
import { pinnedGroupsPath } from './scripts/build-groups.mjs';
import { pinnedNgUnscheduledPath } from './scripts/build-ng-unscheduled.mjs';
import { pinnedVocabularyPath } from './scripts/build-vocabulary.mjs';
import { loadPinnedCorpus, MODULE_INFO_PATH } from './scripts/pinned-corpus.mjs';
import { loadCheckedBundle, localPath, readVectorsManifest, writeShim } from './scripts/vectors-manifest.mjs';

/**
 * The full pinned corpus for test/full, or null when it is unavailable.
 * With FULL_CORPUS=1 (set only by the full-corpus CI job) a missing or
 * mismatched corpus fails the run here, on the Node side, so test/full can
 * never pass by skipping.
 * @returns {Promise<FullCorpus | null>}
 */
async function fullCorpus() {
  const required = process.env.FULL_CORPUS === '1';
  if (!required && !existsSync(MODULE_INFO_PATH)) return null;
  try {
    const c = await loadPinnedCorpus();
    return asFullCorpus({ ...c, moduleInfoSha256: c.moduleInfoSha256 });
  } catch (err) {
    if (required) throw err;
    console.warn(`full corpus unavailable, test/full will skip: ${/** @type {Error} */ (err).message}`);
    return null;
  }
}

/**
 * What a corpus project is given as `corpus`.
 * @param {{ acadYear: string, moduleInfoSha256: string, records: any[], modules: NormalisedModule[], skipped: { code: string, why: string }[],
 *   ng: FullCorpus['ng'] }} c
 * @returns {FullCorpus}
 */
function asFullCorpus(c) {
  const names = (/** @type {'department' | 'faculty'} */ k) => [...new Set(c.records.map((r) => r[k]).filter((v) => typeof v === 'string'))].sort();
  return {
    acadYear: c.acadYear,
    moduleInfoSha256: c.moduleInfoSha256,
    recordCount: c.records.length,
    offeredCodes: c.records.filter((r) => (r.semesterData ?? []).length > 0).map((r) => String(r.moduleCode)),
    modules: c.modules,
    skipped: c.skipped,
    ng: c.ng,
    departments: names('department'),
    faculties: names('faculty'),
  };
}

/**
 * CI on the live year: what the oracle and oracle-node projects search, `current`
 * (data/corpus.json, restored by `npm run corpus -- restore`) normalised with HEAD's NG files, and
 * the production bundle, sha-checked. With PRODUCTION_CORPUS=1 (set only by the oracle CI job, after
 * the restore and `node scripts/vectors.mjs fetch --corpus production`) a missing or mismatched
 * one fails the run here; otherwise both are null and those projects skip.
 * @returns {Promise<{ corpus: FullCorpus, bundle: string } | null>}
 */
async function productionData() {
  const required = process.env.PRODUCTION_CORPUS === '1';
  try {
    const c = await productionCorpus();
    const entry = (await readVectorsManifest()).bundles.production;
    if (!entry) throw new Error('data/vectors.json records no production bundle');
    const path = localPath(entry);
    if (!existsSync(path)) throw new Error(`no production bundle at ${path}: node scripts/vectors.mjs fetch --corpus production`);
    await loadCheckedBundle(entry, path);
    const ngJson = JSON.parse(readFileSync(new URL(`./data/ng-courses-${c.acadYear}.json`, import.meta.url), 'utf8'));
    return {
      corpus: asFullCorpus({ ...c, moduleInfoSha256: c.entry.sha256, ng: { updatedAsAt: ngJson.updatedAsAt ?? null, semesters: ngJson.semesters ?? {} } }),
      bundle: await writeShim(path),
    };
  } catch (err) {
    if (required) throw err;
    return null;
  }
}

/** The committed fixture vectors bundle (scripts/vectors.mjs build --corpus fixture). */
const FIXTURE_BUNDLE = fileURLToPath(new URL('./test/fixtures/vectors.js', import.meta.url));

/**
 * What test/full searches: the pinned bundle, the 6,771
 * pinned modules with the eval's corpus vectors, sha-checked against
 * data/vectors.json, so full-corpus tests search the catalogue the eval
 * scores. With FULL_CORPUS=1 (the full-corpus CI job, after
 * `node scripts/vectors.mjs fetch --corpus pinned`) a missing or mismatched
 * bundle fails the run; otherwise test/full falls back to the fixture bundle
 * and its pinned-bundle tests skip.
 * @returns {Promise<{ alias: string, corpus: 'pinned' | 'fixture' }>}
 */
async function fullBundle() {
  const required = process.env.FULL_CORPUS === '1';
  try {
    const entry = (await readVectorsManifest()).bundles.pinned;
    if (!entry) throw new Error('data/vectors.json records no pinned bundle');
    const path = localPath(entry);
    if (!existsSync(path)) throw new Error(`no pinned bundle at ${path}: node scripts/vectors.mjs fetch --corpus pinned`);
    await loadCheckedBundle(entry, path);
    return { alias: await writeShim(path), corpus: 'pinned' };
  } catch (err) {
    if (required) throw err;
    return { alias: FIXTURE_BUNDLE, corpus: 'fixture' };
  }
}

/** The committed fixture vocabulary (scripts/build-vocabulary.mjs --corpus fixture). */
const FIXTURE_VOCABULARY = fileURLToPath(new URL('./test/fixtures/vocabulary.json', import.meta.url));

/**
 * The vocabulary import in src/intent-data.js (the bare name),
 * pointed at the vocabulary of the corpus a project searches, never the
 * production one (data/).
 * @param {string} path
 */
const vocabularyAlias = (path) => ({ find: 'vocabulary-data', replacement: path });
/** The committed fixture groups (scripts/build-groups.mjs --corpus fixture). */
const FIXTURE_GROUPS = fileURLToPath(new URL('./test/fixtures/groups.json', import.meta.url));
/** The groups import in src/group-data.js (the bare name), pointed at the groups of the corpus the tests search. @param {string} path */
const groupsAlias = (path) => ({ find: 'groups-data', replacement: path });
/** The committed fixture's NG-listed codes with no classes (scripts/build-ng-unscheduled.mjs --corpus fixture). */
const FIXTURE_NG_UNSCHEDULED = fileURLToPath(new URL('./test/fixtures/ng-unscheduled.json', import.meta.url));
/** The import in src/ng-unscheduled.js (the bare name), pointed at the file of the corpus the tests search. @param {string} path */
const ngUnscheduledAlias = (path) => ({ find: 'ng-unscheduled-data', replacement: path });
/**
 * src/intent-data.js's catalogue codes and prefixes (bare names), the files of the
 * corpus a project searches: data/pinned/ (the pinned corpus, from which the fixture is drawn) or
 * data/ (`current`, what production ships). `catalogue-only-data` is what the corpus tests seed
 * D1's catalogue_only from.
 * @param {'pinned' | 'production'} corpus
 * @param {string} [catalogueOnly]
 */
const catalogueAliases = (corpus, catalogueOnly) => {
  const dir = corpus === 'pinned' ? './data/pinned/' : './data/';
  return [
    { find: 'catalogue-codes-data', replacement: fileURLToPath(new URL(`${dir}catalogue-codes.json`, import.meta.url)) },
    { find: 'prefixes-data', replacement: fileURLToPath(new URL(`${dir}prefixes.json`, import.meta.url)) },
    ...(catalogueOnly ? [{ find: 'catalogue-only-data', replacement: catalogueOnly }] : []),
  ];
};
const PRODUCTION_CATALOGUE_ONLY = fileURLToPath(new URL('./data/catalogue-only.json', import.meta.url));

// Files named *.node.test.js run in plain Node instead of workerd: they cover
// Node-side code (scripts/) and read repository files, neither of which the
// Worker runtime can do without nodejs_compat, which production does not set.
const NODE_TESTS = 'test/**/*.node.test.js';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  const workerd = () => cloudflareTest({
    wrangler: { configPath: './test/wrangler.test.jsonc' },
    remoteBindings: false,
    miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
  });
  const full = await fullBundle();
  const fullCorpusData = await fullCorpus();
  // test/full searches the pinned corpus, so it corrects against the pinned
  // vocabulary; without the corpus its tests skip, and the fixture's stands in.
  const fullVocabulary = fullCorpusData ? await pinnedVocabularyPath() : FIXTURE_VOCABULARY;
  const fullGroups = fullCorpusData ? await pinnedGroupsPath() : FIXTURE_GROUPS;
  // The pinned NG-listed codes with no classes, built in memory as the pinned groups are.
  const fullNgUnscheduled = fullCorpusData ? await pinnedNgUnscheduledPath() : FIXTURE_NG_UNSCHEDULED;
  // The pinned catalogue-only rows, built in memory; without the corpus the full tests skip.
  const fullCatalogueOnly = fullCorpusData ? await pinnedCatalogueOnlyPath() : PRODUCTION_CATALOGUE_ONLY;
  // CI on the live year: oracle and oracle-node over `current` and the production bundle and files.
  const production = await productionData();
  const prod = (/** @type {string} */ rel) => fileURLToPath(new URL(rel, import.meta.url));
  const productionBundle = /** @type {'production' | 'fixture'} */ (production ? 'production' : 'fixture');
  return {
    test: {
      projects: [
        {
          plugins: [workerd()],
          // test/wrangler.test.jsonc's `alias`, which the plugin does not read.
          resolve: { alias: [{ find: 'vectors-bundle', replacement: FIXTURE_BUNDLE }, vocabularyAlias(FIXTURE_VOCABULARY), groupsAlias(FIXTURE_GROUPS), ngUnscheduledAlias(FIXTURE_NG_UNSCHEDULED), ...catalogueAliases('pinned')] },
          test: {
            name: 'workers',
            include: ['test/**/!(*.node).test.js'],
            // test/full and test/oracle run in their own projects, against the pinned bundle.
            exclude: [...configDefaults.exclude, 'test/full/**', 'test/oracle/**'],
          },
        },
        {
          plugins: [workerd()],
          resolve: { alias: [{ find: 'vectors-bundle', replacement: full.alias }, vocabularyAlias(fullVocabulary), groupsAlias(fullGroups), ngUnscheduledAlias(fullNgUnscheduled), ...catalogueAliases('pinned', fullCatalogueOnly)] },
          test: {
            name: 'full',
            include: ['test/full/**/!(*.node).test.js'],
            // LEXICAL_GRID=sample runs a fixed 1-in-10 sample of the lexical
            // brute-force grid (~25 s instead of ~4 min locally, ~12 min on CI).
            // CI runs the full grid whenever src/, migrations/, scripts/ or
            // test/full/ change; anything else gets the sample.
            provide: { corpus: fullCorpusData, vectorsBundle: full.corpus, lexicalGrid: /** @type {'sample' | 'full'} */ (process.env.LEXICAL_GRID === 'sample' ? 'sample' : 'full') },
          },
        },
        {
          // The exchange oracle's path tests, in their own project and CI job (npm run test:oracle),
          // over production (`current`, the production bundle and its vocabulary, groups,
          // NG-unscheduled, catalogue and prefix files), so CI tests the live year.
          plugins: [workerd()],
          resolve: {
            alias: [
              { find: 'vectors-bundle', replacement: production?.bundle ?? FIXTURE_BUNDLE },
              vocabularyAlias(production ? prod('./data/vocabulary.json') : FIXTURE_VOCABULARY),
              groupsAlias(production ? prod('./data/groups.json') : FIXTURE_GROUPS),
              ngUnscheduledAlias(production ? prod('./data/ng-unscheduled.json') : FIXTURE_NG_UNSCHEDULED),
              ...catalogueAliases('production', PRODUCTION_CATALOGUE_ONLY),
            ],
          },
          test: {
            name: 'oracle',
            include: ['test/oracle/**/!(*.node).test.js'],
            provide: { corpus: production?.corpus ?? null, vectorsBundle: productionBundle },
          },
        },
        {
          // The oracle's Node-side checks over production, run by the same CI job: the oracle
          // against src/eligibility.js and the rules' department and faculty names. `.node`
          // tests can't run in workerd (oracle above).
          test: {
            name: 'oracle-node',
            environment: 'node',
            include: ['test/oracle/**/*.node.test.js'],
            provide: { corpus: production?.corpus ?? null, vectorsBundle: productionBundle },
          },
        },
        {
          test: {
            name: 'node',
            environment: 'node',
            include: [NODE_TESTS],
            exclude: [...configDefaults.exclude, 'test/oracle/**'],
            // Scripts write run records; a test run's go to a temp dir, never
            // ops/runs/ (scripts/run-record.mjs also refuses that under Vitest).
            env: { VNM_RUNS_DIR: join(tmpdir(), 'vnm-test-runs') },
          },
        },
      ],
    },
  };
});
