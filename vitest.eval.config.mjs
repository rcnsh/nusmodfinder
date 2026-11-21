// @ts-check
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
    resolve: {
      alias: {
        'vectors-bundle': join(ws, 'test/fixtures/vectors.js'),
        'vocabulary-data': join(ws, 'data/vocabulary.json'),
        'groups-data': join(ws, 'data/groups.json'),
        'ng-unscheduled-data': join(ws, 'data/ng-unscheduled.json'),
        'catalogue-codes-data': join(ws, 'data/catalogue-codes.json'),
        'prefixes-data': join(ws, 'data/prefixes.json'),
      },
    },
    test: {
      name: 'eval',
      include: [`${relative(ROOT, ws)}/eval/runner/retrieval.eval.js`],
      testTimeout: 60_000,
      hookTimeout: 900_000,
      fileParallelism: false,
    },
  };
});
