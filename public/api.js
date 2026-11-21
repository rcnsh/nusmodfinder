// @ts-check

export const SEARCH_TIMEOUT_MS = 10_000;

/** @typedef {{ code: string, status?: number, retryAfter?: number | null, detail?: Record<string, unknown> }} ApiError */
/** @typedef {{ kind: 'ok', body: any } | { kind: 'error', error: ApiError } | { kind: 'superseded' }} Outcome */
/** @typedef {{ fetch?: typeof fetch }} Deps */

/**
 * @param {string | null} value
 * @param {number} [now]
 */
export function parseRetryAfter(value, now = Date.now()) {
  const v = value?.trim() ?? '';
  if (/^\d+$/.test(v)) return Number(v);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

const TIMEOUT = Symbol('timeout');
const SUPERSEDED = Symbol('superseded');

/**
 * @param {unknown} body
 * @returns {{ detail?: Record<string, unknown> }}
 */
function errorDetail(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const rest = { .../** @type {Record<string, unknown>} */ (body) };
  delete rest.error;
  delete rest.message;
  return Object.keys(rest).length ? { detail: rest } : {};
}

/**
 * @param {typeof fetch} doFetch
 * @param {string} url
 * @param {AbortController} ctrl
 * @returns {Promise<Outcome>}
 */
async function getJson(doFetch, url, ctrl) {
  const timer = setTimeout(() => ctrl.abort(TIMEOUT), SEARCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (res.status === 429) {
      return { kind: 'error', error: { code: 'rate_limited', status: 429, retryAfter: parseRetryAfter(res.headers.get('retry-after')) } };
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) return { kind: 'error', error: { code: 'not_json', status: res.status } };
    /** @type {any} */
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch (err) {
      if (ctrl.signal.aborted) throw err;
      return { kind: 'error', error: { code: 'not_json', status: res.status } };
    }
    if (!res.ok) {
      const code = typeof body?.error === 'string' && body.error ? body.error : 'http';
      return { kind: 'error', error: { code, status: res.status, ...errorDetail(body) } };
    }
    return { kind: 'ok', body };
  } catch {
    const reason = ctrl.signal.aborted ? ctrl.signal.reason : null;
    if (reason === SUPERSEDED) return { kind: 'superseded' };
    if (reason === TIMEOUT) return { kind: 'error', error: { code: 'timeout' } };
    return { kind: 'error', error: { code: 'network' } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Deps} [deps]
 * @returns {((params: URLSearchParams) => Promise<Outcome>) & { abort: () => void }}
 */
export function createSearchClient({ fetch: doFetch = (...a) => fetch(...a) } = {}) {
  /** @type {AbortController | null} */
  let current = null;
  const abort = () => current?.abort(SUPERSEDED);
  /** @param {URLSearchParams} params */
  const search = (params) => {
    abort();
    const ctrl = new AbortController();
    current = ctrl;
    return getJson(doFetch, `/search?${params}`, ctrl).finally(() => {
      if (current === ctrl) current = null;
    });
  };
  return Object.assign(search, { abort });
}

/**
 * @param {URLSearchParams} params
 * @param {Deps} [deps]
 * @returns {Promise<Outcome>}
 */
export function fetchSearch(params, { fetch: doFetch = (...a) => fetch(...a) } = {}) {
  return getJson(doFetch, `/search?${params}`, new AbortController());
}

/**
 * @param {Deps} [deps]
 * @returns {{ get: (code: string) => Promise<Outcome> }}
 */
export function createModuleClient({ fetch: doFetch = (...a) => fetch(...a) } = {}) {
  /** @type {Map<string, Promise<Outcome>>} */
  const cache = new Map();
  return {
    get(code) {
      const key = code.trim().toUpperCase();
      const hit = cache.get(key);
      if (hit) return hit;
      const pending = getJson(doFetch, `/module/${encodeURIComponent(key)}`, new AbortController()).then((outcome) => {
        if (outcome.kind === 'error' && outcome.error.status !== 404) cache.delete(key);
        return outcome;
      });
      cache.set(key, pending);
      return pending;
    },
  };
}

/**
 * @param {Deps} [deps]
 * @returns {Promise<any | null>}
 */
export async function fetchFacets({ fetch: doFetch = (...a) => fetch(...a) } = {}) {
  const outcome = await getJson(doFetch, '/facets', new AbortController());
  return outcome.kind === 'ok' && outcome.body && typeof outcome.body === 'object' ? outcome.body : null;
}
