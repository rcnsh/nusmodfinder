// @ts-check
// Ranking neutrality of workstream 1B: every request below goes through the
// frozen pre-1B search route (test/legacy/search-f61072e.js) and through the
// live Worker, over the same D1 and the same fakes, and the answers must be
// identical. The only allowed differences are the bug fixes 1B makes, each
// asserted explicitly: an empty `topK=` means the default (B8), and the body
// echoes the canonical query (B7). Both paths share src/lexical.js.
// Since 3B every body also echoes `interpreted` (all null when the parse
// routes nothing), and a query the parse does route (a pin, a partial code, a
// GE phrase, noMatch) is 3B's change by design: those are listed and left out,
// and every other query must still answer exactly as before.
// Since 3C a query with a df-0 token of 4+ letters gets a prefix term or a
// correction in its lexical half (and, under 3C-2, a corrected text in its
// dense half): also a change by design, listed and left out the same way.
// Since 5C-api every body also has `hiddenPins` (empty here: an unrouted query
// pins nothing) and `notOffered`, and every result its `examDates`: additive
// fields, asserted by shape here and by value in test/search-fields.test.js.
// The pre-1B route queries Vectorize, so the live Worker runs under the
// Vectorize standby (DENSE_BACKEND=vectorize, Phase 3 3-0); the bundle's
// identity with that path is test/dense.test.js.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalQuery } from '../src/query-intent.js';
import { Trace } from '../src/timing.js';
import { EMBED_CORRECTED, correctQuery } from '../src/typo.js';
import { parseVocabulary } from '../src/vocabulary.js';
import vocabFile from './fixtures/vocabulary.json';
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
  // Every token in the fixture vocabulary, so 3C leaves them alone (3C).
  'linear algebra', 'database systems', 'computer networks', 'public policy', 'financial accounting',
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
 * The new route without 3F's collapse (the collapsed list is checked against
 * this uncollapsed one, as its group-first projection: test/search-groups.test.js)
 * or 3G's no-signal answer (test/search-no-signal.test.js).
 */
const UNCOLLAPSED = { COLLAPSE_GROUPS: 'off', NO_SIGNAL_TAU: 'off' };

/** `interpreted` for a query the 3B parse routes nothing in. */
const UNROUTED = { pin: null, prefix: null, ge: null, level: null, exam: null, su: null, hoursBelow: null, prereq: null };
/** Whether 3B's parse routed this response. @param {{ status: number, body: any }} r */
const routed = (r) => r.status === 200 && (r.body.noMatch !== undefined || Object.values(r.body.interpreted).some((v) => v !== null));
/** Requests 3B routes, so their answers differ from the pre-1B route by design. */
/** @type {string[]} */
const routedPaths = [];

const vocab = parseVocabulary(/** @type {import('../src/vocabulary.js').VocabularyFile} */ (/** @type {unknown} */ (vocabFile)));
/**
 * Whether 3C changes this request by design: a prefix term or a correction
 * reaches its lexical half, or (3C-2) a corrected text its dense half.
 * @param {string} path
 */
function changedBy3C(path) {
  const params = new URL(path, BASE).searchParams;
  const q = params.get('q')?.trim();
  if (!q) return false;
  const mode = params.get('mode') ?? 'hybrid';
  const c = correctQuery(canonicalQuery(q), vocab);
  return (mode !== 'vector' && c.prefixes.length > 0) || (EMBED_CORRECTED && mode !== 'lexical' && c.corrections.length > 0);
}
/** Requests 3C changes, left out like 3B's. @type {string[]} */
const typoPaths = [];
/**
 * Exchange-mode requests (ng=1), left out too: Phase 4 changes their answers by
 * design (a 400 without `study`, the allow-mask bit with it); SC1's path tests
 * (test/sc1/) cover them. @type {string[]}
 */
const exchangePaths = [];
/** @param {string} path */
const isExchange = (path) => {
  const ng = new URL(path, BASE).searchParams.get('ng');
  return ng !== null && ng !== '' && ng !== '0' && ng !== 'false';
};

/**
 * A pre-1B body with 5C-api's additive fields: `hiddenPins` empty (an
 * unrouted query pins nothing), `notOffered` any list, `examDates` on each result.
 * @param {any} body
 */
const with5CApi = (body) => ({
  ...body, hiddenPins: [], notOffered: expect.any(Array),
  results: body.results.map((/** @type {any} */ r) => ({ ...r, examDates: expect.any(Array) })),
});

/**
 * Compares one request on both paths. Returns a description of any
 * difference that is not one of the declared bug fixes, else null.
 * @param {string} path
 */
async function compare(path) {
  const url = new URL(path, BASE);
  if (isExchange(path)) { exchangePaths.push(path); return null; }
  // B8: `topK=` (empty) now means the default; before, it meant 1.
  const legacyUrl = new URL(url);
  if (legacyUrl.searchParams.get('topK')?.trim() === '') legacyUrl.searchParams.delete('topK');
  const before = await legacy(legacyUrl.pathname + legacyUrl.search);
  const after = await callJson(path, { fakes, env: { ...STANDBY, ...UNCOLLAPSED } });
  if (before.status !== after.status) return `${path}: status ${before.status} -> ${after.status}`;
  if (routed(after)) { routedPaths.push(path); return null; }
  if (after.status === 200 && changedBy3C(path)) { typoPaths.push(path); return null; }
  const expected = before.status === 200
    // B7: the body echoes the canonical query (trimmed, whitespace collapsed, ASCII lower-cased).
    // 3B: and an all-null `interpreted`.
    // 5C-api: and its additive fields.
    ? { ...with5CApi(before.body), query: before.body.query.replace(/\s+/g, ' ').replace(/[A-Z]+/g, (/** @type {string} */ m) => m.toLowerCase()), interpreted: UNROUTED }
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
      const { status, body } = await callJson(p, { fakes, keepCache: true, env: { ...STANDBY, ...UNCOLLAPSED } });
      if (status === 200) { ok += 1; if (body.results.length) withResults += 1; }
    }
    expect(diffs).toEqual([]);
    // The set is broad enough to mean something.
    expect(paths.length).toBeGreaterThanOrEqual(500);
    expect(ok).toBeGreaterThan(paths.length * 0.7);
    expect(withResults).toBeGreaterThan(paths.length * 0.5);
    expect(paths.filter((p) => p.includes('mode=vector')).length).toBeGreaterThan(100);
    // 3B routes the code queries (pins, `cs 1010s`, `CS101`) and nothing else here.
    expect(routedPaths.length).toBeGreaterThan(0);
    expect(paths.length - routedPaths.length).toBeGreaterThan(400);
    for (const p of routedPaths) expect(decodeURIComponent(new URL(p, BASE).searchParams.get('q') ?? ''), p).toMatch(/\d/);
    // 3C changes only queries with a df-0 token of 4+ letters, and leaves most of the set alone.
    expect(typoPaths.length).toBeGreaterThan(0);
    expect(paths.length - routedPaths.length - typoPaths.length).toBeGreaterThan(400);
    console.info(`differential: ${paths.length} requests, ${ok} 200s (${withResults} with results), ${diffs.length} differences, `
      + `${routedPaths.length} routed by 3B, ${typoPaths.length} changed by 3C and ${exchangePaths.length} in exchange mode, left out`);
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
      const paths = requests().filter((p) => !p.includes('mode=lexical') && !isExchange(p)).slice(0, 200);
      let compared = 0;
      for (const p of paths) {
        const before = await legacy(p.replace(/topK=(&|$)/, ''));
        const after = await callJson(p.replace(/topK=(&|$)/, ''), { fakes, env: { ...STANDBY, ...UNCOLLAPSED } });
        expect(after.status, p).toBe(before.status);
        if (before.status !== 200 || routed(after) || changedBy3C(p)) continue;
        // Same page of results. retrieval.fused can only differ here, and only
        // upwards: hydration stops once the page is full, so stale candidates
        // below it are not discovered (and not subtracted).
        expect(after.body.results, p).toEqual(with5CApi(before.body).results);
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
