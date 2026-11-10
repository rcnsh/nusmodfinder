// @ts-check
// The vectors bundle format and the exact search over it (Phase 3, 3-0;
// docs/plans/phase3.md §2 "3-0 In-Worker exact vector search"). Pure code, so
// it runs in Node; test/dense.test.js covers the same search through /search.
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_SCHEMA, ROW_STRIDE, compileMask, decodeFilterRow, encodeBundle, exactSearch, parseBundle, rowsKey,
} from '../src/vector-bundle.js';
import { dataVersion, rowHash } from '../src/rowhash.js';

const DIMS = 384;

/**
 * @param {string} code
 * @param {Partial<import('../src/rowhash.js').RowFields>} [over]
 * @returns {import('../src/rowhash.js').RowFields}
 */
const mod = (code, over = {}) => ({
  code, title: `${code} title`, description: 'd', credits: 4, department: 'Dept', faculty: 'Computing', level: Number(code.match(/\d/)?.[0] ?? 1),
  semesters: [1], workload: null, prerequisite: null, preclusion: null, acadYear: '2026-2027', textHash: `th-${code}`,
  ng: false, ngSemesters: [], ...over,
});

/** A unit-ish vector pointing mostly along `axis`, with a small `tilt` along axis + 1. @param {number} axis @param {number} [tilt] @param {number} [scale] */
const vec = (axis, tilt = 0, scale = 1) => {
  const v = new Array(DIMS).fill(0);
  v[axis] = scale;
  v[(axis + 1) % DIMS] = tilt * scale;
  return v;
};

/** @param {import('../src/rowhash.js').RowFields[]} modules @param {Record<string, number[]>} vectors @param {import('../src/vector-bundle.js').BundleCorpus} [corpus] */
const build = async (modules, vectors, corpus = 'fixture') => {
  const bytes = await encodeBundle({ corpus, embedding: 'test', model: 'm', modules, vectorOf: (m) => vectors[m.code] });
  return parseBundle(/** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
};

describe('encodeBundle / parseBundle', () => {
  it('round-trips codes in code order, the header, normalised float32 rows and the filter table', async () => {
    const modules = [
      mod('CS2040', { semesters: [2, 3], level: 2, credits: 4, faculty: 'Computing', ng: true, ngSemesters: [2], ngAllow: 0x7c00 | 0x3e0 }),
      mod('AB1000', { semesters: [1], level: null, credits: null, faculty: null }),
      mod('CS1010S', { semesters: [1, 2, 4], level: 1, credits: 2.5, faculty: 'Arts' }),
    ];
    const b = await build(modules, { CS2040: vec(1, 0, 3), AB1000: vec(2), CS1010S: vec(3, 0.5) });
    expect(b.codes).toEqual(['AB1000', 'CS1010S', 'CS2040']);
    expect(b.count).toBe(3);
    expect(b.dims).toBe(DIMS);
    expect(b.header.schema).toBe(BUNDLE_SCHEMA);
    expect(b.header.corpus).toBe('fixture');
    expect(b.header.rowStride).toBe(ROW_STRIDE);
    expect(b.header.rowsKey).toBe(await rowsKey(modules));
    expect(b.header.dataVersion).toBe(await dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) })))));
    // CS2040 was scaled by 3: stored L2-normalised.
    const row = (/** @type {number} */ i) => b.vectors.subarray(i * DIMS, (i + 1) * DIMS);
    expect(row(2)[1]).toBe(1);
    const n = Math.hypot(...row(1));
    expect(Math.abs(n - 1)).toBeLessThan(1e-6);
    // The 3H fields a hand-built row leaves out read as their neutral values (test/intents-data.node.test.js sets them).
    const none = { examSemesters: [], su: false, suGrading: false, workloadHours: null, prereqNone: false, prereqCohortOnly: false };
    // A row without ngAllow reads 0: closed in exchange mode everywhere.
    expect(decodeFilterRow(b, 0)).toEqual({ semesters: [1], level: null, credits: null, faculty: null, ng: false, ngSemesters: [], ngAllow: 0, ...none });
    expect(decodeFilterRow(b, 1)).toEqual({ semesters: [1, 2, 4], level: 1, credits: 2.5, faculty: 'Arts', ng: false, ngSemesters: [], ngAllow: 0, ...none });
    expect(decodeFilterRow(b, 2)).toEqual({ semesters: [2, 3], level: 2, credits: 4, faculty: 'Computing', ng: true, ngSemesters: [2], ngAllow: 0x7fe0, ...none });
  });

  it('is deterministic: the same input gives the same bytes, whatever the input order', async () => {
    const a = [mod('X1000'), mod('A2000')];
    /** @type {Record<string, number[]>} */
    const v = { X1000: vec(5), A2000: vec(6) };
    const one = await encodeBundle({ corpus: 'fixture', embedding: 'e', model: 'm', modules: a, vectorOf: (m) => v[m.code] });
    const two = await encodeBundle({ corpus: 'fixture', embedding: 'e', model: 'm', modules: [...a].reverse(), vectorOf: (m) => v[m.code] });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
  });

  it('[A-N6] refuses a row with no textHash', async () => {
    const bad = mod('CS1000', { textHash: '' });
    await expect(encodeBundle({ corpus: 'fixture', embedding: 'e', model: 'm', modules: [bad], vectorOf: () => vec(0) }))
      .rejects.toThrow(/CS1000 has no textHash/);
  });

  it('refuses duplicate codes, a missing vector, wrong dimensions, non-finite or zero vectors', async () => {
    const enc = (/** @type {any[]} */ modules, /** @type {(m: any) => any} */ vectorOf) =>
      encodeBundle({ corpus: 'fixture', embedding: 'e', model: 'm', modules, vectorOf });
    await expect(enc([mod('A1000'), mod('A1000')], () => vec(0))).rejects.toThrow(/duplicate code A1000/);
    await expect(enc([mod('A1000')], () => undefined)).rejects.toThrow(/no vector for A1000/);
    await expect(enc([mod('A1000')], () => [1, 2, 3])).rejects.toThrow(/A1000 has 3 dimensions/);
    await expect(enc([mod('A1000')], () => vec(0).map((x, i) => (i === 7 ? NaN : x)))).rejects.toThrow(/A1000 is not finite/);
    await expect(enc([mod('A1000')], () => new Array(DIMS).fill(0))).rejects.toThrow(/A1000 is a zero vector/);
  });

  it('refuses a truncated, padded or foreign buffer', async () => {
    const bytes = await encodeBundle({ corpus: 'fixture', embedding: 'e', model: 'm', modules: [mod('A1000')], vectorOf: () => vec(0) });
    const ab = /** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(() => parseBundle(ab.slice(0, ab.byteLength - 4))).toThrow(/size/);
    const padded = new Uint8Array(ab.byteLength + 8);
    padded.set(new Uint8Array(ab));
    expect(() => parseBundle(padded.buffer)).toThrow(/size/);
    expect(() => parseBundle(new TextEncoder().encode('not a bundle at all, no').buffer)).toThrow(/magic/);
    expect(() => parseBundle(new ArrayBuffer(0))).toThrow(/magic/);
  });
});

describe('rowsKey', () => {
  it('[B-2] hashes the sorted (code, textHash) pairs, so order does not matter and any text change does', async () => {
    const a = [{ code: 'B1', textHash: 'x' }, { code: 'A1', textHash: 'y' }];
    expect(await rowsKey(a)).toBe(await rowsKey([...a].reverse()));
    expect(await rowsKey(a)).not.toBe(await rowsKey([{ code: 'B1', textHash: 'x' }, { code: 'A1', textHash: 'z' }]));
    expect(await rowsKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('exactSearch', () => {
  /** @param {number[]} q */
  const query = (q) => Float32Array.from(q);

  it('ranks by cosine, desc, and breaks exact ties by code asc', async () => {
    // Shared text: B and C have the same vector (ties), A is closer, D farther.
    const modules = ['D4000', 'C3000', 'B2000', 'A1000'].map((c) => mod(c));
    const b = await build(modules, { A1000: vec(0, 0.1), B2000: vec(0, 0.5), C3000: vec(0, 0.5), D4000: vec(0, 2) });
    const hits = exactSearch(b, query(vec(0)), {}, 10);
    expect(hits.map((h) => h.code)).toEqual(['A1000', 'B2000', 'C3000', 'D4000']);
    expect(hits[1].score).toBe(hits[2].score);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    // Scores are cosines: the query's norm does not matter.
    expect(exactSearch(b, query(vec(0, 0, 7)), {}, 10)).toEqual(hits);
    expect(Math.abs(hits[0].score - 1 / Math.hypot(1, 0.1))).toBeLessThan(1e-6);
  });

  it('keeps only the top `depth`, bounded, with ties at the cut going to the earlier code', async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `M${String(1000 + i)}`);
    // Every vector identical: the page is the first `depth` codes.
    const b = await build(codes.map((c) => mod(c)), Object.fromEntries(codes.map((c) => [c, vec(9)])));
    expect(exactSearch(b, query(vec(9)), {}, 5).map((h) => h.code)).toEqual(codes.slice(0, 5));
    // Scores rising with code: the last five, best first.
    const b2 = await build(codes.map((c) => mod(c)), Object.fromEntries(codes.map((c, i) => [c, vec(9, 1 / (i + 1))])));
    expect(exactSearch(b2, query(vec(9)), {}, 5).map((h) => h.code)).toEqual(codes.slice(-5).reverse());
  });

  it('matches a brute-force sort on random vectors and random depths', async () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 - 0.5; };
    const codes = Array.from({ length: 200 }, (_, i) => `R${String(1000 + i)}`);
    /** @type {Record<string, number[]>} */
    const vs = Object.fromEntries(codes.map((c) => [c, Array.from({ length: DIMS }, rand)]));
    // A few exact duplicates (shared texts).
    vs[codes[10]] = vs[codes[50]];
    vs[codes[11]] = vs[codes[50]];
    const b = await build(codes.map((c) => mod(c)), vs);
    for (const depth of [1, 7, 50, 200, 500]) {
      const q = query(Array.from({ length: DIMS }, rand));
      const brute = codes.map((c, i) => {
        const r = b.vectors.subarray(i * DIMS, (i + 1) * DIMS);
        let s = 0;
        for (let k = 0; k < DIMS; k++) s += r[k] * q[k];
        return { code: c, score: s / Math.hypot(...q) };
      }).sort((x, y) => y.score - x.score || (x.code < y.code ? -1 : 1)).slice(0, depth);
      const got = exactSearch(b, q, {}, depth);
      expect(got.map((h) => h.code)).toEqual(brute.map((h) => h.code));
      got.forEach((h, i) => expect(Math.abs(h.score - brute[i].score)).toBeLessThan(1e-9));
    }
  });

  it('applies the filter mask first, with the same semantics as the Vectorize metadata filter', async () => {
    const modules = [
      // A1000: exchange-open in Sem 1 at every study level (bits 0-4) and so either semester (10-14).
      mod('A1000', { semesters: [1], level: 1, credits: 4, faculty: 'Arts', ng: true, ngSemesters: [1], ngAllow: 0x1f | 0x7c00 }),
      mod('B2000', { semesters: [2], level: 2, credits: 2, faculty: 'Computing', ng: false }),
      // C3000: exchange-open in Sem 2 only (bits 5-9, 10-14), though NUSMods offers it in both.
      mod('C3000', { semesters: [1, 2], level: 3, credits: 4, faculty: 'Computing', ng: true, ngSemesters: [2], ngAllow: 0x3e0 | 0x7c00 }),
      mod('D4000', { semesters: [3], level: null, credits: null, faculty: null, ng: false }),
    ];
    const b = await build(modules, Object.fromEntries(modules.map((m, i) => [m.code, vec(0, i / 10)])));
    const codes = (/** @type {import('../src/vector-bundle.js').FilterEcho} */ echo) => exactSearch(b, query(vec(0)), echo, 10).map((h) => h.code);
    expect(codes({})).toEqual(['A1000', 'B2000', 'C3000', 'D4000']);
    expect(codes({ sem: 1 })).toEqual(['A1000', 'C3000']);
    expect(codes({ sem: 3 })).toEqual(['D4000']);
    expect(codes({ sem: 4 })).toEqual([]);
    expect(codes({ level: 2 })).toEqual(['B2000']);
    expect(codes({ credits: 4 })).toEqual(['A1000', 'C3000']);
    expect(codes({ credits: 0 })).toEqual([]);
    expect(codes({ faculty: 'Computing' })).toEqual(['B2000', 'C3000']);
    expect(codes({ faculty: 'Nowhere' })).toEqual([]);
    // Phase 4: under ng the allow-mask bit for (sem, study) decides, and sem tests no NUSMods semester.
    expect(codes({ ng: true, study: 'ug2' })).toEqual(['A1000', 'C3000']);
    expect(codes({ ng: true, sem: 1, study: 'ug2' })).toEqual(['A1000']);
    expect(codes({ ng: true, sem: 2, study: 'grad' })).toEqual(['C3000']);
    expect(codes({ ng: true, sem: 2, faculty: 'Computing', credits: 4, level: 3, study: 'ug3' })).toEqual(['C3000']);
    // No study (which /search answers 400) shows nothing.
    expect(codes({ ng: true })).toEqual([]);
    expect(compileMask(b, {})).toBeNull();
  });

  it('refuses a query vector of the wrong dimensions', async () => {
    const b = await build([mod('A1000')], { A1000: vec(0) });
    expect(() => exactSearch(b, Float32Array.from([1, 2]), {}, 5)).toThrow(/2 dimensions/);
  });
});
