// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), finding M-1: the deploy guard (and rollback's
// data check, and verify --pre-deploy's dataVersion) trust the `row_hash` column D1 stores. They
// read `code, title, description, text_hash, row_hash, acad_year` (src/admin-hashes.js HASHES_SQL)
// and hash the stored row_hash values; no other column is read. A row whose columns changed without
// its row_hash (a hand `wrangler d1 execute --remote` fix, a partial or older writer, a restore of
// one table) gives the same dataVersion, so the guard passes and the deploy ships over it. The
// catalogueKey covers catalogue_only's codes only, not titles or descriptions.
//
// A local D1 in the Worker test harness, seeded through /admin/ingest (test/helpers.js), read
// through the real REST client as test/admin-hashes-rest.test.js does. `it.fails`: asserts that a
// changed row moves what the guard compares.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { d1RestClient } from '../scripts/d1-rest.mjs';
import { GUARD_CHECKS, readD1 } from '../scripts/guard.mjs';
import { seed } from './helpers.js';

beforeAll(async () => { await seed(); });

function localRest() {
  /** @type {typeof fetch} */
  const fetchImpl = async (_input, init) => {
    const { sql, params } = JSON.parse(String(init?.body));
    const r = await env.DB.prepare(sql).bind(...(params ?? [])).all();
    return Response.json({ success: true, errors: [], messages: [], result: [{ results: r.results, success: true, meta: r.meta }] });
  };
  return d1RestClient({ accountId: 'acct', databaseId: 'db', token: async () => 'local', fetchImpl });
}

/** What the guard compares: every check's D1 value. */
async function guardValues() {
  const ctx = await readD1(localRest());
  return Object.fromEntries(await Promise.all(GUARD_CHECKS.map(async (c) => [c.name, await c.d1(/** @type {any} */ (ctx))])));
}

describe('red team M-1: the guard reads stored row_hash, not the rows', () => {
  it.fails('a row whose eligibility, semesters and credits changed (row_hash untouched) moves the guard\'s values', async () => {
    const before = await guardValues();
    // Every module closed to exchange students, offered in no semester, 99 more credits;
    // catalogue_only titles replaced. row_hash, text_hash, title and description stay.
    await env.DB.batch([
      env.DB.prepare("UPDATE modules SET ng = 0, ng_allow = 0, ng_semesters = '[]', semesters = '[]', credits = credits + 99"),
      env.DB.prepare("UPDATE catalogue_only SET title = 'wrong title'"),
    ]);
    const changed = await env.DB.prepare('SELECT count(*) AS n FROM modules WHERE credits > 90').first();
    expect(Number(changed?.n)).toBeGreaterThan(0);
    const after = await guardValues();
    // Observed: after deep-equals before (rowsKey, dataVersion and catalogueKey all unchanged).
    expect(after).not.toEqual(before);
  });
});
