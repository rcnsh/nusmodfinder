# 0005: Move the D1 primary to APAC

Status: accepted (Jacob, 2026-11-04). Amends the brief's "do not delete or recreate the D1
database": Jacob approved a **new** database, and on 2026-11-04 the deletion of the old WEUR
`nusmods` (`c6a769d3-…`) once production ran on the new one. The rollback section below no longer
applies, and Worker versions deployed before `597c2b7` are bound to the deleted database.

## Context
SC7 failed on 2026-11-04 (`docs/evidence/phase1/sc7.md`): the p50 of `total` was 351 ms against
250 ms.
- **Idle searches.** After about 10 minutes without traffic, every search read from the **WEUR
  primary**, not a nearby replica, even with read replication on and a `first-unconstrained`
  session. FTS took 520–715 ms and hydrate 200–250 ms, for a total of about 870 ms.
- **Warm searches** read from an APAC replica (FTS and hydrate 10–42 ms).

The users, incoming NUS exchange students, are in or heading to Singapore, and a low-traffic site
is idle most of the time. So the first search a user makes is usually the slow one.

## Constraint
D1 sets a database's primary location when the database is created and cannot move it (Cloudflare
docs, "Data location"). The only way to an APAC primary is a new database.

## Decision
- **Create** `nusmods-apac` (`de4527ff-19ec-4a5b-9c5c-4d1791078b25`) with `--location apac`. It
  reports `running_in_region: APAC`.
- **Set it up:** apply migrations 0001–0006 with `wrangler d1 migrations apply --remote`. A fresh
  database needs no bootstrap (ADR 0001). Then enable `read_replication.mode = auto`.
- **Load it with the ingest pipeline** against `wrangler dev --remote` bound to the new database.
  - It is a cold load: every module is embedded and upserted in place into the production
    Vectorize index. That is allowed, and the vectors are keyed by code, so the old database stays
    consistent with them.
  - Then verify, and point the `DB` binding at the new database in `wrangler.jsonc`.
- **Keep** the old database `nusmods` (`c6a769d3-…`, WEUR) unchanged as the rollback target. It
  holds the same 2026-11-04 catalogue (data version `c1cf88518972`). It receives no further
  ingests.
- **Rollback:** revert the binding in `wrangler.jsonc` and `npm run deploy`. If an ingest has run
  against the new database since, re-ingest the old one first (the hash skip sends only the
  difference). Then delete the database that is no longer bound, but only once Jacob says so.

## What this does not fix
Warm searches stay about 350 ms. Vectorize (~232 ms) plus the query embedding (~88 ms) set the
warm total, so SC7 needs a second change. The leading candidate is in-Worker exact vector search,
which goes to Phase 3 planning. This ADR only removes the idle-time penalty of reading from
Europe.

## Dissent
None recorded. No critic round was held: this was an ops change with a rollback path, decided by
Jacob.
