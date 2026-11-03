// @ts-check
// Phase 1 step 0 instrumentation: Server-Timing, the structured /search log
// line, x-app-version and GET /health.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakes } from './fakes.js';
import { searchCacheKey } from '../src/search.js';
import { BASE, call, callJson, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed({ facets: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Parses a Server-Timing header into `{ name: { dur?, desc? } }`, in order.
 * @param {string | null} header
 * @returns {Record<string, { dur?: string, desc?: string }>}
 */
function parseTiming(header) {
  expect(header).toBeTypeOf('string');
  return Object.fromEntries(/** @type {string} */ (header).split(', ').map((part) => {
    const [name, ...params] = part.split(';');
    return [name, Object.fromEntries(params.map((p) => p.split('=')))];
  }));
}

/** @param {Record<string, { dur?: string }>} spans */
const allHaveDurations = (spans) => Object.values(spans).every((s) => s.dur !== undefined && Number.isFinite(Number(s.dur)));

const VERSION = { id: '6f1e1d2c-3b4a-4596-8778-695a4b3c2d1e', tag: 'abc1234', timestamp: '2026-11-04T00:00:00Z' };

/**
 * Captures console.log JSON lines with `event: "search"`.
 * @returns {() => Record<string, any>[]}
 */
function captureSearchLogs() {
  const spy = vi.spyOn(console, 'log');
  return () => spy.mock.calls
    .map((args) => { try { return JSON.parse(String(args[0])); } catch { return null; } })
    .filter((l) => l?.event === 'search');
}

describe('Server-Timing on /search', () => {
  it('a hybrid cache miss reports every stage that ran, in order, plus total', async () => {
    const res = await call('/search?q=machine%20learning%20timing', { fakes });
    expect(res.status).toBe(200);
    const spans = parseTiming(res.headers.get('server-timing'));
    expect(Object.keys(spans)).toEqual(['cache', 'limit', 'embed', 'vector', 'fts', 'hydrate', 'total']);
    expect(spans.cache.desc).toBe('miss');
    expect(allHaveDurations(spans)).toBe(true);
  });

  it('an exact module code adds the pin span; lexical mode has no embed or vector', async () => {
    const res = await call('/search?q=cs1010s&mode=lexical', { fakes });
    const spans = parseTiming(res.headers.get('server-timing'));
    expect(Object.keys(spans)).toEqual(['cache', 'limit', 'pin', 'fts', 'hydrate', 'total']);
  });

  it('a cache hit gets fresh cache;desc=hit and total spans, and the stored copy has none', async () => {
    const path = '/search?q=quantum%20timing%20hit';
    const miss = await call(path, { fakes });
    expect(parseTiming(miss.headers.get('server-timing')).cache.desc).toBe('miss');
    const aiCalls = fakes.ai.calls.length;

    const hit = await call(path, { fakes, keepCache: true });
    expect(fakes.ai.calls.length).toBe(aiCalls);
    const spans = parseTiming(hit.headers.get('server-timing'));
    expect(Object.keys(spans)).toEqual(['cache', 'total']);
    expect(spans.cache.desc).toBe('hit');
    expect(allHaveDurations(spans)).toBe(true);
    // Same body as the miss: the header is the only difference.
    expect(await hit.json()).toEqual(await miss.json());

    const stored = await caches.default.match(/** @type {Request} */ (searchCacheKey(new URL(path, BASE))));
    expect(stored?.headers.get('server-timing')).toBeNull();
    expect(stored?.headers.get('x-app-version')).toBeNull();
  });

  it('400, 429, 502 and degraded responses carry it too', async () => {
    // A 400 is answered before the cache or the limiter is touched.
    const badRes = await call('/search?q=', { fakes });
    expect(badRes.status).toBe(400);
    expect(Object.keys(parseTiming(badRes.headers.get('server-timing')))).toEqual(['total']);

    const limited = createFakes();
    limited.limit.allow = false;
    const res429 = await call('/search?q=databases%20limited', { fakes: limited });
    expect(res429.status).toBe(429);
    expect(Object.keys(parseTiming(res429.headers.get('server-timing')))).toEqual(['cache', 'limit', 'total']);

    const failing = createFakes();
    failing.ai.throws('down');
    const res502 = await call('/search?q=databases%20failing&mode=vector', { fakes: failing });
    expect(res502.status).toBe(502);
    expect(Object.keys(parseTiming(res502.headers.get('server-timing')))).toEqual(['cache', 'limit', 'embed', 'total']);

    const degraded = await call('/search?q=databases%20failing', { fakes: failing });
    expect(degraded.status).toBe(200);
    const spans = parseTiming(degraded.headers.get('server-timing'));
    expect(Object.keys(spans)).toEqual(['cache', 'limit', 'embed', 'fts', 'hydrate', 'degraded', 'total']);
    expect(spans.degraded.desc).toBe('workers-ai-error');
  });
});

describe('Server-Timing on /module and /facets', () => {
  it.each(['/module/CS1010S', '/module/XX9999', '/facets'])('%s reports d1 and total', async (path) => {
    const res = await call(path);
    const spans = parseTiming(res.headers.get('server-timing'));
    expect(Object.keys(spans)).toEqual(['d1', 'total']);
    expect(allHaveDurations(spans)).toBe(true);
  });
});

describe('structured /search log', () => {
  it('writes one line per miss with counts, spans and D1 cost, and no headers or IPs', async () => {
    const logs = captureSearchLogs();
    const res = await call('/search?q=machine%20learning%20logged&sem=1', {
      fakes,
      env: { CF_VERSION_METADATA: VERSION },
      init: { headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'secret-agent/1.0' } },
    });
    const body = await res.json();
    const lines = logs();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({
      event: 'search', status: 200, cache: 'miss', q: 'machine learning logged', qLength: 23,
      mode: 'hybrid', filters: { sem: 1 }, topK: 20, degraded: null,
      counts: {
        vector: body.retrieval.vector, lexical: body.retrieval.lexical, fused: body.retrieval.fused,
        returned: body.count, stale: 0,
      },
      colo: null, version: 'abc1234',
    });
    expect(Object.keys(line.spans)).toEqual(['cache', 'limit', 'embed', 'vector', 'fts', 'hydrate', 'total']);
    // FTS + hydrate, both against the local D1 (a session on it).
    expect(line.d1.queries).toBe(2);
    expect(line.d1.servedByPrimary).toBe(true);
    expect(line.d1.rowsRead).toBeGreaterThan(0);
    expect(line.d1).toHaveProperty('servedByRegion');
    expect(line.d1).toHaveProperty('servedByPrimary');
    const raw = JSON.stringify(line);
    expect(raw).not.toContain('203.0.113.7');
    expect(raw).not.toContain('secret-agent');
  });

  it('cuts the logged query to 100 characters but logs its full length', async () => {
    const logs = captureSearchLogs();
    const q = `${'a'.repeat(95)} long query ${'b'.repeat(40)}`;
    await call(`/search?q=${encodeURIComponent(q)}&mode=lexical`, { fakes });
    const [line] = logs();
    expect(line.q).toBe(q.slice(0, 100));
    expect(line.qLength).toBe(q.length);
  });

  it('logs a cache hit with no D1 cost, and a 400 with its status', async () => {
    const path = '/search?q=robotics%20logged%20hit&mode=lexical';
    await call(path, { fakes });
    const logs = captureSearchLogs();
    await call(path, { fakes, keepCache: true });
    await call('/search?q=x&sem=9', { fakes });
    const [hit, bad] = logs();
    expect(hit).toMatchObject({ status: 200, cache: 'hit', q: 'robotics logged hit', d1: { queries: 0, rowsRead: 0 } });
    expect(Object.keys(hit.spans)).toEqual(['cache', 'total']);
    expect(bad).toMatchObject({ status: 400, cache: 'bypass', q: 'x' });
  });
});

describe('version traceability', () => {
  it('x-app-version is the tag, else the version id, else "dev", on every route', async () => {
    for (const path of ['/', '/search?q=networks%20version', '/module/CS1010S', '/facets', '/health', '/nope']) {
      const tagged = await call(path, { fakes, env: { CF_VERSION_METADATA: VERSION } });
      expect(tagged.headers.get('x-app-version'), path).toBe('abc1234');
    }
    const untagged = await call('/health', { env: { CF_VERSION_METADATA: { ...VERSION, tag: '' } } });
    expect(untagged.headers.get('x-app-version')).toBe(VERSION.id);
    expect((await call('/health')).headers.get('x-app-version')).toBe('dev');
  });

  it('a cache hit carries the current version, not the one that stored it', async () => {
    const path = '/search?q=compilers%20version%20hit';
    await call(path, { fakes, env: { CF_VERSION_METADATA: { ...VERSION, tag: 'old0001' } } });
    const hit = await call(path, { fakes, keepCache: true, env: { CF_VERSION_METADATA: VERSION } });
    expect(parseTiming(hit.headers.get('server-timing')).cache.desc).toBe('hit');
    expect(hit.headers.get('x-app-version')).toBe('abc1234');
  });

  it('GET /health reports the version without touching D1', async () => {
    const { status, headers, body } = await callJson('/health', { env: { CF_VERSION_METADATA: VERSION, DB: undefined } });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, versionId: VERSION.id, versionTag: 'abc1234' });
    expect(headers.get('cache-control')).toBe('no-store');

    const local = await callJson('/health');
    expect(local.body).toEqual({ ok: true, versionId: null, versionTag: null });
  });
});

describe('log hygiene', () => {
  it('never logs free-text faculty values or unvalidated modes', async () => {
    /** @type {string[]} */
    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l) => { lines.push(String(l)); });
    try {
      await call('/search?q=logs%20faculty&faculty=alice%40example.com%20%2B65%209123', { fakes: createFakes() });
      await call(`/search?q=logs%20mode&mode=${'x'.repeat(500)}`, { fakes: createFakes() });
    } finally { spy.mockRestore(); }
    const joined = lines.join('\n');
    expect(joined).not.toContain('alice@example.com');
    expect(joined).not.toContain('x'.repeat(50));
    expect(lines.some((l) => l.includes('"faculty":true'))).toBe(true);
    expect(lines.some((l) => l.includes('"mode":"invalid"'))).toBe(true);
  });
});

