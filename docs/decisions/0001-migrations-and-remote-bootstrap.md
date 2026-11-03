# 0001 — Migrations via `wrangler d1 migrations apply`, remote bootstrapped by hand

Status: accepted (Phase 0)

## Context
Production D1 (`nusmods`) was built by running `schema.sql` and `migrations/0002`–`0005` by hand
with `wrangler d1 execute`. There is no `0001`, no `d1_migrations` table remotely, and `0003`
uses `ALTER TABLE ADD COLUMN`, which SQLite cannot make conditional. The README's setup steps
skip `0003` and `0005`, so the database cannot be rebuilt from the docs.

## Options
1. Keep running files by hand; document the order. Simple, but nothing records what ran.
2. Rewrite history into one `0001` holding the final shape. Clean for fresh databases, but the
   remote can never be reconciled with tracked migrations without a recreate (forbidden).
3. Keep the files, add `0001_init.sql` holding exactly the pre-0002 shape, adopt wrangler's
   migration tracking, and bootstrap the remote `d1_migrations` table with rows for what was
   applied by hand.

## Evidence
- Remote schema captured read-only on 2026-11-03 (pragma columns, indexes, objects,
  `modules_fts_config`): 77 rows read, 0 written. It matches `schema.sql` + 0002–0005.
- Wrangler's table DDL (cli.js `initMigrationsTable`):
  `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;
  `name` is the file name, e.g. `0003_ng.sql`.
- `wrangler d1 migrations list --remote` calls `initMigrationsTable` first, so it is a remote
  write, not a read (critic B, cli.js:226107).
- Critic A applied 0001–0005 to an empty local D1 with `wrangler d1 migrations apply --local`
  and with `applyD1Migrations`; both succeed, including FTS5 and triggers.

## Decision
Option 3. Idempotency: every `CREATE` uses `IF NOT EXISTS`; `0005`'s rank `INSERT` is a config
write and safe to repeat; the ALTERs in `0003` rely on tracking. A CI job rebuilds from empty
and diffs a normalised pragma snapshot against the captured remote one.

Remote bootstrap happens in Phase 1, immediately before `0006` is applied: time-travel bookmark,
then one `d1 execute --remote` with wrangler's exact DDL plus
`INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0001_init.sql'),…,('0005_rank.sql')`.

If `apply --remote` is ever run before the bootstrap: 0001/0002 no-op and are recorded, 0003
fails with `duplicate column name: ng`. Recovery: insert rows for 0003–0005 and re-run.

## Dissent
None.
