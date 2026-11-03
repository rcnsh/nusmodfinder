// @ts-check
// Migration 0006 and its tooling, checked from Node: the remote wrapper that
// scripts/remote-migration.mjs writes, the clean migration file, and the rule
// that nothing writes `modules` with INSERT OR REPLACE or assigns a rowid.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_APPLIED, WRANGLER_MIGRATIONS_DDL, migrationFile, outputPath, remoteWrapper,
} from '../scripts/remote-migration.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
const FILE = '0006_fts_external.sql';
const BODY = read(`migrations/${FILE}`);

describe('remote migration wrapper', () => {
  it('with --bootstrap is exactly: wrangler DDL, 0001–0005 rows, the body, its own row', () => {
    const sql = remoteWrapper({ file: FILE, body: BODY, bootstrap: true });
    expect(sql).toBe([
      'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);',
      "INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0001_init.sql'), ('0002_fts.sql'), ('0003_ng.sql'), ('0004_meta.sql'), ('0005_rank.sql');",
      BODY.trimEnd(),
      "INSERT INTO d1_migrations(name) VALUES('0006_fts_external.sql');",
      '',
    ].join('\n'));
  });

  it('without --bootstrap is the body and its own row only', () => {
    expect(remoteWrapper({ file: FILE, body: BODY, bootstrap: false }))
      .toBe(`${BODY.trimEnd()}\nINSERT INTO d1_migrations(name) VALUES('0006_fts_external.sql');\n`);
  });

  it("uses wrangler's own d1_migrations DDL and the hand-applied set from ADR 0001", () => {
    const adr = read('docs/decisions/0001-migrations-and-remote-bootstrap.md');
    expect(adr).toContain(WRANGLER_MIGRATIONS_DDL);
    expect(BOOTSTRAP_APPLIED).toEqual(readdirSync(join(ROOT, 'migrations')).filter((f) => f < '0006').sort());
  });

  it('names the output after the migration and refuses odd names and dirty bodies', () => {
    expect(migrationFile('0006_fts_external')).toBe(FILE);
    expect(migrationFile(FILE)).toBe(FILE);
    expect(outputPath(FILE)).toBe('/tmp/vnm-remote-0006_fts_external.sql');
    expect(() => migrationFile('../x.sql')).toThrow();
    expect(() => remoteWrapper({ file: '0003_ng.sql', body: '', bootstrap: false })).toThrow(/hand-applied/);
    expect(() => remoteWrapper({ file: FILE, body: "INSERT INTO d1_migrations(name) VALUES('x');", bootstrap: false }))
      .toThrow(/d1_migrations/);
  });
});

describe('migrations/0006_fts_external.sql', () => {
  const sql = BODY.replace(/--[^\n]*/g, '');

  it('is clean: it records nothing in d1_migrations itself', () => {
    expect(sql).not.toMatch(/d1_migrations/i);
  });

  it('builds an external-content FTS table keyed on rowid with code UNINDEXED', () => {
    expect(sql.replace(/\s+/g, ' ')).toContain(
      "CREATE VIRTUAL TABLE modules_fts USING fts5( code UNINDEXED, title, description, content = 'modules', content_rowid = 'rowid', tokenize = 'porter unicode61', prefix = '2 3 4' );");
    expect(sql).toContain("INSERT INTO modules_fts(modules_fts) VALUES('rebuild');");
    expect(sql).toContain("INSERT INTO modules_fts(modules_fts, rank) VALUES('rank', 'bm25(0.0, 3.0, 1.0)');");
    // Every trigger addresses the FTS row by rowid; none deletes by code (B3).
    expect(sql).not.toMatch(/DELETE\s+FROM\s+modules_fts/i);
  });
});

describe('INSERT OR REPLACE', () => {
  // On an external-content FTS table, REPLACE's implicit delete fires no
  // delete trigger (recursive_triggers is off), so the old row's index
  // entries stay behind and integrity-check fails. UPDATE OR REPLACE onto an
  // existing code does the same (PR #8 review round 3).
  const REPLACES_MODULES = /\b(?:(?:INSERT|UPDATE)\s+OR\s+REPLACE(?:\s+INTO)?|REPLACE\s+INTO)\s+["`[]?(?:main\s*\.\s*)?["`[]?modules\b(?!_)/i;

  it('the pattern catches every REPLACE form on modules and nothing else', () => {
    for (const sql of ['INSERT OR REPLACE INTO modules VALUES (1)', 'replace into "modules" (code) values (?)', 'UPDATE OR REPLACE modules SET code = ?',
      'update or replace [modules] set code = ?', 'INSERT OR REPLACE INTO main.modules (code) VALUES (?)']) {
      expect(REPLACES_MODULES.test(sql), sql).toBe(true);
    }
    for (const sql of ['INSERT OR REPLACE INTO meta (key) VALUES (?)', 'UPDATE OR REPLACE modules_fts SET x = 1', "SELECT replace(title, 'a', 'b') FROM modules"]) {
      expect(REPLACES_MODULES.test(sql), sql).toBe(false);
    }
  });

  it('UPDATE OR REPLACE onto an existing code really corrupts the index (why it is banned)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) db.exec(read(join('migrations', f)));
    db.exec("INSERT INTO modules (code, title, description, acad_year, text_hash) VALUES ('A1', 'alpha', 'alpha one', 'y', 'h'), ('B2', 'beta', 'beta two', 'y', 'h')");
    db.exec("UPDATE OR REPLACE modules SET code = 'B2' WHERE code = 'A1'");
    expect(() => db.exec("INSERT INTO modules_fts(modules_fts, rank) VALUES('integrity-check', 1)")).toThrow();
  });

  it('is never used on modules anywhere in src/, scripts/, migrations/ or test/', () => {
    /** @param {string} dir @returns {string[]} */
    const files = (dir) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(m?js|sql|py)$/.test(f)).map((f) => join(dir, f));
    const offenders = [];
    for (const f of [...files('src'), ...files('scripts'), ...files('migrations'), ...files('test')]) {
      // This file's own examples (the pattern test, the rowid trigger's refused forms) are not uses.
      if (f.startsWith(join('test', 'fixtures')) || f === join('test', 'migrations.node.test.js')) continue;
      const text = read(f);
      if (REPLACES_MODULES.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('modules.rowid is immutable', () => {
  // The external-content FTS table is keyed on modules.rowid. Changing a
  // rowid moves the row out from under its FTS entry, and no text pattern
  // catches every spelling (PR #8 review round 2: the upsert form ingest
  // uses, schema-qualified names, row-value SET, [bracketed] identifiers).
  // 0006's modules_rowid_immutable trigger refuses them in the database.
  const FORMS = [
    "INSERT INTO modules (code, title, acad_year, text_hash) VALUES ('A1', 't', 'y', 'h') ON CONFLICT(code) DO UPDATE SET rowid = 100",
    "INSERT INTO modules (code, title, acad_year, text_hash) VALUES ('A1', 't', 'y', 'h') ON CONFLICT(code) DO UPDATE SET title = excluded.title, rowid = 101",
    'UPDATE main.modules SET rowid = rowid + 10',
    'UPDATE modules AS m SET rowid = 70',
    'UPDATE [modules] SET [rowid] = 80',
    "UPDATE modules SET (title, rowid) = ('x', 90) WHERE code = 'A1'",
    "UPDATE modules SET \"title\" = 'q', [_rowid_] = 110 WHERE code = 'A1'",
    "UPDATE modules SET title = 'a;b', oid = 120 WHERE code = 'A1'",
    'UPDATE modules INDEXED BY idx_modules_level SET rowid = rowid + 130',
    'UPDATE OR REPLACE modules SET rowid = rowid + 140',
    "UPDATE OR IGNORE modules SET rowid = 150 WHERE code = 'A1'",
  ];

  /** A database with every migration applied and two modules. */
  async function migrated() {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) db.exec(read(join('migrations', f)));
    db.exec("INSERT INTO modules (code, title, description, acad_year, text_hash) VALUES ('A1', 'alpha', 'alpha one', 'y', 'h'), ('B2', 'beta', 'beta two', 'y', 'h')");
    return db;
  }

  it.each(FORMS)('refuses %s', async (sql) => {
    const db = await migrated();
    const before = db.prepare('SELECT rowid, code FROM modules ORDER BY rowid').all();
    expect(() => db.exec(sql)).toThrow(/modules\.rowid is immutable/);
    expect(db.prepare('SELECT rowid, code FROM modules ORDER BY rowid').all()).toEqual(before);
    expect(db.prepare("SELECT m.code FROM modules_fts JOIN modules m ON m.rowid = modules_fts.rowid WHERE modules_fts MATCH 'alpha'").all()).toEqual([{ code: 'A1' }]);
  });

  it('allows every update that keeps the rowid, including ingest\'s upsert', async () => {
    const db = await migrated();
    db.exec("INSERT INTO modules (code, title, description, acad_year, text_hash) VALUES ('A1', 'gamma', 'gamma one', 'y', 'h2') ON CONFLICT(code) DO UPDATE SET title = excluded.title, description = excluded.description, text_hash = excluded.text_hash");
    db.exec("UPDATE modules SET title = 'delta' WHERE rowid = 2");
    db.exec('UPDATE modules SET rowid = rowid');
    expect(db.prepare('SELECT rowid, code, title FROM modules ORDER BY rowid').all()).toEqual([{ rowid: 1, code: 'A1', title: 'gamma' }, { rowid: 2, code: 'B2', title: 'delta' }]);
    expect(db.prepare("SELECT rowid FROM modules_fts WHERE modules_fts MATCH 'gamma OR delta' ORDER BY rowid").all()).toEqual([{ rowid: 1 }, { rowid: 2 }]);
  });
});
