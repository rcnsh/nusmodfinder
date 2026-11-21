# 0021: Ingest and the admin routes write safely within the platform's limits

Status: accepted. The runbook is [docs/data.md](../data.md#re-ingesting).

## Context
Ingest (`scripts/ingest.mjs` over `scripts/ingest-core.mjs`) writes production through the
Worker's admin routes: `/admin/ingest`, `/admin/delete`, `/admin/vectors` and `/admin/catalogue`,
read back through `/admin/hashes`. Each call writes D1 and Vectorize, which share no transaction,
over a network that drops requests, and a run can stop at a budget, a signal or a 5xx and be
rerun. The data comes from NUSMods, which can answer truncated or wrong. And Workers, D1 and
Vectorize each set limits that a straightforward version of the code crosses: parameters per
statement, vectors per call, topK, model input, timeouts, cached responses.

## Decision
**Every step is safe to fail or repeat**
- `handleDelete` (`src/ingest.js`) clears `text_hash` and `row_hash` first, then deletes the
  vectors, then the D1 rows. If a later step fails, the cleared hash makes ingest re-embed the
  module should it return, and the surviving row makes the next plan delete it again. Deleting from
  D1 first would orphan the vector, which no plan built from D1's codes can see.
- `handleVectors` (POST `/admin/vectors`) takes vector values from `scripts/vectors.mjs`, read from
  the sha-checked bundle asset, never from the Worker's own bundle (the fixture, in a dev session).
  It builds each vector's metadata from its D1 row (`storedVectorMetadata`), so an upsert never
  wipes the filter properties, and refuses upserts for ids D1 doesn't hold and deletes for codes
  D1 still holds.
- `row_hash` vouches for a row only while it describes the row. `UPSERT_SET` (`src/rowhash.js`) is
  derived from `ROW_COLUMNS` (every column but `code`, plus `row_hash`), so the upsert overwrites
  every column it binds; a hand-written SET list could leave a new column at its old value under a
  fresh hash. `NORMALISER_VERSION` is part of the hash: bump it whenever `normalise()`
  (`scripts/lib.mjs`) changes what it derives from a NUSMods record without changing the derived
  values' shape, so the next ingest rewrites every row once; without the bump the hash skip keeps
  rows the old normaliser wrote. `/admin/hashes` and GET `/admin/catalogue` answer a row's hash only
  when the stored `row_hash` matches its columns, so a row changed behind it is rewritten by the
  next run.
- `schemaStatus` (`src/admin-hashes.js`) reads a `no such table` error as a database older than
  migration 0004, so not migrated, and rethrows any other (D1 down, a refused REST token).
  Reporting those as "not migrated" would make ingest and the deploy guard refuse for a schema
  problem that isn't there.

**Ingest refuses unsafe runs**
- `catalogue_only` has the modules' mass-delete guard (`massDeleteRatio`,
  `scripts/ingest-core.mjs`): a truncated or hostile NUSMods answer would otherwise empty it.
- `scripts/ingest.mjs` writes `src/data-version.json` only after a run that finished.
- `fileStateStore` writes the pending-mutation file through a temp file unique to each write.
  Concurrent writes may overwrite each other (the run lock keeps two ingests apart), but none may
  fail or leave a temp file behind.
- The deletions a D1-only step 4 leaves in `.data/d1-only-deletes.json` are not trusted to be
  complete: a budget stop and resume, a clean rerun or a retried delete all lose codes. The later
  steps (the Vectorize standby) derive the deletions from D1.

**The platform's limits**
- D1 binds at most 100 parameters per statement, so `rowsFor` (`src/ingest.js`) and the
  `code IN (…)` reads in `src/search.js` go in chunks of `D1_PARAMS`.
- One `/admin/vectors` call upserts at most `VECTORS_LIMIT` (1,000) vectors, the binding's limit.
  Vectorize's topK is at most 100 without values or metadata, which is `STANDBY_NG_DEPTH`.
- bge-small reads about 512 tokens, so a no-match answer's `related` text is cut to
  `RELATED_TEXT_CHARS` (2,000).
- D1's `meta.changes` counts the FTS triggers' writes, so `handleDelete` counts deletions with
  `RETURNING code`.
- `withTimeout` (`src/upstream.js`) aborts its signal, which Workers AI honours and D1 and
  Vectorize don't; a timed-out D1 or Vectorize call is abandoned and its result ignored.
- Responses from `caches.default` have immutable headers, so `withHeaders` (`src/http.js`) copies
  the response before setting any.

## Consequences
- A failed or interrupted run is recovered by rerunning the same command; no step needs a manual
  repair of D1 or Vectorize first.
- A change to `normalise()`, to the columns D1 stores or to these limits' call sites has to keep
  the rules above, or the hash skip, the deletes or the chunking go quietly wrong.
