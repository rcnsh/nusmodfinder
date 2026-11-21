// @ts-check
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

/** @returns {Promise<FullCorpus | null>} */
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

/** @returns {Promise<{ corpus: FullCorpus, bundle: string } | null>} */
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

const FIXTURE_BUNDLE = fileURLToPath(new URL('./test/fixtures/vectors.js', import.meta.url));

/** @returns {Promise<{ alias: string, corpus: 'pinned' | 'fixture' }>} */
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

const FIXTURE_VOCABULARY = fileURLToPath(new URL('./test/fixtures/vocabulary.json', import.meta.url));

/** @param {string} path */
const vocabularyAlias = (path) => ({ find: 'vocabulary-data', replacement: path });
const FIXTURE_GROUPS = fileURLToPath(new URL('./test/fixtures/groups.json', import.meta.url));
/** @param {string} path */
const groupsAlias = (path) => ({ find: 'groups-data', replacement: path });
const FIXTURE_NG_UNSCHEDULED = fileURLToPath(new URL('./test/fixtures/ng-unscheduled.json', import.meta.url));
/** @param {string} path */
const ngUnscheduledAlias = (path) => ({ find: 'ng-unscheduled-data', replacement: path });
/**
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
  const fullVocabulary = fullCorpusData ? await pinnedVocabularyPath() : FIXTURE_VOCABULARY;
  const fullGroups = fullCorpusData ? await pinnedGroupsPath() : FIXTURE_GROUPS;
  const fullNgUnscheduled = fullCorpusData ? await pinnedNgUnscheduledPath() : FIXTURE_NG_UNSCHEDULED;
  const fullCatalogueOnly = fullCorpusData ? await pinnedCatalogueOnlyPath() : PRODUCTION_CATALOGUE_ONLY;
  const production = await productionData();
  const prod = (/** @type {string} */ rel) => fileURLToPath(new URL(rel, import.meta.url));
  const productionBundle = /** @type {'production' | 'fixture'} */ (production ? 'production' : 'fixture');
  return {
    test: {
      projects: [
        {
          plugins: [workerd()],
          resolve: { alias: [{ find: 'vectors-bundle', replacement: FIXTURE_BUNDLE }, vocabularyAlias(FIXTURE_VOCABULARY), groupsAlias(FIXTURE_GROUPS), ngUnscheduledAlias(FIXTURE_NG_UNSCHEDULED), ...catalogueAliases('pinned')] },
          test: {
            name: 'workers',
            include: ['test/**/!(*.node).test.js'],
            exclude: [...configDefaults.exclude, 'test/full/**', 'test/oracle/**'],
          },
        },
        {
          plugins: [workerd()],
          resolve: { alias: [{ find: 'vectors-bundle', replacement: full.alias }, vocabularyAlias(fullVocabulary), groupsAlias(fullGroups), ngUnscheduledAlias(fullNgUnscheduled), ...catalogueAliases('pinned', fullCatalogueOnly)] },
          test: {
            name: 'full',
            include: ['test/full/**/!(*.node).test.js'],
            provide: { corpus: fullCorpusData, vectorsBundle: full.corpus, lexicalGrid: /** @type {'sample' | 'full'} */ (process.env.LEXICAL_GRID === 'sample' ? 'sample' : 'full') },
          },
        },
        {
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
            env: { VNM_RUNS_DIR: join(tmpdir(), 'vnm-test-runs') },
          },
        },
      ],
    },
  };
});
