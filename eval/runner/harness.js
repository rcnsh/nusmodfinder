// @ts-check
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../../src/index.js';

/** @typedef {import('../../test/fakes.js').Fakes} Fakes */

const BASE = 'https://vector-nusmods.test';
const SECRET = 'eval-ingest-secret';

/**
 * @param {string} path
 * @param {Fakes} fakes
 * @param {{ init?: RequestInit, extra?: Record<string, unknown> }} [options]
 * @returns {Promise<Response>}
 */
export async function call(path, fakes, options = {}) {
  const bindings = /** @type {Env} */ (/** @type {unknown} */ ({
    ...env, AI: fakes.ai, VECTORIZE: fakes.vectorize, SEARCH_LIMIT: fakes.limit, SEARCH_LIMIT_MINUTE: fakes.limitMinute, ...options.extra,
  }));
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, BASE), options.init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
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
