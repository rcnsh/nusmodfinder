// @ts-check
// The eval runner's Vitest config. Not part of `npm test`: started by
// `npm run eval` (eval/runner/run.mjs), which first builds a workspace in
// .eval-work/ holding the ranker under test (src/ + migrations/ from a git
// ref or the working tree) and the HEAD runner, and points
// VNM_EVAL_WORKSPACE at it. Same isolation as the test config: no AI,
// Vectorize or rate-limit bindings, remoteBindings off, fakes injected.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(async () => {
  const ws = process.env.VNM_EVAL_WORKSPACE;
  if (!ws || !existsSync(join(ws, 'eval/runner/retrieval.eval.js'))) {
    throw new Error('vitest.eval.config.mjs runs only under `npm run eval` (VNM_EVAL_WORKSPACE is unset or empty)');
  }
  const migrations = await readD1Migrations(join(ws, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: join(ws, 'test/wrangler.test.jsonc') },
        remoteBindings: false,
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    // The workspace's test/wrangler.test.jsonc `alias` (the plugin does not
    // read it): the bundle eval/runner/run.mjs built for this run. Unused by
    // rankers without in-Worker vectors (eval-v0).
    // The vocabulary and groups: this run's own copies
    // in the workspace, which the run overwrites with ones built from its
    // corpus (eval/lib/corrected.mjs), never the repo's data/. Rankers from
    // before the bare names import ../data/*.json, the same files. The
    // NG-listed codes with no classes: the workspace's committed copy, which
    // only the no-match branch reads, so it never touches a ranking; rankers
    // from before them import none and have none.
    resolve: {
      alias: {
        'vectors-bundle': join(ws, 'test/fixtures/vectors.js'),
        'vocabulary-data': join(ws, 'data/vocabulary.json'),
        'groups-data': join(ws, 'data/groups.json'),
        'ng-unscheduled-data': join(ws, 'data/ng-unscheduled.json'),
        // The run corpus's catalogue codes and prefixes, which the run writes over
        // the workspace's copies (eval/lib/corpus.mjs writeRunCatalogue).
        'catalogue-codes-data': join(ws, 'data/catalogue-codes.json'),
        'prefixes-data': join(ws, 'data/prefixes.json'),
      },
    },
    test: {
      name: 'eval',
      include: [`${relative(ROOT, ws)}/eval/runner/retrieval.eval.js`],
      testTimeout: 60_000,
      hookTimeout: 900_000,
      // One file, one isolate: seeding happens once per run.
      fileParallelism: false,
    },
  };
});
