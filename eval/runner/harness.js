// @ts-check
// The eval runner's way into the Worker. It is overlaid onto every ranker the
// eval runs, including old refs such as eval-v0, so it uses only what every
// ranker has: the default export's `fetch` and the `/admin/ingest` route. It
// must not import any other module from src/ (test/eval/workspace.node.test.js
// checks this); test/helpers.js follows the current src/ layout and does not
// qualify.
//
// Each /search goes through `caches.default` as in production. A query whose
// parameters repeat an earlier one's is a cache hit and gets the same body,
// which the lookup AI and fake Vectorize make identical to a miss anyway.
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../src/index.js';

/** @typedef {import('../../test/fakes.js').Fakes} Fakes */

const BASE = 'https://vector-nusmods.test';
const SECRET = 'eval-ingest-secret';

/**
 * Sends one request through the ranker's Worker with the fakes bound.
 * @param {string} path
 * @param {Fakes} fakes
 * @param {{ init?: RequestInit, extra?: Record<string, unknown> }} [options]
 * @returns {Promise<Response>}
 */
export async function call(path, fakes, options = {}) {
  const bindings = /** @type {Env} */ (/** @type {unknown} */ ({
    ...env, AI: fakes.ai, VECTORIZE: fakes.vectorize, SEARCH_LIMIT: fakes.limit, ...options.extra,
  }));
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, BASE), options.init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * Resets the bindings, applies the ranker's migrations and loads `modules`
 * through its own /admin/ingest, so D1 and the fake Vectorize hold what
 * production would.
 * @param {NormalisedModule[]} modules
 * @param {Fakes} fakes
 */
export async function seed(modules, fakes) {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (let i = 0; i < modules.length; i += 100) {
    const res = await call('/admin/ingest', fakes, {
      extra: { INGEST_SECRET: SECRET },
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ modules: modules.slice(i, i + 100) }),
      },
    });
    if (res.status !== 200) throw new Error(`seed: ingest batch ${i / 100} failed: HTTP ${res.status} ${await res.text()}`);
  }
}
