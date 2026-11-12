# Architecture

How the service is put together and how a search is answered. The short version is the
[README](../README.md); the routes are in [api.md](api.md); why each piece is built this way is
in [decisions/](decisions/).

## The pieces

One Cloudflare Worker (`src/index.js` routes; no framework, no build step) with:

| Binding | What it holds |
|---|---|
| `DB` (D1, `nusmods-apac`, APAC primary, read replication on; ADR 0005) | one row per offered module (`modules`), the FTS5 index, catalogue-only rows, the `meta` row behind `/facets` |
| the vectors bundle (a `Data` module, alias `vectors-bundle`) | every corpus vector and a filter row per module: the dense half, searched in the Worker (ADR 0006) |
| `AI` (Workers AI) | `@cf/baai/bge-small-en-v1.5`, 384 dims: one embedding per uncached search |
| `VECTORIZE` (`nusmods-modules`) | the cold standby for the dense half |
| `SEARCH_LIMIT`, `SEARCH_LIMIT_MINUTE` | the per-IP rate limits |
| static assets (`public/`) | the page ([page.md](page.md)) |

Data files ship with the Worker through bare-name aliases (below). Course data comes from
NUSMods, exchange availability from the NUS Registrar; both are loaded by a local ingest script
([data.md](data.md)).

## How a search is answered

`searchRoute` and `runSearch` in [`src/search.js`](../src/search.js), in order:

1. **Refuse cross-site, validate, cache, limit.** Another site's page gets the cross-site 403
   first. A bad parameter is a 400 before any binding is touched. The canonical cache key is
   looked up next, and a hit costs no binding call. Then the two per-IP rate limits, asked
   together.
2. **Parse the query** ([`src/query-intent.js`](../src/query-intent.js)): typed course codes to
   pin (up to 3), partial codes, code prefixes and GE pillars as code ranges, a spelling
   correction against the catalogue's own words ([`src/typo.js`](../src/typo.js),
   [`src/vocabulary.js`](../src/vocabulary.js)), and the no-exam, S/U, workload, prerequisite and
   level phrases as constraints ([`src/intents.js`](../src/intents.js)). The parse picks one of
   three routes.
3. **`no-match`:** a whole query that is one code not offered this year answers `count: 0` with
   its reason (`unknown-code`, `not-offered` or `ng-unscheduled`) and, as `related`, the dense
   neighbours of its catalogue text.
4. **`mask`:** a whole query that is a partial code, a prefix or a GE phrase answers that set's
   members, in exact dense order (code order without the dense half).
5. **`search`:** three lookups start together. The pin lookup in D1. The dense half
   ([`src/dense.js`](../src/dense.js), [`src/vector-bundle.js`](../src/vector-bundle.js)): the
   query is embedded (once more when a word was corrected), then scored by exact cosine against
   every corpus vector held in the Worker, after a mask for the filters and constraints. The
   lexical half ([`src/lexical.js`](../src/lexical.js), [`src/fts-query.js`](../src/fts-query.js)):
   a D1 FTS5 query, `ORDER BY rank` over the table's `bm25(0, 3, 1)`, porter stemming, stopwords
   removed, with the same filters in SQL. A code token adds its prefix's members as a third list.
6. **No signal** ([`src/no-signal.js`](../src/no-signal.js)): a query with no route and no
   catalogue word whose best cosine is below τ answers `noMatch: { reason: "no-signal" }`.
7. **Fuse and hydrate.** After the pins, the lists are combined by reciprocal-rank fusion,
   `1/(60 + rank)`, and only as many candidates as the page shows are read from D1. A dense-only
   candidate whose fresh D1 row fails the filters is dropped, so a bundle older than D1 (between
   a re-ingest and its deploy) never shows a row that no longer passes.
8. **Collapse duplicates** ([`src/groups.js`](../src/groups.js)): one result per duplicate group,
   the other members as its variants. With a semester set, the member offered in that semester
   stands for the group (ADR 0006, "The semester representative").
9. **Answer.** In exchange mode each result carries its `exchange` status from its stored allow
   mask ([exchange-mode.md](exchange-mode.md)). A 200 is cached for an hour, a keyword-only
   answer for 60 s.

**The cache key** is built from the validated parameters only (query trimmed, whitespace
collapsed and lower-cased, parameters sorted, defaults and unknown parameters dropped), plus the
data version in `src/data-version.json` and the deployed version's id
(`CF_VERSION_METADATA.id`), so every deploy starts a fresh cache. A new parameter joins the key in
parsed form in the PR that adds it. A repeated search (a shared link, a reload, an eval run)
costs no D1 read, no Vectorize query and no Workers AI call, however it is spelled.

## The vectors bundle

Every corpus vector, L2-normalised float32, plus a 32-byte filter row per module (semesters,
level, credits, faculty, NG, the prefix id, the group id and the constraint fields), is one binary
file (`src/vector-bundle.js` documents the layout). The Worker imports it as a `Data` module
through the wrangler `alias` `vectors-bundle` and parses it on its first dense search: no I/O per
request, no Vectorize query, and the vectors deploy and roll back with the code that reads them.

| bundle | what | where |
|---|---|---|
| fixture | the fixture's test modules, fake embedder | `test/fixtures/vectors.bin`, committed; the alias's default, so `npm test`, `npm run dev` and a fresh checkout build against it |
| pinned | the eval's pinned corpus, its default corpus vectors (`emb-bge-small-v1`) | release asset, sha256 in `data/vectors.json`; `test/full` and the `full-corpus` CI job (`node scripts/vectors.mjs fetch --corpus pinned`) |
| production | what D1 holds | release asset, sha256 in `data/vectors.json`; only `npm run deploy` uses it, and it refuses the other two |

<!-- pointer --> Each bundle's course count and size are in `data/vectors.json`.
`scripts/vectors.mjs` builds all three. It looks each module's vector up in the eval's corpus
embedding asset by `embeddingKey(model, text)`, so codes that share a text share one vector, and
production gets the replica's bits for every text the two share. Texts the asset lacks are
embedded once (`npm run eval:embed -- --texts`, which records its neurons in its run record). The
manifest records each bundle's data version, row count, sha256 and `rowsKey`, the sha256 of its
sorted (code, `text_hash`) pairs; the deploy guard compares that with D1.

Plain `npx wrangler deploy` would ship the fixture bundle. Use `npm run deploy`.

## Data files as aliases

The vocabulary and groups are bare-name aliases too: `src/intent-data.js` and
`src/group-data.js` import `vocabulary-data` and `groups-data`, which `wrangler.jsonc` points at
`data/vocabulary.json` and `data/groups.json`, the Vitest configs at the fixture's, the pinned
corpus's (`test/full`) or production's (`test/oracle`), `test/wrangler.ui.jsonc` at the
fixture's, and `vitest.eval.config.mjs` at each eval run's own workspace copies, so a run never
ranks with the wrong vocabulary. `catalogue-codes-data` and `prefixes-data` work the same way
([data.md](data.md#the-catalogue-files)).

`ng-unscheduled-data` (`src/ng-unscheduled.js`) is aliased the same way:
`data/ng-unscheduled.json` in production, `test/fixtures/ng-unscheduled.json` for the Worker tests
and the UI stack, the pinned corpus's (built in memory into `.data/ng-unscheduled/`) for
`test/full`, production's for `test/oracle`, and the eval workspace's committed copy. Only
`/module`'s 404 and `/search`'s no-match answer read it, so it never touches a ranking.

**NG-listed codes with no classes.** NUS lists some codes for exchange students that NUSMods
offers no classes for this year, so D1 has no row for them. <!-- pointer --> They and their count
are in `data/ng-unscheduled.json`. The file holds each one's fields, its other codes (the
duplicate groups over the offered rows plus the file's codes, so FIN3701B gets FIN3701A, C and D)
and the allow mask and rule ids `eligibility()` gives it, as ingest stores for a row.
`node scripts/build-ng-unscheduled.mjs --corpus production` writes it from `current` (the corpus
manifest), refused unless that corpus is the production bundle's; `vectors.mjs build --corpus
production` rewrites it with the bundle. `--corpus fixture` writes
`test/fixtures/ng-unscheduled.json` from `test/fixtures/ng-unscheduled-source.json` (six records
copied from a production corpus); `--check` rebuilds in memory and exits 1 on a difference.
`test/ng-unscheduled.node.test.js` recomputes every entry's mask from its own fields, so a stale
one fails CI.

## The Vectorize standby

`DENSE_BACKEND=vectorize` (a wrangler var, flipped by a deploy) sends the dense half to Vectorize,
with the same filters. That is degraded service: masks fall back to code order and constraint
filters apply after hydrate. The standby is kept identical to the bundle by runbook step 8
([data.md](data.md#re-ingesting)).

Semesters are stored in Vectorize as four booleans (`sem1`..`sem4`), not an array, because
Vectorize metadata indexes support only string, number and boolean. The eight filterable
metadata indexes are listed in [operations.md](operations.md#setup); they can't be added to an
index that holds vectors.

## Failure behaviour

Workers AI and Vectorize calls time out after 1.5 s, D1 calls after 3 s. In hybrid mode, if
embedding or the dense index fails (a bundle that doesn't parse is `source: "dense-index"`;
Vectorize under the standby flip), `/search` answers with the keyword results alone and says so:
`"degraded": { "source", "reason" }` in the body, cached for 60 s instead of an hour. After 3
consecutive dense failures an isolate skips the dense half for 30 s (`reason: "circuit-open"`).
`mode=vector` still answers 502, and a D1 failure is a 502. Anything unhandled is a JSON 500 with
a `requestId` (the `cf-ray`) that matches the `"event":"unhandled"` log line.

## Instrumentation

`/search`, `/module/:code` and `/facets` responses carry a `Server-Timing` header. `/search` has
spans `cache` (`desc=hit|miss`), `limit`, `pin`, `embed`, `vector`, `fts` and `hydrate` for the
stages that ran (pin, `fts` and `embed`→`vector` run concurrently; the header keeps that order),
`degraded` (`desc=<source>-<reason>`) on a keyword-only fallback, plus `total` from fetch entry.
`/module` and `/facets` have `d1` and `total`. workerd's clock only advances across I/O, so the
spans measure waiting on bindings, not CPU. A cache hit gets fresh spans, never the stored ones.

Each `/search` writes one JSON log line (`"event":"search"`) with the status, cache result, the
query (first 100 characters) and its length, the mode, filters, result counts, the fallback
(`degraded`), spans, D1 rows read and serving region (`d1.servedByRegion`,
`d1.servedByPrimary`), and the colo. The `search` and `d1_error` lines hold no header or IP (the
`unhandled` line carries the `cf-ray`). A D1 failure on `/module/:code` or `/facets` writes
`{"event":"d1_error","route","error"}`: the route pattern and the error, no URL, code, query or
IP.

## What is kept about visitors

ADR 0012, and said in `public/privacy.html`. `observability` is on with no `logs` block, so
Workers Logs keep an invocation log for every Worker request (the request URL, so the search text
and filters, and the request's metadata and headers, `cf-connecting-ip` among them) beside the
Worker's own lines, for 7 days on Workers Paid (Cloudflare's Workers Logs docs; Workers Logs move
to Observability pricing on 2026-12-01, and the note promises nothing past today's retention).
Workers Logs keep every event (`head_sampling_rate` unset). Cloudflare's zone analytics keep
sampled request records, the page's own `/?q=…` included, which the Worker can't turn off. The
page keeps the year of study and the last edited shortlist in `localStorage` and sets no cookies.
A change to any of these changes the note in the same PR.

## Known limitations

- **One academic year.** The site serves one year at a time and switches in July
  ([year-refresh/](year-refresh/README.md)). Two years would double the vectors bundle the Worker
  loads and the standby's stored dimensions.
- **Exchange mode is a manual snapshot.** The NG list and restrictions come from PDFs and pages
  that must be downloaded by hand (NUS blocks automated fetching) and re-checked when NUS updates
  them. The page names each source with its date so staleness is visible. YST's Sem 2 list is last
  year's until YST publishes this year's (`year check` says so), and from the July switch until
  NUS publishes Sem 2's NG list, Sem 2 shows last year's list, each course "to confirm".
- **The year's sources need one key.** NUS's documents are archived encrypted per revision; the
  key is backed up in Bitwarden. Without it the next source change can't be checked
  (`year check --full`), though deploys that touch no source-derived input still work.
- **Exchange mode covers Semesters 1 and 2.** The NG list has no special-term data.
- **Only some constraints are read from the query.** *No final exam*, *S/U*, *light workload* and
  level phrases become filters. Others, such as "no Friday classes", are not understood, and
  there is no filter for class days.
- **The PDF is the browser's print.** Only Chromium's is checked as a PDF (tagged, real text);
  WebKit's print page by screenshot; iOS's Share, Print path is untested on a phone. A system font
  draws U+2010 and U+2011, which the Plex subsets lack; on macOS its text layer reads them as "-".
  A 40-entry list prints in about 15 to 19 A4 pages.
- **No scheduled re-ingest.** A refresh is a manual command run on the Mac. Detection is
  scheduled: the drift workflow opens an issue when NUSMods' data no longer matches production's,
  or next year appears ([operations.md](operations.md#drift-and-reminder-issues)).
- **The ranking is measured offline,** on a pinned corpus, with one judge model and queries
  written for personas; see [EVAL.md](../EVAL.md), "What the numbers don't show".
