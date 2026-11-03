// @ts-check
// The fakes stand in for real services, so their contract is tested too:
// where they diverge from Cloudflare's behaviour, tests built on them lie.
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS, FakeAI, FakeRateLimit, FakeVectorize, hashEmbed } from './fakes.js';

/** Resolves to 'pending' if `p` has not settled within `ms`. */
const settlesWithin = (/** @type {Promise<unknown>} */ p, ms = 50) =>
  Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

describe('hashEmbed', () => {
  it('is deterministic, 384-d and unit length', () => {
    const a = hashEmbed('machine learning');
    expect(a).toHaveLength(EMBEDDING_DIMS);
    expect(hashEmbed('machine learning')).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
  });
});

describe('FakeVectorize', () => {
  const v = (/** @type {string} */ id, /** @type {string} */ text, /** @type {Record<string, unknown>} */ metadata) =>
    ({ id, values: hashEmbed(text), metadata });

  it('ranks by cosine and applies $eq, $ne, $in and implicit equality', async () => {
    const index = new FakeVectorize();
    await index.upsert([
      v('A', 'machine learning', { level: 3, faculty: 'Computing', sem1: true }),
      v('B', 'machine learning theory', { level: 5, faculty: 'Computing', sem1: false }),
      v('C', 'french literature', { level: 3, faculty: 'Arts', sem1: true }),
    ]);
    const q = hashEmbed('machine learning');
    expect((await index.query(q, { topK: 3 })).matches.map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect((await index.query(q, { topK: 3, filter: { sem1: true } })).matches.map((m) => m.id)).toEqual(['A', 'C']);
    expect((await index.query(q, { topK: 3, filter: { level: { $ne: 3 } } })).matches.map((m) => m.id)).toEqual(['B']);
    expect((await index.query(q, { topK: 3, filter: { faculty: { $in: ['Arts'] } } })).matches.map((m) => m.id)).toEqual(['C']);
    expect((await index.query(q, { topK: 3, filter: { level: { $eq: 5 } } })).matches.map((m) => m.id)).toEqual(['B']);
  });

  it('supports the documented range and $nin operators', async () => {
    const index = new FakeVectorize();
    await index.upsert([v('A', 'x', { level: 3 }), v('B', 'x', { level: 5 })]);
    const q = hashEmbed('x');
    expect((await index.query(q, { filter: { level: { $gte: 4 } } })).matches.map((m) => m.id)).toEqual(['B']);
    expect((await index.query(q, { filter: { level: { $lt: 4 } } })).matches.map((m) => m.id)).toEqual(['A']);
    expect((await index.query(q, { filter: { level: { $nin: [5] } } })).matches.map((m) => m.id)).toEqual(['A']);
  });

  it('throws on an unknown filter operator', async () => {
    const index = new FakeVectorize();
    await index.upsert([v('A', 'x', { level: 3 })]);
    await expect(index.query(hashEmbed('x'), { filter: { level: { $regex: 'x' } } })).rejects.toThrow(/unsupported filter operator/);
  });

  it('rejects operator combinations Vectorize forbids, allows one upper + one lower bound', async () => {
    const index = new FakeVectorize();
    await index.upsert([v('A', 'x', { level: 3, ng: false }), v('B', 'x', { level: 5, ng: true })]);
    const q = hashEmbed('x');
    await expect(index.query(q, { filter: { level: { $eq: 3, $lt: 5 } } })).rejects.toThrow(/not allowed/);
    await expect(index.query(q, { filter: { level: { $gte: 3, $gt: 4 } } })).rejects.toThrow(/not allowed/);
    await expect(index.query(q, { filter: { ng: { $gt: false } } })).rejects.toThrow(/string or number/);
    expect((await index.query(q, { filter: { level: { $gt: 2, $lt: 4 } } })).matches.map((m) => m.id)).toEqual(['A']);
  });

  it('validates the filter even when no vector reaches it', async () => {
    const empty = new FakeVectorize();
    await expect(empty.query(hashEmbed('x'), { filter: { level: { $eq: 1, $lt: 5 } } })).rejects.toThrow(/not allowed/);
    await expect(empty.query(hashEmbed('x'), { filter: { level: 1, ng: { $gt: false } } })).rejects.toThrow(/string or number/);
  });

  it('rejects non-float typed arrays and non-finite values', async () => {
    const index = new FakeVectorize();
    await expect(index.upsert([{ id: 'U', values: /** @type {any} */ (new Uint8Array(384)) }])).rejects.toThrow(/finite numbers/);
    await expect(index.upsert([{ id: 'N', values: new Array(384).fill(NaN) }])).rejects.toThrow(/finite numbers/);
    await expect(index.upsert([{ id: 'S', values: new Array(384) }])).rejects.toThrow(/finite numbers/);
  });

  it('accepts typed-array vectors', async () => {
    const index = new FakeVectorize();
    await expect(index.upsert([{ id: 'F', values: /** @type {any} */ (new Float32Array(384)) }])).resolves.toBeDefined();
  });

  it('rejects vectors of the wrong dimension on upsert', async () => {
    const index = new FakeVectorize();
    await expect(index.upsert([{ id: 'A', values: [1, 2, 3] }])).rejects.toThrow(/finite numbers/);
  });

  it('enforces the topK ceilings', async () => {
    const index = new FakeVectorize();
    const q = hashEmbed('x');
    await expect(index.query(q, { topK: 100 })).resolves.toBeDefined();
    await expect(index.query(q, { topK: 101 })).rejects.toThrow(/topK/);
    await expect(index.query(q, { topK: 50, returnMetadata: 'indexed' })).resolves.toBeDefined();
    await expect(index.query(q, { topK: 51, returnMetadata: 'indexed' })).rejects.toThrow(/topK/);
    await expect(index.query(q, { topK: 51, returnValues: true })).rejects.toThrow(/topK/);
    await expect(index.query(q, { topK: 51, returnMetadata: 'all' })).rejects.toThrow(/topK/);
  });

  it('returns only indexed metadata for returnMetadata "indexed"', async () => {
    const index = new FakeVectorize();
    await index.upsert([v('A', 'x', { code: 'A', level: 3 })]);
    const { matches } = await index.query(hashEmbed('x'), { topK: 1, returnMetadata: 'indexed' });
    expect(matches[0].metadata).toEqual({ level: 3 });
  });

  it('supports getByIds and deleteByIds', async () => {
    const index = new FakeVectorize();
    await index.upsert([v('A', 'x', {}), v('B', 'y', {})]);
    await index.deleteByIds(['A']);
    expect((await index.getByIds(['A', 'B'])).map((r) => r.id)).toEqual(['B']);
  });
});

describe('throw and hang switches', () => {
  it('AI can throw, hang and recover', async () => {
    const ai = new FakeAI();
    ai.throws('boom');
    await expect(ai.run('m', { text: ['x'] })).rejects.toThrow('boom');
    ai.hangs();
    expect(await settlesWithin(ai.run('m', { text: ['x'] }))).toBe('pending');
    ai.ok();
    expect(await settlesWithin(ai.run('m', { text: ['x'] }))).toBe('settled');
    expect(ai.calls).toHaveLength(3);
  });

  it('Vectorize and the rate limiter share the same switches', async () => {
    const index = new FakeVectorize().hangs();
    expect(await settlesWithin(index.query(hashEmbed('x')))).toBe('pending');
    const limiter = new FakeRateLimit().throws('limiter down');
    await expect(limiter.limit({ key: 'k' })).rejects.toThrow('limiter down');
  });

  it('the rate limiter can cap requests per key', async () => {
    const limiter = new FakeRateLimit();
    limiter.limitPerKey = 2;
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await limiter.limit({ key: 'ip' })).success);
    expect(results).toEqual([true, true, false]);
  });
});
