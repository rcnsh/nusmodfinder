// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), finding M-3: scripts/d1-rest.mjs assertReadOnly
// accepts a statement that writes. SQLite's tokenizer reads `$`, `@`, `:` and `#` followed by an
// identifier character as a parameter, and a TCL-style `(...)` after it runs to the next `)` or
// space, swallowing quotes. The check refuses `[$@:#][A-Za-z0-9_]`, but SQLite's identifier
// characters also include `$` itself and every byte >= 0x80, so `$$(')` or `@é(')` is a parameter
// that eats a quote the literal-blanking skeleton() thinks opens a string. The `;` after it is then
// invisible to the "one statement" check, and the client sends the whole string. Whether D1's REST
// query endpoint (https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
// then runs the second statement was not tested: no Cloudflare call was made. Below, SQLite (D1's
// engine) runs it when given the string as a batch.
//
// Local only: node:sqlite in memory stands in for D1 (same tokenizer), and the REST client's fetch
// is a fake that records the body. `it.fails`: each case asserts the safe behaviour.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { assertReadOnly, d1RestClient } from '../scripts/d1-rest.mjs';

const PAYLOADS = [
  "SELECT $$(');UPDATE modules SET title='pwned';--')",
  "SELECT @é(');UPDATE modules SET title='pwned';--')",
];

/** Runs `sql` as a batch, as the REST endpoint does, over a two-row table; returns the titles after. @param {string} sql */
function runBatch(sql) {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE modules(code TEXT, title TEXT); INSERT INTO modules VALUES ('CS1010', 'Programming'), ('CS2030', 'OOP');");
  db.exec(sql);
  return db.prepare('SELECT title FROM modules ORDER BY code').all().map((r) => r.title);
}

describe('red team M-3: assertReadOnly lets a write through', () => {
  for (const sql of PAYLOADS) {
    it.fails(`refuses ${JSON.stringify(sql)}`, async () => {
      // Observed: no throw.
      expect(() => assertReadOnly(sql)).toThrow(/refusing/);
    });

    it(`(evidence) SQLite runs ${JSON.stringify(sql)} as a SELECT and then an UPDATE`, () => {
      expect(runBatch(sql)).toEqual(['pwned', 'pwned']);
    });
  }

  it.fails('the REST client never sends it', async () => {
    /** @type {string[]} */
    const sent = [];
    const client = d1RestClient({
      accountId: 'acct', databaseId: 'db', token: 'fake',
      fetchImpl: /** @type {typeof fetch} */ (async (_u, init) => {
        sent.push(JSON.parse(String(init?.body)).sql);
        return Response.json({ success: true, result: [{ results: [], meta: {} }] });
      }),
    });
    await client.query(PAYLOADS[0]).catch(() => {});
    // Observed: sent === [PAYLOADS[0]].
    expect(sent).toEqual([]);
  });
});
