// @ts-check
// public/api.js (Phase 5 5B, F2, F7): each search aborts the previous, gives up
// after 10 s, reads 429's Retry-After, and handles a non-JSON body before
// parsing it. Driven with a fake fetch and fake timers; the browser half is
// test/ui/failures.spec.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_TIMEOUT_MS, createSearchClient, fetchFacets, parseRetryAfter } from '../../public/api.js';

/**
 * A fetch that answers each call with the next queued responder, and records
 * the URL and signal of every call.
 * @param {((url: string, init: RequestInit) => Promise<Response>)[]} queue
 */
function fakeFetch(queue) {
  /** @type {{ url: string, signal: AbortSignal }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const f = async (input, init = {}) => {
    calls.push({ url: String(input), signal: /** @type {AbortSignal} */ (init.signal) });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: no response queued');
    return next(String(input), init);
  };
  return { fetch: f, calls };
}

/** A response that settles only when its request is aborted (then rejects as fetch does). */
const hang = (/** @type {string} */ _url, /** @type {RequestInit} */ init) => new Promise((_, reject) => {
  const signal = /** @type {AbortSignal} */ (init.signal);
  signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
});
const jsonResponse = (/** @type {unknown} */ body, status = 200, headers = {}) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

const params = (/** @type {string} */ q) => new URLSearchParams({ q });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('search (F2)', () => {
  it('[F2 fixed] a new search aborts the one in flight, which settles as superseded, never as an error', async () => {
    const { fetch, calls } = fakeFetch([hang, jsonResponse({ count: 0, results: [] })]);
    const search = createSearchClient({ fetch });
    const first = search(params('a'));
    const second = search(params('b'));
    expect(calls[0].signal.aborted).toBe(true);
    expect(await first).toEqual({ kind: 'superseded' });
    expect(await second).toEqual({ kind: 'ok', body: { count: 0, results: [] } });
    expect(calls.map((c) => c.url)).toEqual(['/search?q=a', '/search?q=b']);
  });

  it('[F2 fixed] gives up after 10 s with a timeout error, aborting the request', async () => {
    expect(SEARCH_TIMEOUT_MS).toBe(10_000);
    const { fetch, calls } = fakeFetch([hang]);
    const pending = createSearchClient({ fetch })(params('slow'));
    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS - 1);
    expect(calls[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0].signal.aborted).toBe(true);
    expect(await pending).toEqual({ kind: 'error', error: { code: 'timeout' } });
  });

  it('a body that is slow to arrive is covered by the same timeout', async () => {
    const slowBody = async (/** @type {string} */ _u, /** @type {RequestInit} */ init) => new Response(new ReadableStream({
      start(controller) { init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason)); },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { fetch } = fakeFetch([slowBody]);
    const pending = createSearchClient({ fetch })(params('slow'));
    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: 'error', error: { code: 'timeout' } });
  });

  it('abort() settles the search in flight as superseded and clears its timer', async () => {
    const { fetch, calls } = fakeFetch([hang]);
    const search = createSearchClient({ fetch });
    const pending = search(params('a'));
    search.abort();
    expect(calls[0].signal.aborted).toBe(true);
    expect(await pending).toEqual({ kind: 'superseded' });
    expect(vi.getTimerCount()).toBe(0);
    search.abort();
  });

  it('a finished search clears its timer', async () => {
    const { fetch } = fakeFetch([jsonResponse({ count: 0, results: [] })]);
    await createSearchClient({ fetch })(params('x'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a network failure is its own error, not a timeout', async () => {
    const { fetch } = fakeFetch([async () => { throw new TypeError('Failed to fetch'); }]);
    expect(await createSearchClient({ fetch })(params('x'))).toEqual({ kind: 'error', error: { code: 'network' } });
  });
});

describe('responses (F7)', () => {
  it('[F7 fixed] 429 reads Retry-After in seconds, whatever the body is', async () => {
    const { fetch } = fakeFetch([
      jsonResponse({ error: 'rate_limited', message: 'Too many searches' }, 429, { 'retry-after': '60' }),
      async () => new Response('<html>slow down</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '7' } }),
      async () => new Response('', { status: 429 }),
    ]);
    const search = createSearchClient({ fetch });
    expect(await search(params('a'))).toEqual({ kind: 'error', error: { code: 'rate_limited', status: 429, retryAfter: 60 } });
    expect(await search(params('b'))).toEqual({ kind: 'error', error: { code: 'rate_limited', status: 429, retryAfter: 7 } });
    expect(await search(params('c'))).toEqual({ kind: 'error', error: { code: 'rate_limited', status: 429, retryAfter: null } });
  });

  it('[F7 fixed] a non-JSON body (an HTML or plain-text error page) is handled before parsing', async () => {
    const { fetch } = fakeFetch([
      async () => new Response('<!doctype html><h1>502 Bad Gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } }),
      async () => new Response('error code: 1101', { status: 500, headers: { 'content-type': 'text/plain' } }),
      async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);
    const search = createSearchClient({ fetch });
    expect(await search(params('a'))).toEqual({ kind: 'error', error: { code: 'not_json', status: 502 } });
    expect(await search(params('b'))).toEqual({ kind: 'error', error: { code: 'not_json', status: 500 } });
    expect(await search(params('c'))).toEqual({ kind: 'error', error: { code: 'not_json', status: 200 } });
  });

  it('a JSON error keeps its code and status, never its message', async () => {
    const { fetch } = fakeFetch([
      jsonResponse({ error: 'upstream_failure', source: 'd1', message: 'D1_ERROR: boom' }, 502),
      jsonResponse({ error: 'study-required', message: 'Exchange mode (ng=1) needs …' }, 400),
      jsonResponse({ nope: true }, 503),
    ]);
    const search = createSearchClient({ fetch });
    expect(await search(params('a'))).toEqual({ kind: 'error', error: { code: 'upstream_failure', status: 502 } });
    expect(await search(params('b'))).toEqual({ kind: 'error', error: { code: 'study-required', status: 400 } });
    expect(await search(params('c'))).toEqual({ kind: 'error', error: { code: 'http', status: 503 } });
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates, and nothing else', () => {
    const now = Date.parse('2026-11-11T00:00:00Z');
    expect(parseRetryAfter('60', now)).toBe(60);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Wed, 11 Nov 2026 00:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Wed, 10 Nov 2026 00:00:00 GMT', now)).toBe(0);
    for (const bad of [null, '', 'soon', '-5', '1.5']) expect(parseRetryAfter(bad, now)).toBeNull();
  });
});

describe('fetchFacets (F4)', () => {
  it('[F4 fixed] fetchFacets resolves null, never rejects, when /facets fails, hangs or answers garbage', async () => {
    const { fetch } = fakeFetch([
      async () => { throw new TypeError('Failed to fetch'); },
      async () => new Response('<html>', { status: 500, headers: { 'content-type': 'text/html' } }),
      hang,
      jsonResponse({ faculties: [{ name: 'Computing', count: 3 }] }),
    ]);
    expect(await fetchFacets({ fetch })).toBeNull();
    expect(await fetchFacets({ fetch })).toBeNull();
    const hung = fetchFacets({ fetch });
    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS);
    expect(await hung).toBeNull();
    expect(await fetchFacets({ fetch })).toEqual({ faculties: [{ name: 'Computing', count: 3 }] });
  });
});
