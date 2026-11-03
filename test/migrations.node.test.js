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
  // entries stay behind and integrity-check fails.
  it('is never used on modules anywhere in src/, scripts/, migrations/ or test/', () => {
    /** @param {string} dir @returns {string[]} */
    const files = (dir) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(m?js|sql|py)$/.test(f)).map((f) => join(dir, f));
    const offenders = [];
    for (const f of [...files('src'), ...files('scripts'), ...files('migrations'), ...files('test')]) {
      if (f.startsWith(join('test', 'fixtures'))) continue;
      const text = read(f);
      if (/\b(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\s+["`]?modules\b(?!_)/i.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('UPDATE … SET rowid', () => {
  // The external-content FTS table is keyed on modules.rowid. Changing a
  // rowid moves the row out from under its FTS entry: the update trigger
  // fires only when code/title/description change, so after a rowid-only
  // update the index still holds the row under the old rowid.
  const ASSIGNS_ROWID = /\bUPDATE\s+(?:OR\s+\w+\s+)?["`]?\w+["`]?\s+SET\s+(?:[^;`]*?,\s*)?["`]?(?:rowid|_rowid_|oid)["`]?\s*=/i;

  it('the pattern catches the forms it bans and not a rowid in WHERE', () => {
    expect(ASSIGNS_ROWID.test('UPDATE modules SET rowid = rowid + 1')).toBe(true);
    expect(ASSIGNS_ROWID.test('update modules set title = ?, _rowid_ = ? where code = ?')).toBe(true);
    expect(ASSIGNS_ROWID.test('UPDATE OR IGNORE "modules" SET oid=7')).toBe(true);
    expect(ASSIGNS_ROWID.test('UPDATE modules SET title = ? WHERE rowid = ?')).toBe(false);
  });

  it('is never used in src/, scripts/ or migrations/', () => {
    /** @param {string} dir @returns {string[]} */
    const files = (dir) => readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(m?js|sql|py)$/.test(f)).map((f) => join(dir, f));
    const offenders = [];
    for (const f of [...files('src'), ...files('scripts'), ...files('migrations')]) {
      // SQL comments may name the hazard (0006's header does).
      const text = f.endsWith('.sql') ? read(f).replace(/--[^\n]*/g, '') : read(f);
      if (ASSIGNS_ROWID.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
