// @ts-check
// Phase 7 7B (G1): the deploy guard, rollback and d1:restore read production D1 through
// Cloudflare's D1 REST query endpoint (scripts/d1-rest.mjs), never `wrangler dev --remote`.
// The client sends only SELECT and read-only PRAGMA statements, refusing anything else before
// a request leaves; it sums `meta.rows_read`; and the token (CLOUDFLARE_API_TOKEN, else
// `wrangler auth token`) never reaches an error, a log line or a run record. Fake fetch and
// exec only: nothing here calls Cloudflare.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertReadOnly, D1_API, d1RestClient } from '../scripts/d1-rest.mjs';
import { d1Config, resolveAccountId, resolveToken } from '../scripts/d1-read.mjs';
import { TOKEN, fakeD1 } from './deploy-fakes.node.mjs';

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
      // (meta, not modules: test/migrations.node.test.js bans any REPLACE on modules in the repo.)
      'REPLACE INTO meta (key) VALUES (1)',
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
      // SQLite's TCL-style parameter tokens run to the next ')' and swallow quotes, so a quote
      // inside one would hide a second statement from a quote-aware scan (review finding 1).
      "SELECT $a(');DELETE FROM modules --')",
      "SELECT @x(');DELETE FROM modules --')",
      'SELECT :name',
      'SELECT #n',
    ]) expect(() => assertReadOnly(sql), JSON.stringify(sql)).toThrow(/read-only|only SELECT/);
  });
});

// Red team M-3 (docs/evidence/phase7/redteam.md): SQLite reads `$`, `@`, `:` or `#` followed by an
// identifier character as a parameter, and its identifier characters include `$` and every byte
// >= 0x80, so `$$(')` or `@é(')` is a TCL-style parameter that swallows a quote the literal-blanking
// took for a string's start, hiding the `;` after it. The check now refuses any parameter sigil.
describe('assertReadOnly, strict (red team M-3)', () => {
  const PAYLOADS = [
    "SELECT $$(');UPDATE modules SET title='pwned';--')",
    "SELECT @é(');UPDATE modules SET title='pwned';--')",
  ];
  /** Runs `sql` as a batch, as the REST endpoint might, over a two-row table; the titles after. @param {string} sql */
  const runBatch = (sql) => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE modules(code TEXT, title TEXT); INSERT INTO modules VALUES ('CS1010', 'Programming'), ('CS2030', 'OOP');");
    db.exec(sql);
    return db.prepare('SELECT title FROM modules ORDER BY code').all().map((r) => r.title);
  };

  for (const sql of PAYLOADS) {
    it(`refuses ${JSON.stringify(sql)}, which SQLite runs as a SELECT and then an UPDATE`, () => {
      expect(runBatch(sql)).toEqual(['pwned', 'pwned']);
      expect(() => assertReadOnly(sql)).toThrow(/refusing/);
    });
  }

  it('the REST client never sends it', async () => {
    /** @type {string[]} */
    const sent = [];
    const client = d1RestClient({
      accountId: 'acct', databaseId: 'db', token: 'fake',
      fetchImpl: /** @type {typeof fetch} */ (async (_u, init) => {
        sent.push(JSON.parse(String(init?.body)).sql);
        return Response.json({ success: true, result: [{ results: [], meta: {} }] });
      }),
    });
    for (const sql of PAYLOADS) await expect(client.query(sql)).rejects.toThrow(/refusing/);
    expect(sent).toEqual([]);
  });

  it('refuses the classics: a `;` behind a comment, WITH … DELETE, RETURNING, a write keyword anywhere, any parameter sigil', () => {
    for (const sql of [
      'SELECT 1 -- note\n; DELETE FROM modules',
      'SELECT 1 /* x */; DROP TABLE modules',
      'WITH x AS (SELECT 1) DELETE FROM modules',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'DELETE FROM modules RETURNING code',
      "INSERT INTO meta (key) VALUES ('x') RETURNING *",
      'SELECT code FROM modules RETURNING code',
      "SELECT replace(title, 'a', 'b') FROM modules",
      "SELECT 'it''s' || $x",
      'SELECT ?1, :a',
      'SELECT [a]$',
      'SELECT 1 # note',
      'SELECT @1',
      "VACUUM INTO 'x.db'",
      'REINDEX modules',
      'DETACH DATABASE x',
    ]) expect(() => assertReadOnly(sql), JSON.stringify(sql)).toThrow(/refusing/);
  });

  it('still admits every statement the callers send (each a constant)', async () => {
    const { SCHEMA_SQL, HASHES_SQL, CATALOGUE_TABLE_SQL, CATALOGUE_CODES_SQL } = await import('../src/admin-hashes.js');
    for (const sql of [SCHEMA_SQL, HASHES_SQL, CATALOGUE_TABLE_SQL, CATALOGUE_CODES_SQL]) expect(() => assertReadOnly(sql), sql).not.toThrow();
    // Words that hold a write keyword but are not one, and keywords inside literals.
    for (const sql of ["SELECT name FROM sqlite_master WHERE name = 'modules_fts_update'", 'SELECT "delete" FROM t', 'SELECT updated_at, created FROM t']) {
      expect(() => assertReadOnly(sql), sql).not.toThrow();
    }
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

  it('on a Mac with no cached account, the one account `wrangler whoami` lists; several or none refuse', async () => {
    const none = join(dir, 'none.json');
    /** @param {unknown[]} accounts */
    const whoami = (accounts) => async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      expect([cmd, ...args]).toEqual(['npx', 'wrangler', 'whoami', '--json']);
      return { code: 0, stdout: `noise\n${JSON.stringify({ loggedIn: true, accounts })}` };
    };
    expect(await resolveAccountId({ env: {}, cacheFile: none, exec: whoami([{ id: 'from-whoami', name: 'x' }]) })).toBe('from-whoami');
    await expect(resolveAccountId({ env: {}, cacheFile: none, exec: whoami([{ id: 'a' }, { id: 'b' }]) })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    await expect(resolveAccountId({ env: {}, cacheFile: none, exec: whoami([]) })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    await expect(resolveAccountId({ env: {}, cacheFile: none, exec: async () => ({ code: 1, stdout: '' }) })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('the database is wrangler.jsonc\'s DB binding', async () => {
    expect(await d1Config()).toEqual({ databaseName: 'nusmods-apac', databaseId: 'de4527ff-19ec-4a5b-9c5c-4d1791078b25' });
  });

  // Red team L-3: d1Config took the first d1_databases entry, whatever its binding.
  it('picks the DB binding when another database is listed first, and fails when none is bound as DB', async () => {
    const path = join(dir, 'wrangler.jsonc');
    writeFileSync(path, `{
  "d1_databases": [
    // a second database, listed first
    { "binding": "ANALYTICS", "database_name": "nusmods-analytics", "database_id": "11111111-1111-1111-1111-111111111111" },
    { "binding": "DB", "database_name": "nusmods-apac", "database_id": "de4527ff-19ec-4a5b-9c5c-4d1791078b25" },
  ],
}
`);
    expect(await d1Config(path)).toEqual({ databaseName: 'nusmods-apac', databaseId: 'de4527ff-19ec-4a5b-9c5c-4d1791078b25' });
    writeFileSync(path, '{ "d1_databases": [{ "binding": "ANALYTICS", "database_name": "a", "database_id": "1" }] }');
    await expect(d1Config(path)).rejects.toThrow(/no d1_databases entry bound as DB/);
    writeFileSync(path, '{ "d1_databases": [{ "binding": "DB", "database_name": "a", "database_id": "1" }, { "binding": "DB", "database_name": "b", "database_id": "2" }] }');
    await expect(d1Config(path)).rejects.toThrow(/2 d1_databases entries bound as DB/);
  });
});
