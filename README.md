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

After regenerating the extract, bump `NG_LIST_UPDATED` in `src/modules.js` so `/facets` —
and therefore the UI — reports the right date.

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
`embed`, `vector`, `fts` and `hydrate` for the stages that ran, plus `total` from fetch
entry. `/module` and `/facets` have `d1` and `total`. workerd's clock only advances across
I/O, so the spans measure waiting on bindings, not CPU. A cache hit gets fresh spans,
never the stored ones. Each `/search` also writes one JSON log line (`"event":"search"`)
with the status, cache result, the query (first 100 characters) and its length, the mode,
filters, result counts, spans, D1 rows read and serving region, and the colo. Headers and
IPs are never logged.

## Re-ingesting for a new acad year

Ingest is a local Node script by design: `moduleInfo.json` is ~19 MB and parsing it
inside a Worker would crowd the 128 MB memory ceiling. Embedding and upserting happen
*in* the Worker, over an authenticated admin route, so no Cloudflare API token has to
exist on disk.

```bash
export INGEST_SECRET=$(openssl rand -hex 24)
echo "INGEST_SECRET=$INGEST_SECRET" > .dev.vars     # gitignored
npx wrangler dev --remote --port 8787 &             # binds the real D1/Vectorize/AI
npm run ingest -- --year 2026-2027 --url http://localhost:8787
```

The script prints module count, skipped count and vectors upserted. It is **idempotent
and resumable**: each module's embedded text is hashed into `modules.text_hash`, and a
rerun re-embeds only what changed. A full cold ingest of 6,771 modules takes ~75 seconds.

Verify the two stores agree:

```bash
npx wrangler d1 execute nusmods --remote --command "SELECT COUNT(*) FROM modules"
npx wrangler vectorize info nusmods-modules
```

Vectorize applies upserts asynchronously — `vectorCount` lags by a minute or two after a
large ingest before it settles. That is expected, not a failure.

**The admin routes do not exist in production.** `/admin/ingest` and `/admin/hashes`
return 404 unless an `INGEST_SECRET` is bound, and the deployed Worker has none. Ingest is
run locally against `wrangler dev --remote`. Do not `wrangler secret put INGEST_SECRET`
unless you intend to expose a write endpoint on the public URL.

## Evaluation

```bash
npm run eval -- --baseline-only                      # BM25 baseline alone
npm run eval -- --url <worker> --modes vector,lexical,hybrid --json
npm run eval -- --fixture holdout.json --url <worker> --modes vector,lexical,hybrid
```

Two fixtures: `eval/queries.json` (15 queries, used during development, so the retriever
was tuned against it) and `eval/holdout.json` (12 topical queries written after tuning was
frozen). Relevance judgements are generated by `scripts/judge.mjs` from written criteria
applied to the whole corpus, so they are complete and reproducible rather than hand-picked.
`scripts/pool.mjs` builds a blind judging pool from all retrievers for re-judging.

## Cost

**D1 row reads are the binding constraint, not Vectorize.** This was mis-stated in an
earlier version of this README, which quoted only the Vectorize budget and implied
~71,000 searches/month were affordable. They are not, on the free plan.

| | Workers Free | measured cost here |
|---|---|---|
| **D1 rows read** | **5,000,000 / day** (enforced since 1 Sep 2026) | ~50 per search, 1 per page load |
| D1 rows written | 100,000 / day | ~13,600 per full re-ingest |
| Vectorize stored dims | 5,000,000 | 6,771 × 384 = **2,600,064** (52%) |
| Vectorize queried dims | 30,000,000 / month | ~71,000 searches/month |

A search now costs roughly the number of rows it returns (~7 for the FTS half) plus one
hydration query (~40 rows for 20 modules), and a page load costs 1. That is on the order
of **50 rows per search** rather than ~4,000 — call it 100,000+ searches/day against the
5M limit, with repeats served free from cache.

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
3. **`/search` responses are cached** (Workers Cache API, keyed on the full URL, 1 hour).
   A repeated search — a shared link, a reload, an evaluation run — costs zero D1 rows,
   zero Vectorize queries and zero Workers AI calls.

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
