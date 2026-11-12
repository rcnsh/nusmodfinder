// @ts-check
// The deploy guard reads production D1 over the D1 REST query endpoint, not
// through GET /admin/hashes on a `wrangler dev --remote` session. Both run the same code
// (src/admin-hashes.js); this proves they give the same answer over the same rows: a local D1
// seeded through the Worker's own /admin/ingest, read once through the route and once through
// the real REST client (scripts/d1-rest.mjs), whose fetch runs each statement against that
// same local D1 and answers in Cloudflare's envelope.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { d1RestClient } from '../scripts/d1-rest.mjs';
import { GUARD_CHECKS, compareWithTag, readD1, runGuard } from '../scripts/guard.mjs';
import { adminHashes } from '../src/admin-hashes.js';
import { DEFAULT_MODEL } from '../src/embedding.js';
import { catalogueKey } from '../src/rowhash.js';
import { adminCall, fixture, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => { fakes = await seed(); });

/** The REST client, its "Cloudflare" being the local D1 the Worker wrote. */
function localRest() {
  /** @type {string[]} */
  const sent = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (_input, init) => {
    const { sql, params } = JSON.parse(String(init?.body));
    sent.push(sql);
    const r = await env.DB.prepare(sql).bind(...(params ?? [])).all();
    return Response.json({ success: true, errors: [], messages: [], result: [{ results: r.results, success: true, meta: r.meta }] });
  };
  return { client: d1RestClient({ accountId: 'acct', databaseId: 'db', token: async () => 'local', fetchImpl }), sent };
}

/** The guard's values (rowsKey, dataVersion, catalogueKey) from a hashes body. @param {any} hashes */
async function guardValues(hashes) {
  const ctx = { hashes, query: async () => ({ results: [] }) };
  return Object.fromEntries(await Promise.all(GUARD_CHECKS.map(async (c) => [c.name, await c.d1(/** @type {any} */ (ctx))])));
}

describe('/admin/hashes and the REST guard read agree', () => {
  it('give the same body over the seeded fixture, and the same guard values', async () => {
    const route = await (await adminCall('/admin/hashes', fakes)).json();
    const { client, sent } = localRest();
    const rest = await adminHashes(client.query, { embeddingModel: DEFAULT_MODEL });
    expect(rest).toEqual(route);
    expect(Object.keys(rest.modules ?? {})).toHaveLength(fixture.modules.length);
    // Only reads went out, and the client counted what D1 says it read.
    expect(sent.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
    expect(client.rowsRead).toBeGreaterThanOrEqual(fixture.modules.length);

    const viaGuard = await readD1(localRest().client);
    expect(viaGuard.hashes).toEqual(route);
    expect(await guardValues(viaGuard.hashes)).toEqual(await guardValues(route));
  });

  it('still agree after a row changes, and the data version moves with it', async () => {
    const before = await guardValues(await (await adminCall('/admin/hashes', fakes)).json());
    const m = fixture.modules[0];
    const res = await adminCall('/admin/ingest?d1Only=1', fakes, { modules: [{ ...m, title: `${m.title} (revised)`, credits: (m.credits ?? 0) + 1 }] });
    expect(res.status).toBe(200);
    const route = await (await adminCall('/admin/hashes', fakes)).json();
    const rest = await adminHashes(localRest().client.query, { embeddingModel: DEFAULT_MODEL });
    expect(rest).toEqual(route);
    const after = await guardValues(rest);
    expect(after.dataVersion).not.toBe(before.dataVersion);
    expect(after).toEqual(await guardValues(route));
  });

  it('agree on the catalogueKey: the key of catalogue_only\'s codes, moving when a code is added', async () => {
    const codes = ['ZZ1000', 'ZZ2000', 'AA0999'];
    const upsert = codes.map((code) => ({ code, title: `Title ${code}`, description: null, acadYear: fixture.modules[0].acadYear }));
    expect((await adminCall('/admin/catalogue', fakes, { upsert })).status).toBe(200);
    const route = await (await adminCall('/admin/hashes', fakes)).json();
    const rest = await adminHashes(localRest().client.query, { embeddingModel: DEFAULT_MODEL });
    expect(rest.catalogueKey).toBe(route.catalogueKey);
    const { results } = /** @type {D1Result<{ code: string }>} */ (await env.DB.prepare('SELECT code FROM catalogue_only').all());
    expect(results.map((r) => r.code).sort()).toEqual(expect.arrayContaining([...codes].sort()));
    expect(rest.catalogueKey).toBe(await catalogueKey(results.map((r) => r.code)));
    expect((await guardValues(rest)).catalogueKey).toBe(rest.catalogueKey);

    expect((await adminCall('/admin/catalogue', fakes, { upsert: [{ code: 'ZZ3000', title: 'T', description: null, acadYear: fixture.modules[0].acadYear }] })).status).toBe(200);
    const after = await adminHashes(localRest().client.query, { embeddingModel: DEFAULT_MODEL });
    expect(after.catalogueKey).not.toBe(rest.catalogueKey);
    expect(after.catalogueKey).toBe((await (await adminCall('/admin/hashes', fakes)).json()).catalogueKey);
  });
});

// The guard recomputes each row's hash from the row's own columns (src/rowhash.js, as ingest does),
// for modules and catalogue_only alike. Hashing D1's stored row_hash values instead would let a row
// changed behind its row_hash (a hand `d1 execute`, an older writer, a one-table restore) keep the
// same dataVersion, and the deploy would ship over it.
describe('the guard recomputes every row\'s hash from its columns', () => {
  /** What the deploy would ship, taken from D1 as it is now (so the guard passes before the edit). */
  async function shipped() {
    const values = await guardValues((await readD1(localRest().client)).hashes);
    const { results } = /** @type {D1Result<{ code: string }>} */ (await env.DB.prepare('SELECT code FROM catalogue_only').all());
    return {
      bundle: { entry: { rowsKey: /** @type {string} */ (values.rowsKey), count: fixture.modules.length } },
      committed: /** @type {string} */ (values.dataVersion),
      catalogue: { codes: results.map((r) => r.code) },
      fields: { dataVersion: /** @type {string} */ (values.dataVersion), catalogueKey: /** @type {string} */ (values.catalogueKey) },
    };
  }

  it('refuses a module row edited behind its row_hash, and a catalogue_only row likewise; rollback\'s data check too', async () => {
    const acadYear = fixture.modules[0].acadYear;
    const upsert = ['ZZ1000', 'ZZ2000'].map((code) => ({ code, title: `Title ${code}`, description: null, acadYear }));
    expect((await adminCall('/admin/catalogue', fakes, { upsert })).status).toBe(200);
    const ship = await shipped();
    const pass = await runGuard({ client: localRest().client, ...ship });
    expect(pass.results.filter((r) => !r.ok)).toEqual([]);
    expect(pass.ok).toBe(true);
    expect((await compareWithTag({ client: localRest().client, fields: ship.fields })).ok).toBe(true);

    // One module closed to exchange students and 99 credits heavier; row_hash, text_hash, title
    // and description untouched. The guard reads every column, as many rows as before.
    const code = fixture.modules[0].code;
    await env.DB.prepare("UPDATE modules SET ng = 0, ng_allow = 0, ng_semesters = '[]', credits = credits + 99 WHERE code = ?").bind(code).run();
    const { client, sent } = localRest();
    const moduleEdit = await runGuard({ client, ...ship });
    expect(moduleEdit.ok).toBe(false);
    const failed = moduleEdit.results.filter((r) => !r.ok);
    expect(failed.map((r) => r.name).sort()).toEqual(['dataVersion', 'rowHashes']);
    expect(failed.find((r) => r.name === 'rowHashes')?.message).toContain(code);
    expect(sent.some((q) => /^SELECT code, title, description, credits, .* row_hash FROM modules$/.test(q))).toBe(true);
    const rollback = await compareWithTag({ client: localRest().client, fields: ship.fields });
    expect(rollback.ok).toBe(false);
    expect(rollback.results.filter((r) => !r.ok).map((r) => r.name).sort()).toEqual(['dataVersion', 'rowHashes']);

    // A whole-table edit: every value the guard compares moves.
    const before = await guardValues((await readD1(localRest().client)).hashes);
    await env.DB.batch([
      env.DB.prepare("UPDATE modules SET ng = 0, ng_allow = 0, ng_semesters = '[]', semesters = '[]', credits = credits + 99"),
      env.DB.prepare("UPDATE catalogue_only SET title = 'wrong title'"),
    ]);
    const after = await guardValues((await readD1(localRest().client)).hashes);
    expect(after).not.toEqual(before);
    const catalogueEdit = await runGuard({ client: localRest().client, ...ship });
    expect(catalogueEdit.results.filter((r) => !r.ok).map((r) => r.name).sort()).toEqual(['catalogueRows', 'dataVersion', 'rowHashes']);
    expect(catalogueEdit.results.find((r) => r.name === 'catalogueRows')?.message).toMatch(/ZZ1000/);
    // catalogueKey covers codes only, and they did not change.
    expect(catalogueEdit.results.find((r) => r.name === 'catalogueKey')?.ok).toBe(true);
  });
});
