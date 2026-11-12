// @ts-check
// Request helper and seeding for Worker tests. Every request goes through
// `call()`, which builds the env from the raw test env plus fakes, runs the
// real Worker's fetch handler, and waits for its waitUntil work.
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index.js';
import { searchCacheKey } from '../src/search.js';
import { denseCircuit } from '../src/upstream.js';
import { createFakes } from './fakes.js';
import fixtureJson from './fixtures/corpus.json';

/** @typedef {import('./fakes.js').Fakes} Fakes */

export const BASE = 'https://vector-nusmods.test';
/** Only ever bound inside tests; the raw test env has no INGEST_SECRET. */
export const TEST_INGEST_SECRET = 'test-ingest-secret';

/**
 * The NG list of the fixture's year (Phase 7 7D, one year source: found by the year, not named):
 * data/ng-courses-<acad year>.json, which the fixture corpus was built with.
 */
const ngJson = /** @type {{ updatedAsAt: string, source: string, semesters: Record<string, string[]> }} */ (
  /** @type {Record<string, { default: unknown }>} */ (import.meta.glob('../data/ng-courses-*.json', { eager: true }))[
    `../data/ng-courses-${/** @type {FixtureCorpus} */ (/** @type {unknown} */ (fixtureJson)).modules[0].acadYear}.json`].default);

/** The NG list provenance ingest posts to /admin/facets (scripts/ingest.mjs). */
export const NG_LIST = {
  updatedAsAt: ngJson.updatedAsAt,
  source: ngJson.source,
  count: new Set(Object.values(/** @type {Record<string, string[]>} */ (ngJson.semesters)).flat()).size,
};

/** The committed fixture corpus (~400 modules). */
export const fixture = /** @type {FixtureCorpus} */ (/** @type {unknown} */ (fixtureJson));

/**
 * The env the Worker sees: raw test bindings (DB only) plus fakes and any
 * extra vars. Pass `fakes: null` to get the raw env with no AI/Vectorize.
 * @param {Fakes | null} fakes
 * @param {Record<string, unknown>} [extra]
 * @returns {Env}
 */
export function buildEnv(fakes, extra = {}) {
  const withFakes = fakes ? { AI: fakes.ai, VECTORIZE: fakes.vectorize, SEARCH_LIMIT: fakes.limit } : {};
  return /** @type {Env} */ (/** @type {unknown} */ ({ ...env, ...withFakes, ...extra }));
}

/**
 * @typedef {object} CallOptions
 * @property {Fakes | null} [fakes] Defaults to a fresh, empty set of fakes.
 * @property {RequestInit} [init] Method, headers, body.
 * @property {Record<string, unknown>} [env] Extra env vars, e.g. `{ INGEST_SECRET }`.
 * @property {boolean} [keepCache] `/search` responses are cached in
 *   `caches.default`, which persists across tests in a file. By default the
 *   entry this URL maps to (its canonical key) is deleted first so each call
 *   is a cache miss.
 * @property {boolean} [keepCircuit] The dense-half circuit breaker is
 *   per-isolate state shared by every test in a file. By default it is reset
 *   before each call so one test's failures cannot open it for the next.
 */

/**
 * Sends one request through the real Worker.
 * @param {string} path Path and query, e.g. `/search?q=python`.
 * @param {CallOptions} [options]
 * @returns {Promise<Response>}
 */
export async function call(path, options = {}) {
  const { fakes = createFakes(), init, env: extra, keepCache = false, keepCircuit = false } = options;
  const url = new URL(path, BASE);
  if (url.pathname === '/search' && !keepCache) {
    const key = searchCacheKey(url);
    if (key) await caches.default.delete(key);
  }
  if (!keepCircuit) denseCircuit.reset();
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url, init), buildEnv(fakes, extra), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * `call()` and parse the JSON body.
 * @param {string} path
 * @param {CallOptions} [options]
 * @returns {Promise<{ status: number, headers: Headers, body: any }>}
 */
export async function callJson(path, options) {
  const res = await call(path, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, headers: res.headers, body };
}

/**
 * Admin request with the test secret bound and presented.
 * @param {string} path
 * @param {Fakes} fakes
 * @param {unknown} [body]
 */
export function adminCall(path, fakes, body) {
  return call(path, {
    fakes,
    env: { INGEST_SECRET: TEST_INGEST_SECRET },
    init: {
      method: body === undefined && (path === '/admin/hashes' || path === '/admin/catalogue') ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${TEST_INGEST_SECRET}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  });
}

/**
 * Resets all bindings, applies every migration, and loads modules through the
 * Worker's own /admin/ingest route, so D1 and the fake Vectorize index hold
 * what production would. Call from `beforeAll` (or `beforeEach` when a test
 * mutates D1). Call logs on the returned fakes are cleared afterwards.
 * @param {{ modules?: NormalisedModule[], fakes?: Fakes, facets?: boolean }} [options]
 *   `facets: true` also records the NG list and builds the precomputed
 *   /facets row, as ingest does.
 * @returns {Promise<Fakes>}
 */
export async function seed(options = {}) {
  const { modules = fixture.modules, fakes = createFakes(), facets = false } = options;
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (let i = 0; i < modules.length; i += 100) {
    const res = await adminCall('/admin/ingest', fakes, { modules: modules.slice(i, i + 100) });
    if (res.status !== 200) throw new Error(`seed: ingest batch ${i / 100} failed: HTTP ${res.status} ${await res.text()}`);
  }
  if (facets) {
    const res = await adminCall('/admin/facets', fakes, { ngList: NG_LIST });
    if (res.status !== 200) throw new Error(`seed: facets rebuild failed: HTTP ${res.status} ${await res.text()}`);
  }
  for (const fake of [fakes.ai, fakes.vectorize, fakes.limit]) fake.calls.length = 0;
  return fakes;
}
