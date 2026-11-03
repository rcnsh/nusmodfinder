# vector-nusmods

Semantic + keyword search over NUS course modules, on Cloudflare Workers, Vectorize and D1.

**Live:** https://vector-nusmods.jacobjameswiltshire.workers.dev

Type what you want to study — `machine learning for beginners`, `i want to understand
climate change`, `how do i start my own company` — or a module code like `CS3244`, and
filter by semester, level, credits and faculty.

> **Read [EVAL.md](EVAL.md) before trusting the ranking.** The retrieval quality was
> measured against a BM25 keyword baseline rather than assumed, and the honest result is
> more equivocal than the demo looks. In particular, the lexical half of the retriever
> accounts for essentially all of the measured improvement; the vector half does not
> currently earn its keep on recall.

## What it does

| Route | Purpose |
|---|---|
| `GET /` | Single-page UI, no framework, no build step |
| `GET /search?q=&sem=&level=&credits=&faculty=&ng=&topK=&mode=` | Ranked results as JSON |
| `GET /module/:code` | The full D1 row for one module |
| `GET /facets` | Distinct faculties and levels, with counts, for the filter UI |

`ng=1` narrows to courses open to **Non-Graduating (exchange) students**. Only `true`
narrows — `ng=0` is ignored, because "show me courses I am not allowed to take" is not a
thing anyone wants.

`mode` is `hybrid` (default), `vector` or `lexical`. It exists so the evaluation harness
can measure each retriever on its own — which is the only reason we know the vector half
is not pulling its weight.

`/search` returns at most 20 results by default; `topK` may raise that to 50, the
Vectorize ceiling when metadata is returned. Queries over 200 characters are rejected.

### How a search is answered

1. If `q` looks like a module code and that module exists, it is pinned to position 1.
2. The query is embedded with `@cf/baai/bge-small-en-v1.5` (384 dims) and used to query
   Vectorize, with the structured filters applied as a metadata filter.
3. The same query runs against a D1 FTS5 index (`bm25(modules_fts, 0, 3, 1)`, porter
   stemming, stopwords removed), with the same filters applied in SQL.
4. The two ranked lists are combined by reciprocal-rank fusion, `1/(60 + rank)`.
5. Surviving codes are hydrated from D1 in a single `WHERE code IN (...)`.

Semesters are stored in Vectorize as four booleans (`sem1`..`sem4`) rather than an array,
because Vectorize metadata indexes only support string, number and boolean.

### Exchange-student (Non-Graduating) availability

This is **not in the NUSMods API**. NUS publishes it as a PDF from the Registrar, behind
bot protection that blocks programmatic fetching. So the workflow is:

1. Download `ng-courses.pdf` by hand from the
   [NUS Non-Graduating page](https://www.nus.edu.sg/registrar/prospective-students/non-graduating).
2. Extract it into a committed JSON artifact:

```bash
python3 -m venv .venv && .venv/bin/pip install pypdf
.venv/bin/python scripts/extract-ng.py ~/Downloads/ng-courses.pdf
```

That writes `data/ng-courses-<acadYear>.json`. The ingest script picks it up
automatically and sets `modules.ng` plus the `ng` Vectorize metadata property. If the file
is missing, ingest says so loudly and every module is marked not-NG.

**Cross-checked against the corpus** for AY2026/2027: of 1,207 course codes in the PDF,
**1,175 (97.3%)** exist in the NUSMods corpus — the other 32 are not offered this year.
Where both sources state a semester they agree on **1,411 of 1,447 (97.5%)**; the ~2.5%
disagreement is a snapshot-vs-daily-scrape artifact.

**Caveat on combining filters.** `ng` is a single boolean, not per-semester, so
`?ng=1&sem=1` means "open to NG students *this year*, and offered in semester 1" rather
than "open to NG students *in semester 1*". Those differ for the ~2.5% of rows above.
Per-semester NG flags would need two more Vectorize metadata indexes; there are 8 of the
maximum 10 in use, and spending two more for a 2.5% correction was not worth the
headroom. Per-semester detail *is* stored in D1 (`modules.ng_semesters`) and is returned
on every result, so the UI shows it in the NG badge tooltip.

The extract's `updatedAsAt` date reaches `/facets` (and so the UI) through ingest: the
ingest script posts it to `/admin/facets`, which stores it as `meta.ng_list`. Re-run
ingest after regenerating the extract; there is no copy of the date to bump by hand.

## Setup

```bash
npm install
npx wrangler login
```

Resources (already created for this deployment; do not re-run these against it):

```bash
npx wrangler d1 create nusmods
npx wrangler vectorize create nusmods-modules --dimensions=384 --metric=cosine
```

The schema lives only in `migrations/` (`0001_init.sql` onwards); there is no separate
`schema.sql`. `wrangler d1 migrations apply` records what it ran in a `d1_migrations`
table. The existing production database was built by hand before that tracking existed,
so **do not run `migrations apply --remote` or `migrations list --remote` against it**
(both write `d1_migrations`) until it has been bootstrapped as described in
[ADR 0001](docs/decisions/0001-migrations-and-remote-bootstrap.md). For a brand-new
database the schema step is `npx wrangler d1 migrations apply <name> --remote`; a local
database needs no bootstrap: `npx wrangler d1 migrations apply nusmods --local`.

Then the eight filterable metadata indexes — **these cannot be added retroactively**, so
they must exist before any vector is written:

```bash
for spec in sem1:boolean sem2:boolean sem3:boolean sem4:boolean level:number credits:number faculty:string ng:boolean; do
  npx wrangler vectorize create-metadata-index nusmods-modules --property-name="${spec%%:*}" --type="${spec##*:}"
done
```

Adding a ninth filterable property later means **recreating the index and re-ingesting**.
Vectorize allows at most 10 metadata indexes, and only the first 64 bytes of a string
property are filterable.

## Deploying

```bash
npm run deploy
```

This is the only supported way to deploy. `scripts/deploy.mjs` refuses unless the working
tree is clean and `HEAD` is already on `origin/main`, then runs
`wrangler deploy --tag <short sha> --message "<sha> <subject>"` and prints the new version
id. Plain `npx wrangler deploy` still works, but the version it creates carries no commit,
so nobody can tell later what it was built from.

To check what's live: every response carries `x-app-version` (the tag, else the version
id), and `GET /health` returns `{ ok, versionId, versionTag }` without touching D1.

**Instrumentation.** `/search`, `/module/:code` and `/facets` responses carry a
`Server-Timing` header. `/search` has spans `cache` (`desc=hit|miss`), `limit`, `pin`,
`embed`, `vector`, `fts` and `hydrate` for the stages that ran (pin, `fts` and
`embed`→`vector` run concurrently; the header keeps that order), `degraded`
(`desc=<source>-<reason>`) on a keyword-only fallback, plus `total` from fetch entry. `/module` and `/facets` have `d1` and `total`. workerd's clock only advances across
I/O, so the spans measure waiting on bindings, not CPU. A cache hit gets fresh spans,
never the stored ones. Each `/search` also writes one JSON log line (`"event":"search"`)
with the status, cache result, the query (first 100 characters) and its length, the mode,
filters, result counts, the fallback (`degraded`), spans, D1 rows read and serving region
(`d1.servedByRegion`, `d1.servedByPrimary`), and the colo. Headers and IPs are never logged.

**Failure behaviour.** Workers AI and Vectorize calls time out after 1.5 s, D1 calls after
3 s. In hybrid mode, if embedding or Vectorize fails or times out, `/search` answers with
the keyword results alone and says so: `"degraded": { "source", "reason" }` in the body,
cached for 60 s instead of an hour. After 3 consecutive dense failures an isolate skips
the dense half for 30 s (`reason: "circuit-open"`). `mode=vector` still answers 502, and
a D1 failure is still a 502. Anything unhandled is a JSON 500 with a `requestId` (the
`cf-ray`) that matches the `"event":"unhandled"` log line.

## Re-ingesting for a new acad year

Ingest is a local Node script by design: `moduleInfo.json` is ~19 MB and parsing it
inside a Worker would crowd the 128 MB memory ceiling. Embedding and upserting happen
*in* the Worker, over authenticated admin routes, so no Cloudflare API token has to
exist on disk.

**Runbook** (ingest → verify → commit `src/data-version.json` → deploy):

```bash
export INGEST_SECRET=$(openssl rand -hex 24)
echo "INGEST_SECRET=$INGEST_SECRET" > .dev.vars     # gitignored
npx wrangler dev --remote --port 8787 &             # binds the real D1/Vectorize/AI
npm run ingest -- --year 2026-2027 --url http://localhost:8787
npm run verify -- --url http://localhost:8787       # exits non-zero on drift
git add src/data-version.json && git commit -m "chore(data): data version after ingest"
npm run deploy                                      # new cache key, so no stale /search hits
```

Before any remote write, check the account-wide D1 headroom for the UTC day
(`docs/decisions/0002-phase1-remote-ops.md`): proceed only if the estimate × 1.5 fits.

A run for a different acad year than D1 holds is refused unless you pass
`--allow-year-change` (it rewrites every row to the new year). Pass `--allow-mass-delete`
as well if more than 5% of the codes D1 holds leave the corpus.

**What a run does.** It compares two hashes per module with what D1 holds
(`GET /admin/hashes`): `text_hash` (embedding model + embedded-text version + text) and
`row_hash` (normaliser version + every column D1 stores + the Vectorize metadata).

- Text changed: the module is re-embedded, then the vector and the row are upserted.
- Only the row changed: the row is rewritten, and the vector is re-upserted with its
  stored values under the new metadata. There is no new embedding, unless the stored
  vector's `metadata.textHash` is not the module's `text_hash` (a vector written before
  `textHash` was stored, or one Vectorize has not yet replaced with a newer embedding).
  Then the module is re-embedded, so old values never overwrite a pending new embedding.
- Unchanged: skipped. A rerun with nothing changed writes nothing but the facets row.
- Codes D1 holds that the corpus no longer offers are deleted through `/admin/delete`:
  their hashes are cleared in D1, then Vectorize deletes the vectors, then D1 deletes the
  rows. If the D1 delete fails and the module comes back, its cleared hash makes ingest
  re-embed it. Deletes run last, and only if every upsert batch succeeded.

The run then rebuilds the facets row and waits, by polling `describe()`, until Vectorize
has processed its last mutation. Only then does it write `src/data-version.json`, the
`/search` cache-key version (a hash of every code and row hash). Every mutation id is
saved in `.data/ingest-state.json` (git-ignored, per `--url`) as it is sent, and cleared
only once a wait confirms it. A rerun after exit 3 has nothing to send but still waits for
that id, and writes `src/data-version.json` only once it is confirmed.

**Guards.** Each one stops the run before it writes anything:

- the database lacks migration 0006: the schema marker, the external-content FTS table,
  any of its four triggers (`modules_fts_insert`, `_delete`, `_update`,
  `modules_rowid_immutable`) or `row_hash`. Rewriting rows through the old FTS triggers
  reads ~46M rows (FINDINGS B3), and a missing trigger lets the FTS index drift;
- the plan would delete more than 5% of the codes D1 holds, whatever the corpus size
  (pass `--allow-mass-delete` if the drop is real);
- the corpus is for another acad year than most of D1's rows (pass `--allow-year-change`).
  An empty database has no year;
- the corpus mixes acad years or repeats a code;
- the Worker embeds with a different model than `text_hash` assumes.

**Write budget.** `--write-budget` (default 40,000 D1 rows, ADR 0002) charges each admin
call the larger of the `meta.rows_written` it reports and an estimate per module. The
estimate includes the FTS5 shadow-table writes for inserted or text-changed rows, which
local D1 does not report and remote D1 may bill. Before a batch would pass the budget, the run
stops cleanly (exit 2) and prints how to resume. Rerun the same command: the hash skip
sends only what is still pending. A stopped `--force` run resumes with `--from <code>`.
A forced full re-ingest of existing rows costs ~35k rows read and ~34.4k written, with
no FTS writes, and is charged ~37k.

**Do not cold-load the remote database with the default budget.** Loading an empty
database writes ~48k table and index rows plus ~89k FTS5 shadow rows, about 137k in all.
That is over the 100k/day account cap, and the remote billing of FTS writes has not been
measured. The budget charges ~149k for it and would stop a run at 40k, but until remote
metering of FTS writes is measured, the charged figure is only an estimate. Rebuild
production from empty only after measuring it, spread over several UTC days
([`ingest-cost.md`](docs/evidence/phase1/ingest-cost.md)).

**Download cache.** `.data/` entries keep NUSMods' `ETag`, `Last-Modified` and the body's
sha256 in a `<file>.cache.json` sidecar. An entry older than `--max-age` (default `24h`)
is revalidated with `If-None-Match`; `--offline` uses the cache as it is and never fetches.
A body that does not match its recorded sha256 is never served or revalidated. It is
downloaded again in full, and `--offline` refuses it.

Other flags: `--force` (re-embed and rewrite everything), `--batch`, `--concurrency` and
`--wait-timeout` (default `10m`). Exit codes: 0 done, 1 refused or failed, 2 stopped by
the budget, 3 Vectorize did not confirm the last mutation in time (D1 is complete; rerun
the same command later, then verify).

**The admin routes do not exist in production.** `/admin/*` returns 404 unless an
`INGEST_SECRET` is bound, and the deployed Worker has none. Ingest is run locally against
`wrangler dev --remote`. Do not `wrangler secret put INGEST_SECRET` unless you intend to
expose a write endpoint on the public URL.

## Evaluation

The eval runs the actual Worker inside workerd (local D1 with the full pinned corpus, a fake
Vectorize holding real `bge-small-en-v1.5` corpus embeddings, a fake AI returning precomputed
query embeddings) and scores it against blind judgments with nDCG@10, P@5 and MRR, paired
bootstrap CIs and a pre-committed ship gate. No live traffic, no Cloudflare calls at run time.

```bash
npm run eval -- --variant v0 --ref eval-v0        # the baseline ranker, dev set
npm run eval -- --variant head --baseline v0      # the working tree vs v0, with gate verdict
npm run eval:report -- --run head --baseline v0   # recompute metrics from run files only
npm run test:eval                                 # harness self-test on the fixture set (CI)
```

Details, file formats and holdout custody: [`eval/README.md`](eval/README.md). The v1 eval
(regex relevance, recall@10) is kept for history in [`eval/v1/`](eval/v1/); `EVAL.md` still
describes it.

## Cost

**Vectorize queried dimensions are the binding limit, not D1.** An earlier version of
this README said the opposite; its own numbers did not support it (FINDINGS B9).

| | Workers Free | cost here |
|---|---|---|
| **D1 rows read** | **5,000,000 / day** (enforced since 1 Sep 2026) | per search: pending: measured after the Phase 1 deploy (local grid: [`lexical-cost.md`](docs/evidence/phase1/lexical-cost.md)); 1 per page load |
| D1 rows written | 100,000 / day | ~34,400 per forced full re-ingest (and ~35,100 read), measured locally ([`ingest-cost.md`](docs/evidence/phase1/ingest-cost.md)); a rerun with nothing changed writes 2 |
| Vectorize stored dims | 5,000,000 | 6,771 × 384 = **2,600,064** (52%) |
| Vectorize queried dims | 30,000,000 / month | ~71,354 searches/month (below) |

The arithmetic. Vectorize bills a query as (stored vectors + 1) × 384 dimensions against
30,000,000 a month: 30,000,000 / 384 − 6,771 ≈ **71,354 uncached searches a month**,
about 2,378 a day. D1 allows 5,000,000 rows read a day: at the ~50 rows per search measured in
Phase 0, 5,000,000 / 50 ≈ 100,000 searches a day, about 3,000,000 a month, about 42× more
than Vectorize allows. D1 would bind first only if uncached searches averaged more than
5,000,000 / 2,378 ≈ 2,100 rows read. Unfiltered searches stay far below that, but filtered
ones cost more since Phase 1 made them exact (FINDINGS B1): on the local test grid, which
leans on broad queries, single-filter searches averaged 2,160 rows and the worst read 7,772.
So the traffic mix decides, and the per-search numbers measured after the Phase 1 deploy
replace these local ones. Cached repeats cost neither.

### How that number was brought down

The first version of this app burned its entire daily D1 allowance in one afternoon of
load testing. Three fixes, each measured with the `meta.rows_read` field D1 returns:

1. **`ORDER BY bm25(...)` → `ORDER BY rank`.** This is the big one, and it is a one-word
   change. Both give identical ordering — the table's persistent rank config is
   `bm25(0.0, 3.0, 1.0)` (`migrations/0005_rank.sql`) — but calling `bm25()` as a SQL
   function makes FTS5 materialise and score **every matching row**, while the `rank`
   column uses its internal top-N path. On a query matching 224 documents:
   **389 rows read → 7.**
2. **`/facets` was three full-table aggregates on every page load** — 1,364 + 7,303 +
   1,175 = **9,842 rows read** to produce ~35 rows of output. Now one precomputed JSON row
   in the `meta` table, rebuilt at the end of ingest. **9,842 → 1.**
3. **`/search` responses are cached** (Workers Cache API, 1 hour). The key is built from
   the validated parameters only — query trimmed, whitespace collapsed and lower-cased,
   parameters sorted, defaults and unknown parameters dropped — plus the data version in
   `src/data-version.json`, so a deploy after an ingest that bumps it starts a fresh
   cache. A repeated search — a shared link, a reload, an evaluation run — costs zero D1
   rows, zero Vectorize queries and zero Workers AI calls, however it is spelled.

The join to `modules` is also skipped unless a filter needs a column from it.

An interim fix that made the FTS query `AND`-first instead of `OR` was **reverted** once
`ORDER BY rank` removed the cost pressure: it would have changed retrieval behaviour, and
the evaluation in EVAL.md measured the `OR` version.

**If you blow the limit anyway**, every D1 query fails until midnight UTC and the Worker
returns HTTP 502 with the upstream message. It does not silently return empty results
(R7). The fix is to wait, or move to the Workers Paid plan ($5/month), where the first
25 billion rows/month are included.

**The caveat:** the Vectorize and D1 allowances are per *account*, not per project.
Another project on the same account can consume them. The `/search` rate limit (20 per
10s per IP) is a burst guard — per-colo and eventually consistent — and does not protect
the daily account-wide budget.

## Data source

[NUSMods API](https://api.nusmods.com/v2/) — statically generated JSON, scraped daily from
NUS's own systems. It is **community-maintained and unofficial; NUS does not run it.** The
ingest script validates that the expected keys are present and aborts rather than writing
malformed rows if the shape changes.

Only modules with at least one `semesterData` entry are indexed — 6,771 of the 21,130
records in `moduleInfo.json`. The rest are catalogue entries not offered this year.

## Known limitations

- **One acad year.** Indexing more would exceed the free stored-dimension cap.
- **The exchange-student list is a manual snapshot.** It comes from a PDF that must be
  downloaded by hand (NUS blocks automated fetching) and re-extracted when NUS updates it.
  The UI shows the extract's date so staleness is visible.
- **No natural-language constraint parsing.** "No Friday classes" needs the explicit filter
  parameters instead.
- **No scheduled re-ingest.** Refresh is a manual command, once a semester.
- **The vector half is unproven.** See EVAL.md.
