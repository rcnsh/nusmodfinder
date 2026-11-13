# Cost

What the site costs to run against the account's allowances, and the arithmetic behind its
limits. The rule is ADR 0004: never go over an included allowance.

## Cost

The account is on **Workers Paid** ($5/month). Going over an included allowance there is billed,
not refused, and ADR 0004 allows no overage. Nothing in the Worker caps its own use. **Vectorize
is off the search path (the dense half runs in the Worker, ADR 0006), so the binding limit is
Workers CPU or Workers AI neurons, not Vectorize queried dimensions.**

| | Workers Paid, included | cost here |
|---|---|---|
| D1 rows read | 25,000,000,000 / month | per search, measured on production: p50 255, max 1,403; unfiltered p50 240, filtered p50 613.5; the local grid's worst filtered search 7,772; 1 per page load (`/facets`); 1 per `/module/:code` (2 on a 404 for a code outside `data/ng-unscheduled.json`); ~21k per deploy (the guard reads every module and catalogue row) and one per module for a standby refresh |
| D1 rows written | 50,000,000 / month | about 34,400 per forced full re-ingest, measured against production; a rerun with nothing changed writes 2; the standby refresh writes 0 |
| Vectorize stored dims | 10,000,000 | <!-- pointer --> the standby holds one vector per module the database holds, the production bundle's count in `data/vectors.json`. At 384 dimensions each that is about a quarter of the allowance |
| Vectorize queried dims | 50,000,000 / month | **~0 per search** (only under `DENSE_BACKEND=vectorize`); the stored term still counts once a month |
| **Workers CPU** | **30,000,000 ms / month** | live: **p50 9.1 ms, p75 15.5 ms** CPU per request (`/health` included), 33–34 ms on a fresh isolate's first search; the exact search alone is 1.44 ms locally and 3.4 ms on a CI runner |
| **Workers AI** | **10,000 neurons / day, shared by the account** | 0.033 per typical uncached search, 0.066 when a word is corrected (a second embedding), up to ~0.88 for a whole-query catalogue-only code's `related` (*est.*), at 1,841 neurons per million tokens; ~2,400 per forced re-ingest (measured); a bundle build embeds only texts the eval asset lacks |
| CPU per request | 30 s | as above |

The arithmetic. **The limit is CPU or the shared neurons.** At the measured ~12 ms of CPU a
request, 30M CPU-ms cover **~2.5M searches a month**. Workers AI's 10,000 neurons a day cover
150,000 to 300,000 uncached searches a day (4.5M to 9M a month) at 0.066 to 0.033 each, if this
project had them alone. It doesn't: on the busiest day measured the account used 6,805 neurons
(68%), about 4,300 of them this project's two corpus embeds and about 2,500 other projects'
([`ops/reports/2026-11.md`](../ops/reports/2026-11.md)). With no corpus embed or re-ingest that
day, about 110,000 uncached searches fit beside other projects' ~2,500; on a day with one, far
fewer, so a week the site is announced has none (ADR 0004). At 2.5M searches a month, D1's 25
billion reads cover ~10,000 rows read per search; the production p50 (255) and max (1,403) are
well inside that, and the worst filtered search on the local grid (7,772 rows) is not. Cached
repeats cost none of these.

**The scheduled and live checks.** The uptime check sends about 290 requests a day (96 runs of
`/health`, `/module` and one uncached `/search`), plus the uptime Worker's 96 cron invocations:
about 25k D1 rows read (96 searches at the p50 of 255, plus 96 `/module` rows) and about 4
neurons. Each Actions deploy's smoke adds 5 GETs (up to
7 more `/health` while the promote propagates), one of them an uncached search (about 0.03
neurons).

**No overage.** Nothing in Cloudflare caps Workers AI or D1 spending automatically. A Cloudflare
budget alert at the lowest amount emails the day after a billed day and caps nothing. What keeps
the project inside the allowances is ADR 0004's rules: at most one forced re-ingest or corpus embed
a UTC day, and none in a week the site is announced, since a forced re-ingest spends about 2,400
of the 10,000 daily neurons.

**A spike** (*est.* where marked):

| Uncached searches | Neurons | CPU (*est.* 12 ms each) | D1 rows (*est.* 500 each) | What happens |
|---|---|---|---|---|
| 1,000 a day | 33–66 | 12k ms | 0.5M | nothing |
| 10,000 a day | 330–660 | 120k ms (0.4% of a month) | 5M (0.02%) | nothing |
| 50,000 a day | 1.7k–3.3k | 600k ms (2%) | 25M | nothing, unless this project embeds its corpus that day too (~2–4k neurons) |
| 100,000 a day | 3.3k–6.6k | 1.2M ms (4%) | 50M | with other projects at ~2,500, inside; with a corpus embed the same day, up to ~3.4k neurons over, billed at $0.011 per 1,000 (about $0.04), which ADR 0004 doesn't allow |
| 1,500–3,000 in one **minute** | — | — | — | past Workers AI's 3,000 requests a minute for embedding models (a corrected search makes two), embeddings fail and searches go keyword-only, perhaps other projects' too |

**Past an allowance**, Workers Paid bills the overage and no request fails for it. A D1 error of
any kind is a 502 with the upstream message, never a silently empty answer.

**The caveat:** the allowances are per *account*, not per project, and the one other use that
reaches this project's limits is Workers AI's: other projects' embeddings and this project's own
corpus embeds share its 10,000 neurons a day. The `/search` rate limits (40 per 10 s and 200 per
60 s per IP) are burst guards, per colo and eventually consistent, and don't protect the daily
account-wide budget against traffic spread over many addresses.

## Why D1 reads per search are low

Each of these was measured with the `meta.rows_read` field D1 returns:

1. **`ORDER BY rank`, not `ORDER BY bm25(...)`.** Both give identical ordering (the table's
   persistent rank config is `bm25(0.0, 3.0, 1.0)`, `migrations/0005_rank.sql`), but calling
   `bm25()` as a SQL function makes FTS5 materialise and score **every matching row**, while the
   `rank` column uses its internal top-N path. On a query matching 224 documents: **389 rows read
   → 7.** Don't change it back.
2. **`/facets` is one precomputed JSON row** in the `meta` table, rebuilt at the end of ingest,
   instead of three full-table aggregates on every page load: **9,842 rows read → 1.**
3. **`/search` responses are cached** (Workers Cache API, 1 hour) under a canonical key
   ([architecture.md](architecture.md#how-a-search-is-answered)). A repeated search costs no D1
   read, no Vectorize query and no Workers AI call, however it is spelled.
4. **Filter indexes** keep the exact filtered keyword search bounded (ADR 0002), and the join to
   `modules` is skipped unless a filter needs a column from it.

The FTS query is `OR`-first: an `AND`-first query would cost less but change retrieval, and `OR`
is what the eval measures.
