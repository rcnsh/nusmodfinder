// @ts-check
import { call, TEST_INGEST_SECRET } from './helpers.js';

/**
 * @param {() => import('./fakes.js').Fakes} getFakes
 * @param {Record<string, unknown>} [extraEnv]
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
