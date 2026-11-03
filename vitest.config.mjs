// @ts-check
// Tests run inside workerd via @cloudflare/vitest-plugin, against
// test/wrangler.test.jsonc: the production config minus AI, Vectorize and the
// rate limiter, with remoteBindings off, so nothing can reach a metered
// Cloudflare service. Fakes for those bindings live in test/fakes.js.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { loadPinnedCorpus, MODULE_INFO_PATH } from './scripts/pinned-corpus.mjs';

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

// Files named *.node.test.js run in plain Node instead of workerd: they cover
// Node-side code (scripts/) and read repository files, neither of which the
// Worker runtime can do without nodejs_compat, which production does not set.
const NODE_TESTS = 'test/**/*.node.test.js';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './test/wrangler.test.jsonc' },
              remoteBindings: false,
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: 'workers',
            // Not an `exclude`: a project-level exclude replaces the CLI's
            // `--exclude 'test/full/**'` that `npm test` relies on.
            include: ['test/**/!(*.node).test.js'],
            provide: { corpus: await fullCorpus() },
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
