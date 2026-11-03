// @ts-check
// In-memory stand-ins for the bindings the test config deliberately omits
// (AI, VECTORIZE, SEARCH_LIMIT). They model the parts of the real services the
// Worker depends on, and enforce the real limits where breaking them would be
// a bug (Vectorize topK ceilings, unknown filter operators). Every fake can be
// told to throw or to hang, for upstream-failure tests.

export const EMBEDDING_DIMS = 384;

/**
 * @typedef {{ kind: 'ok' } | { kind: 'throw', error: Error } | { kind: 'hang' }} Behaviour
 */

/** Shared throw/hang switch. */
class Switchable {
  /** @type {Behaviour} */
  behaviour = { kind: 'ok' };
  /** Every call, in order: `{ method, args }`. */
  /** @type {{ method: string, args: unknown[] }[]} */
  calls = [];

  /** @param {Error | string} [error] */
  throws(error = 'fake failure') {
    this.behaviour = { kind: 'throw', error: typeof error === 'string' ? new Error(error) : error };
    return this;
  }

  /** Every later call returns a promise that never settles. */
  hangs() {
    this.behaviour = { kind: 'hang' };
    return this;
  }

  ok() {
    this.behaviour = { kind: 'ok' };
    return this;
  }

  /**
   * Records the call, then applies the current behaviour.
   * @param {string} method
   * @param {unknown[]} args
   * @returns {Promise<void>}
   */
  async gate(method, args) {
    this.calls.push({ method, args });
    if (this.behaviour.kind === 'throw') throw this.behaviour.error;
    if (this.behaviour.kind === 'hang') await new Promise(() => {});
  }
}

/**
 * FNV-1a, 32-bit. Deterministic and dependency-free.
 * @param {string} s
 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words embedding: each lower-cased token is hashed to a
 * dimension and a sign, then the vector is L2-normalised. Texts that share
 * words have positive cosine similarity, which is enough for retrieval tests
 * to be meaningful without any model.
 * @param {string} text
 * @returns {number[]}
 */
export function hashEmbed(text) {
  const v = new Array(EMBEDDING_DIMS).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const t of tokens) {
    const h = fnv1a(t);
    v[h % EMBEDDING_DIMS] += (h & 0x80000000) ? -1 : 1;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** Fake Workers AI binding. Only text-embedding models are modelled. */
export class FakeAI extends Switchable {
  /**
   * Replace to return a malformed response, e.g. `() => ({})`.
   * @type {((model: string, input: { text: string[] }) => unknown) | null}
   */
  respond = null;

  /**
   * @param {string} model
   * @param {{ text: string | string[] }} input
   */
  async run(model, input) {
    await this.gate('run', [model, input]);
    const text = Array.isArray(input?.text) ? input.text : [input?.text ?? ''];
    if (this.respond) return this.respond(model, { text });
    return { shape: [text.length, EMBEDDING_DIMS], data: text.map(hashEmbed), pooling: 'mean' };
  }
}

/** The metadata properties production has indexes for (README). */
export const INDEXED_PROPERTIES = ['sem1', 'sem2', 'sem3', 'sem4', 'level', 'credits', 'faculty', 'ng'];

/**
 * @typedef {{ id: string, values: number[], metadata?: Record<string, unknown> }} StoredVector
 */

/** @param {Record<string, unknown>} filter */
function validateFilter(filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) continue;
    // Cloudflare docs: an operator object holds one operator, except that one
    // upper bound ($lt/$lte) may pair with one lower bound ($gt/$gte).
    const ops = Object.keys(cond);
    const ranged = ops.length === 2
      && ops.filter((o) => o === '$lt' || o === '$lte').length === 1
      && ops.filter((o) => o === '$gt' || o === '$gte').length === 1;
    if (ops.length !== 1 && !ranged) {
      throw new Error(`fake Vectorize: operator combination ${ops.join(', ')} on "${key}" is not allowed`);
    }
    for (const [op, expected] of Object.entries(cond)) {
      if (op === '$eq' || op === '$ne') continue;
      if (op === '$in' || op === '$nin') {
        if (!Array.isArray(expected)) throw new Error(`fake Vectorize: ${op} needs an array for "${key}"`);
      } else if (op === '$lt' || op === '$lte' || op === '$gt' || op === '$gte') {
        if (typeof expected !== 'string' && typeof expected !== 'number') {
          throw new Error(`fake Vectorize: ${op} on "${key}" needs a string or number, got ${typeof expected}`);
        }
      } else {
        throw new Error(`fake Vectorize: unsupported filter operator "${op}" on "${key}"`);
      }
    }
  }
}

/**
 * Assumes validateFilter() already accepted `filter`.
 * @param {Record<string, unknown> | undefined} metadata
 * @param {Record<string, unknown>} filter
 */
function matchesFilter(metadata, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    const actual = metadata?.[key];
    if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) {
      if (actual !== cond) return false;
      continue;
    }
    for (const [op, expected] of Object.entries(cond)) {
      if (op === '$eq') { if (actual !== expected) return false; }
      else if (op === '$ne') { if (actual === expected) return false; }
      else if (op === '$in' || op === '$nin') {
        if (/** @type {unknown[]} */ (expected).includes(actual) === (op === '$nin')) return false;
      } else {
        if (typeof actual !== typeof expected) return false;
        const a = /** @type {any} */ (actual), e = /** @type {any} */ (expected);
        if (op === '$lt' ? !(a < e) : op === '$lte' ? !(a <= e) : op === '$gt' ? !(a > e) : !(a >= e)) return false;
      }
    }
  }
  return true;
}

/** @param {number[]} a @param {number[]} b */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Fake Vectorize index with cosine similarity. topK ceiling: 50 when values or
 * metadata are returned, else 100; exceeding it throws as the real service
 * does. Filters support implicit equality, $eq, $ne, $in, $nin, and range
 * operators ($lt/$lte/$gt/$gte, string or number values, at most one upper plus
 * one lower bound per key); anything else throws rather than silently matching.
 */
export class FakeVectorize extends Switchable {
  /** @type {Map<string, StoredVector>} */
  vectors = new Map();

  /** @param {string[]} [indexedProperties] */
  constructor(indexedProperties = INDEXED_PROPERTIES) {
    super();
    this.indexedProperties = indexedProperties;
  }

  /**
   * @param {number[]} vector
   * @param {{ topK?: number, returnValues?: boolean, returnMetadata?: boolean | 'none' | 'indexed' | 'all', filter?: Record<string, unknown> }} [options]
   */
  async query(vector, options = {}) {
    await this.gate('query', [vector, options]);
    const topK = options.topK ?? 5;
    const returnMetadata = options.returnMetadata === true ? 'all' : options.returnMetadata || 'none';
    const ceiling = options.returnValues || returnMetadata === 'all' || returnMetadata === 'indexed' ? 50 : 100;
    if (!Number.isInteger(topK) || topK < 1 || topK > ceiling) {
      throw new Error(`fake Vectorize: topK ${topK} outside 1..${ceiling} for these return options`);
    }
    if (options.filter) validateFilter(options.filter);
    if (vector.length !== EMBEDDING_DIMS) {
      throw new Error(`fake Vectorize: query has ${vector.length} dimensions, index has ${EMBEDDING_DIMS}`);
    }
    const filter = options.filter ?? {};
    const matches = [...this.vectors.values()]
      .filter((v) => matchesFilter(v.metadata, filter))
      .map((v) => ({ v, score: cosine(vector, v.values) }))
      .sort((a, b) => b.score - a.score || a.v.id.localeCompare(b.v.id))
      .slice(0, topK)
      .map(({ v, score }) => ({
        id: v.id,
        score,
        ...(options.returnValues ? { values: v.values } : {}),
        ...(returnMetadata === 'all' ? { metadata: v.metadata } : {}),
        ...(returnMetadata === 'indexed'
          ? { metadata: Object.fromEntries(Object.entries(v.metadata ?? {}).filter(([k]) => this.indexedProperties.includes(k))) }
          : {}),
      }));
    return { count: matches.length, matches };
  }

  /** @param {StoredVector[]} vectors */
  async upsert(vectors) {
    await this.gate('upsert', [vectors]);
    for (const v of vectors) {
      const vals = /** @type {unknown} */ (v.values);
      const okType = Array.isArray(vals) || vals instanceof Float32Array || vals instanceof Float64Array;
      if (!okType || v.values.length !== EMBEDDING_DIMS || !Array.from(v.values).every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new Error(`fake Vectorize: vector "${v.id}" is not ${EMBEDDING_DIMS} finite numbers (got ${v.values?.length} values)`);
      }
    }
    for (const v of vectors) this.vectors.set(v.id, { id: v.id, values: [...v.values], metadata: v.metadata });
    return { mutationId: `fake-${this.calls.length}`, count: vectors.length, ids: vectors.map((v) => v.id) };
  }

  /** @param {string[]} ids */
  async deleteByIds(ids) {
    await this.gate('deleteByIds', [ids]);
    for (const id of ids) this.vectors.delete(id);
    return { mutationId: `fake-${this.calls.length}`, count: ids.length, ids };
  }

  /** @param {string[]} ids */
  async getByIds(ids) {
    await this.gate('getByIds', [ids]);
    return ids.flatMap((id) => {
      const v = this.vectors.get(id);
      return v ? [{ id: v.id, values: v.values, metadata: v.metadata }] : [];
    });
  }
}

/**
 * Fake rate limiter. Allows everything by default; set `allow` to false, or
 * `limitPerKey` to a number, to exercise the 429 path.
 */
export class FakeRateLimit extends Switchable {
  allow = true;
  /** @type {number | null} */
  limitPerKey = null;
  /** @type {Map<string, number>} */
  seen = new Map();

  /** @param {{ key: string }} options */
  async limit(options) {
    await this.gate('limit', [options]);
    const n = (this.seen.get(options.key) ?? 0) + 1;
    this.seen.set(options.key, n);
    if (!this.allow) return { success: false };
    return { success: this.limitPerKey === null || n <= this.limitPerKey };
  }
}

/**
 * A fresh, independent set of fakes.
 * @returns {Fakes}
 */
export function createFakes() {
  return { ai: new FakeAI(), vectorize: new FakeVectorize(), limit: new FakeRateLimit() };
}

/** @typedef {{ ai: FakeAI, vectorize: FakeVectorize, limit: FakeRateLimit }} Fakes */
