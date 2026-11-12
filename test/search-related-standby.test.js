// @ts-check
// A not-offered code's `related` on the Vectorize standby: with no constraint
// param the neighbours come straight from Vectorize, with no D1 read; with
// one, they are checked after hydrate, and a failed read gives none rather than
// unfiltered neighbours or a 500.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCall, callJson, fixture, seed } from './helpers.js';

const STANDBY = { DENSE_BACKEND: 'vectorize' };
/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
  const res = await adminCall('/admin/catalogue', fakes, {
    upsert: [{ code: 'GEQ1000', title: 'Asking Questions', description: 'How to ask good questions about the world.', acadYear: fixture.modules[0].acadYear }],
  });
  if (res.status !== 200) throw new Error(`catalogue seed: HTTP ${res.status}`);
});

describe('related on the standby', () => {
  it('with no constraint param, reads no D1 row: a neighbour whose row is gone still shows', async () => {
    const before = await callJson('/search?q=GEQ1000', { fakes, env: STANDBY });
    const related = before.body.noMatch.related;
    expect(related.length).toBe(5);
    await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind(related[0]).run();
    const after = await callJson('/search?q=GEQ1000', { fakes, env: STANDBY });
    expect(after.status).toBe(200);
    expect(after.body.noMatch.related).toEqual(related);
  });
});
