// @ts-check
// Smoke tests: prove the harness drives the real Worker (src/index.js) end to
// end over the fixture corpus. Behaviour checks for the Phase 0 findings live
// in their own files (workstream 0c).
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakes } from './fakes.js';
import { adminCall, call, callJson, fixture, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;

beforeAll(async () => {
  fakes = await seed();
});

describe('seeding', () => {
  it('loads every fixture module into D1 and the fake index', async () => {
    const res = await adminCall('/admin/hashes', fakes);
    const hashes = await res.json();
    expect(Object.keys(/** @type {object} */ (hashes))).toHaveLength(fixture.modules.length);
    expect(fakes.vectorize.vectors.size).toBe(fixture.modules.length);
  });
});

describe('/search', () => {
  it('answers a lexical search from D1 FTS without touching AI or Vectorize', async () => {
    const { status, body } = await callJson('/search?q=programming%20methodology&mode=lexical', { fakes });
    expect(status).toBe(200);
    expect(body.mode).toBe('lexical');
    expect(body.retrieval.vector).toBe(0);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.map((/** @type {{ code: string }} */ r) => r.code)).toContain('CS1010S');
    expect(fakes.ai.calls).toHaveLength(0);
    expect(fakes.vectorize.calls).toHaveLength(0);
  });

  it('answers a hybrid search through the fake embedder and index', async () => {
    const before = { ai: fakes.ai.calls.length, vec: fakes.vectorize.calls.length };
    const { status, body } = await callJson('/search?q=machine%20learning%20for%20physicists', { fakes });
    expect(status).toBe(200);
    expect(body.mode).toBe('hybrid');
    expect(body.retrieval.vector).toBeGreaterThan(0);
    expect(body.retrieval.lexical).toBeGreaterThan(0);
    expect(body.results.map((/** @type {{ code: string }} */ r) => r.code)).toContain('PC3270');
    expect(fakes.ai.calls.length - before.ai).toBe(1);
    expect(fakes.vectorize.calls.length - before.vec).toBe(1);
    expect(fakes.vectorize.calls.at(-1)?.args[1]).toMatchObject({ topK: 50, returnMetadata: 'indexed' });
  });

  it('pins an exact module code to the top', async () => {
    const { status, body } = await callJson('/search?q=cs1010s&mode=lexical', { fakes });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({ code: 'CS1010S', score: 1 });
  });

  it('serves a repeat from cache only when the helper is told to keep it', async () => {
    const path = '/search?q=quantum%20physics%20smoke';
    await call(path, { fakes });
    const afterFirst = fakes.ai.calls.length;
    await call(path, { fakes, keepCache: true });
    expect(fakes.ai.calls.length).toBe(afterFirst);
    await call(path, { fakes });
    expect(fakes.ai.calls.length).toBe(afterFirst + 1);
  });

  it('reports an embedding failure as a 502 from workers-ai', async () => {
    const failing = createFakes();
    failing.ai.throws('model unavailable');
    const { status, body } = await callJson('/search?q=databases', { fakes: failing });
    expect(status).toBe(502);
    expect(body).toMatchObject({ error: 'upstream_failure', source: 'workers-ai', message: 'model unavailable' });
  });

  it('returns 429 when the rate limiter refuses', async () => {
    const limited = createFakes();
    limited.limit.allow = false;
    const res = await call('/search?q=databases', { fakes: limited });
    expect(res.status).toBe(429);
    expect(limited.ai.calls).toHaveLength(0);
  });
});

describe('/module/:code', () => {
  it('returns the full row for CS1010S', async () => {
    const { status, body } = await callJson('/module/CS1010S');
    expect(status).toBe(200);
    expect(body).toMatchObject({ code: 'CS1010S', title: 'Programming Methodology', semesters: [1, 2], ng: false });
  });
});

describe('/facets', () => {
  it('falls back to live aggregates when no precomputed row exists', async () => {
    const { status, headers, body } = await callJson('/facets');
    expect(status).toBe(200);
    // The precomputed path sets a cache-control header; the fallback does not.
    expect(headers.get('cache-control')).toBeNull();
    const faculties = new Set(fixture.modules.map((m) => m.faculty));
    expect(body.faculties).toHaveLength(faculties.size);
    expect(body.ng).toEqual({ count: fixture.modules.filter((m) => m.ng).length, updatedAsAt: '01 Sep 2026' });
  });
});

describe('admin routes', () => {
  it.each([
    ['GET', '/admin/hashes'],
    ['POST', '/admin/ingest'],
    ['POST', '/admin/facets'],
  ])('%s %s is 404 when no INGEST_SECRET is bound', async (method, path) => {
    const { status, body } = await callJson(path, {
      init: { method, headers: { authorization: 'Bearer anything' }, ...(method === 'POST' ? { body: '{}' } : {}) },
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});
