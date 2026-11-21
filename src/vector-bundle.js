// @ts-check
import { INTENT } from './intents.js';
import { ngBit } from './ng-bit.js';
import { dataVersion, rowHash, sha256Hex } from './rowhash.js';

export const BUNDLE_MAGIC = 'VNMVEC01';
export const BUNDLE_SCHEMA = 'vnm-vectors/3';
export const ROW_STRIDE = 32;
const NULL_LEVEL = 255;
const NULL_FACULTY = 0xffff;

/**
 * @typedef {'fixture' | 'pinned' | 'production' | 'eval'} BundleCorpus
 * @typedef {{
 *   schema: string, corpus: BundleCorpus, model: string, embedding: string, dims: number, count: number,
 *   dataVersion: string, rowsKey: string, rowStride: number, faculties: string[], codes: string[],
 * }} BundleHeader
 * @typedef {{
 *   header: BundleHeader, codes: string[], count: number, dims: number,
 *   table: Uint8Array, view: DataView, vectors: Float32Array, facultyId: Map<string, number>,
 * }} Bundle
 * @typedef {import('./rowhash.js').RowFields} RowFields
 * @typedef {{ sem?: number, level?: number | number[], credits?: number | number[], faculty?: string, ng?: boolean,
 *   study?: import('./ng-bit.js').Study, exam?: 0, su?: 1, hoursBelow?: number, prereq?: 'none' }} FilterEcho
 * @typedef {[string, string]} CodeRange
 * @typedef {FilterEcho & { ranges?: CodeRange[], levelWindow?: { min: number, max: number | null }, ngIgnoreAllow?: true }} Constraints
 */

/**
 * @param {number | number[]} v
 * @returns {number[]}
 */
export const filterValues = (v) => (Array.isArray(v) ? v : [v]);

const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {string | null | undefined} basis */
export const suGrading = (basis) => basis === 'Completed Satisfactory/Unsatisfactory';

/** @param {number[]} sems */
const semBits = (sems) => sems.reduce((bits, s) => (Number.isInteger(s) && s >= 1 && s <= 4 ? bits | (1 << (s - 1)) : bits), 0);
/** @param {number} bits */
const bitsSems = (bits) => [1, 2, 3, 4].filter((s) => bits & (1 << (s - 1)));

/**
 * @param {{ code: string, textHash: string }[]} rows
 * @returns {Promise<string>}
 */
export async function rowsKey(rows) {
  return sha256Hex(rows.map((r) => `${r.code}\t${r.textHash}`).sort().join('\n'));
}

/**
 * @param {{
 *   corpus: BundleCorpus, embedding: string, model: string, modules: RowFields[],
 *   vectorOf: (m: RowFields) => ArrayLike<number> | undefined, dims?: number,
 * }} args
 * @returns {Promise<Uint8Array>}
 */
export async function encodeBundle({ corpus, embedding, model, modules, vectorOf, dims = 384 }) {
  const seen = new Set();
  for (const m of modules) {
    if (seen.has(m.code)) throw new Error(`vectors bundle: duplicate code ${m.code}`);
    seen.add(m.code);
    if (typeof m.textHash !== 'string' || m.textHash === '') throw new Error(`vectors bundle: ${m.code} has no textHash`);
  }
  const rows = [...modules].sort((a, b) => byCode(a.code, b.code));
  const faculties = [...new Set(rows.map((m) => m.faculty).filter((f) => typeof f === 'string'))].sort(byCode);
  if (faculties.length >= NULL_FACULTY) throw new Error(`vectors bundle: ${faculties.length} faculties do not fit a u16 id`);
  const facultyId = new Map(faculties.map((f, i) => [f, i]));

  /** @type {BundleHeader} */
  const header = {
    schema: BUNDLE_SCHEMA, corpus, model, embedding, dims, count: rows.length,
    dataVersion: await dataVersion(await Promise.all(rows.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) })))),
    rowsKey: await rowsKey(rows),
    rowStride: ROW_STRIDE, faculties, codes: rows.map((m) => m.code),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const tableAt = align8(12 + headerBytes.length);
  const vectorsAt = tableAt + rows.length * ROW_STRIDE;
  const out = new Uint8Array(vectorsAt + rows.length * dims * 4);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(BUNDLE_MAGIC), 0);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  const vectors = new Float32Array(out.buffer, vectorsAt, rows.length * dims);

  rows.forEach((m, i) => {
    const at = tableAt + i * ROW_STRIDE;
    out[at] = semBits(m.semesters);
    out[at + 1] = Number.isInteger(m.level) && /** @type {number} */ (m.level) >= 0 && /** @type {number} */ (m.level) < NULL_LEVEL
      ? /** @type {number} */ (m.level) : NULL_LEVEL;
    out[at + 2] = m.ng === true ? 1 : 0;
    out[at + 3] = semBits(m.ngSemesters ?? []);
    view.setUint16(at + 4, typeof m.faculty === 'string' ? /** @type {number} */ (facultyId.get(m.faculty)) : NULL_FACULTY, true);
    view.setUint16(at + 6, (m.ngAllow ?? 0) & 0x7fff, true);
    view.setFloat64(at + 8, typeof m.credits === 'number' ? m.credits : NaN, true);
    out[at + 20] = semBits(m.examSemesters ?? []);
    out[at + 21] = (m.su === true ? 1 : 0) | (suGrading(m.gradingBasis) ? 2 : 0);
    out[at + 22] = (m.prereqNone === true ? 1 : 0) | (m.prereqCohortOnly === true ? 2 : 0);
    view.setFloat64(at + 24, typeof m.workloadHours === 'number' ? m.workloadHours : NaN, true);

    const v = vectorOf(m);
    if (!v) throw new Error(`vectors bundle: no vector for ${m.code}`);
    if (v.length !== dims) throw new Error(`vectors bundle: ${m.code} has ${v.length} dimensions, expected ${dims}`);
    let norm = 0;
    for (let k = 0; k < dims; k++) {
      const x = Number(v[k]);
      if (!Number.isFinite(x)) throw new Error(`vectors bundle: ${m.code} is not finite`);
      norm += x * x;
    }
    if (norm === 0) throw new Error(`vectors bundle: ${m.code} is a zero vector`);
    norm = Math.sqrt(norm);
    for (let k = 0; k < dims; k++) vectors[i * dims + k] = Number(v[k]) / norm;
  });
  return out;
}

/** @param {number} n */
const align8 = (n) => Math.ceil(n / 8) * 8;

/**
 * @param {ArrayBuffer} buffer
 * @returns {Bundle}
 */
export function parseBundle(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12
    || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== BUNDLE_MAGIC) {
    throw new Error('vectors bundle: bad magic (not a vectors bundle)');
  }
  const view = new DataView(buffer);
  const headerLength = view.getUint32(8, true);
  if (12 + headerLength > buffer.byteLength) throw new Error('vectors bundle: header runs past the end (size)');
  /** @type {BundleHeader} */
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength)));
  } catch {
    throw new Error('vectors bundle: header is not JSON');
  }
  if (header.schema !== BUNDLE_SCHEMA) throw new Error(`vectors bundle: schema ${header.schema}, this Worker reads ${BUNDLE_SCHEMA}`);
  const { count, dims, rowStride, codes } = header;
  if (!Number.isInteger(count) || !Number.isInteger(dims) || dims <= 0 || rowStride !== ROW_STRIDE
    || !Array.isArray(codes) || codes.length !== count || !Array.isArray(header.faculties)) {
    throw new Error('vectors bundle: malformed header');
  }
  const tableAt = align8(12 + headerLength);
  const vectorsAt = tableAt + count * ROW_STRIDE;
  const expected = vectorsAt + count * dims * 4;
  if (buffer.byteLength !== expected) throw new Error(`vectors bundle: size ${buffer.byteLength} B, header implies ${expected} B`);
  for (let i = 1; i < count; i++) {
    if (!(codes[i - 1] < codes[i])) throw new Error(`vectors bundle: codes not strictly in code order at ${codes[i]}`);
  }
  return {
    header, codes, count, dims,
    table: new Uint8Array(buffer, tableAt, count * ROW_STRIDE),
    view: new DataView(buffer, tableAt, count * ROW_STRIDE),
    vectors: new Float32Array(buffer, vectorsAt, count * dims),
    facultyId: new Map(header.faculties.map((f, i) => [f, i])),
  };
}

/**
 * @param {Bundle} b
 * @param {number} i
 */
export function decodeFilterRow(b, i) {
  const at = i * ROW_STRIDE;
  const level = b.table[at + 1];
  const faculty = b.view.getUint16(at + 4, true);
  const credits = b.view.getFloat64(at + 8, true);
  return {
    semesters: bitsSems(b.table[at]),
    level: level === NULL_LEVEL ? null : level,
    credits: Number.isNaN(credits) ? null : credits,
    faculty: faculty === NULL_FACULTY ? null : b.header.faculties[faculty],
    ng: (b.table[at + 2] & 1) === 1,
    ngSemesters: bitsSems(b.table[at + 3]),
    ngAllow: b.view.getUint16(at + 6, true),
    examSemesters: bitsSems(b.table[at + 20]),
    su: (b.table[at + 21] & 1) === 1,
    suGrading: (b.table[at + 21] & 2) === 2,
    workloadHours: Number.isNaN(b.view.getFloat64(at + 24, true)) ? null : b.view.getFloat64(at + 24, true),
    prereqNone: (b.table[at + 22] & 1) === 1,
    prereqCohortOnly: (b.table[at + 22] & 2) === 2,
  };
}

/**
 * @param {string[]} codes
 * @param {string} code
 */
function lowerBound(codes, code) {
  let lo = 0, hi = codes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (codes[mid] < code) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * @param {Bundle} b
 * @param {CodeRange[]} ranges
 * @returns {[number, number][]}
 */
export function rowBlocks(b, ranges) {
  /** @type {[number, number][]} */
  const blocks = ranges.map(([lo, hi]) => /** @type {[number, number]} */ ([lowerBound(b.codes, lo), lowerBound(b.codes, hi)]))
    .filter(([from, to]) => to > from)
    .sort((x, y) => x[0] - y[0]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const blk of blocks) {
    const last = merged.at(-1);
    if (last && blk[0] <= last[1]) last[1] = Math.max(last[1], blk[1]);
    else merged.push([blk[0], blk[1]]);
  }
  return merged;
}

/**
 * @param {Bundle} b
 * @param {string} code
 */
export function hasCode(b, code) {
  const i = lowerBound(b.codes, code);
  return i < b.count && b.codes[i] === code;
}

/**
 * @param {Bundle} b
 * @param {Constraints} echo
 * @returns {((i: number) => boolean) | null}
 */
export function compileMask(b, echo) {
  /** @type {((i: number) => boolean)[]} */
  const tests = [];
  const { table, view } = b;
  const allowBit = ngBit(echo);
  if (echo.sem !== undefined && echo.ng !== true) {
    const bit = 1 << (echo.sem - 1);
    tests.push((i) => (table[i * ROW_STRIDE] & bit) !== 0);
  }
  if (echo.level !== undefined) {
    const levels = filterValues(echo.level);
    const [level] = levels;
    tests.push(levels.length === 1 ? (i) => table[i * ROW_STRIDE + 1] === level : (i) => levels.includes(table[i * ROW_STRIDE + 1]));
  }
  if (echo.levelWindow) {
    const { min } = echo.levelWindow;
    const max = echo.levelWindow.max ?? NULL_LEVEL - 1;
    tests.push((i) => { const l = table[i * ROW_STRIDE + 1]; return l !== NULL_LEVEL && l >= min && l <= max; });
  }
  if (echo.ng === true) tests.push((i) => (table[i * ROW_STRIDE + 2] & 1) === 1);
  if (echo.ng === true && !echo.ngIgnoreAllow) {
    const bit = allowBit ?? 0;
    tests.push((i) => (view.getUint16(i * ROW_STRIDE + 6, true) & bit) !== 0);
  }
  if (echo.faculty !== undefined) {
    const id = b.facultyId.get(echo.faculty);
    if (id === undefined) return () => false;
    tests.push((i) => view.getUint16(i * ROW_STRIDE + 4, true) === id);
  }
  if (echo.credits !== undefined) {
    const credits = filterValues(echo.credits);
    const [one] = credits;
    tests.push(credits.length === 1
      ? (i) => view.getFloat64(i * ROW_STRIDE + 8, true) === one
      : (i) => credits.includes(view.getFloat64(i * ROW_STRIDE + 8, true)));
  }
  if (echo.exam === 0) {
    const bits = echo.sem !== undefined ? 1 << (echo.sem - 1) : 0xf;
    tests.push((i) => (table[i * ROW_STRIDE + 20] & bits) === 0);
  }
  if (echo.su === 1) tests.push((i) => (table[i * ROW_STRIDE + 21] & 3) !== 0);
  if (echo.hoursBelow !== undefined) {
    const below = echo.hoursBelow;
    tests.push((i) => view.getFloat64(i * ROW_STRIDE + 24, true) < below);
  }
  if (echo.prereq === 'none') {
    const bits = INTENT.prereq === 'i' ? 1 : 3;
    tests.push((i) => (table[i * ROW_STRIDE + 22] & bits) !== 0);
  }
  if (tests.length === 0) return null;
  return (i) => tests.every((t) => t(i));
}

/**
 * @param {Bundle} b
 * @param {ArrayLike<number>} query
 * @param {Constraints} echo
 * @param {number} depth
 * @returns {{ code: string, score: number }[]}
 */
export function exactSearch(b, query, echo, depth) {
  const { dims, count, vectors } = b;
  if (query.length !== dims) throw new Error(`query vector has ${query.length} dimensions, the bundle ${dims}`);
  const q = new Float64Array(dims);
  let norm = 0;
  for (let k = 0; k < dims; k++) { q[k] = Number(query[k]); norm += q[k] * q[k]; }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let k = 0; k < dims; k++) q[k] /= norm;

  const mask = compileMask(b, echo);
  const cap = Math.max(0, Math.min(depth, count));
  const topScore = new Float64Array(cap);
  const topRow = new Int32Array(cap);
  let n = 0;
  const blocks = echo.ranges ? rowBlocks(b, echo.ranges) : [[0, count]];
  for (const [from, to] of blocks) for (let r = from; r < to; r++) {
    if (mask && !mask(r)) continue;
    const base = r * dims;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    let k = 0;
    for (; k + 3 < dims; k += 4) {
      s0 += vectors[base + k] * q[k];
      s1 += vectors[base + k + 1] * q[k + 1];
      s2 += vectors[base + k + 2] * q[k + 2];
      s3 += vectors[base + k + 3] * q[k + 3];
    }
    for (; k < dims; k++) s0 += vectors[base + k] * q[k];
    const s = (s0 + s1) + (s2 + s3);
    if (n === cap && !(s > topScore[cap - 1])) continue;
    let j = n < cap ? n : cap - 1;
    while (j > 0 && s > topScore[j - 1]) {
      topScore[j] = topScore[j - 1];
      topRow[j] = topRow[j - 1];
      j--;
    }
    topScore[j] = s;
    topRow[j] = r;
    if (n < cap) n++;
  }
  return Array.from({ length: n }, (_, i) => ({ code: b.codes[topRow[i]], score: topScore[i] }));
}

/** @param {string} b64 */
export function base64ToFloat32(b64) {
  const bin = atob(b64);
  const out = new Float32Array(Math.floor(bin.length / 4));
  const bytes = new Uint8Array(out.buffer);
  if (bin.length !== bytes.length) throw new Error(`${bin.length} bytes is not a whole number of float32 values`);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return out;
}

/** @param {ArrayLike<number>} values */
export function float32ToBase64(values) {
  const f32 = values instanceof Float32Array ? values : Float32Array.from(values);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
