// @ts-check
// scripts/verify-core.mjs against the real /admin/verify route, local D1 and
// the fake index (whose ids stand in for `wrangler vectorize list-vectors`):
// a freshly ingested corpus agrees, and every kind of drift is reported.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runVerify } from '../scripts/verify-core.mjs';
import { fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeEach(async () => { fakes = await seed(); });

/** @param {{ sample?: string[], sampleSize?: number }} [o] */
const verify = (o = {}) => runVerify({
  api: adminApi(() => fakes), listVectorIds: async () => [...fakes.vectorize.vectors.keys()], ...o,
});

describe('verify', () => {
  it('a freshly ingested corpus agrees: every code has a vector, row hashes recompute, sampled metadata matches', async () => {
    const r = await verify();
    expect(r).toMatchObject({
      ok: true, d1Rows: fixture.modules.length, vectors: fixture.modules.length, sampleChecked: 100,
      missingVectors: [], extraVectors: [], rowHashDrift: [], rowHashMissing: [], metadataDrift: [], sampleMissingVectors: [],
    });
    // One full read of modules; getByIds in chunks of at most 20.
    expect(r.rowsRead).toBe(fixture.modules.length);
    const gets = fakes.vectorize.calls.filter((c) => c.method === 'getByIds');
    expect(gets).toHaveLength(5);
    for (const g of gets) expect(/** @type {string[]} */ (g.args[0]).length).toBeLessThanOrEqual(20);
  });

  it('reports missing and extra vectors', async () => {
    const [a] = fixture.modules;
    fakes.vectorize.vectors.delete(a.code);
    fakes.vectorize.vectors.set('ZZ9999', { id: 'ZZ9999', values: [], metadata: {} });
    const r = await verify({ sample: [a.code] });
    expect(r).toMatchObject({ ok: false, missingVectors: [a.code], extraVectors: ['ZZ9999'], sampleMissingVectors: [a.code] });
  });

  it('reports metadata drift in the sample', async () => {
    const [a, b] = fixture.modules;
    const v = /** @type {import('./fakes.js').StoredVector} */ (fakes.vectorize.vectors.get(a.code));
    v.metadata = { ...v.metadata, sem4: !v.metadata?.sem4 };
    const r = await verify({ sample: [a.code, b.code] });
    expect(r.ok).toBe(false);
    expect(r.metadataDrift.map((d) => d.code)).toEqual([a.code]);
  });

  it('[PR13 #2] reports a sampled vector whose metadata textHash is not the row\'s text_hash, or has none', async () => {
    const [a, b, c] = fixture.modules;
    const vec = (/** @type {string} */ code) => /** @type {import('./fakes.js').StoredVector} */ (fakes.vectorize.vectors.get(code));
    expect((await verify({ sample: [a.code, b.code, c.code] })).ok).toBe(true);
    // The F2 end state: D1 has the new text_hash, the vector still embeds the old text.
    vec(a.code).metadata = { ...vec(a.code).metadata, textHash: 'old-text-hash' };
    const legacy = { .../** @type {Record<string, unknown>} */ (vec(b.code).metadata) };
    delete legacy.textHash;
    vec(b.code).metadata = legacy;
    const r = await verify({ sample: [a.code, b.code, c.code] });
    expect(r.ok).toBe(false);
    expect(r.metadataDrift.map((d) => d.code)).toEqual([a.code, b.code]);
  });

  it('reports a row whose stored row_hash no longer matches its columns, and a row with none', async () => {
    const [a, b] = fixture.modules;
    await env.DB.prepare('UPDATE modules SET credits = 99 WHERE code = ?').bind(a.code).run();
    await env.DB.prepare('UPDATE modules SET row_hash = NULL WHERE code = ?').bind(b.code).run();
    const r = await verify({ sampleSize: 0 });
    expect(r.ok).toBe(false);
    expect(r.rowHashDrift.map((d) => d.code)).toEqual([a.code]);
    expect(r.rowHashMissing).toEqual([b.code]);
  });
});
