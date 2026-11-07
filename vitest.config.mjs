// @ts-check
// Tests run inside workerd via @cloudflare/vitest-plugin, against
// test/wrangler.test.jsonc: the production config minus AI, Vectorize and the
// rate limiter, with remoteBindings off, so nothing can reach a metered
// Cloudflare service. Fakes for those bindings live in test/fakes.js.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
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
    const offered = c.records.filter((r) => (r.semesterData ?? []).length > 0).map((r) => String(r.moduleCode));
    return {
      acadYear: c.acadYear,
      moduleInfoSha256: c.moduleInfoSha256,
      recordCount: c.records.length,
      offeredCodes: offered,
      modules: c.modules,
      skipped: c.skipped,
      ng: c.ng,
    };
  } catch (err) {
    if (required) throw err;
    console.warn(`full corpus unavailable, test/full will skip: ${/** @type {Error} */ (err).message}`);
    return null;
  }
}

/** The committed fixture vectors bundle (scripts/vectors.mjs build --corpus fixture). */
const FIXTURE_BUNDLE = fileURLToPath(new URL('./test/fixtures/vectors.js', import.meta.url));

/**
 * What test/full searches (Phase 3 3-0, B2-4): the pinned bundle, the 6,771
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
  return {
    test: {
      projects: [
        {
          plugins: [workerd()],
          // test/wrangler.test.jsonc's `alias`, which the plugin does not read.
          resolve: { alias: { 'vectors-bundle': FIXTURE_BUNDLE } },
          test: {
            name: 'workers',
            include: ['test/**/!(*.node).test.js'],
            // test/full runs in its own project, against the pinned bundle.
            exclude: [...configDefaults.exclude, 'test/full/**'],
          },
        },
        {
          plugins: [workerd()],
          resolve: { alias: { 'vectors-bundle': full.alias } },
          test: {
            name: 'full',
            include: ['test/full/**/!(*.node).test.js'],
            // LEXICAL_GRID=sample runs a fixed 1-in-10 sample of the lexical
            // brute-force grid (~25 s instead of ~4 min locally, ~12 min on CI).
            // CI runs the full grid whenever src/, migrations/, scripts/ or
            // test/full/ change; anything else gets the sample.
            provide: { corpus: await fullCorpus(), vectorsBundle: full.corpus, lexicalGrid: process.env.LEXICAL_GRID === 'sample' ? 'sample' : 'full' },
          },
        },
        {
          test: {
            name: 'node',
            environment: 'node',
            include: [NODE_TESTS],
          },
        },
      ],
    },
  };
});
