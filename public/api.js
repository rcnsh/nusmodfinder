// @ts-check
// The fetch layer (Phase 5 5B, F2, F7). Each search aborts the one before it
// and gives up after 10 s; a non-JSON body (Cloudflare's HTML or plain-text
// error pages) is caught before parsing; 429 reads Retry-After. Callers get an
// outcome, never a rejection, and never the server's message text: the codes
// here are mapped to sentences by messages.js.

/** How long a /search or /facets request may take, body included. */
export const SEARCH_TIMEOUT_MS = 10_000;

/**
 * `code` is the Worker's `error` field, or one of the fetch layer's own:
 * `timeout`, `network`, `not_json` (an answer that is not JSON), `http` (a
 * JSON error without a code). `retryAfter` is seconds, 429 only.
 * @typedef {{ code: string, status?: number, retryAfter?: number | null }} ApiError
 */
/** @typedef {{ kind: 'ok', body: any } | { kind: 'error', error: ApiError } | { kind: 'superseded' }} Outcome */
/** @typedef {{ fetch?: typeof fetch }} Deps */

/**
 * Seconds to wait from a Retry-After header: delta-seconds or an HTTP date
 * (RFC 9110 §10.2.3); null when absent or unreadable.
 * @param {string | null} value
 * @param {number} [now] ms since the epoch
 */
export function parseRetryAfter(value, now = Date.now()) {
  const v = value?.trim() ?? '';
  if (/^\d+$/.test(v)) return Number(v);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Thrown into a request's signal when its time runs out. */
const TIMEOUT = Symbol('timeout');
/** Thrown into a request's signal when a newer search replaces it. */
const SUPERSEDED = Symbol('superseded');

/**
 * GETs `url` as JSON with a timeout, mapping every failure to an ApiError.
 * @param {typeof fetch} doFetch
 * @param {string} url
 * @param {AbortController} ctrl aborted with SUPERSEDED by the caller to cancel
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
      return { kind: 'error', error: { code, status: res.status } };
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
 * A search function whose every call aborts the call before it (F2): the
 * aborted one settles as `superseded`, so a stale answer can never be shown.
 * `abort()` cancels the one in flight the same way (the query was cleared).
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
 * A one-off /search that aborts nothing and is aborted by nothing but its
 * timeout: the partial-code state asks whether the other semester has results
 * without cancelling the search on screen.
 * @param {URLSearchParams} params
 * @param {Deps} [deps]
 * @returns {Promise<Outcome>}
 */
export function fetchSearch(params, { fetch: doFetch = (...a) => fetch(...a) } = {}) {
  return getJson(doFetch, `/search?${params}`, new AbortController());
}

/**
 * GET /module/:code for the detail and the hidden-code lines (5C), each code
 * fetched once per page (the response is also browser-cached for 5 minutes).
 * Answers and requests in flight are shared; a failure is not kept, so asking
 * again retries.
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
        if (outcome.kind !== 'ok') cache.delete(key);
        return outcome;
      });
      cache.set(key, pending);
      return pending;
    },
  };
}

/**
 * GET /facets: the faculty list and the exchange-mode sources. Resolves null
 * on any failure, so nothing on the page waits on it or breaks without it (F4).
 * @param {Deps} [deps]
 * @returns {Promise<any | null>}
 */
export async function fetchFacets({ fetch: doFetch = (...a) => fetch(...a) } = {}) {
  const outcome = await getJson(doFetch, '/facets', new AbortController());
  return outcome.kind === 'ok' && outcome.body && typeof outcome.body === 'object' ? outcome.body : null;
}
