// @ts-check
// Drives scripts/ingest-core.mjs straight into the real Worker: its AdminApi
// over `call()` with the test ingest secret, so a test exercises the same
// routes `npm run ingest` does over HTTP.
import { call, TEST_INGEST_SECRET } from './helpers.js';

/**
 * @param {() => import('./fakes.js').Fakes} getFakes read on every call, so a
 *   test may re-seed between runs
 * @param {Record<string, unknown>} [extraEnv] e.g. `{ DB: meteredDb }`
 * @returns {import('../scripts/ingest-core.mjs').AdminApi}
 */
export function adminApi(getFakes, extraEnv = {}) {
  const headers = { authorization: `Bearer ${TEST_INGEST_SECRET}`, 'content-type': 'application/json' };
  /** @param {string} path @param {RequestInit} init */
  const send = async (path, init) => {
    const res = await call(path, { fakes: getFakes(), env: { INGEST_SECRET: TEST_INGEST_SECRET, ...extraEnv }, init: { ...init, headers } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  return {
    get: (path) => send(path, { method: 'GET' }),
    post: (path, body) => send(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}
