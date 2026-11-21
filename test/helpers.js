// @ts-check
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index.js';
import { searchCacheKey } from '../src/search.js';
import { denseCircuit } from '../src/upstream.js';
import { createFakes } from './fakes.js';
import fixtureJson from './fixtures/corpus.json';

/** @typedef {import('./fakes.js').Fakes} Fakes */

export const BASE = 'https://vector-nusmods.test';
export const TEST_INGEST_SECRET = 'test-ingest-secret';

const ngJson = /** @type {{ updatedAsAt: string, source: string, semesters: Record<string, string[]> }} */ (
  /** @type {Record<string, { default: unknown }>} */ (import.meta.glob('../data/ng-courses-*.json', { eager: true }))[
    `../data/ng-courses-${/** @type {FixtureCorpus} */ (/** @type {unknown} */ (fixtureJson)).modules[0].acadYear}.json`].default);

export const NG_LIST = {
  updatedAsAt: ngJson.updatedAsAt,
  source: ngJson.source,
  count: new Set(Object.values(/** @type {Record<string, string[]>} */ (ngJson.semesters)).flat()).size,
};

export const fixture = /** @type {FixtureCorpus} */ (/** @type {unknown} */ (fixtureJson));

/**
 * @param {Fakes | null} fakes
 * @param {Record<string, unknown>} [extra]
 * @returns {Env}
 */
export function buildEnv(fakes, extra = {}) {
  const withFakes = fakes ? { AI: fakes.ai, VECTORIZE: fakes.vectorize, SEARCH_LIMIT: fakes.limit, SEARCH_LIMIT_MINUTE: fakes.limitMinute } : {};
  return /** @type {Env} */ (/** @type {unknown} */ ({ ...env, ...withFakes, ...extra }));
}

/**
 * @typedef {object} CallOptions
 * @property {Fakes | null} [fakes]
 * @property {RequestInit} [init]
 * @property {Record<string, unknown>} [env]
 * @property {boolean} [keepCache]
 * @property {boolean} [keepCircuit]
 */

/**
 * @param {string} path
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
 * @param {{ modules?: NormalisedModule[], fakes?: Fakes, facets?: boolean }} [options]
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
