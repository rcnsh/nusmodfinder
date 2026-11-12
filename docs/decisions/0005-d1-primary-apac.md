# 0005: The D1 primary is in APAC, with read replication on

Status: accepted.

## Context
The users, incoming NUS exchange students, are in or heading to Singapore, and a low-traffic site
is idle most of the time. A database with a Western Europe primary served idle searches from the
primary, not a nearby replica, even with read replication on: FTS took 520–715 ms and hydrate
200–250 ms. Warm searches read from an APAC replica in 10–42 ms. So the first search a visitor
made was usually the slow one.

D1 fixes a database's primary location when the database is created (Cloudflare docs, "Data
location"); the only way to an APAC primary is a new database.

## Decision
- **Production D1 is `nusmods-apac`** (`de4527ff-19ec-4a5b-9c5c-4d1791078b25`), created with
  `--location apac` and built with `wrangler d1 migrations apply --remote` (a fresh database
  needs no bootstrap, ADR 0001). The old Western Europe database is deleted.
- **Read replication is on** (`read_replication.mode = auto`), and the Worker reads through
  `withSession('first-unconstrained')`, so a warm search can read from any replica.
  `served_by_region` and `served_by_primary` in the `search` log line show which answered.

## Consequences
- Worker versions bound to the deleted database can't serve; no rollback target predates the
  Worker's current name anyway (ADR 0009).
- Moving the primary again means a new database, a cold load through the ingest pipeline and a
  binding change in `wrangler.jsonc`.
- Warm-search latency is set by the embedding call and the dense half; ADR 0006 moved the dense
  half into the Worker for that reason.
