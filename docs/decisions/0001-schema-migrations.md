# 0001: The schema is `migrations/`, tracked by wrangler

Status: accepted.

## Context
The D1 schema has to be rebuildable from the repo alone, and a production database must say
which migrations it holds. SQLite can't make `ALTER TABLE ADD COLUMN` conditional (`0003_ng.sql`
uses it), so re-running a migration by hand is not safe. The first production database was built
by hand from `schema.sql` and `0002`–`0005`, before any tracking.

## Decision
- **`migrations/` is the only schema.** There is no `schema.sql`. `0001_init.sql` holds exactly
  the shape `0002` builds on, and every later change is a new numbered file. A migration file is
  never renamed, edited or squashed once applied: wrangler tracks them by name.
- **Wrangler tracks what ran**, in its `d1_migrations` table:
  `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
  (wrangler's own DDL; `name` is the file name, e.g. `0003_ng.sql`). A fresh database, local or
  remote, is built with `wrangler d1 migrations apply`.
- **A migration applied to production by hand** goes through `scripts/remote-migration.mjs`,
  which writes one SQL file: the migration body verbatim, then
  `INSERT INTO d1_migrations(name) VALUES('<file>')`. With `--bootstrap` it first creates the
  table with the DDL above and inserts `INSERT OR IGNORE` rows for `0001`–`0005`, for a database
  built before tracking. Migration files themselves never write `d1_migrations`.
- **Idempotency.** Every `CREATE` uses `IF NOT EXISTS`, and `0005`'s rank `INSERT` is a config
  write that is safe to repeat. The `ALTER`s in `0003` rely on tracking.
- **CI proves the rebuild** (`npm run db:rebuild-check`, `scripts/schema-snapshot.mjs`): it
  builds the schema from empty three ways, locally, and diffs normalised pragma snapshots
  against the committed ones. `--compare-remote` diffs a saved production capture against the
  full-chain snapshot, comparing the migrations as a set.

## Why not the alternatives
- Running files by hand with a documented order records nothing about what ran.
- Squashing history into one `0001` is clean for fresh databases, but a database built from the
  old files could never be reconciled with tracked migrations without being recreated.

## Consequences
- `wrangler d1 migrations list --remote` creates the tracking table if it is missing, so it is a
  remote write, not a read.
- If `apply --remote` ever runs against a database built before tracking and not bootstrapped,
  `0001`/`0002` no-op and are recorded and `0003` fails with `duplicate column name: ng`. The
  recovery is to insert rows for `0003`–`0005` and re-run.
- Production applied `0008` before `0007`; tracking is by name, so order between independent
  migrations doesn't matter.

## In the code
- **`modules` is never written with a REPLACE.** No `INSERT OR REPLACE`, `UPDATE OR REPLACE` or
  `REPLACE INTO` on `modules`, and nothing assigns a rowid. On the external-content `modules_fts`
  table, REPLACE's implicit delete fires no delete trigger (`recursive_triggers` is off), so the
  old row's index entries stay and the FTS integrity-check fails; a changed rowid moves the row out
  from under its FTS entry. `test/migrations.node.test.js` bans the text forms, and 0006's
  `modules_rowid_immutable` trigger refuses the rest in the database. Under that rule the FTS
  table stays exactly what a fresh `rebuild` makes under any mix of inserts, upserts, updates and
  deletes, and rewriting an unchanged row (or one whose only change is a filter column) writes
  nothing to the FTS shadow tables (`test/fts.test.js`).
- **`/module/:code` names its columns** (`MODULE_COLUMNS`, `src/modules.js`) rather than selecting
  `*`, so a column a later migration adds (generated filter columns, `row_hash`) never changes the
  response; a field joins the response only by name.
- **`scripts/schema-snapshot.mjs`** drops only Cloudflare's (`_cf_`), wrangler's (`d1_`) and
  SQLite's (`sqlite_`) internal tables (`INTERNAL_RE`); the FTS5 shadow tables are real schema and
  stay in the snapshot. Its `wrangler()` wrapper refuses to run without `--local` and stops if the
  output mentions "remote" outside wrangler's two fixed hint lines. `d1 execute --local` never reads
  `migrations_dir`, so the test config serves every build; only `migrations apply` gets the
  rewritten subset config (`partialConfig`). `normaliseSql` strips `--` and `/* */` comments by
  pattern, which is safe only while no string literal in the schema contains them.
