# Findings

Phase 0 triage of every §4 finding ID in [`CRITERIA.md`](CRITERIA.md). Each claim was checked
against `main` at `7ac9841` (production runs `3b18041`; `src/` is identical). The status set is
closed: `reproduced | partially-reproduced | rejected | fixed`. Line references of the form
`src/index.js:N` point at `7ac9841`; Phase 1 split that file into `src/*.js` modules.
`npm run check:findings` (`scripts/check-findings.mjs`) fails CI if an ID is missing, has
another status, or a reproduced/fixed finding names evidence that does not exist.

**Evidence kinds**
- **Tests** are characterisation tests named `[<ID> known-bug] …`: plain `it`, asserting the
  current wrong behaviour, so each one fails the moment the bug is fixed and must then be
  rewritten to assert the fix (see PLAN.md). `[<ID> evidence]` tests pin data facts a finding
  rests on. Worker tests run in workerd over the 400-module fixture (`test/fixtures/corpus.json`)
  with the fakes in `test/fakes.js`; `*.node.test.js` run in Node; `test/full/` runs over the
  full pinned corpus (6,771 modules) in the `full-corpus` CI job.
- **Live evidence** is the 0b run against production on 2026-11-03, in `docs/evidence/phase0/`
  (`raw/<ID>_*.body|headers` from curl; `fe-results.json`, `axe-1280-*.json`, `shots/` from
  Playwright). Every live call is logged in `docs/evidence/requests.tsv`. No live call was made
  for this triage. "Server time" below is curl `ttfb − tls`, which still includes one round trip.

## Summary

| ID | Status | Evidence |
|---|---|---|
| B1 | reproduced | test (fixture + full corpus), live |
| B2 | reproduced | tests |
| B3 | reproduced | test (EXPLAIN QUERY PLAN) |
| B4 | fixed | tests (concurrency, differential), live latency |
| B5 | fixed | tests, live |
| B6 | fixed | test |
| B7 | fixed | test, live |
| B8 | reproduced | tests, live |
| B9 | reproduced | test (README arithmetic) |
| S1 | reproduced | test (source + EVAL.md) |
| S2 | reproduced | live |
| S3 | reproduced | tests |
| S4 | reproduced | tests, live |
| S5 | reproduced | tests, live |
| S6 | reproduced | live, full-corpus test |
| S7 | reproduced | tests |
| S8 | reproduced | tests, live |
| P1 | reproduced | tests, live |
| P2 | partially-reproduced | tests, live |
| P3 | reproduced | test |
| F1 | reproduced | test, Playwright |
| F2 | reproduced | test |
| F3 | reproduced | test, Playwright |
| F4 | reproduced | test |
| F5 | reproduced | test, Playwright, axe |
| F6 | reproduced | test, axe |
| F7 | reproduced | test, live |
| F8 | reproduced | test |
| F9 | reproduced | test |
| F10 | reproduced | test, Playwright, screenshot |
| V1 | partially-reproduced | test, screenshots |
| O1 | fixed | test, `db:rebuild-check` (PR #1) |
| O2 | fixed | test, CI (PR #1) |
| O3 | fixed | test |
| O4 | reproduced | tests |

Checked and **not** findings (noted, no ID): the `/search` cache does work on workers.dev
(`raw/B7conn.headers`: `cf-cache-status: HIT` on an identical repeat); the 87 s page load was
the network, not the Worker.

## Backend and data

### B1 · Semester filter drops keyword results

**Status:** reproduced

**Claim:** FTS runs with `LIMIT 4 × depth`, then the semester filter runs in JS, so
`q=management&sem=3&mode=lexical` returns 6 when about 31 match.

**Evidence:**
- test `[B1 known-bug] lexical management&sem=3&topK=50 returns 6 of the 31 sem-3 keyword matches (as live)` (`test/full/findings.test.js`): over the full pinned corpus, exactly 31 sem-3 modules match `"management"`, more than 200 match overall, and lexical search returns the same 6 codes production did.
- test `[B1 known-bug] lexical sem=3 returns 0 results although 3 sem-3 modules match "management"` (`test/findings/b1.test.js`): 20 strong sem-1 decoys + 3 sem-3 targets, `topK=1` → FTS `LIMIT 12` → 0 results.
- test `[B1 known-bug] hybrid sem=3 finds the targets only through the vector half`
- `docs/evidence/phase0/raw/B1_sem3.body`: live `count: 6` (BMC5415, TCX2003, BME5042, BMA5134, TCX2005, BME5046). `docs/evidence/phase0/raw/B1_hybrid_sem3.body`: hybrid `retrieval.lexical: 6`, and it surfaces BMA5302 and MEM5103, which lexical misses.

**Notes:** Cause `src/index.js:223` (`bind(...binds, limit * 4)`) then `:226` (sem filter in
JS); depth is `min(topK × 3, 50)` (`:317`), so at most 200 FTS rows are ever considered. The
~31 figure is confirmed exactly (31) on the full corpus. The live check couldn't count all
matches because of the topK cap; the full-corpus test can.

### B2 · Re-ingest misses field changes; nothing deletes; cache never expires; acad_year ignored

**Status:** reproduced

**Claim:** Ingest hashes only the embedded text (title/department/faculty/description), so
changes to semesters, NG flags, credits and prereqs never land; nothing deletes dropped
modules; the `.data/` download cache never expires; `/search` ignores `acad_year`.

**Evidence:**
- test `[B2 known-bug] textHash ignores semesters, credits, workload, prerequisite, preclusion and NG flags` (`test/findings/ingest.node.test.js`)
- test `[B2 known-bug] scripts/ingest.mjs skips a module whenever its textHash is unchanged`
- test `[B2 known-bug] /admin/hashes exposes a single embedded-text hash per module, so ingest can only compare text` (`test/findings/b2.test.js`): `/admin/hashes` returns only `text_hash`, and `/module` keeps serving the stale row.
- test `[B2 known-bug] re-ingesting a corpus without a module leaves that module in D1 and Vectorize`: no `deleteByIds` call, no delete route (404).
- test `[B2 known-bug] the .data/ download cache is used however old it is`: a cache file dated 2000-01-01 is served with `cached: true` (fetch stubbed to throw).
- test `[B2 known-bug] /search returns a module from another acad year`: a `2019-2020` row is returned.

**Notes:** Hash input `scripts/lib.mjs:94-101` (`embeddingText`) and `:163` (`textHash:
hashOf(text)`); skip predicate `scripts/ingest.mjs:61`; cache read with no age check
`scripts/lib.mjs:39-44`; no `acad_year` predicate anywhere in `src/index.js` `runFts`
(`:193-229`) or `fetchRows` (`:262-269`). The Worker's own `ON CONFLICT DO UPDATE`
(`src/index.js:557-563`) would write every field; it's the client-side skip that stops it.

### B3 · FTS triggers delete by an UNINDEXED column

**Status:** reproduced

**Claim:** The FTS update/delete triggers delete by UNINDEXED `code`, so every row change scans
the whole FTS table.

**Evidence:**
- test `[B3 known-bug] the FTS update/delete triggers delete by the UNINDEXED code column, a full scan` (`test/findings/backend.test.js`): `EXPLAIN QUERY PLAN DELETE FROM modules_fts WHERE code = ?` → `SCAN modules_fts VIRTUAL TABLE INDEX 0:` (no usable constraint; a rowid delete gives `INDEX 0:=`). Updating one module reports `rows_read` ≥ the 400 rows in the table (401 measured).

**Notes:** `migrations/0002_fts.sql:5` (`code UNINDEXED`) and the triggers at `:15-21`. A full
re-ingest of 6,771 rows therefore reads about 6,771² ≈ 46M FTS rows, far over the 5M/day D1
free read limit. That figure is extrapolated, not measured remotely. The query plan is a
property of the schema, so the local plan is the remote plan.

### B4 · Request path is fully serial

**Status:** fixed

**Claim:** pin → embed → Vectorize → FTS → hydrate run one after another; measured server
time hybrid ~540 ms, `/module` ~240 ms.

**Evidence:**
- test `[B4 fixed] with Workers AI hanging, the pin and lexical queries still start before the embedding resolves`
- test `[B4 fixed] pin, lexical and embed -> Vectorize run concurrently, then one hydrate query, all on a read session`: with the embedding held back, the FTS (and pin) statements have already been issued and nothing is hydrated; once it is released, exactly one hydrate query follows, and every statement ran on a `withSession('first-unconstrained')` session.
- test `[B4 instrumented] /search responses carry Server-Timing spans for each stage`: flipped from the Phase 0 characterisation test that asserted there was none; `test/instrument.test.js` covers misses, hits, errors and the log line
- test `1B is ranking-neutral` (`test/differential.test.js`): 522 generated requests through the pre-1B route and the new one give identical bodies.
- `docs/evidence/requests.tsv` rows 4–9 (`raw/B4_search_*`, `raw/B4_module_*`): hybrid cache-miss `ttfb−tls` 932 / 1427 / 1411 ms; `/module/CS3244` 242 / 387 / 716 ms.

**Notes:** The serial structure was reproduced exactly (`src/index.js:304-367` at `7ac9841`);
the latency figures only partly (hybrid measured 0.9–1.4 s, not ~540 ms, with no
`Server-Timing` to separate server from network time). Phase 1 step 0 added the spans.

Fixed in PR #7 (workstream 1B): `runSearch` in `src/search.js` starts the pin lookup, the
lexical query and embed→Vectorize together and waits on all three (`Promise.all`), then runs
one hydrate query for only the columns and rows the response renders. Every public D1 read
(`/search`, `/module`, `/facets`) goes through `env.DB.withSession('first-unconstrained')`,
which works with or without read replication; admin routes stay on `env.DB` (primary).
Vectorize is asked for ids only (`returnMetadata` dropped); depth stays 50. Enabling read
replication itself (ADR 0002) and the deployed SC7 measurement are separate Phase 1 steps.

### B5 · No upstream timeouts, no top-level try/catch

**Status:** fixed

**Claim:** No upstream timeouts and no top-level try/catch; `/module/%E0%A4%A` → error 1101.

**Evidence:**
- test `[B5 fixed] /module/%E0%A4%A is a 400 naming the bad encoding, not an exception out of fetch`
- test `[B5 fixed] a hanging %s call times out at 1.5 s and the search answers keyword-only` (run for `ai` and `vectorize`): still pending at 1.35 s, settled by 1.7 s, 200 with `degraded.reason: "timeout"`.
- test `[B5 fixed] a hanging D1 query times out at 3 s with a 502 naming D1`
- test `[B5 fixed] a throwing rate limiter fails open, and the failure is logged`
- test `[B5 fixed] an exception no route handles is a JSON 500 carrying the request id, and is logged`
- `docs/evidence/phase0/raw/B5_module.headers`: live `HTTP/2 500`, `text/plain`, body `error code: 1101` (before the fix).

**Notes:** Was: `decodeURIComponent` outside any try, no catch in `fetch()`, no timeout on
AI or Vectorize (`src/index.js:461`, `:583-628`, `:329`, `:336` at `7ac9841`). `/search` with
the same bytes did not crash: `URLSearchParams` decodes leniently to U+FFFD.

Fixed in PR #7: `fetch` catches anything a route throws and answers
`500 { "error": "internal", "requestId" }` (the `cf-ray`, else a random UUID), logged as
`"event":"unhandled"`. `/module` guards `decodeURIComponent` (400). `src/upstream.js`
races every Workers AI (1.5 s, also aborted through its `signal` option), Vectorize (1.5 s)
and D1 (3 s) call against a timer. The rate limiter call fails open and logs
`"event":"limiter_error"`.

### B6 · No keyword fallback when AI or Vectorize fails

**Status:** fixed

**Claim:** A Vectorize/AI failure fails the whole search; there's no keyword fallback.

**Evidence:**
- test `[B6 fixed] %s throwing in hybrid mode returns the keyword results, flagged degraded and cached for 60 s` (run for `ai` and `vectorize`): 200, `degraded: { source, reason: "error" }`, the same codes as `mode=lexical`, `cache-control: public, max-age=60`, `Server-Timing` span `degraded`, and the log line's `degraded`.
- test `[B6 fixed] mode=vector still fails loudly with a 502 from the failing binding`
- test `[B6 fixed] after 3 consecutive dense failures the dense half is skipped for 30 s, then retried`

**Notes:** Was: `src/index.js:319-345` at `7ac9841` returned `upstream(...)` from inside the
vector half, deliberately (R7: "never an empty or quietly degraded 200"). SC7 requires the
fallback, so it is now explicit instead of quiet: in hybrid mode an AI or Vectorize failure
or timeout returns the lexical results with `degraded: { source, reason }` in the body
(`reason` is `error`, `timeout` or `circuit-open`), a `degraded;desc=<source>-<reason>`
Server-Timing span, and a 60 s cache lifetime. A per-isolate circuit breaker
(`denseCircuit` in `src/upstream.js`) skips the dense half for 30 s after 3 consecutive
failures. `mode=vector` (the eval's dense-only mode) never falls back and is never
short-circuited. Fixed in PR #7.

### B7 · Cache key is the raw URL

**Status:** fixed

**Claim:** The cache key is the raw URL: case, parameter order and junk parameters all miss.

**Evidence:**
- test `[B7 fixed] the cache key is canonical: order, case, whitespace, defaults and junk params share one entry`: five spellings of one query make one entry and one embedding; hits read no D1 row; parameters that change the answer still get their own entry.
- test `[B7 evidence] every stage is case- and whitespace-insensitive, so the key may lower-case q`
- `docs/evidence/phase0/raw/B7conn.headers`: live, `cf-cache-status: HIT` only on the identical repeat; reordered, re-cased and `&_r=` variants miss (`docs/evidence/phase0/raw/B7conn.timing`).

**Notes:** Was: `src/index.js:596` at `7ac9841` (`new Request(url.toString())`). A junk
parameter let anyone bypass the cache and spend metered quota.

Fixed in PR #7: `canonicalCacheKey` in `src/search.js` builds the key from the validated
parameters only: `q` trimmed, whitespace runs collapsed and lower-cased; `sem`, `level`,
`credits`, `faculty`, `ng` in parsed form; `mode` and `topK` only when not the default
(`topK` after clamping); unknown parameters dropped; sorted; plus `v=<DATA_VERSION>` from
the committed `src/data-version.json` (seeded with the pinned corpus sha256 prefix
`2d138795d387`). Nothing reads D1 before the lookup. Invalid requests are answered before
the cache is touched and never stored. Lower-casing is safe because every stage already
ignores case: the FTS tokens are lower-cased, the pin upper-cases, the fake embedder
lower-cases (tested), and bge-small-en-v1.5 is uncased (its `BertTokenizer` has
`do_lower_case: true` in the model's `tokenizer_config.json`, so the real model sees the
same token ids; not tested live). The body echoes the canonical query, so a cached answer
is the same whichever spelling stored it.

### B8 · topK, hydration and tokeniser defects

**Status:** reproduced

**Claim:** `?topK=` (empty) → 1 result; hydration reads up to 77 rows for 50 results and
selects unused columns; `returnMetadata:'indexed'` is unused and caps topK at 50 (100 without
it); the ASCII-only tokeniser splits "naïve".

**Evidence:**
- test `[B8 fixed] an empty topK= returns the default 20 results`; live (before the fix) `docs/evidence/phase0/raw/B8_emptyTopK.body` (`count: 1`).
- test `[B8 fixed] hydration reads only the rows and columns the response renders`
- test `[B8 fixed] a candidate missing from D1 (stale vector) is skipped and the next one hydrated`
- test `[B8 fixed] Vectorize is asked for ids only; the candidate depth stays 50`
- test `[B8 known-bug] the ASCII-only tokeniser splits "naïve" into "na" and "ve"`: MATCH is `"na" OR "ve" OR "bayes"`.

**Notes:** Was: `Number('') === 0` clamped to 1 (`src/index.js:298-302` at `7ac9841`);
hydration `:262-269` read every fused candidate with `SELECT_COLUMNS`; `returnMetadata`
`:338` with only `m.id` read; tokeniser `:158`. Live hydration was 66 rows for 20 results.

PR #7 (workstream 1B) fixes three of the four sub-claims: an empty `topK=` is the default;
hydration selects only `RESULT_COLUMNS` and reads only as many fused candidates as the page
shows, topping up in order when a candidate is missing from D1, so the page is the same as
before (`test/differential.test.js`); Vectorize no longer gets `returnMetadata`. The topK
ceiling stays 50 on purpose (Phase 1 plan r2: a deeper list would change rankings). The
Unicode tokeniser is workstream 1A's (`src/lexical.js`); B8 becomes `fixed` when that lands
and its known-bug test flips.

### B9 · README names the wrong binding limit

**Status:** reproduced

**Claim:** README says D1 is the binding limit, but Vectorize's ~71k queries/month runs out
first.

**Evidence:**
- test `[B9 known-bug] README calls D1 the binding limit, but its own numbers put Vectorize ~40x lower` (`test/findings/source.node.test.js`)

**Notes:** `README.md:169` versus its own table (`:175-178`). D1 allows 5M rows/day ÷ ~50 per
search ≈ 3M searches/month. Vectorize allows 30M queried dims/month ÷ 384 − 6,771 stored ≈
71,354 searches/month, about 42× fewer. The claim's arithmetic holds.

## Search

### S1 · The eval is circular and mis-scoped

**Status:** reproduced

**Claim:** Relevance is title regexes written from the query words; recall@10 ignores order;
only tidy queries; topK=10 versus production depth 50; `ORDER BY rank` never re-measured;
hybrid MRR 0.820 < lexical 0.903.

**Evidence:**
- test `[S1 known-bug] held-out relevance is a regex over titles, recall@10 ignores order, and hybrid MRR trails lexical`: 11 of 12 held-out rules are a regex over `m.title`; `K` defaults to 10; recall is `h / |relevant|`; EVAL.md's held-out MRR row reads 0.833 / 0.674 / 0.903 / 0.820 and states `ORDER BY rank` was not re-run.

**Notes:** `scripts/judge-holdout.mjs:13-49`, `scripts/eval.mjs:34,104`, `EVAL.md:94` and
`:41`. Production returns 20 of a 50-deep candidate list (`src/index.js:28-29,317`). "Tidy
queries only" is a judgement, but it mostly holds. Across `eval/queries.json` and
`eval/holdout.json` (27 queries), the three code queries are exact codes (`CS3244`, `cs2040s`,
`EC4308`), and none has a space in a code, a partial code, a typo, or an exam/S/U/workload
constraint. One query, `machine learning for beginners`, does carry level intent.

### S2 · Equal-weight RRF drops correct vector answers

**Status:** reproduced

**Claim:** Equal-weight RRF with a hash tiebreak pushes correct vector answers down
(`intro to psych`, `learn korean`).

**Evidence:**
- `docs/evidence/phase0/raw/S2_psych_vector.body`: vector #1 PL1101E (Introduction to Psychology). `docs/evidence/phase0/raw/S2_psych_hybrid.body`: hybrid #1 CE5316QA, PL1101E #2; lexical found only 4.
- `docs/evidence/phase0/raw/S2_korean_vector.body`: vector #1 LAK1201 (Korean 1). `docs/evidence/phase0/raw/S2_korean_hybrid.body`: hybrid #1 LAK2201 (Korean 2), LAK1201 #2.

**Notes:** `fuse()` at `src/index.js:235-255`. A document ranked #1 in one list only ties with
any other #1-in-one-list document, and the hash tiebreak (`:247-253`) decides it. The real
embedding model is required, so this has no local test; fakes would only test the fake.

### S3 · Vector half set up badly

**Status:** reproduced

**Claim:** No bge query instruction prefix; embedded text lacks code and level and leads with
department/faculty boilerplate; a 768-d model won't fit the free stored-dims cap.

**Evidence:**
- test `[S3 known-bug] the query is embedded verbatim, with no bge query instruction prefix` (`test/findings/search.test.js`)
- test `[S3 known-bug] the embedded text has no module code or level and puts department/faculty before the description` (`test/findings/ingest.node.test.js`)

**Notes:** Query `src/index.js:329`; passage text `scripts/lib.mjs:94-101`. One nuance: the
text starts with the **title**, then department and faculty, then the description, so "starts
with boilerplate" is slightly overstated; the boilerplate sits between title and description.
768-d: 6,771 × 768 = 5.2M > the 5M stored-dims cap (README cost table), arithmetic only.

### S4 · Keyword half is brittle

**Status:** reproduced

**Claim:** No prefix or fuzzy matching; the stopword list lacks "modules", "teach", "intro",
"something"; the code column is UNINDEXED, so `CS32` and `GEA` get 0 keyword hits.

**Evidence:**
- test `[S4 known-bug] "%s" gets 0 lexical hits because the code column is UNINDEXED` (CS32, GEA)
- test `[S4 known-bug] "modules", "intro", "teach" and "something" are not stopwords`
- test `[S4 known-bug] no fuzzy or prefix matching: "%s" gets 0 lexical hits` (`machne`, `progr`)
- `docs/evidence/phase0/raw/S4_CS32.body` and `docs/evidence/phase0/raw/S4_GEA.body`: live `retrieval.lexical: 0`; no GEA module in GEA's top 20.

**Notes:** Stopwords `src/index.js:150-151`; `migrations/0002_fts.sql:5`. The keyword half has
no fuzzy matching, but hybrid `machne learning` is **not** broken in production: the vector
half carries it (`raw/S5_machne.body`, 15 of 20 titles are ML). So SC4's typo case is already
met by hybrid; the keyword-half claim still stands.

### S5 · Code handling is exact-only

**Status:** reproduced

**Claim:** `cs 1010s` puts CS1010S at #14; partial codes get no route.

**Evidence:**
- test `[S5 known-bug] "cs 1010s" is not recognised as the code CS1010S`
- test `[S5 known-bug] the partial code "CS101" has no route: no pin, 0 lexical hits`
- `docs/evidence/phase0/raw/S4_cs1010s.body`: live CS1010S at #14.

**Notes:** The pin tests the whole query against `MODULE_CODE_RE` (`src/index.js:307-308`);
`cs 1010s` fails it because of the space, and `1010s` is not a word in any indexed text.

### S6 · Graduate courses flood undergraduate queries

**Status:** reproduced

**Claim:** 46% of the corpus is level ≥ 5; `machine learning for beginners` puts CS2109S at
#18; `AI` returns 13/20 at level 5–6.

**Evidence:**
- test `[S6 evidence] 46% of offered modules are level 5 or above` (`test/full/findings.test.js`): 3,098 of 6,771 (45.8%).
- `docs/evidence/phase0/raw/S6_ml_beginners.body`: CS2109S at #18; 9 of 20 at level ≥ 5.
- `docs/evidence/phase0/raw/S6_AI.body`: 14 of 20 at level 5–6.

**Notes:** Nothing in ranking uses level or "beginner" intent. The claim said 13/20 for `AI`;
the recorded run shows 14/20. Same finding, slightly worse.

### S7 · Intent data downloaded but unused

**Status:** reproduced

**Claim:** Exam dates, workload, `attributes.su`, grading basis, prereqs and the GE pillar
(from the code prefix) are downloaded but unused.

**Evidence:**
- test `[S7 known-bug] the schema has no exam, S/U, grading-basis or attributes columns`
- test `[S7 known-bug] /search accepts no workload, exam, S/U or prerequisite filter: they are ignored`

**Notes:** In the pinned `moduleInfo.json`, 1,633 offered modules carry
`semesterData[].examDate`, 933 carry `attributes.su: true`, and every record has
`gradingBasisDescription`. `normalise()` (`scripts/lib.mjs:138-169`) drops all three.
`workload` and `prerequisite` are stored (`migrations/0001_init.sql`) but nothing filters or
ranks on them.

### S8 · No "no match" state; near-duplicates crowd lists

**Status:** reproduced

**Claim:** `xqzvbnm flurble` returns 20 results; near-duplicate variants (TR3202I/S/T) crowd
lists.

**Evidence:**
- test `[S8 known-bug] gibberish returns a full page of results in hybrid mode`
- test `[S8 known-bug] near-duplicate variants (TR3202*) crowd the top of the list`
- `docs/evidence/phase0/raw/S8_nonsense.body`: live 20 results, `retrieval.lexical: 0`. `docs/evidence/phase0/raw/S8_startup_intern.body`: TR3202N, TR3202I, TR3202T, TR3202S at #5–#8.

**Notes:** Vector search always returns its topK nearest neighbours and there's no score floor
(`src/index.js:358-387`). The TR3202 variants share a title and description.

## Product (exchange mode)

### P1 · Exchange filter is a yearly boolean

**Status:** reproduced

**Claim:** `ng=1&sem=1` `machine learning` shows CS3244 and CG3201, which are NG-open in Sem 2
only; 934 of 1,207 NG courses are open in one semester only; per-semester data is already in
D1 as `ng_semesters`.

**Evidence:**
- test `[P1 known-bug] ng=1&sem=1 returns modules that are open to exchange students only in Sem 2`
- test `[P1 known-bug] the Vectorize filter is the yearly ng boolean, not per semester`
- test `[P1 evidence] 934 of the 1,207 NG courses are open to exchange students in one semester only`
- `docs/evidence/phase0/raw/P1_ml_ng_sem1.body`: live CG3201 #2 and CS3244 #4, both `ngSemesters: [2]`.

**Notes:** `src/index.js:124-128` (yearly `ng`), `:139` (sem checked against `semesters`, not
`ng_semesters`), `:544` (`ng` metadata). The README documents this as a known caveat. It also
understates the problem: about 2.5% of rows *disagree*, but 934 of 1,207 NG courses (77%) are
single-semester, and any of those can leak into the other semester. A further data issue
turned up: PC3270 has `semesters: [2]` but `ngSemesters: [1]` (NUSMods and the Registrar PDF
disagree).

### P2 · Graduate courses shown to undergraduate exchange students

**Status:** partially-reproduced

**Claim:** Undergraduate exchange students can't take 5000-level courses (NUS BBA incoming
exchange FAQ Q11), but the filter shows them.

**Evidence:**
- test `[P2 known-bug] ng=1 returns a level-5 module (LI5202) to an undergraduate exchange student`
- test `[P2 evidence] 28 NG courses are level 5 or above`
- `docs/evidence/phase0/raw/P2_ml_ng.body`: live `machine learning&ng=1` top 20, max level 4. Not reproduced on that query.

**Notes:** The behaviour is reproduced. Nothing stops `ng=1` returning level ≥ 5 (there's no
study-level input), and the Registrar's NG list itself contains 28 codes at level 5+ (e.g.
LI5202, PP5288). Two things keep this partial. First, the recorded live query didn't surface
any. Second, the policy premise comes from one faculty's FAQ (BBA) and was not re-checked
here. Because the Registrar's own NG list includes graduate courses, hiding all of them would
be wrong too. The correct rule depends on the student's study level, which SC1 already
requires as an input.

### P3 · No source links; reads as official NUSMods

**Status:** reproduced

**Claim:** No source links (NG PDF, Registrar vacancy report, course-restrictions list); the
title "NUSMods semantic search" reads as official NUSMods.

**Evidence:**
- test `[P3 known-bug] no source links anywhere, and the title reads as official NUSMods` (`test/findings/source.node.test.js`): `src/page.html` has no `<a>` or `href` at all.

**Notes:** `src/page.html:6,84-85`. The hint says "NUS Registrar list" (`:139`) as plain text
with no link. The subtitle says "unofficial NUSMods API", but the title and `<h1>` don't.

## Frontend

### F1 · Result cards are dead ends

**Status:** reproduced

**Claim:** No links or focusables in cards; `/module/:code` is never called; no description
snippet; the raw RRF score (`0.030`) sits in the prime spot.

**Evidence:**
- test `[F1 known-bug] result cards are dead ends: no link, button or tabindex, no description, raw score`
- `docs/evidence/phase0/fe-results.json`: `dom.linksInResults: 0`, `focusableInResults: 0`, `resultsWithTabIndex: 0`.

**Notes:** Card template `src/page.html:167-179`; score `:172`.

### F2 · No abort or timeout on search requests

**Status:** reproduced

**Claim:** No AbortController or timeout.

**Evidence:**
- test `[F2 known-bug] search fetches have no AbortController and no timeout`

**Notes:** `src/page.html:197`. Stale responses are dropped by the `ticket` check (`:199`), but
they still run to completion, and a hung request leaves the button disabled indefinitely
(combined with B5's missing server timeouts).

### F3 · History is broken

**Status:** reproduced

**Claim:** `replaceState`, no `popstate`; Back leaves the site; clearing the query leaves a
stale URL.

**Evidence:**
- test `[F3 known-bug] history uses replaceState only, never pushState, and nothing handles popstate`
- `docs/evidence/phase0/fe-results.json`: `historyAfterSearch3.length: 2` after three searches; `afterBack.url: "about:blank"`.

**Notes:** `src/page.html:190` (`replaceState`); `:185` returns before touching the URL when
the query is cleared.

### F4 · Shared links lose filters when /facets fails

**Status:** reproduced

**Claim:** Shared links lose filters when `/facets` fails; the first search waits for
`/facets`.

**Evidence:**
- test `[F4 known-bug] a failed /facets is swallowed and the shared-link search waits on it`
- `docs/evidence/phase0/fe-results.json`: `requests` shows `/facets` at +499 ms and the first `/search` only at +934 ms after page load.

**Notes:** `src/page.html:132-143` and `:224-235`. Level and faculty `<option>`s exist only if
`/facets` succeeded, and assigning `.value` to a `<select>` with no matching option is a
silent no-op, so `level=`/`faculty=` from the URL are dropped. Shown at source level (DOM
semantics); a failing `/facets` was not browser-exercised.

### F5 · Accessibility gaps

**Status:** reproduced

**Claim:** `#status` has no `aria-live`, results have no `aria-busy`, disabling the focused
button drops focus to BODY, no `<main>`, no `role="search"`.

**Evidence:**
- test `[F5 known-bug] no aria-live status, no aria-busy, no <main>, no role="search"; the focused button is disabled`
- `docs/evidence/phase0/fe-results.json`: `statusAriaLive: null`, `mainCount: 0`, `roleSearchCount: 0`, `focusDuringSearch.active: "go"` → `focusAfterSearch.active: "BODY"`.
- `docs/evidence/phase0/axe-1280-light.json`: `landmark-one-main` ×1, `region` ×6.

**Notes:** `src/page.html:117`, `:193`.

### F6 · Contrast failures

**Status:** reproduced

**Claim:** Dark-mode button 2.08:1; light `<code>` and NG badges 4.44:1.

**Evidence:**
- test `[F6 known-bug] colour tokens fail WCAG AA: dark button 2.08:1, light <code>/NG badge 4.44:1`: recomputes the ratios from the `src/page.html` tokens.
- `docs/evidence/phase0/axe-1280-dark.json`: `#go` 2.08 (#fff on #ff9a62). `docs/evidence/phase0/axe-1280-light.json`: `code` and `.ng` 4.44 (#b4541f on #fdf0e8).

**Notes:** Tokens `src/page.html:11,16`; button `:40`.

### F7 · Raw error states

**Status:** reproduced

**Claim:** Errors show raw codes (`rate_limited`, `upstream_failure`); `Retry-After` is
ignored; an HTML error page makes `res.json()` throw.

**Evidence:**
- test `[F7 known-bug] errors show raw codes, ignore Retry-After, and parse JSON before checking res.ok`
- `docs/evidence/phase0/raw/B5_module.headers`: Cloudflare error pages are `text/plain` (`error code: 1101`), which `res.json()` cannot parse.

**Notes:** `src/page.html:198-209`. A non-JSON error lands in the `catch`, which shows "Could
not reach the search service" plus a JSON `SyntaxError` message. That is wrong: the service was
reached.

### F8 · Unescaped innerHTML interpolation

**Status:** reproduced

**Claim:** `credits`, `semesters` and the `ngSemesters` title attribute are interpolated into
`innerHTML` without escaping.

**Evidence:**
- test `[F8 known-bug] credits, semesters and the NG title attribute are interpolated into innerHTML unescaped`

**Notes:** `src/page.html:171`, `:176`, `:177`. Today these values are numbers from the
Worker's own D1, so this isn't exploitable without a poisoned row. It's an injection seam all
the same, and `esc` already exists (`:154`).

### F9 · Enter during IME composition fires a search

**Status:** reproduced

**Claim:** Enter during IME composition fires a search.

**Evidence:**
- test `[F9 known-bug] Enter fires a search even during IME composition`

**Notes:** `src/page.html:219-221` checks only `e.key === 'Enter'`, not `e.isComposing` or
keyCode 229, so confirming a CJK candidate submits a half-typed query.

### F10 · Mobile layout

**Status:** reproduced

**Claim:** On mobile the first result sits at y≈500/844, the score wraps, and the 15px input
triggers iOS zoom.

**Evidence:**
- test `[F10 known-bug] 15px inputs (iOS zooms below 16px) and a score pushed to its own line on narrow cards`
- `docs/evidence/phase0/fe-results.json`: `mobile.firstResultTopY: 499` at 390×844, `inputFontSize: "15px"`.
- `docs/evidence/phase0/shots/390x844-light.png`: the score wraps to its own line, and so does "Sem 1, Sem 2".

**Notes:** `src/page.html:22`, `:33-36`, `:69`, `:72`. At y=499 the first card's top is
technically above the fold (`firstResultVisibleAboveFold: true`), but less than one card fits;
SC8 needs the first result readable above the fold.

## Visual design

### V1 · Visual design 4/10

**Status:** partially-reproduced

**Claim:** Template look; off-brand orange `#b4541f`; accent everywhere; inconsistent filter
labels ("2", "2000 (1016)", "sem: Sem 2"); non-removable chips; dead-end no-results; data-source
notes fill the hero.

**Evidence:**
- test `[V1 known-bug] orange accent everywhere, inconsistent filter labels, non-removable chips, dead-end empty state`
- `docs/evidence/phase0/shots/1280x800-light.png` and `docs/evidence/phase0/shots/390x844-light.png`

**Notes:** Every factual sub-claim holds: accent `#b4541f` with ≥ 8 `var(--accent)` uses;
option "2" (`src/page.html:95`), level labels `${level}000 (${count})` (`:135`), chip
`sem: Sem 2` (`:160`); chips are plain spans; the empty state is text only (`:163`); data notes
in `.sub` (`:85`). "4/10", "template look" and "off-brand" are judgements, not reproducible
claims, hence partial. The Phase 5 design gate decides those.

## Ops

### O1 · Database not rebuildable from the README

**Status:** fixed

**Claim:** The README skips 0003/0005, has no 0001, the ALTERs are not idempotent, and the
metadata-index loop omits `ng`.

**Evidence:**
- test `[O1 fixed] the README rebuilds the schema from migrations/, which start at 0001 and include ng in the metadata loop`
- `scripts/schema-snapshot.mjs` (`npm run db:rebuild-check`, run by `.github/workflows/ci.yml`): rebuilds from empty and diffs against `test/fixtures/remote-schema.json`.
- `docs/decisions/0001-migrations-and-remote-bootstrap.md`

**Notes:** Fixed by PR #1 (`7ac9841`). ALTER idempotency comes from migration tracking (ADR
0001). The remote `d1_migrations` bootstrap is still pending (Phase 1), but that's an ops step,
not this finding.

### O2 · No tests, CI, lint or types

**Status:** fixed

**Claim:** No tests, CI, lint or types.

**Evidence:**
- test `[O2 fixed] lint, typecheck, tests and the schema rebuild run in CI`
- `.github/workflows/ci.yml`, `eslint.config.mjs`, `tsconfig.json`, `vitest.config.mjs`

**Notes:** Fixed by PR #1 (`7ac9841`). An eval gate in CI (SC9) is still open; Phase 2.

### O3 · NG_LIST_UPDATED kept in two places

**Status:** fixed

**Claim:** `NG_LIST_UPDATED` is maintained by hand in `src/index.js` and in the NG JSON.

**Evidence:**
- test `[O3 fixed] the NG list date has one source: ingest posts it from data/ng-courses-*.json, no copy is kept by hand`
- test `[O3 fixed] /facets reports the NG list date ingest recorded from data/ng-courses-*.json`

**Notes:** Was: a constant in `src/modules.js` (`src/index.js:38` at `7ac9841`) versus
`data/ng-courses-2026-2027.json` `updatedAsAt`, with the README asking for a manual bump.
Fixed in PR #7: `scripts/ingest.mjs` posts `{ ngList: { updatedAsAt, source, count } }`
(from `loadNgCourses`) to `/admin/facets`, which stores it as `meta('ng_list')` before
rebuilding the facets row; `/facets` (precomputed or live) reads the date from there. The
constant and the README instruction are gone. Until the next ingest records it, the live
`/facets` row keeps the date it was built with.

### O4 · No scheduled refresh

**Status:** reproduced

**Claim:** No scheduled refresh.

**Evidence:**
- test `[O4 known-bug] the Worker has no scheduled handler, so nothing refreshes the data`
- test `[O4 known-bug] wrangler.jsonc declares no cron trigger`

**Notes:** The default export has only `fetch` (`src/index.js:577-629`); `wrangler.jsonc` has
no `triggers`. The README lists it as a known limitation.
