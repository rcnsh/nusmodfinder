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
candidate depth of each retriever. Queries over 200 characters are rejected.

### How a search is answered

1. If `q` looks like a module code and that module exists, it is pinned to position 1.
2. The query is embedded with `@cf/baai/bge-small-en-v1.5` (384 dims) and scored by exact
   cosine against every corpus vector, held **in the Worker** (below), after a mask for the
   structured filters. The top 50 are kept, by score, then code.
3. The same query runs against a D1 FTS5 index (`bm25(modules_fts, 0, 3, 1)`, porter
   stemming, stopwords removed), with the same filters applied in SQL.
4. The two ranked lists are combined by reciprocal-rank fusion, `1/(60 + rank)`.
5. Surviving codes are hydrated from D1 in a single `WHERE code IN (...)`.

Semesters are stored in Vectorize as four booleans (`sem1`..`sem4`) rather than an array,
because Vectorize metadata indexes only support string, number and boolean.

**The vectors bundle** (Phase 3 3-0, ADR 0006). Every corpus vector, L2-normalised float32,
plus a 32-byte filter row per module (semesters, level, credits, faculty, NG; slots reserved
for 3B's prefix id, 3F's group id and 3H's fields), is one binary file
(`src/vector-bundle.js` documents the layout). The Worker imports it as a `Data` module
through the wrangler `alias` `vectors-bundle`, and parses it on its first dense search. That
costs no I/O per request and no Vectorize query, and the vectors deploy and roll back with
the code that reads them. The bundles:

| bundle | what | where |
|---|---|---|
| fixture | the ~400 test modules, fake embedder (632 KB) | `test/fixtures/vectors.bin`, committed; the alias's default, so `npm test`, `wrangler dev` and a fresh checkout build against it |
| pinned | the 6,771 pinned modules, the eval's default corpus vectors (`emb-bge-small-v1` since 3A-2; 10.7 MB) | release asset, sha256 in `data/vectors.json`; `test/full` and the `full-corpus` CI job (`node scripts/vectors.mjs fetch --corpus pinned`) |
| production | what D1 holds (6,778 at the 3-0 cutover) | release asset, sha256 in `data/vectors.json`; only `npm run deploy` uses it, and it refuses the other two |

`scripts/vectors.mjs` builds all three. It looks each module's vector up in the eval's corpus
asset by `embeddingKey(model, text)`, so codes that share a text share one vector, and
production gets the replica's bits for every text the two share. Texts the asset lacks are
embedded once (`npm run eval:embed -- --texts`, logged in `neurons.tsv`). The manifest records
each bundle's data version, row count, sha256 and `rowsKey`, the sha256 of its sorted
(code, `text_hash`) pairs.

**Vectorize is the standby.** `DENSE_BACKEND=vectorize` (a wrangler var, flipped by a
deploy) sends the dense half back to Vectorize, with the same filters. That is degraded
service, kept identical to the bundle by runbook step 8 below.

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
npx wrangler d1 create nusmods-apac --location apac   # APAC primary (ADR 0005)
npx wrangler vectorize create nusmods-modules --dimensions=384 --metric=cosine
```

The schema lives only in `migrations/` (`0001_init.sql` onwards); there is no separate
`schema.sql`. `wrangler d1 migrations apply` records what it ran in a `d1_migrations`
table. The production database `nusmods-apac` (APAC primary, ADR 0005) was created empty and built
with `npx wrangler d1 migrations apply nusmods-apac --remote`, so its `d1_migrations` table is
complete. A local database needs no
bootstrap: `npx wrangler d1 migrations apply nusmods-apac --local`.

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

This is the only supported way to deploy. `scripts/deploy.mjs`:

1. refuses unless the working tree is clean and `HEAD` is already on `origin/main`;
2. takes the production bundle `data/vectors.json` records (downloaded from its release if
   absent), checks its sha256, and refuses the fixture or pinned bundle, or a data version that
   is not `src/data-version.json`;
3. **the guard**: reads D1's (code, `text_hash`, `row_hash`) through `/admin/hashes` on a
   local `wrangler dev --remote` session with a one-off secret (~6.8k rows read; log it in
   `remote-ops.md`), and refuses unless they hash to the manifest's `rowsKey` and the committed
   data version. No production secret is ever bound;
4. runs `wrangler check startup` locally with the bundle aliased in, then
   `wrangler versions upload --tag <short sha> --message "<sha> <subject>"`, and refuses to
   promote a version whose reported startup time is missing or over 200 ms;
5. only then `wrangler versions deploy <id>@100%`. Record the version id in `remote-ops.md`;
   it is the rollback target (`wrangler rollback <id>`).

Plain `npx wrangler deploy` would ship the fixture bundle. Don't use it.

To check what's live: every response carries `x-app-version` (the tag, else the version
id), and `GET /health` returns `{ ok, versionId, versionTag, dataVersion, vectors }` without
touching D1. `vectors` is the bundle's `{ corpus, count, dataVersion }`, so after a deploy it
must say `production`.

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
3 s. In hybrid mode, if embedding or the dense index fails (a bundle that doesn't parse is
`source: "dense-index"`; Vectorize under the standby flip), `/search` answers with
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

**Runbook** (Phase 3 3-0, `docs/plans/phase3.md` §2). The same order for every corpus change: a
catalogue update, a re-embedding, a row-only change. The deploy guard refuses any commit whose
manifest D1 does not yet hold, so the manifest merges first and D1 is written before the deploy.
Vectorize, the standby, is written last.

```bash
# 1. Offline, on a branch: the production bundle and the data version D1 will have.
node scripts/vectors.mjs data-version --offline                   # what ingest would write
node scripts/vectors.mjs build --corpus production --expect-count <rows> --offline
#    If texts are missing from the eval asset, it writes .data/vectors/missing-production.json
#    and stops; embed them (neurons logged), then rebuild with --extra:
npm run eval:embed -- --texts .data/vectors/missing-production.json --out .data/vectors/extra-production.json
node scripts/vectors.mjs build --corpus production --expect-count <rows> --offline --extra .data/vectors/extra-production.json
gh release create <release> .data/vectors/<asset> --title <asset> --notes "vectors bundle, sha256 <sha256>"
git add data/vectors.json src/data-version.json data/vocabulary.json data/groups.json   # the build rewrites 3C's vocabulary and 3F's groups too; plus any code the change needs; open a PR
# 2. Merge it. Nothing deploys yet: the guard refuses until D1 matches.
# 3. Record a D1 Time Travel bookmark in remote-ops.md.
export INGEST_SECRET=$(openssl rand -hex 24)
echo "INGEST_SECRET=$INGEST_SECRET" > .dev.vars     # gitignored
npx wrangler dev --remote --port 8787 &             # binds the real D1/Vectorize/AI
# 4. D1 only: no Workers AI, no Vectorize. Refuses unless the corpus hashes to the committed data version.
npm run ingest -- --year 2026-2027 --url http://localhost:8787 --d1-only --offline
# 5. D1 against the manifest and the bundle, before the deploy. Reads no Vectorize.
npm run verify -- --url http://localhost:8787 --pre-deploy
# 6. Guard, startup gate, promote. The guard starts its own dev session, on a free port.
npm run deploy
# 7. Smoke (≤ 4 calls): /health says vectors.corpus "production"; read CPUTimeMs in Workers Logs.
#    On failure: wrangler rollback <previous id>, restore D1 to the step-3 bookmark, revert step 2.
# 8. The standby: upsert every code (bundle values, D1 metadata, ≤ 1,000 a batch), delete
#    every index id D1 no longer holds, wait for the mutation, then verify, values included.
node scripts/vectors.mjs standby --url http://localhost:8787
```

Log every remote D1 operation, reads included, in `remote-ops.md`. Between steps 4 and 6 the
live Worker searches its old bundle against the new D1, so `/search` re-checks every dense-only
candidate's filters against its fresh D1 row after hydrate and drops those that fail.

`npm run ingest` without `--d1-only` still embeds and upserts as described below, for a
database with no bundle to match (a local one, or a cold load).

Before any remote write, estimate it and check the month's account-wide D1 usage
(`docs/decisions/0004-workers-paid-and-single-judge.md`): proceed only if the estimate × 1.5
fits in the remaining included writes.

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
saved in `.data/ingest-state.json` (git-ignored, per `--url`) as it is sent, with the
Worker's `Date.now()` when Vectorize accepted it (`sentAt`), and cleared only once a wait
confirms it. The wait is satisfied when `processedUpToMutation` is that id, or when
`processedUpToDatetime` is later than `sentAt`: Vectorize processes mutations in order, so a
later one being processed covers it, even when another client (another `--url` to the
same index) mutated the index since and the id never matches again. Both times come from
Cloudflare's clock. The time check never counts one of the run's own earlier mutations (nor
those of a pending mutation it carried over; they are saved with it as `earlier`): the docs do
not say whether `processedUpToDatetime` is when a mutation was accepted or when it was
processed, and in the second reading an earlier batch would pass while the last is still
queued. If a mutating request was retried after a 5xx or a dropped connection, its first
attempt may have queued a mutation whose id never came back, so that run (and any rerun
carrying its entry over) waits by id only (`sentAt` saved as null). A rerun after exit 3 has nothing to send but still waits for that
mutation, and writes `src/data-version.json` only once it is confirmed. If the state file
cannot be written mid-run, the run carries on but ends with exit 1, naming the mutation ids
it could not record, and does not write `src/data-version.json`.

**If a rerun keeps exiting 3.** An entry saved by a Worker older than this script has no
`sentAt`, so only the exact id ends its wait. Check `npx wrangler vectorize info
nusmods-modules`. Once `processedUpToMutation` is the id in `.data/ingest-state.json`, or
`processedUpToDatetime` is later than the time that run ended (its last mutation was sent
before then), delete that URL's entry (or the
whole file, if it holds no other) and rerun the same command. It then has nothing to wait
for and writes `src/data-version.json`. Run `npm run verify` after.

**One run at a time.** A run holds `.data/ingest-state.json.lock` (created exclusively,
holding its pid and a nonce) until it exits. The first Ctrl-C (SIGINT) or SIGTERM stops the
run after the requests in flight, records their mutation ids, releases the lock and exits
130/143; the rerun waits for those mutations. A second signal stops it at once (a mutation
in flight may then go unrecorded: run `npm run verify` after the rerun). A second `npm run ingest` from
the same checkout refuses with exit 1 and names the pid. If no ingest is running (a run that
crashed or was `kill -9`ed leaves the lock behind; the message says whether the pid is alive,
but pids are reused), delete the lock file and rerun. A run only removes a lock carrying its
own nonce.

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
estimate includes the FTS5 shadow-table writes for inserted rows and rows whose code, title
or description change, which local D1 does not report and remote D1 may bill. Which rows
those are is decided by `ftsHash`, a hash of those three columns (the ones the 0006 FTS
update trigger watches) that `/admin/hashes` computes from what D1 stores. It is not decided
by `text_hash`, which also changes with the model or the embedded-text version. Before a
batch would pass the budget, the run stops cleanly (exit 2) and prints how to resume. Rerun
the same command: the hash skip sends only what is still pending. A stopped `--force` run
resumes with `--from <code>`.

The planned first run against production (rows written by main: `text_hash` in main's
`hashOf(text)` format, `row_hash` NULL, titles and descriptions unchanged) re-embeds and
rewrites all 6,771 modules with no FTS writes. Locally it reads 35,102 rows, D1 reports
34,381 written, and the budget charges **37,251**, so it finishes in one run. That figure is
from the `productionStart` step of `test/full/ingest.test.js`, which rebuilds that state in
local D1 ([`ingest-cost.md`](docs/evidence/phase1/ingest-cost.md) "Remote estimate"). A
forced re-ingest of rows this script wrote costs the same.

**Do not cold-load the remote database with the default budget.** Loading an empty
database writes ~48k table and index rows plus ~89k FTS5 shadow rows, about 137k in all.
That fits the Workers Paid allowance (50M a month, ADR 0004), but the budget charges ~149k
and stops a run at the 40k default, so pass `--write-budget` explicitly. The remote billing of
FTS writes on inserts has not been measured
([`ingest-cost.md`](docs/evidence/phase1/ingest-cost.md)).

**Download cache.** Downloads live in `.data/cache/`, never in `.data/` itself:
`.data/2026-2027-moduleInfo.json` is the pinned snapshot that the eval and the full-corpus tests
read and hash-check (`scripts/pinned-corpus.mjs`), and a fetch must not overwrite it. To
ingest the pinned snapshot itself, copy it into `.data/cache/` without a sidecar and pass
`--offline`. Cache entries keep NUSMods' `ETag`, `Last-Modified` and the body's
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

**Since 3-0, Vectorize is off the search path, so the binding limit is Workers CPU or Workers AI
neurons, not Vectorize queried dimensions.** Before 3-0 every uncached search queried 384
dimensions, billed as (queries + stored vectors) × 384 against 50,000,000 a month:
50,000,000 / 384 − 6,771 ≈ **123,400 uncached searches a month**, about 4,100 a day
(FINDINGS B9). The account is on **Workers Paid** ($5/month, ADR 0004). Going over an included allowance there is
billed, not refused, and this project stays inside them.

| | Workers Paid, included | cost here |
|---|---|---|
| D1 rows read | 25,000,000,000 / month | per search: unfiltered 137–239 (median 239), filtered 249–1,784 (median 497), measured on 36 production searches with SC7 ([`sc7.md`](docs/evidence/phase1/sc7.md); local grid: [`lexical-cost.md`](docs/evidence/phase1/lexical-cost.md)); 1 per page load; ~6.8k per deploy (the guard) and per standby refresh |
| D1 rows written | 50,000,000 / month | 34,383 per forced full re-ingest, measured against production on 2026-11-04 ([`remote-ops.md`](docs/evidence/phase1/remote-ops.md)); a rerun with nothing changed writes 2; the standby refresh writes 0 |
| Vectorize stored dims | 10,000,000 | 6,778 × 384 = **2,602,752** (26%), the standby |
| Vectorize queried dims | 50,000,000 / month | **~0 per search** (only under `DENSE_BACKEND=vectorize`); the stored term, ~2.6M, still counts once a month |
| **Workers CPU** | **30,000,000 ms / month** | live, version `343ea371`: **p50 9.1 ms, p75 15.5 ms** CPU per request (first 18 requests after the cutover, `/health` included), 33–34 ms on a fresh isolate's first search ([`3-0-cutover.md`](docs/evidence/phase3/3-0-cutover.md)); the exact search alone is 1.44 ms locally and 3.4 ms on a CI runner ([`3-0.md`](docs/evidence/phase3/3-0.md)) |
| Workers AI | 10,000 neurons / day | ~0.03 per search; ~2,400 per forced re-ingest (measured); a bundle build embeds only texts the eval asset lacks (~54 for the 3-0 cutover, est.) |
| CPU per request | 30 s | as above |

The arithmetic. **CPU is the smaller limit.** At the measured ~12 ms of CPU a request, 30M
CPU-ms cover **~2.5M searches a month**, about 20 times the old Vectorize-bound ~123,400.
Workers AI's 10,000 neurons a day at ~0.03 a search cover ~10M a month, or ~6.0M at 3A-1's
~0.05. At 2.5M searches a month, D1's 25 billion reads cover ~10,000 rows read per search. The measured medians (239–497) are well inside that; the worst filtered search on the
local grid (7,772 rows) is not. Cached repeats cost none of these.

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
   `src/data-version.json` and the deployed version's id (`CF_VERSION_METADATA.id`), so
   every deploy (a ranker change, new vectors, a `DENSE_BACKEND` flip) starts a fresh
   cache. A parameter added later joins the key in parsed form, in the PR that adds it:
   3H adds `exam`, `su`, `hoursBelow` and `prereq`, and `ignore` as a sorted list. A repeated search — a shared link, a reload, an evaluation run — costs zero D1
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

- **One acad year.** Two years would fit the Paid stored-dimension allowance (5.2M of 10M)
  but halve the uncached searches the queried-dimension allowance covers.
- **The exchange-student list is a manual snapshot.** It comes from a PDF that must be
  downloaded by hand (NUS blocks automated fetching) and re-extracted when NUS updates it.
  The UI shows the extract's date so staleness is visible.
- **No natural-language constraint parsing.** "No Friday classes" needs the explicit filter
  parameters instead.
- **No scheduled re-ingest.** Refresh is a manual command, once a semester.
- **The vector half is unproven.** See EVAL.md.
