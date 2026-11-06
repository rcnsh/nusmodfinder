// @ts-check
// Ranking neutrality of workstream 1B: every request below goes through the
// frozen pre-1B search route (test/legacy/search-f61072e.js) and through the
// live Worker, over the same D1 and the same fakes, and the answers must be
// identical. The only allowed differences are the bug fixes 1B makes, each
// asserted explicitly: an empty `topK=` means the default (B8), and the body
// echoes the canonical query (B7). Both paths share src/lexical.js.
// The pre-1B route queries Vectorize, so the live Worker runs under the
// Vectorize standby (DENSE_BACKEND=vectorize, Phase 3 3-0); the bundle's
// identity with that path is test/dense.test.js.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Trace } from '../src/timing.js';
import { BASE, buildEnv, callJson, fixture, seed } from './helpers.js';
import { searchRoute as legacySearchRoute } from './legacy/search-f61072e.js';

const STANDBY = { DENSE_BACKEND: 'vectorize' };

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
  // Both paths log a line per request; keep the output readable.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

/**
 * @param {string} path
 * @returns {Promise<{ status: number, body: any }>}
 */
async function legacy(path) {
  const url = new URL(path, BASE);
  await caches.default.delete(new Request(url.toString(), { method: 'GET' }));
  const ctx = createExecutionContext();
  const res = await legacySearchRoute(new Request(url), buildEnv(fakes), ctx, new Trace());
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

/** Deterministic PRNG (mulberry32), so the request set is the same every run. */
function rng(seedValue = 0x1b) {
  let a = seedValue;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const modules = fixture.modules;
const faculties = [...new Set(modules.map((m) => m.faculty).filter(Boolean))].slice(0, 4);
const QUERIES = [
  'machine learning', 'Machine  Learning', 'DATA visualisation', '  data   visualisation ',
  'programming methodology', 'how do i start my own company', 'the', 'is it', 'or',
  'asdkjhqwe zxq', 'naïve bayes', 'intro to modules that teach something', 'quantum physics',
  'accounting', 'japanese language', 'statistics for life sciences', 'management', 'introduction',
  'machine learning for physicists', 'C++ & Java: (advanced)', '"quoted" AND NOT near*', 'cs 1010s', 'CS101',
  'cs1010s', 'CS1010S', 'Cs1010S',
  // Non-ASCII case: U+212A KELVIN SIGN lower-cases to 'k' under full Unicode rules.
  'LA\u212A1201', 'la\u212A1201', 'NAÏVE BAYES', 'Ünïcode ÉCONOMICS', 'stra\u00DFe', '\uFB01nance',
  // Every 25th fixture module: its code, and a few words of its title.
  ...modules.filter((_, i) => i % 25 === 0).flatMap((m) => [m.code, m.title.split(/\s+/).slice(0, 3).join(' ')]),
];
const FILTERS = [
  '', 'sem=1', 'sem=2', 'sem=3', 'sem=4', 'level=1', 'level=4', 'level=5', 'credits=4', 'credits=2', 'ng=1',
  'sem=1&ng=1', 'sem=2&level=2&credits=4', ...faculties.map((f) => `faculty=${encodeURIComponent(String(f))}`),
  'sem=9', 'level=x', 'credits=-1', 'ng=0', 'ng=false',
];
const MODES = ['', 'mode=lexical', 'mode=vector', 'mode=hybrid', 'mode=bogus'];
const TOPKS = ['', 'topK=5', 'topK=20', 'topK=50', 'topK=100', 'topK=0', 'topK=abc', 'topK=7.9', 'topK=', 'topK=-3'];

/** Every query × mode, each with 3 random filter/topK combinations, plus junk params now and then. */
function requests() {
  const next = rng();
  const pick = (/** @type {string[]} */ xs) => xs[Math.floor(next() * xs.length)];
  /** @type {string[]} */
  const out = [];
  for (const q of QUERIES) {
    for (const mode of MODES.slice(0, 3)) {
      for (let i = 0; i < 3; i++) {
        const parts = [`q=${encodeURIComponent(q)}`, mode, pick(FILTERS), pick(TOPKS)];
        if (next() < 0.1) parts.push(pick(MODES));
        if (next() < 0.1) parts.push('_junk=1');
        out.push(`/search?${parts.filter(Boolean).join('&')}`);
      }
    }
  }
  return out;
}

/**
 * Compares one request on both paths. Returns a description of any
 * difference that is not one of the declared bug fixes, else null.
 * @param {string} path
 */
async function compare(path) {
  const url = new URL(path, BASE);
  // B8: `topK=` (empty) now means the default; before, it meant 1.
  const legacyUrl = new URL(url);
  if (legacyUrl.searchParams.get('topK')?.trim() === '') legacyUrl.searchParams.delete('topK');
  const before = await legacy(legacyUrl.pathname + legacyUrl.search);
  const after = await callJson(path, { fakes, env: STANDBY });
  if (before.status !== after.status) return `${path}: status ${before.status} -> ${after.status}`;
  const expected = before.status === 200
    // B7: the body echoes the canonical query (trimmed, whitespace collapsed, ASCII lower-cased).
    ? { ...before.body, query: before.body.query.replace(/\s+/g, ' ').replace(/[A-Z]+/g, (/** @type {string} */ m) => m.toLowerCase()) }
    : before.body;
  try {
    expect(after.body).toEqual(expected);
  } catch (err) {
    return `${path}: ${/** @type {Error} */ (err).message.slice(0, 2000)}`;
  }
  return null;
}

describe('1B is ranking-neutral', () => {
  it('returns the same status and body as the pre-1B route for every generated request', async () => {
    const paths = requests();
    const diffs = [];
    let ok = 0, withResults = 0;
    for (const p of paths) {
      const diff = await compare(p);
      if (diff) diffs.push(diff);
      const { status, body } = await callJson(p, { fakes, keepCache: true, env: STANDBY });
      if (status === 200) { ok += 1; if (body.results.length) withResults += 1; }
    }
    expect(diffs).toEqual([]);
    // The set is broad enough to mean something.
    expect(paths.length).toBeGreaterThanOrEqual(500);
    expect(ok).toBeGreaterThan(paths.length * 0.7);
    expect(withResults).toBeGreaterThan(paths.length * 0.5);
    expect(paths.filter((p) => p.includes('mode=vector')).length).toBeGreaterThan(100);
    console.info(`differential: ${paths.length} requests, ${ok} 200s (${withResults} with results), ${diffs.length} differences`);
  }, 120_000);

  it('returns the same results when the index holds stale vectors missing from D1', async () => {
    const saved = fakes.vectorize.vectors;
    fakes.vectorize.vectors = new Map(saved);
    // Ghosts identical to real vectors, so they rank at the top of the dense list.
    for (const [i, code] of ['CS1010S', 'CS2040S', modules[0].code, modules[200].code].entries()) {
      const v = saved.get(code);
      if (v) fakes.vectorize.vectors.set(`ZZ900${i}`, { ...v, id: `ZZ900${i}` });
    }
    try {
      const paths = requests().filter((p) => !p.includes('mode=lexical')).slice(0, 200);
      let compared = 0;
      for (const p of paths) {
        const before = await legacy(p.replace(/topK=(&|$)/, ''));
        const after = await callJson(p.replace(/topK=(&|$)/, ''), { fakes, env: STANDBY });
        expect(after.status, p).toBe(before.status);
        if (before.status !== 200) continue;
        // Same page of results. retrieval.fused can only differ here, and only
        // upwards: hydration stops once the page is full, so stale candidates
        // below it are not discovered (and not subtracted).
        expect(after.body.results, p).toEqual(before.body.results);
        expect(after.body.count, p).toBe(before.body.count);
        expect(after.body.retrieval.fused, p).toBeGreaterThanOrEqual(before.body.retrieval.fused);
        compared += 1;
      }
      expect(compared).toBeGreaterThan(100);
    } finally {
      fakes.vectorize.vectors = saved;
    }
  }, 120_000);
});
