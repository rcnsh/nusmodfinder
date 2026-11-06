// @ts-check
// Phase 3 3-0: the bundled exact dense search (src/dense.js) on the fixture
// corpus. The fixture bundle (test/fixtures/vectors.bin) holds the fake
// embedder's vectors for the fixture modules, the vectors seed() puts in the
// fake Vectorize, so the two dense backends must rank alike.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { denseBundle } from '../src/dense.js';
import { decodeFilterRow, rowsKey } from '../src/vector-bundle.js';
import { fieldsFromRow } from '../src/rowhash.js';
import manifest from '../data/vectors.json';
import { createFakes, hashEmbed } from './fakes.js';
import { callJson, fixture, seed } from './helpers.js';

const STANDBY = { DENSE_BACKEND: 'vectorize' };
/** Adjacent items whose scores differ by less than this may swap (docs/plans/phase3.md 3-0, A-N6). */
const SWAP_TOLERANCE = 1e-6;

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

/** Exact cosine in double precision, as the fake Vectorize scores. @param {number[]} a @param {number[]} b */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const textOf = new Map(fixture.modules.map((m) => [m.code, m.text]));

/**
 * Where two ranked lists differ, position by position, with the exact cosine
 * of each side's item for `q`. Every difference must be a near-tie swap.
 * @param {string} q @param {string[]} a @param {string[]} b
 */
function differences(q, a, b) {
  const qv = hashEmbed(q);
  /** @type {{ at: number, a: string, b: string, delta: number }[]} */
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const sa = a[i] ? cosine(qv, hashEmbed(/** @type {string} */ (textOf.get(a[i])))) : NaN;
    const sb = b[i] ? cosine(qv, hashEmbed(/** @type {string} */ (textOf.get(b[i])))) : NaN;
    out.push({ at: i, a: a[i], b: b[i], delta: Math.abs(sa - sb) });
  }
  return out;
}

const QUERIES = [
  'machine learning', 'data visualisation', 'programming methodology', 'how do i start my own company', 'the', 'or',
  'quantum physics', 'accounting', 'japanese language', 'statistics for life sciences', 'management', 'introduction',
  'machine learning for physicists', 'cs1010s', 'applications of ai', 'law, technology and', 'deep learning in',
  'asdkjhqwe zxq', 'climate change policy', 'financial markets',
];
const faculties = [...new Set(fixture.modules.map((m) => m.faculty).filter(Boolean))].slice(0, 3);
const FILTERS = ['', '&sem=1', '&sem=3', '&level=2', '&credits=4', '&ng=1', '&ng=1&sem=2', `&faculty=${encodeURIComponent(String(faculties[0]))}`,
  `&faculty=${encodeURIComponent(String(faculties[1]))}&level=3`, '&level=5&credits=4'];

describe('3-0 identity on the fixture (A-N6)', () => {
  it('the bundle ranks like the fake Vectorize (exact cosine, id tiebreak) for every query and filter; near-tie swaps listed', async () => {
    /** @type {{ path: string, at: number, a: string, b: string, delta: number }[]} */
    const swaps = [];
    /** @type {string[]} */
    const hybridFollows = [];
    let compared = 0;
    for (const q of QUERIES) {
      for (const f of FILTERS) {
        /** @param {string} mode */
        const both = async (mode) => {
          const path = `/search?q=${encodeURIComponent(q)}${f}&mode=${mode}&topK=50`;
          const bundle = await callJson(path, { fakes });
          const standby = await callJson(path, { fakes, env: STANDBY });
          expect(bundle.status, path).toBe(200);
          expect(standby.status, path).toBe(200);
          expect(bundle.body.degraded, path).toBeUndefined();
          return { path, a: bundle.body.results.map((/** @type {any} */ r) => r.code), b: standby.body.results.map((/** @type {any} */ r) => r.code) };
        };
        // mode=vector is the whole dense list (depth 50 = topK 50).
        const dense = await both('vector');
        const diff = differences(q, dense.a, dense.b);
        for (const d of diff) swaps.push({ path: dense.path, ...d });
        // Fusion is rank-based, so the hybrid page is identical whenever the
        // dense lists are; a near-tie swap moves fused ranks, and is listed.
        const hybrid = await both('hybrid');
        if (diff.length === 0) expect(hybrid.a, hybrid.path).toEqual(hybrid.b);
        else if (JSON.stringify(hybrid.a) !== JSON.stringify(hybrid.b)) hybridFollows.push(hybrid.path);
        compared++;
      }
    }
    expect(compared).toBe(QUERIES.length * FILTERS.length);
    // Every dense difference is a pair of items tied to within the tolerance
    // (the fake embedder's integer word counts tie exactly; float rounding orders them).
    expect(swaps.filter((s) => !(s.delta < SWAP_TOLERANCE))).toEqual([]);
    console.log(`3-0 fixture identity: ${compared} query x filter cells; ${swaps.length} near-tie swap positions in the dense lists `
      + `(max |Δ| ${swaps.length ? Math.max(...swaps.map((s) => s.delta)).toExponential(1) : 0}), ${hybridFollows.length} hybrid pages reordered by them:\n`
      + swaps.map((s) => `  ${s.path} @${s.at}: ${s.a} <-> ${s.b} (|Δ| ${s.delta.toExponential(1)})`).join('\n'));
  }, 120_000); // 800 searches

  it('the bundled search makes no Vectorize call; the standby makes exactly one', async () => {
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    for (const mode of ['vector', 'hybrid']) {
      const { status, body } = await callJson(`/search?q=machine%20learning&mode=${mode}&sem=1`, { fakes: f });
      expect(status).toBe(200);
      expect(body.retrieval.vector).toBeGreaterThan(0);
    }
    expect(f.vectorize.calls).toEqual([]);
    expect(f.ai.calls).toHaveLength(2);
    await callJson('/search?q=machine%20learning&mode=vector&sem=1', { fakes: f, env: STANDBY });
    expect(f.vectorize.calls.map((c) => c.method)).toEqual(['query']);
    expect(f.vectorize.calls[0].args[1]).toEqual({ topK: 50, filter: { sem1: true } });
  });

  it('any DENSE_BACKEND other than "vectorize" is the bundle', async () => {
    const f = createFakes();
    for (const value of ['bundle', 'Vectorize', '', undefined]) {
      const { body } = await callJson('/search?q=machine%20learning&mode=vector', { fakes: f, env: { DENSE_BACKEND: value } });
      expect(body.retrieval.vector).toBe(50);
    }
    expect(f.vectorize.calls).toEqual([]);
  });

  it('the fixture bundle is what data/vectors.json records, and holds every fixture module\'s row', async () => {
    const b = denseBundle();
    const entry = /** @type {any} */ (manifest).bundles.fixture;
    expect(b.header).toMatchObject({ corpus: 'fixture', count: fixture.modules.length, rowsKey: entry.rowsKey, dataVersion: entry.dataVersion });
    expect(await rowsKey(fixture.modules)).toBe(entry.rowsKey);
    const { results } = /** @type {D1Result<import('../src/rowhash.js').ModuleRow>} */ (await env.DB.prepare('SELECT * FROM modules ORDER BY code').all());
    expect(b.codes).toEqual(results.map((r) => r.code).sort((x, y) => (x < y ? -1 : 1)));
    for (const r of results) {
      const f = fieldsFromRow(r);
      expect(decodeFilterRow(b, b.codes.indexOf(r.code)), r.code).toEqual({
        semesters: f.semesters, level: f.level, credits: f.credits, faculty: f.faculty, ng: f.ng, ngSemesters: f.ngSemesters,
      });
    }
  });
});

describe('3-0 between a D1-only ingest and the deploy (B-3)', () => {
  it('a dense row whose fresh D1 row fails the filters is dropped after hydrate, and the next one fills the page', async () => {
    await seed();
    const path = '/search?q=machine%20learning&mode=vector&sem=1&topK=10';
    const before = await callJson(path);
    const top = before.body.results[0].code;
    // D1 moves the top module out of semester 1; the bundle still says sem 1.
    await env.DB.prepare("UPDATE modules SET semesters = '[2]' WHERE code = ?").bind(top).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const after = await callJson(path);
      const codes = after.body.results.map((/** @type {any} */ r) => r.code);
      expect(codes).not.toContain(top);
      expect(codes).toHaveLength(10);
      expect(codes.slice(0, 9)).toEqual(before.body.results.slice(1).map((/** @type {any} */ r) => r.code));
      const line = logs.mock.calls.map((a) => { try { return JSON.parse(String(a[0])); } catch { return null; } }).find((l) => l?.event === 'search');
      expect(line.counts).toMatchObject({ filtered: 1, stale: 0, returned: 10 });
      expect(warn.mock.calls.flat().join(' ')).toContain(top);
      // Unfiltered, the row is still served: only a failing filter drops it.
      expect((await callJson('/search?q=machine%20learning&mode=vector&topK=10')).body.results.map((/** @type {any} */ r) => r.code)).toContain(top);
    } finally { warn.mockRestore(); logs.mockRestore(); }
    await seed();
  });

  it('a lexical candidate is never dropped by the dense rule: D1 filtered it in SQL', async () => {
    await seed();
    // Hybrid: a module both retrievers find, which still matches in D1.
    const { body } = await callJson('/search?q=programming%20methodology&sem=1');
    expect(body.results.map((/** @type {any} */ r) => r.code)).toContain('CS1010S');
  });

  it('a bundle row D1 no longer holds is dropped at hydrate, as a stale Vectorize id is', async () => {
    await seed();
    const path = '/search?q=machine%20learning&mode=vector&topK=5';
    const before = (await callJson(path)).body.results.map((/** @type {any} */ r) => r.code);
    await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind(before[0]).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const after = (await callJson(path)).body.results.map((/** @type {any} */ r) => r.code);
      expect(after).not.toContain(before[0]);
      expect(after.slice(0, 4)).toEqual(before.slice(1));
    } finally { warn.mockRestore(); }
    await seed();
  });
});
