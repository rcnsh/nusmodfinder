// @ts-check
// Phase 7 7A: `schema-snapshot.mjs --compare-remote`, which diffs a production capture (the
// output of `wrangler d1 execute … --json`, one file per query) against the full-chain snapshot
// offline. The captures here are built from the committed snapshot; nothing remote is read.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareRemote, loadCapture } from '../scripts/schema-snapshot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const expected = JSON.parse(await readFile(join(ROOT, 'test/fixtures/schema-0006.json'), 'utf8'));
const migrations = (await readdir(join(ROOT, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();

/** wrangler's `--json` envelope around rows. @param {unknown[]} rows */
const envelope = (rows) => [{ results: rows, success: true, meta: { rows_read: rows.length } }];

/** A capture equal to the snapshot, with production's internal tables and 0008 applied before 0007. */
function capture() {
  const order = migrations.map((name) => name);
  const i7 = order.findIndex((n) => n.startsWith('0007'));
  const i8 = order.findIndex((n) => n.startsWith('0008'));
  [order[i7], order[i8]] = [order[i8], order[i7]];
  return {
    pragma: envelope(expected.pragma.map((/** @type {string} */ r) => JSON.parse(r))),
    master: envelope([
      { type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID' },
      { type: 'table', name: 'd1_migrations', tbl_name: 'd1_migrations', sql: 'CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)' },
      ...expected.master.map((/** @type {string} */ r) => JSON.parse(r)),
    ]),
    indexXinfo: envelope(expected.indexXinfo.map((/** @type {string} */ r) => JSON.parse(r))),
    migrations: envelope(order.map((name, i) => ({ id: i + 1, name, applied_at: '2026-11-04 07:40:48' }))),
  };
}

const compare = (/** @type {ReturnType<typeof capture>} */ c) => compareRemote(c, { expected, migrations });

describe('--compare-remote', () => {
  it('matches a capture equal to the full chain, with 0008 applied before 0007 (migrations compare as a set)', () => {
    expect(compare(capture())).toEqual([]);
  });

  it('reports a missing index', () => {
    const c = capture();
    const rows = /** @type {any[]} */ (c.master[0].results);
    const index = rows.find((r) => r.type === 'index' && r.sql);
    c.master[0].results = rows.filter((r) => r !== index);
    c.indexXinfo[0].results = /** @type {any[]} */ (c.indexXinfo[0].results).filter((r) => r.idx !== index.name);
    c.pragma[0].results = /** @type {any[]} */ (c.pragma[0].results).filter((r) => !Object.values(r).includes(index.name));
    const diff = compare(c);
    expect(diff).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`sqlite_master - .*"name":"${index.name}"`))]));
    for (const line of diff) expect(line).toContain(index.name);
    expect(diff.every((l) => / - /.test(l))).toBe(true);
  });

  it('reports a changed trigger body', () => {
    const c = capture();
    const trigger = /** @type {any[]} */ (c.master[0].results).find((r) => r.type === 'trigger');
    trigger.sql = trigger.sql.replace(/END$/, '; SELECT 1; END');
    const diff = compare(c);
    expect(diff).toHaveLength(2);
    expect(diff.join('\n')).toMatch(new RegExp(`sqlite_master - .*"name":"${trigger.name}"`));
    expect(diff.join('\n')).toMatch(/SELECT 1/);
  });

  it('reports a missing migration row', () => {
    const c = capture();
    c.migrations[0].results = /** @type {any[]} */ (c.migrations[0].results).filter((r) => !r.name.startsWith('0009'));
    expect(compare(c)).toEqual(['d1_migrations - 0009_exchange.sql']);
  });

  it('loads a capture directory of wrangler outputs, one file per query, as committed in docs/evidence/phase7/schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vnm-capture-'));
    try {
      const c = capture();
      await writeFile(join(dir, 'pragma.json'), JSON.stringify(c.pragma));
      await writeFile(join(dir, 'master.json'), JSON.stringify(c.master));
      await writeFile(join(dir, 'index_xinfo.json'), JSON.stringify(c.indexXinfo));
      await writeFile(join(dir, 'd1_migrations.json'), JSON.stringify(c.migrations));
      expect(compare(await loadCapture(dir))).toEqual([]);
      // One file holding every section is read the same way.
      await writeFile(join(dir, 'all.json'), JSON.stringify(c));
      expect(compare(await loadCapture(join(dir, 'all.json')))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
