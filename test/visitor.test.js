// @ts-check
// Phase 8 8B (docs/plans/phase8.md §2 "8B", as §5's answers adjust it): what a visitor and a
// stranger's page get from the Worker. The HTML 404 with public/_headers' security headers, the
// search hit's TTL re-sent, the cross-site refusal on /search before the cache, the limiters and any
// binding, the two per-IP rate limits (G5 (b)), and one log line for a D1 error on /module and
// /facets.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import headersFile from '../public/_headers';
import { searchCacheKey } from '../src/search.js';
import { createFakes } from './fakes.js';
import { BASE, call, callJson, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;

beforeAll(async () => {
  fakes = await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * public/_headers' `/*` rule, read here the way Workers Static Assets reads it (a path line, then
 * indented "Name: value" lines), independently of the Worker's own reading.
 * @returns {Record<string, string>}
 */
function headersRule() {
  /** @type {Record<string, Record<string, string>>} */
  const rules = {};
  let path = '';
  for (const line of headersFile.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { path = line.trim(); rules[path] = {}; continue; }
    const at = line.indexOf(':');
    rules[path][line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return rules['/*'];
}

/** What Chromium sends for a typed address or a link. */
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

describe('the 404 for a browser (8B)', () => {
  it('a browser asking for an unknown path gets an HTML page: the name, "unofficial" and a link home', async () => {
    const res = await call('/no-such-page', { init: { headers: { accept: BROWSER_ACCEPT } } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('NUS Mod Finder');
    expect(html).toContain('unofficial');
    expect(html).toMatch(/<a [^>]*href="\/"/);
    // The page is static: the path asked for is never echoed back into it.
    expect(html).not.toContain('no-such-page');
  });

  it('carries public/_headers\' CSP, X-Frame-Options and X-Content-Type-Options, which Cloudflare applies only to assets', async () => {
    const rule = headersRule();
    expect(rule['content-security-policy']).toContain("default-src 'none'");
    const res = await call('/no-such-page', { init: { headers: { accept: 'text/html' } } });
    expect(res.headers.get('content-security-policy')).toBe(rule['content-security-policy']);
    expect(res.headers.get('x-frame-options')).toBe(rule['x-frame-options']);
    expect(res.headers.get('x-content-type-options')).toBe(rule['x-content-type-options']);
  });

  it.each([
    ['no Accept', undefined],
    ['*/* (curl, Node fetch, smoke)', '*/*'],
    ['application/json', 'application/json'],
    ['JSON preferred over HTML', 'application/json, text/html;q=0.5'],
    ['HTML refused', 'text/html;q=0, */*'],
    ['HTML ranked below anything else', 'text/html;q=0.1, */*'],
    ['HTML ranked below any application type', 'text/html;q=0.5, application/*;q=0.9'],
  ])('%s keeps today\'s JSON 404', async (_label, accept) => {
    const { status, headers, body } = await callJson('/no-such-page', { init: accept === undefined ? {} : { headers: { accept } } });
    expect(status).toBe(404);
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(body).toEqual({ error: 'not_found', message: 'No route for /no-such-page.' });
  });

  it('an API path\'s own 404 stays JSON for a browser too: a /module miss is data, not a page', async () => {
    const { status, body } = await callJson('/module/ZZ9999', { init: { headers: { accept: BROWSER_ACCEPT } } });
    expect(status).toBe(404);
    expect(body.kind).toBe('unknown');
  });
});

describe('the search hit\'s TTL (8B)', () => {
  /**
   * Production's `cache.match` returns the stored copy with the zone's Browser Cache TTL on it
   * (max-age=14400); Miniflare's returns what was stored, so only a stub shows it.
   * @param {Record<string, string>} [extra]
   */
  const storedCopy = (extra = {}) => new Response(JSON.stringify({ query: 'stub', results: [] }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=14400', ...extra },
  });

  it('a hit is sent with 3600 whatever max-age the stored copy carries', async () => {
    vi.spyOn(caches.default, 'match').mockResolvedValue(storedCopy());
    const res = await call('/search?q=ttl%20hit%20full', { fakes, keepCache: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('a degraded entry stores its flag, and its hit is sent with 60', async () => {
    const failing = createFakes();
    failing.ai.throws('model unavailable');
    const path = '/search?q=ttl%20degraded%20entry';
    const miss = await call(path, { fakes: failing });
    expect(miss.headers.get('cache-control')).toBe('public, max-age=60');
    const stored = await caches.default.match(/** @type {Request} */ (searchCacheKey(new URL(path, BASE))));
    expect(stored).toBeDefined();
    const flagged = Object.fromEntries([.../** @type {Response} */ (stored).headers].filter(([k]) => k === 'x-search-degraded'));
    expect(flagged).toEqual({ 'x-search-degraded': '1' });

    vi.spyOn(caches.default, 'match').mockResolvedValue(storedCopy(flagged));
    const hit = await call(path, { fakes: failing, keepCache: true });
    expect(hit.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('a full answer stores no degraded flag', async () => {
    const path = '/search?q=ttl%20full%20entry';
    await call(path, { fakes });
    const stored = await caches.default.match(/** @type {Request} */ (searchCacheKey(new URL(path, BASE))));
    expect(stored?.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(stored?.headers.has('x-search-degraded')).toBe(false);
  });
});

/**
 * Sec-Fetch-* as browsers send them (MDN; Chromium, Firefox and Safari since March 2023), and as
 * Node's fetch sends them (undici: Sec-Fetch-Mode only, captured live by a round 3 critic).
 * @type {[string, Record<string, string>][]}
 */
const REFUSED = [
  ['another site\'s fetch()', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
  ['another site\'s no-cors request (an <img> or a script tag)', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
  ['a hidden iframe on another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }],
];
/** @type {[string, Record<string, string>][]} */
const SERVED = [
  ['a link a student follows from another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' }],
  ['the page itself', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
  ['a bookmark or a typed address', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1' }],
  ['Node\'s fetch (smoke, uptime)', { 'sec-fetch-mode': 'cors', accept: '*/*', 'accept-language': '*', 'user-agent': 'node' }],
  ['the eval and curl (no Sec-Fetch-*)', { accept: '*/*', 'user-agent': 'curl/8.7.1' }],
];

describe('the cross-site refusal on /search (8B)', () => {
  /** A D1 binding that fails the test if anything touches it. */
  const untouchable = new Proxy({}, { get(_t, prop) { throw new Error(`D1 touched: ${String(prop)}`); } });

  it.each(REFUSED)('%s: 403 before the cache, the limiters and any binding', async (_label, headers) => {
    const watched = createFakes();
    const match = vi.spyOn(caches.default, 'match');
    const res = await call('/search?q=cross%20site%20refused', { fakes: watched, env: { DB: untouchable }, init: { headers } });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = await res.json();
    expect(body.error).toBe('cross_site');
    expect(body.message).toMatch(/^[A-Z].*\.$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(match).not.toHaveBeenCalled();
    expect(watched.limit.calls).toHaveLength(0);
    expect(watched.limitMinute.calls).toHaveLength(0);
    expect(watched.ai.calls).toHaveLength(0);
    expect(watched.vectorize.calls).toHaveLength(0);
  });

  it.each(SERVED)('%s: served as today', async (_label, headers) => {
    const { status, body } = await callJson('/search?q=cross%20site%20served', { fakes, init: { headers } });
    expect(status).toBe(200);
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('refuses only /search: another site may still read /module and /facets', async () => {
    const headers = REFUSED[0][1];
    expect((await call('/module/CS1010S', { init: { headers } })).status).toBe(200);
    expect((await call('/facets', { init: { headers } })).status).toBe(200);
  });
});

describe('the rate limits (8B, G5 (b))', () => {
  const IP = { 'cf-connecting-ip': '203.0.113.9' };

  it('both limits are asked, keyed by the client IP, before any other binding', async () => {
    const f = createFakes();
    await call('/search?q=two%20limits%20asked', { fakes: f, init: { headers: IP } });
    expect(f.limit.calls.map((c) => c.args[0])).toEqual([{ key: '203.0.113.9' }]);
    expect(f.limitMinute.calls.map((c) => c.args[0])).toEqual([{ key: '203.0.113.9' }]);
  });

  it.each([['the 10-second limit', 'limit'], ['the minute limit', 'limitMinute']])('%s refusing gives today\'s 429, with no binding touched', async (_label, which) => {
    const f = createFakes();
    f[/** @type {'limit' | 'limitMinute'} */ (which)].allow = false;
    const res = await call('/search?q=one%20limit%20refuses', { fakes: f, init: { headers: IP } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' });
    expect(f.ai.calls).toHaveLength(0);
  });

  it('each limiter fails open on its own: a broken one never takes search down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const which of /** @type {const} */ (['limit', 'limitMinute'])) {
      const f = createFakes();
      f[which].throws('limiter down');
      const res = await call('/search?q=limiter%20fails%20open', { fakes: f, init: { headers: IP } });
      expect(res.status, which).toBe(200);
    }
    const both = createFakes();
    both.limit.throws('down');
    both.limitMinute.allow = false;
    expect((await call('/search?q=limiter%20fails%20open%20one', { fakes: both, init: { headers: IP } })).status).toBe(429);
  });
});

describe('a D1 error outside /search leaves one log line (8B)', () => {
  /** The `d1_error` lines console.error wrote. @param {import('vitest').MockInstance} spy */
  const d1Lines = (spy) => spy.mock.calls.map((args) => String(args[0])).filter((l) => l.includes('d1_error'));
  const IP = '198.51.100.23';
  const lost = () => { throw new Error('D1_ERROR: network connection lost'); };
  /** A D1 binding whose reads fail when `fails(sql)`, and find nothing otherwise. @param {(sql: string) => boolean} fails */
  const db = (fails) => ({ withSession: () => ({ prepare: (/** @type {string} */ sql) => ({ bind: () => ({ first: async () => (fails(sql) ? lost() : null) }) }) }) });

  it.each([
    ['/module/:code', '/module/CS1010S', 'CS1010S', () => true],
    ['/module/:code', '/module/CS1010J', 'CS1010J', (/** @type {string} */ sql) => sql.includes('catalogue_only')],
    ['/facets', '/facets?x=secret-query', 'secret-query', () => true],
  ])('%s (%s): the route and the error, and no URL, query or IP', async (route, path, private_, fails) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(path, { env: { DB: db(fails) }, init: { headers: { 'cf-connecting-ip': IP } } });
    expect(res.status).toBe(502);
    const lines = d1Lines(spy);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: 'd1_error', route, error: 'D1_ERROR: network connection lost' });
    expect(lines[0]).not.toContain(private_);
    expect(lines[0]).not.toContain(IP);
    expect(lines[0]).not.toContain('http');
  });
});
