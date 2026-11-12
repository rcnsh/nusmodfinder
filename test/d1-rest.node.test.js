// @ts-check
// Phase 7 7B (G1): the deploy guard, rollback and d1:restore read production D1 through
// Cloudflare's D1 REST query endpoint (scripts/d1-rest.mjs), never `wrangler dev --remote`.
// The client sends only SELECT and read-only PRAGMA statements, refusing anything else before
// a request leaves; it sums `meta.rows_read`; and the token (CLOUDFLARE_API_TOKEN, else
// `wrangler auth token`) never reaches an error, a log line or a run record. Fake fetch and
// exec only: nothing here calls Cloudflare.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertReadOnly, D1_API, d1RestClient } from '../scripts/d1-rest.mjs';
import { d1Config, resolveAccountId, resolveToken } from '../scripts/d1-read.mjs';
import { TOKEN, fakeD1 } from './deploy-fakes.js';

describe('assertReadOnly', () => {
  it('admits SELECT and read-only PRAGMA statements, comments and a trailing semicolon', () => {
    for (const sql of [
      'SELECT 1',
      '  select code, row_hash from modules where code = ?',
      'SELECT count(*) FROM modules;',
      '-- the guard\nSELECT code FROM modules',
      '/* note */ SELECT 1',
      'PRAGMA table_info(modules)',
      'pragma index_list("modules")',
      'PRAGMA table_list',
      "SELECT 'a;b' AS x",
    ]) expect(() => assertReadOnly(sql), sql).not.toThrow();
  });

  it('refuses every write, schema change, multi-statement or writing PRAGMA', () => {
    for (const sql of [
      '', '   ', ';',
      "INSERT INTO modules (code) VALUES ('X')",
      "UPDATE modules SET title = 'x'",
      'DELETE FROM modules',
      'REPLACE INTO modules (code) VALUES (1)',
      'DROP TABLE modules',
      // 7-0's mistake: a permission probe that would have written, had the token allowed it.
      'CREATE TABLE IF NOT EXISTS probe (x)',
      'ALTER TABLE modules ADD COLUMN x',
      'SELECT 1; DELETE FROM modules',
      'SELECT 1;; ',
      'WITH x AS (SELECT 1) DELETE FROM modules',
      'PRAGMA foreign_keys = OFF',
      'PRAGMA writable_schema=1',
      'PRAGMA user_version(5)',
      'PRAGMA wal_checkpoint(TRUNCATE)',
      "ATTACH DATABASE 'x' AS y",
      'VACUUM',
      'BEGIN',
    ]) expect(() => assertReadOnly(sql), JSON.stringify(sql)).toThrow(/read-only|only SELECT/);
  });
});

describe('d1RestClient', () => {
  it('posts one statement with its params to the query endpoint, with the bearer token, and sums rows_read', async () => {
    const { client, sent } = fakeD1({ extra: { 'SELECT code FROM modules WHERE code = ?': [{ code: 'CS2040' }] } });
    const one = await client.query('SELECT code FROM modules WHERE code = ?', ['CS2040']);
    expect(one.results).toEqual([{ code: 'CS2040' }]);
    await client.query('SELECT code FROM modules WHERE code = ?', ['CS1010S']);
    expect(sent).toEqual([
      { url: `${D1_API}/accounts/acct-id/d1/database/db-id/query`, sql: 'SELECT code FROM modules WHERE code = ?', params: ['CS2040'], auth: `Bearer ${TOKEN}` },
      { url: `${D1_API}/accounts/acct-id/d1/database/db-id/query`, sql: 'SELECT code FROM modules WHERE code = ?', params: ['CS1010S'], auth: `Bearer ${TOKEN}` },
    ]);
    expect(client.rowsRead).toBe(2);
    expect(client.queries).toBe(2);
  });

  it('refuses a write before any request is sent or the token is asked for', async () => {
    let asked = 0;
    /** @type {string[]} */
    const urls = [];
    const client = d1RestClient({
      accountId: 'a', databaseId: 'd', token: async () => { asked++; return TOKEN; },
      fetchImpl: /** @type {typeof fetch} */ (async (u) => { urls.push(String(u)); return Response.json({}); }),
    });
    await expect(client.query('DELETE FROM modules')).rejects.toThrow(/read-only|only SELECT/);
    await expect(client.query('CREATE TABLE IF NOT EXISTS probe (x)')).rejects.toThrow();
    expect(urls).toEqual([]);
    expect(asked).toBe(0);
  });

  it('asks for the token once, however many queries', async () => {
    let asked = 0;
    const { fetchImpl } = fakeD1({ extra: { 'SELECT 1 AS one': [{ one: 1 }] } });
    const client = d1RestClient({ accountId: 'a', databaseId: 'd', token: async () => { asked++; return TOKEN; }, fetchImpl });
    await client.query('SELECT 1 AS one');
    await client.query('SELECT 1 AS one');
    expect(asked).toBe(1);
  });

  it('a refused request names the HTTP status and Cloudflare\'s error code, never the token', async () => {
    const { client } = fakeD1({ status: 403 });
    const err = await client.query('SELECT 1').then(() => null, (e) => e);
    expect(String(err?.message)).toMatch(/HTTP 403.*7403/);
    expect(String(err?.message)).not.toContain(TOKEN);
    expect(String(err?.stack)).not.toContain(TOKEN);
  });
});

describe('the token and the account', () => {
  /** @type {string} */
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-d1-rest-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('takes CLOUDFLARE_API_TOKEN without running wrangler', async () => {
    /** @type {string[][]} */
    const calls = [];
    const token = await resolveToken({ env: { CLOUDFLARE_API_TOKEN: TOKEN }, exec: async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: '' }; } });
    expect(token).toBe(TOKEN);
    expect(calls).toEqual([]);
  });

  it('else captures `wrangler auth token --json` in-process, never streamed', async () => {
    /** @type {{ args: string[], opts: any }[]} */
    const calls = [];
    const token = await resolveToken({
      env: {},
      exec: async (c, a, opts) => { calls.push({ args: [c, ...a], opts }); return { code: 0, stdout: `${JSON.stringify({ type: 'oauth', token: TOKEN })}\n` }; },
    });
    expect(token).toBe(TOKEN);
    expect(calls).toEqual([{ args: ['npx', 'wrangler', 'auth', 'token', '--json'], opts: undefined }]);
  });

  it('a failed or unreadable `wrangler auth token` says so without echoing its output', async () => {
    for (const answer of [{ code: 1, stdout: TOKEN }, { code: 0, stdout: `not json ${TOKEN}` }, { code: 0, stdout: JSON.stringify({ type: 'oauth' }) }]) {
      const err = await resolveToken({ env: {}, exec: async () => answer }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/wrangler auth token/);
      expect(String(err.message)).not.toContain(TOKEN);
    }
  });

  it('the account: CLOUDFLARE_ACCOUNT_ID, else wrangler\'s cached account, else a refusal naming the variable', async () => {
    expect(await resolveAccountId({ env: { CLOUDFLARE_ACCOUNT_ID: 'from-env' }, cacheFile: join(dir, 'none.json') })).toBe('from-env');
    const cacheFile = join(dir, 'wrangler-account.json');
    writeFileSync(cacheFile, JSON.stringify({ account: { id: 'from-cache', name: 'x' } }));
    expect(await resolveAccountId({ env: {}, cacheFile })).toBe('from-cache');
    await expect(resolveAccountId({ env: {}, cacheFile: join(dir, 'none.json') })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('the database is wrangler.jsonc\'s DB binding', async () => {
    expect(await d1Config()).toEqual({ databaseName: 'nusmods-apac', databaseId: 'de4527ff-19ec-4a5b-9c5c-4d1791078b25' });
  });
});
