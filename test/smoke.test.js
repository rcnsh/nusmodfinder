// @ts-check
// Smoke tests: prove the harness drives the real Worker (src/index.js) end to
// end over the fixture corpus. Behaviour checks live in their own files.
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
    const hashes = /** @type {{ modules: object }} */ (await res.json());
    expect(Object.keys(hashes.modules)).toHaveLength(fixture.modules.length);
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
    // CS1010S may stand in its duplicate group's variants.
    expect(body.results.flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)])).toContain('CS1010S');
    expect(fakes.ai.calls).toHaveLength(0);
    expect(fakes.vectorize.calls).toHaveLength(0);
  });

  it('answers a hybrid search through the fake embedder and the bundled vectors, without Vectorize', async () => {
    const before = { ai: fakes.ai.calls.length, vec: fakes.vectorize.calls.length };
    const { status, body } = await callJson('/search?q=machine%20learning%20for%20physicists', { fakes });
    expect(status).toBe(200);
    expect(body.mode).toBe('hybrid');
    expect(body.retrieval.vector).toBeGreaterThan(0);
    expect(body.retrieval.lexical).toBeGreaterThan(0);
    expect(body.results.map((/** @type {{ code: string }} */ r) => r.code)).toContain('PC3270');
    expect(fakes.ai.calls.length - before.ai).toBe(1);
    expect(fakes.vectorize.calls.length - before.vec).toBe(0);
  });

  it('answers a hybrid search through the fake embedder and index under DENSE_BACKEND=vectorize', async () => {
    const before = { ai: fakes.ai.calls.length, vec: fakes.vectorize.calls.length };
    const { status, body } = await callJson('/search?q=machine%20learning%20for%20physicists', { fakes, env: { DENSE_BACKEND: 'vectorize' } });
    expect(status).toBe(200);
    expect(body.mode).toBe('hybrid');
    expect(body.retrieval.vector).toBeGreaterThan(0);
    expect(body.retrieval.lexical).toBeGreaterThan(0);
    expect(body.results.map((/** @type {{ code: string }} */ r) => r.code)).toContain('PC3270');
    expect(fakes.ai.calls.length - before.ai).toBe(1);
    expect(fakes.vectorize.calls.length - before.vec).toBe(1);
    expect(fakes.vectorize.calls.at(-1)?.args[1]).toEqual({ topK: 50 });
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

  it('degrades a hybrid search to keyword-only when embedding fails, and fails mode=vector with a 502', async () => {
    const failing = createFakes();
    failing.ai.throws('model unavailable');
    const hybrid = await callJson('/search?q=databases', { fakes: failing });
    expect(hybrid.status).toBe(200);
    expect(hybrid.body.degraded).toEqual({ source: 'workers-ai', reason: 'error' });
    const { status, body } = await callJson('/search?q=databases&mode=vector', { fakes: failing });
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
  it('returns the full row for CS1010S: the columns of migrations 0001-0005, the exchange allow mask and its reasons, then the exams and link, the cohort-only flag, and the grading basis and other codes', async () => {
    const { status, body } = await callJson('/module/CS1010S');
    expect(status).toBe(200);
    expect(body).toMatchObject({ code: 'CS1010S', title: 'Programming Methodology', semesters: [1, 2], ng: false, ng_allow: 0 });
    expect(Object.keys(body)).toEqual(['code', 'title', 'description', 'credits', 'department', 'faculty', 'level',
      'semesters', 'workload', 'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters', 'ng_allow', 'exchange',
      'examDates', 'nusmodsUrl', 'prereqCohortOnly', 'gradingBasis', 'otherCodes']);
    // Off the NG list: closed for every semester and study level, saying so.
    expect(body.exchange).toHaveLength(15);
    for (const e of body.exchange) {
      expect(e).toMatchObject({ status: 'closed', reasons: [{ id: 'ng-list:not-listed', kind: 'closed' }] });
    }
  });
});

describe('/facets', () => {
  it('carries offListRules beside ngSources: NUS\'s four rules about courses off the exchange list, each with its scope', async () => {
    const { body } = await callJson('/facets');
    expect(Object.keys(body).slice(-2)).toEqual(['ngSources', 'offListRules']);
    expect(body.offListRules.map((/** @type {{ id: string }} */ r) => r.id)).toEqual(['E-offerings-list', '2-biz-no-late-add', '4-cee-no-appeal', '4-isem-no-appeal']);
    // The page finds rule E by its overlay role, not by an id a new year may rename.
    for (const r of body.offListRules) {
      expect(Object.keys(r), r.id).toEqual(r.id === 'E-offerings-list' ? ['id', 'text', 'scope', 'role'] : ['id', 'text', 'scope']);
      expect(r.text, r.id).toMatch(/\S{3}/);
    }
    expect(body.offListRules[2].scope).toEqual({ departments: ['Civil and Environmental Engineering'], levels: [1, 2, 3, 4] });
  });

  it('falls back to live aggregates when no precomputed row exists (no NG date before an ingest records one)', async () => {
    const { status, headers, body } = await callJson('/facets');
    expect(status).toBe(200);
    // The precomputed path sets a cache-control header; the fallback does not.
    expect(headers.get('cache-control')).toBeNull();
    const faculties = new Set(fixture.modules.map((m) => m.faculty));
    expect(body.faculties).toHaveLength(faculties.size);
    expect(body.ng).toEqual({ count: fixture.modules.filter((m) => m.ng).length, updatedAsAt: null });
  });
});

describe('admin routes', () => {
  it.each([
    ['GET', '/admin/hashes'],
    ['POST', '/admin/ingest'],
    ['POST', '/admin/facets'],
    ['POST', '/admin/delete'],
    ['GET', '/admin/vectorize'],
    ['POST', '/admin/verify'],
  ])('%s %s is 404 when no INGEST_SECRET is bound', async (method, path) => {
    const { status, body } = await callJson(path, {
      init: { method, headers: { authorization: 'Bearer anything' }, ...(method === 'POST' ? { body: '{}' } : {}) },
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});
