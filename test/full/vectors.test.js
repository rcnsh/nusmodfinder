// @ts-check
// The pinned vectors bundle (Phase 3 3-0, B2-4): what the full-corpus CI job
// and the SC4 suite search. Skipped unless vitest.config.mjs aliased it in
// (it is fetched by `node scripts/vectors.mjs fetch --corpus pinned`; with
// FULL_CORPUS=1 a missing bundle fails the config before any test runs).
//
// The CPU microbenchmark (B-5, B2-8): workerd's clock reads ~0 for CPU work
// in production, so the `vector` span is no evidence. Locally, under the
// Vitest pool, performance.now() advances with CPU time, so the exact search
// is timed here: cold (the first call in this isolate: the bundle parse, then
// a search with unoptimised code) and warm (the median over many queries).
import { describe, expect, inject, it } from 'vitest';
import manifest from '../../data/vectors.json';
import embeddings from '../../eval/embeddings.json';
import { denseBundle } from '../../src/dense.js';
import { decodeFilterRow, exactSearch, rowsKey, suGrading } from '../../src/vector-bundle.js';

const corpus = inject('corpus');
const bundleKind = inject('vectorsBundle');
const entry = /** @type {any} */ (manifest).bundles.pinned;

describe.skipIf(!corpus || bundleKind !== 'pinned')('the pinned vectors bundle', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  /** @type {{ parseMs: number, coldMs: number } | null} */
  let cold = null;

  it('[cold] parses and answers its first search in this isolate', () => {
    const t0 = performance.now();
    const b = denseBundle();
    const t1 = performance.now();
    const hits = exactSearch(b, b.vectors.subarray(0, b.dims), {}, 50);
    const t2 = performance.now();
    cold = { parseMs: t1 - t0, coldMs: t2 - t1 };
    expect(hits).toHaveLength(50);
    expect(hits[0].code).toBe(b.codes[0]);
  });

  it('is the bundle data/vectors.json records, keyed by the pinned corpus\'s texts (B-2, B2-5)', async () => {
    const b = denseBundle();
    expect(b.header).toMatchObject({ corpus: 'pinned', count: 6771, dims: 384, embedding: entry.embedding, dataVersion: entry.dataVersion, rowsKey: entry.rowsKey });
    expect(await rowsKey(c.modules)).toBe(entry.rowsKey);
    expect(b.codes).toEqual(c.modules.map((m) => m.code).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });

  it('carries every module\'s filter fields, as D1 and the Vectorize metadata hold them', () => {
    const b = denseBundle();
    const index = new Map(b.codes.map((code, i) => [code, i]));
    for (const m of c.modules) {
      expect(decodeFilterRow(b, /** @type {number} */ (index.get(m.code))), m.code).toEqual({
        semesters: m.semesters, level: m.level, credits: m.credits, faculty: m.faculty, ng: m.ng, ngSemesters: m.ngSemesters,
        ngAllow: m.ngAllow, examSemesters: m.examSemesters, su: m.su, suGrading: suGrading(m.gradingBasis), workloadHours: m.workloadHours,
        prereqNone: m.prereqNone, prereqCohortOnly: m.prereqCohortOnly,
      });
    }
  });

  it('shares one vector between codes with the same text (B2-5)', () => {
    const b = denseBundle();
    const index = new Map(b.codes.map((code, i) => [code, i]));
    /** @type {Map<string, string[]>} */
    const byText = new Map();
    for (const m of c.modules) byText.set(m.text, [...(byText.get(m.text) ?? []), m.code]);
    const shared = [...byText.values()].filter((codes) => codes.length > 1);
    // As many distinct texts as the bundle's embedding version embedded (v0 5,920; v1, whose text leads with the code, 6,771).
    expect(byText.size).toBe(/** @type {any} */ (embeddings).versions[entry.embedding].count);
    for (const codes of shared) {
      const rows = codes.map((code) => b.vectors.subarray(/** @type {number} */ (index.get(code)) * b.dims, (/** @type {number} */ (index.get(code)) + 1) * b.dims));
      for (const r of rows.slice(1)) expect(r).toEqual(rows[0]);
    }
  });

  // A measurement, not a gate: 1,000+ searches take ~7 s on a CI runner (3.4 ms each), so it gets room.
  it('[B-5] CPU per exact search over 6,771 x 384 float32 rows, warm, unfiltered and filtered', { timeout: 60_000 }, () => {
    const b = denseBundle();
    // The clock ticks in whole milliseconds here, so each figure is a batch of
    // N searches timed together; five batches, their per-search means reported.
    const N = 200;
    /** @param {import('../../src/vector-bundle.js').FilterEcho} echo */
    const time = (echo) => {
      const means = [];
      for (let batch = 0; batch < 5; batch++) {
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          const row = ((batch * N + i) * 7919) % b.count;
          exactSearch(b, b.vectors.subarray(row * b.dims, (row + 1) * b.dims), echo, 50);
        }
        means.push((performance.now() - t0) / N);
      }
      means.sort((x, y) => x - y);
      return { msPerSearch: { min: means[0], median: means[2], max: means[4] } };
    };
    const result = {
      bench: '3-0 exact search', rows: b.count, dims: b.dims, searchesPerBatch: N, batches: 5, ...cold,
      unfiltered: time({}), sem1: time({ sem: 1 }), level1: time({ level: 1 }), ngSem2: time({ ng: true, sem: 2 }),
    };
    console.log(JSON.stringify(result));
    // A generous bound, so the test is no timing gate; the evidence is the printed line.
    expect(result.unfiltered.msPerSearch.median).toBeLessThan(50);
  });
});
