# NUS Mod Finder: technical reference

How the service works, is deployed and is kept honest. The short version is the [README](../README.md).

Semantic + keyword search over NUS courses, on Cloudflare Workers, D1 and Workers AI, with the dense half exact in the Worker and Vectorize as the cold standby.

**Live:** https://nusmodfinder.rcn.sh

Type what you want to study — `machine learning for beginners`, `i want to understand
climate change`, `how do i start my own company` — or a module code like `CS3244`, and
filter by semester, level, credits and faculty.

> **Read [EVAL.md](../EVAL.md) before trusting the ranking.** It is measured offline on judged
> queries, not assumed. On the dev set hybrid clearly beats the keyword half alone, but its lead
> over the dense half alone (+0.022 nDCG@10) is not distinguishable from 0: the keyword half adds
> little beyond the dense half. SC5 measured the Phase 3
> ranker above the first hybrid version on a sealed test set, and every later ranking change ships
> on a holdout look or a no-look route, held by CI's ranking lock.

## What it does

| Route | Purpose |
|---|---|
| `GET /` | The page: `public/`, served as Workers Static Assets (no Worker CPU); native ES modules, no framework, no build step ([below](#the-page)) |
| `GET /search?q=&sem=&level=&credits=&faculty=&ng=&study=&exam=&su=&hoursBelow=&prereq=&ignore=&topK=&mode=` | Ranked results as JSON (the parameters below) |
| `GET /module/:code` | The full D1 row for one module, with its exchange-mode status for every semester and year of study, its exams, its workload, its NUSMods link, its grading basis and its other codes; a 404 says which kind of miss it is (below) |
| `GET /facets` | Distinct faculties and levels, with counts, for the filter UI, the exchange-mode sources with their dates, and NUS's rules about courses off the exchange list (`offListRules`, below) |
| `GET /health` | `{ ok, versionId, versionTag, dataVersion, vectors }`, without touching D1 ("Deploying", below) |
| `GET /privacy` | The privacy note (`public/privacy.html`, a static asset): what Cloudflare's logs and the site's own line keep, what stays on the device, no cookies |
| any other path | JSON 404 `{ error: "not_found", message }`; for a browser (`GET` or `HEAD` whose `Accept` prefers `text/html`), the 404 page instead (below) |

**The 404 page** (Phase 8 8B) is `src/404.html`, a Text module, sent with status 404 and the CSP,
`X-Frame-Options` and `X-Content-Type-Options` of `public/_headers`' `/*` rule, since Cloudflare
applies `_headers` to static assets only. `src/not-found.js` holds a copy of the three, so the
Worker (and the ranking lock's inputs) reaches no file outside `src/`; `test/visitor.test.js`
parses `public/_headers` and fails when the copy differs. It is static: nothing from the request is
written into it. `curl` and Node's `fetch` (`*/*`) and the page's own fetches (`application/json`)
keep the JSON; so does any `Accept` that ranks HTML below JSON or `*/*`. It lives in `src/`, so it
is never also served as `/404.html`. `/favicon.ico` is a static file (the 32 px PNG in an ICO), so
a browser's request for it never runs the Worker.

**`/search` refuses other sites' pages** (Phase 8 8B): a request with `Sec-Fetch-Site: cross-site`
and any `Sec-Fetch-Dest` but `document` answers 403 `{ error: "cross_site", message }` with
`no-store`, before the cache, the rate limits and any binding. It stops another site's fetch, image
or hidden iframe spending this account's Workers AI through its visitors' browsers. A link a
student follows (`navigate` + `document`), the page itself (`same-origin`), a bookmark (`none`), and
callers that send no `Sec-Fetch-Site` (Node's `fetch` as smoke sends it, the eval, `curl`) are
served as before. `/module` and `/facets` don't refuse, and `access-control-allow-origin: *` stays.

**Two per-IP rate limits** guard `/search` (Phase 8 8B, ADR 0012 G5 (b)): `SEARCH_LIMIT`, 40 per
10 s, and `SEARCH_LIMIT_MINUTE`, 200 per 60 s, both keyed by `cf-connecting-ip`, asked together
(one `limit` span) after the cache and before any other binding. Either refusing answers 429
`{ error: "rate_limited", message }` with `retry-after: 60`; each fails open on its own. A cache
hit skips them. A hit is re-sent with its own TTL, `public, max-age=3600`, or 60 for a keyword-only
answer, which is stored with `x-search-degraded: 1`: the copy Cloudflare's cache returns carries
the zone's Browser Cache TTL (4 hours), not the one it was stored with.

`ng=1` is **exchange mode**: only courses an exchange (Non-Graduating) student may take, under
the Registrar's NG course list and course restrictions (below). It needs `study=ug1|ug2|ug3|ug4|grad`,
the student's year of study during the exchange (`ug4` = 4th year or later); without it `/search` answers
400 `study-required`. Under `ng=1`, `sem=1|2` picks the semester the student would come in
(the NG list's semesters, not NUSMods'), no `sem` means either, and `sem=3|4` answers no
courses with `noMatch: { reason: "ng-special-term" }`: the NG list has no special-term data.
Each result then carries `exchange: { status: "open" | "note", reasons: [{ id, kind, text }] }`
(the reasons include R3's year-of-study note and R6-2's level 4000 note, below).
Only `true` narrows — `ng=0` is ignored, and `study` is ignored without `ng=1`.

3H's explicit constraints, each a hard filter: `exam=0` (no final exam listed, in the `sem` asked
for when there is one), `su=1` (S/U-able, or graded CS/CU), `hoursBelow=N` (NUSMods' weekly workload below N
hours, 1 to 99) and `prereq=none` (no prerequisite). The same constraints are also read from the
query's own words (*no final exam*, *S/U*, *light workload*; the tighter hour limit holds), and
`ignore=` names parsed phrases to undo, as the page's chips do (`src/search.js` `parseFilters`,
`parseIgnore`). Every one is part of the cache key.

`/module/:code` (Phase 5 5A) also answers `examDates`, one `{ sem, date, durationMins }` per
semester with an exam (`date` ISO UTC as NUSMods gives it; `[]` for none); `workload` as
`{ lecture, tutorial, lab, project, prep, total }` hours a week, `{ raw }` when NUSMods gives
something other than its 5-number array (two modules give a string), or `null` when not listed
(absent or all zero); `nusmodsUrl`, where the class times are; and (5D) `prereqCohortOnly`, the
stored 3H-0 flag that the prerequisite names only NUS intake years or programmes. Phase 6 6A adds
`gradingBasis` (NUSMods' text, e.g. `"Graded"` or `"Completed Satisfactory/Unsatisfactory"`) and
`otherCodes`, the course's duplicate group (3F, `src/group-data.js`) other than itself, `[]` when
none; both come after `prereqCohortOnly`, and no other field changed. It is cached
`public, max-age=300` on a 200, `public, max-age=60` on a 404 and `no-store` on a 5xx, with no ETag.

A 404 (6A) is `{ error: "not_found", kind, message, acadYear, … }`, `kind` one of:
- `ng-listed`: on the NG list but with no classes in NUSMods this year (`EE4407`, for one),
  from `data/ng-unscheduled.json` (below), with no D1 read past the row's. It carries the
  fields a row has (`code`, `title`, `description`, `credits`, `faculty`, `department`, `level`,
  `ngSemesters`, `workload`, `prerequisite`, `preclusion`, `gradingBasis`, `otherCodes`),
  `semesters: []`, `ng: true`, `examDates: []`, `nusmodsUrl`, and `exchange` built from the
  file's allow mask by the same function a row's uses, so it reads like a row with no classes;
- `catalogue-only`: a `catalogue_only` row (in the catalogue, not offered this year), with its
  `code`, `title` and `description`;
- `unknown`: neither, or no `catalogue_only` table yet.

`acadYear` is the file's, the catalogue row's, else `data/ng-reasons.json`'s. A row always wins
over the file. A 404 not in the file costs a second D1 read, timed under the same `d1` span; any
failed read but a missing table is a 5xx with `no-store`. An answer from before 6A has no `kind`;
read it as `unknown`. The page's fetch layer (`public/api.js`) passes a JSON error body's fields,
its `message` left out, through as `error.detail`, and keeps a 404 as final for the page.

`/facets` (6A) carries `offListRules: [{ id, text, scope }]` beside `ngSources`: NUS's four rules
about courses off the exchange list (`E-offerings-list`, `2-biz-no-late-add`, `4-cee-no-appeal`,
`4-isem-no-appeal`), each quoted from the restrictions PDF, with the scope it states
(`{ departments, levels }` or `{ faculties }`, matched on a row's fields, never by code prefix;
`{}` for every course). They are the rules file's `info` entries with a `text`, passed through
`data/ng-reasons.json`.

`/search` (Phase 5 5C-api) also answers, on every 200, what the page needs to explain a typed
code. None of it changes which results show or their order:
- `hiddenPins: [code]`: the typed codes, in query order, whose row the filters, `ng`/`study` and
  the parsed intents remove. Every code-shaped token counts (up to 10), not only the 3 that pin.
  A code with no row, or one that passes but whose duplicate group already shows, is never listed.
  Empty on routes that pin nothing (a whole-query partial code or prefix, `noMatch`).
- `notOffered: [code]`: the typed codes that are in the catalogue but not offered this year,
  also inside a longer query (a whole-query one still answers `noMatch: { reason: "not-offered" }`).
  6A: an NG-listed code with no classes (`data/ng-unscheduled.json`) counts as not offered here
  even where the bundled catalogue lacks it, and as a whole query answers
  `noMatch: { reason: "ng-unscheduled", code, title, ngSemesters, related }` instead of
  `not-offered` or `unknown-code`; the page says "NUS lists EE4438 (Solar Cells and Modules) for
  Sem 2, but NUSMods shows no classes for it this academic year." The parse is untouched.
- each result's `examDates`, as `/module/:code` gives them (`[]` for none);
- under `ng=1` with no `sem`, each result's `exchangeBySem: { "1": …, "2": … }`: the
  `{ status: "open" | "note" | "closed", reasons }` for each semester at the `study` level, beside
  `exchange` (the either-semester value), so a student planning both sees one value per semester.

`mode` is `hybrid` (default), `vector` or `lexical`. It exists so the evaluation harness
can measure each retriever on its own: EVAL.md's Phase 2 baseline compares the two halves with it.

`/search` returns at most 20 results by default; `topK` may raise that to 50, the
candidate depth of each retriever. Queries over 200 characters are rejected.

### How a search is answered

`searchRoute` and `runSearch` in [`src/search.js`](../src/search.js), in order:

1. **Validate, cache, limit.** A bad parameter is a 400 before any binding is touched. The
   canonical cache key (B7) is looked up next, and a hit costs no binding call. Then the per-IP
   rate limit (`SEARCH_LIMIT`).
2. **Parse the query** ([`src/query-intent.js`](../src/query-intent.js)): typed course codes to
   pin (R5, up to 3), partial codes, code prefixes and GE pillars as code ranges (3B), a spelling
   correction against the catalogue's own words (3C, [`src/typo.js`](../src/typo.js),
   [`src/vocabulary.js`](../src/vocabulary.js)), the no-exam, S/U, workload and prerequisite
   phrases (3H, [`src/intents.js`](../src/intents.js)) and level phrases (5F) as constraints. The
   parse picks one of three routes.
3. **`no-match`:** a whole query that is one code not offered this year answers `count: 0` with
   its reason (`unknown-code`, `not-offered`, or 6A's `ng-unscheduled`) and, as `related`, the
   dense neighbours of its catalogue text.
4. **`mask`:** a whole query that is a partial code, a prefix or a GE phrase answers that set's
   members, in exact dense order (code order without the dense half).
5. **`search`:** three lookups start together. The pin lookup in D1. The dense half
   ([`src/dense.js`](../src/dense.js), [`src/vector-bundle.js`](../src/vector-bundle.js)): the
   query is embedded with `@cf/baai/bge-small-en-v1.5` (384 dims), and once more when 3C
   corrected a word, then scored by exact cosine against every corpus vector held **in the
   Worker** (below), after a mask for the filters and constraints. The lexical half
   ([`src/lexical.js`](../src/lexical.js), [`src/fts-query.js`](../src/fts-query.js)): a D1 FTS5
   query, `ORDER BY rank` over the table's `bm25(0, 3, 1)`, porter stemming and stopwords
   removed, with the same filters in SQL. A code token adds its prefix's members as a third list.
6. **No signal** (3G, [`src/no-signal.js`](../src/no-signal.js)): a query with no route and no
   catalogue word whose best cosine is below τ answers `noMatch: { reason: "no-signal" }`.
7. **Fuse and hydrate.** After the pins, the lists are combined by reciprocal-rank fusion,
   `1/(60 + rank)`, and only as many candidates as the page shows are read from D1. A dense-only
   candidate whose fresh D1 row fails the filters is dropped.
8. **Collapse duplicates** (3F, [`src/groups.js`](../src/groups.js)): one result per duplicate
   group, the other members as its variants. With a semester set, the member offered in that
   semester stands for the group (ADR 0006, "The semester representative").
9. **Answer.** In exchange mode each result carries its `exchange` status from its stored allow
   mask. A 200 is cached for an hour, a keyword-only answer for 60 s.

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
| fixture | the fixture's test modules, fake embedder | `test/fixtures/vectors.bin`, committed; the alias's default, so `npm test`, `npm run dev` and a fresh checkout build against it |
| pinned | the 6,771 pinned modules, the eval's default corpus vectors (`emb-bge-small-v1` since 3A-2) | release asset, sha256 in `data/vectors.json`; `test/full` and the `full-corpus` CI job (`node scripts/vectors.mjs fetch --corpus pinned`) |
| production | what D1 holds | release asset, sha256 in `data/vectors.json`; only `npm run deploy` uses it, and it refuses the other two |

<!-- pointer --> Each bundle's course count and size are in `data/vectors.json`.
`scripts/vectors.mjs` builds all three. It looks each module's vector up in the eval's corpus
asset by `embeddingKey(model, text)`, so codes that share a text share one vector, and
production gets the replica's bits for every text the two share. Texts the asset lacks are
embedded once (`npm run eval:embed -- --texts`, logged in `neurons.tsv`). The manifest records
each bundle's data version, row count, sha256 and `rowsKey`, the sha256 of its sorted
(code, `text_hash`) pairs.

**The vocabulary and groups** (3C, 3F) are bare-name aliases too: `src/intent-data.js` and
`src/group-data.js` import `vocabulary-data` and `groups-data`, which `wrangler.jsonc` points at
`data/vocabulary.json` and `data/groups.json` (deploy adds no `--alias` for them), the Vitest
configs at the fixture's, the pinned corpus's (`test/full`) or production's (`test/sc1`),
`test/wrangler.ui.jsonc` at the fixture's, and
`vitest.eval.config.mjs` at each eval run's own workspace copies, so a run never ranks with
the wrong vocabulary. 6A's `ng-unscheduled-data` (`src/ng-unscheduled.js`) is aliased the same
way: `data/ng-unscheduled.json` in production, `test/fixtures/ng-unscheduled.json` for the Worker
tests and the UI stack, the pinned corpus's (built in memory into `.data/ng-unscheduled/`) for
`test/full`, production's for `test/sc1`, and the eval workspace's committed copy. Only `/module`'s 404 and
`/search`'s no-match answer read it, so it never touches a ranking.

**NG-listed codes with no classes** (6A). NUS lists some codes for exchange students that
NUSMods offers no classes for this year, so D1 has no row for them. <!-- pointer --> They and
their count are in `data/ng-unscheduled.json`. The file holds each one's fields, its other codes (groups-v1 over the offered rows plus the file's codes, so
FIN3701B gets FIN3701A, C and D) and the allow mask and rule ids `eligibility()` gives it, as
ingest stores for a row. `node scripts/build-ng-unscheduled.mjs --corpus production` writes it
from `current` (the corpus manifest, below), refused unless that corpus is the production bundle's;
`vectors.mjs build --corpus production` rewrites it with the bundle. `--corpus fixture` writes
`test/fixtures/ng-unscheduled.json` from `test/fixtures/ng-unscheduled-source.json` (six records
copied from a production corpus); `--check` rebuilds in memory and exits 1 on a difference.
`test/ng-unscheduled.node.test.js` recomputes every entry's mask from its own fields, so a
stale one fails CI.

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
.venv/bin/python scripts/extract-ng.py <dir>/ng-courses.pdf --year <yyyy-yyyy>
```

<!-- year:live --> The live 2026/27 list (`data/ng-courses-2026-2027.json`) has 730 codes for Sem 1
and 750 for Sem 2, 1,207 codes in all. The extractor writes `data/ng-courses-<acadYear>.json`, keeping only the sections whose heading names that
year (NUS prepends the next year's Sem 1 above this year's Sem 2), and fails when a semester the
year's source manifest marks published has no section or a section has no rows (Phase 7 7E;
`--from-text` reads text already extracted, with no `pypdf`). The ingest script picks it up and
sets `modules.ng` plus the `ng` Vectorize metadata property. A missing or stub file is refused:
exchange mode would show every course closed. `year check --full` re-runs the extractor with
`.venv/bin/python` on the archived PDF and requires the committed file byte for byte, so a hand
edit to it can't pass (red team H-1); keep the venv above in the repo.

**The source manifest and the year refresh** (Phase 7 7E). Each year's sources are listed in
`data/ng-sources-<year>.json`: the revisions of NUS's documents (name, URL, file, sha256, "updated
as at"), each revision's encrypted archive (a release asset; `npm run sources`), which semesters
NUS has published, the transcription, overlay (`scripts/ng-overlay/<year>.mjs`), oracle and
register paths, and the quote index (every NUS sentence copied by hand into `src/` or `public/`,
with its document). `npm run year -- check` checks the year's files agree with it (the deploy
preflight runs it), and `--full`, on the Mac with the key, finds every quote in its document,
re-extracts `data/ng-courses-<year>.json` from the archived NG list PDF and rebuilds the rules file,
each byte for byte; while a semester is unpublished it re-extracts last year's list (which exchange
mode shows for it) from last year's archive too, and refuses when there is none. Every document's `file` and `text` is a plain base name (red team L-4), and each
`text` extraction carries a `textSha256` (red team L-5), which `sources publish` writes and restore,
`--full` and the restrictions builder check. The runbook for a year switch and a mid-year revision is
[`docs/year-refresh/README.md`](year-refresh/README.md).

**A semester NUS hasn't published (G2, ADR 0011).** The site moves to a new year once NUSMods has
it and NUS has published the Sem 1 list (July). Until NUS publishes Sem 2's, the manifest marks it
unpublished, `scripts/lib.mjs` takes last year's Sem 2 list for it and marks every module
`ngUnpublished: [2]`, and `src/eligibility.js` gives a course on that list the note
`ng:unpublished-sem` (kind `ask`: "On NUS's <last year> list; NUS hasn't published <this year>'s
yet."), never open; the shortlist counts it "to confirm with NUS". A course not on last year's Sem 2
list is closed there with `ng:unpublished-sem-unlisted` ("Not on last year's NG list for Sem 2"),
not "only in the other semester". With every semester published, nothing changes.

**Cross-checked against the pinned corpus** (`test/full/corpus.test.js` asserts these).
<!-- year:pinned --> For the pinned AY2026/2027 snapshot, of 1,207 course codes in the PDF, **1,175
(97.3%)** exist in the NUSMods corpus, and the other 32 are not offered that year. Where both
sources state a semester they agree on **1,411 of 1,447 (97.5%)**; the ~2.5% disagreement is a
snapshot-vs-daily-scrape artifact.

**Restrictions (Phase 4).** Being on the NG list isn't enough: the Registrar's
"course restrictions for NG students" PDF closes schools, levels and single courses, and adds
conditions (a major at home, a partner university, approval, a quota, graded only). These are
data, not code: `data/ng-restrictions-<year>.json`, built by `scripts/build-ng-restrictions.mjs`
from the documents the year's source manifest lists (`data/ng-sources-<year>.json`, archived
encrypted; `npm run sources -- restore` unpacks them) and the year's overlay
(`scripts/ng-overlay/<year>.mjs`), with every reading the sources leave open decided in the year's
register (`docs/evidence/phase4/interpretations.md` for 2026/27).
Ingest runs `src/eligibility.js` over every module for every (semester, year of study) and
stores a 15-bit allow mask (`modules.ng_allow`) and the rule ids behind each answer
(`modules.ng_rules`); the Worker runs no rule logic. Every search path tests the one bit for the
request; a zero or missing mask is closed. Reason texts ship with the Worker
(`data/ng-reasons.json`, built by `scripts/build-ng-reasons.mjs`), so rewording one rewrites no
rows. An independent oracle for the year (`test/sc1/oracle-<year>.node.mjs`, picked by the selector
`test/sc1/oracle.mjs`) checks the rules on every module, and the `sc1` CI job checks every search
path against it.

**Year of study (Jacob's ruling R3, ADR 0008).** A NUS prerequisite that requires an
undergraduate year ("If undertaking an Undergraduate Degree THEN must be Year 4") doesn't change
a course's exchange status, but an undergraduate whose year of study during the exchange is below that year gets one more
note, `{ id: "prereq:year-of-study", kind: "year" }`: "NUS lists this course for Year 4 students.
Ask the department whether your year of study during your exchange counts." An open course with it is
`note`; a closed one stays closed without it. It is read per request from the stored prerequisite
by `src/year-note.js` (no stored column, so no data change): `/module/:code` reads the row's
`prerequisite`, and `/search`'s hydrate reads it as `year_prereq`, only where it mentions a year.
Only unambiguous texts give it: one undergraduate branch (or none) and a year item that no OR sits
beside at any level. A year that is one alternative ("GPA of 3.2 or greater OR must be Year 4"),
several "if undertaking" branches, or a graduate student give none. The SC1 oracle reads the
prerequisite on its own (`prereqYears`, `oracleShown`), and both suites check every path against it.

**Level 4000 (Jacob's ruling R6-2, ADR 0010).** NUS Global's (GRO's) sentence on higher-level
undergraduate courses is a condition, like a quota: a level 4000 course outside Law that an
undergraduate (`ug1` to `ug4`) is shown gets the note `{ id: "gro:level-4000", kind: "supply" }`,
whose text is GRO's sentence word for word after "GRO: " ("Higher level undergraduate courses (e.g.
course code starting from 4000 & above) have very limited supply and are usually NOT available to
exchange students. …"); the page leads it with "Places." and cites "GRO, Incoming Exchange
Students". An open course with it is `note` ("Open, with 1 note"); the shortlist counts `supply`
as it counts `quota` ("Counted, if NUS accepts you"). Level 4 only: NUS's undergraduate courses
run from 1000 to 4000 (the brochure's "4000: Honours courses"; rule D makes 5000 and 6000 graduate
courses), so graduate courses are left to rule D and the departments. No note for a graduate
student or a Law course (Phase 6 plan, C5-m1: NUS Law opens only its LL4 electives and registers
its own invitees). Read per request from the row's `level` and `faculty` by `src/level-note.js`
(no data change, never closes or opens anything); the SC1 oracle reads it from the code and
faculty on its own (`levelNoteOf`). Over the pinned corpus: 245 offered courses carry it, all on
the NG list (952 level 4000 courses outside Law; the rest are closed to every undergraduate).

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
complete for 0001–0006; 0007–0010 were hand-run with their `d1_migrations` rows
(`scripts/remote-migration.mjs`), 0008 before 0007. A local database needs no
bootstrap: `npx wrangler d1 migrations apply nusmods-apac --local`.

`npm run db:rebuild-check` rebuilds the schema three ways, locally, and diffs each (ADR 0001).
`node scripts/schema-snapshot.mjs --compare-remote <dir-or-file>` builds nothing: it diffs a saved
production capture (the `wrangler d1 execute nusmods-apac --remote --command … --json` output of the
pragma query, `sqlite_master`, `index_xinfo` and the `d1_migrations` names) against the full-chain
snapshot, offline, comparing the migrations as a set. The 2026-11-12 capture
(`docs/evidence/phase7/schema/`) has 0 differences.

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

## The page

The page is **NUS Mod Finder (unofficial)** at nusmodfinder.rcn.sh (ADR 0009); "unofficial" is in
its title and visible header at every width, and its footer
links NUSMods, the NG list, the restrictions and the Registrar's vacancy report (P3).

**The design is direction D, "Annotated catalogue"** (Phase 5 5D; Jacob's pick, ADR 0008; the
spec is `docs/design/phase5-direction-d.html`): IBM Plex Sans, with Plex Mono for codes, units
and exam times; nothing heavier than 600; 1px rules; outlined or lightly tinted chips and
stamps; a near-white ground and one muted plum accent. Light is D's primary theme; a dark theme
built to match follows the system setting (`prefers-color-scheme`). Every colour is a token at
the top of `styles.css`, and `npm run contrast` (`scripts/contrast.mjs`, also run by `npm test`)
checks every text/background and boundary pair in both themes against WCAG AA.

- **The first screen is the exchange set-up** (D2): the semester at NUS (Sem 1, Sem 2 or both),
  the year of study (pre-filled from this device), then what to study; "Browse all courses
  instead" leads to the general search. A link with any state skips it.
- **Results:** a rail on the left ("Your exchange", the filters and the key) beside the search
  bar, the filter chips (each removes its filter; the semester and year exchange mode needs are
  changed in the rail), and the entries in three columns: code and units; title, department,
  timetable semesters, exam day and time (Singapore) and other codes; the exchange stamp per
  semester (an icon, a word and a colour) with every note in full after a lead-in word. Below
  1040px the status drops under the title. An entry's other codes ("Also as") are links: each
  opens that code's own search with its detail open (`open=`), whose head says "Opened from
  `<code>`" (`from=`); Back returns to the list. For a query of course codes only, the count line
  names the typed codes shown ("20 courses shown: CS2030, then 19 other matches").
- **Typed codes not shown** are explained above the entries (D4): each with its title, a stamp
  ("Not on the NG list for Sem 1", "Not for exchange students", "Not open in Sem 1", "Outside
  your filters", or "Not this year" for a code not offered in 2026/27), and why, from its own stored reasons. Where the
  other semester is open to the student and nothing else hides the course, "Switch to Sem 2 to
  see CS3244" changes the semester and focuses the course's entry.
- **On a phone** (≤ 640px) the form is one bar (query and Search), and the rail opens as a modal
  `<dialog>` from "Filters (n)": its controls move into the dialog while it is open, so there is
  one copy of each; focus stays inside, Escape or Done closes it, and focus returns to the
  button. Inputs are 16px, so iOS doesn't zoom.
- **The detail** opens as a sheet under its entry: its head repeats the code and title (one
  heading) with the units and department, then "can you take it" (per semester, every note with
  its source and date, "check with NUS", the NUSMods link) beside the course facts, and above
  them on a narrow screen.
- **Accessibility** (5E, SC8): a skip link is the first Tab stop and moves focus to the shown
  `<main>`; one `<h1>`; landmarks for the header, the rail, the search and the footer. One polite
  live region (`#live`, in the header, and in the filters dialog while it is open, since a modal
  dialog makes the rest of the page inert) says each answer once in a sentence: the count, why
  there are none and the next step, the typed codes not shown, errors and 429. The list is `aria-busy`
  while a search runs; the Search button is never disabled (a second press aborts the first).
  Escape closes the open detail and focus returns to its button, as it does after Back to an
  open detail. Every control shows a 2px plum focus ring, and nothing covers it (the sticky
  header leaves a scroll padding of its height). There is no manual VoiceOver walkthrough
  (Jacob, 2026-11-11, ADR 0008): the screen-reader flow rests on the aria snapshots, the
  live-region specs and axe; `docs/evidence/phase5/voiceover-checklist.md` is kept for anyone who
  wants to run it.
- **The shortlist's state** (Phase 6 6B; `docs/plans/phase6.md` 6B, ADR 0010). The list lives
  in the URL with no account: `pick` (primary) and `alt` (backup), each repeated in rank order,
  each `CODE.S` (S is 1 or 2) or an untagged `CODE`, then `ay`, `inv` and `view`, e.g.
  `/?q=networks&sem=1&ng=1&study=ug2&pick=CS2113.1&pick=CS2030.2&alt=GE2101.1&ay=2026-2027&inv=biz&view=shortlist`.
  Tags are kept as written; parsing upper-cases, drops malformed values and other tags, keeps the
  first of duplicates (a code in both lists stays a pick), and keeps at most 20 entries a tagged
  semester and 40 in all. `ay` (as `acad_year` writes it) is written with the first edit or Copy
  link once a `/module` row has loaded, never on load alone; `inv` (`biz`, `law`) only when ticked;
  `view=shortlist` opens the view and drops `open`. The list is page-wide, not per history entry:
  Back and Forward keep it and write it into the entry they reach. An edit replaces the entry at
  once and never searches. Every `pushState` and `replaceState` goes through one writer
  (`history.js`), which keeps under WebKit's 100 writes in 10 s. Links the page renders carry no
  list, so a new tab starts without one. The last list the student edited is kept on this device
  (`localStorage` `vnm.shortlist`, G3) for "Restore your last shortlist"; opening a link never
  overwrites it. `shortlist.js` works the list out (what counts, to confirm with NUS, or not and
  why; the same course twice; NUS's form order per semester against 40 units; totals; exam and
  preclusion flags; NUS's notes), for the view (6C) and the exports (6D). Some specs still
  drive the list through test hooks the page installs only when `globalThis.vnmTest` is set
  before it loads.
- **The shortlist** (Phase 6 6C; the mockup is `docs/design/phase6-shortlist/a/`, approved in
  ADR 0010). Each card and the detail's head carry a "Shortlist" toggle (`aria-pressed`, named
  "Shortlist, CODE"); adding a card's course tags it with the semester the results show, and the
  live region says the semester's units picked so far once its row has loaded ("…, 1 course
  still loading" past 2 s). Taking a card off says so with Undo. The shortlist button sits at the
  foot of the rail and, on a phone, in a row under the search bar; it names the units picked per
  semester (on two lines when it must) and opens the view (`view=shortlist`, a pushed entry;
  "Back to results", Escape or browser Back close it, and focus returns to the button). The view
  hides the results and status, keeps the search bar and rail, and lists primary picks then
  backups, each row with its title, units, exam, workload, its stamp at its own semester, every
  note, NUS's notes on the course and its flags, and Move up, Move down, Make backup or primary,
  a semester button and Remove (with Undo at the top of the list). Under them: per-semester
  totals (counted, to confirm, only if invited, hours, NUS's limits said once), NUS's form order,
  the CourseReg box and the applicant lines. Rows load four at a time; a failed one offers Try
  again, a 404 reads as its `kind` says. The invitation checkbox shows only for the faculty the
  list holds (Business or Law). In browse mode, or with untagged entries, an export question asks
  the year of study and each entry's semester first. Copy link writes `shortlistUrl` to the
  clipboard within the click; if the browser refuses, a selected field labelled "Shortlist link"
  holds it. The view moves no focused row: a moved row's neighbours move around it,
  and rows that load later never take focus. While the view is shown, a search under it says
  nothing; the view says its own sentences (each edit, "Loading N courses" and "N courses
  loaded", Restore and Forget).
- **The exports** (Phase 6 6D; ADR 0010's G1). "Download CSV" and "Print or save as PDF" sit in
  the view's actions, with the hint "On a phone: Share, then Print, then pinch out the preview to
  save the PDF. Excel shows one column? Use Data › From Text/CSV." Both draw one document
  (`export.js`), built from the same rows as the view, each entry at its own semester: the head
  (what it plans on which year's data, the year of study during the exchange, the date, the
  shortlist link at `https://nusmodfinder.rcn.sh`, the later-year line, NUS Mod Finder's name);
  each semester present, Sem 1 then Sem 2, its primary picks then its backups in rank order,
  then its totals; "Closed, or not on NUS's exchange list, in that semester"; "Not placed in a
  semester" (untagged, special terms only, catalogue-only and unknown 404s); then the foot (the
  form order per semester, the lines for applicants, the CourseReg box, the Canvas line, transfer
  of units, the lists' dates, what isn't checked, "Unofficial"). Each course carries its form
  number, list and rank, units, department, faculty, level (the brochure's bands), grading when
  not "Graded", whether it counts and why, its stamp and every note with its source and date,
  NUS's notes, its 2026/27 exam in Singapore time, NUSMods' workload with each part labelled,
  the estimate at NUS's 2.5 hours a week per unit, "Course description (NUS, via NUSMods)",
  NUS's prerequisite and preclusion, its flags and its NUSMods link. The CSV (`csv.js`) is RFC
  4180: the header first, one row per entry, then a padded empty row and the head, totals and
  foot as label/value rows (the Excel hint last); every field quoted, CRLF, UTF-8 with a BOM, and
  a field starting with `=`, `+`, `-`, `@`, a tab or a CR given a leading `'`. Its name is
  `exchange-shortlist-sem1-sem2-2026-27-courses.csv` (the semesters present; the rows' year). The
  PDF is the browser's own print of `#slPrint` (`print.js`), which the screen never shows: print
  shows it alone, light on white whatever the theme (the dark tokens apply to screen only), when
  `html.print-shortlist` is on. That class is derived from state (the view shown, every row
  settled, the export question answered or not needed), so Ctrl+P prints the shortlist then and
  the screen otherwise; printing sets the title to the file name and `afterprint` restores it.
  A press before every row is in keeps the button's name, says "Loading 7 of 12 courses" on the
  line it points to (`aria-describedby`) and in the live region, then "Ready: press again to
  download" (or "to print"), so the download or `print()` comes from the user's own click. An
  export writes `ay` into the URL. The print fonts load when the view opens.
- **Fonts** are self-hosted (`public/fonts/`, IBM's own Latin1 WOFF2 subsets, SIL OFL in
  `public/fonts/OFL.txt`) with `font-display: swap` and a system fallback stack; the page makes
  no request to any other origin. Plex Mono draws a dotted zero, so mono text sets its stylistic
  set 4, the plain one (Plex Sans's zero is plain already).

`public/` is the whole frontend (Phase 5 5B to 5D, `docs/plans/phase5.md`): `index.html`,
`styles.css` and native ES modules with `// @ts-check` and JSDoc, served by Workers Static
Assets (the `assets` block in `wrangler.jsonc`, no binding). No file there matches an API
path, so `/search`, `/facets`, `/module/:code`, `/health` and `/admin/*` still reach the Worker.
`public/_headers` (5G S3) sends every page file with `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and a CSP: `default-src 'none'`, the page's own scripts,
styles, fonts and API (`'self'`), `frame-ancestors 'none'`, and the one inline script in
`index.html` by its sha256. Change that script and `test/web/source.node.test.js` names the new
hash; `test/ui/headers.spec.js` checks the headers on the local stack (which applies `_headers`
as production does), that another origin can't frame the page, and that no flow trips the CSP.

| module | does |
|---|---|
| `state.js` | the state ↔ URL mapping (pure). In exchange mode `ng=1` and `study` are always in the URL; `open=` names the one open detail, and `from=` the entry whose "Also as" link opened it (kept only beside `open=`, and only while it is one of the open entry's own other codes: `app.js` drops any other, so a link can't claim two courses are one); `view=shortlist`; `urlFor(state, list, path)` writes the state and the shortlist together, and `shortlistUrl` Copy link's URL (no `q`, filters or detail) |
| `list.js` | the shortlist's half of the URL (pure): parsing with its caps, and every edit (add, remove and Undo, Move up and down, Make backup or primary, a semester, an invitation, `ay` once), each refusing past a cap with the reason |
| `history.js` | the one history writer: a sliding 10 s budget of 80 writes; past it, writes are held and go out 300 ms after the last, each replace folded into the write before it (a flood of edits is one write) and each push kept as its own; each write in `try`, a refusal retried with backoff (1 s … 10 s) with later writes queued behind it; `flush()` before `act()`, Copy link, exports, on hidden and `pagehide`; `cancel()` on popstate |
| `shortlist.js`, `preclusion.js` | the shortlist worked out (pure): each entry at its own semester; counted, to confirm with NUS, only if invited (Business and Law), or not counted and why; the same course listed twice (one group, both on the NG list or a preclusion naming the other, compared only with entries kept); NUS's form order per semester against 40 units; totals in tenths with the hours at NUS's rate; exam-overlap, preclusion and same-title flags; NUS's notes on particular courses; the cited lines (applicants, the CourseReg box, G2's maximum in Jacob's words, with a semester above 20 flagged). `preclusion.js` reads whether NUS's text names a code, skipping cohort-only branches and, at `grad`, undergraduate-only rules |
| `shortlist-view.js` | the view's DOM (6C): the heading, actions, export question, invitation, both lists' keyed rows (updated in place, never moving the focused row), the totals, the form order and the boxes, from the model `app.js` builds out of `shortlist.js`'s result; its buttons are handled by delegation (`data-act`) |
| `export.js`, `csv.js`, `print.js` | the exports (6D): `export.js` works `shortlist.js`'s result into one document (head, sections by semester, closed, not placed, foot; pure); `csv.js` writes it as RFC 4180 with the formula guard (pure); `print.js` draws it into `#slPrint`, the print page |
| `saved.js`, `year.js` | the list on this device (G3: save on the page's own edits, restore only when a link has none, forget); the acad year before any row loads |
| `nav.js` | the history transitions (pure): submit pushes, filter changes replace and drop `open=`, closing a detail goes `back()` only from the entry the page pushed, an "Also as" link pushes that code's search with its detail open; every action that changes `open=` drops `from=`. Phase 6: no transition touches the list; settings while the view is shown keep it and the submitted `q`; a submit closes it; opening and closing the view (6C wires them); `searchAgain`, whether Back or Forward searches (a changed search, or the same one after a network or server error, never after a 429) |
| `api.js` | the fetch layer: each search aborts the previous one, 10 s timeout, non-JSON bodies caught before parsing, `Retry-After` read on 429 |
| `messages.js` | a plain sentence for every error code and `noMatch` reason; raw codes are never shown |
| `format.js` | semester names, workload, exams in Singapore time, NUS prerequisite and preclusion spacing, the cohort-only prerequisite line, course codes in NUS's text, and the student's own text as the page's sentences repeat it (`quoteUser`: no bidi, zero-width or control characters, no quote mark or lookalike inside (one apostrophe instead), at most 60 characters, in curly quotes; 5G S2). A link's faculty is quoted the same way, in its chip and option, until `/facets` lists it; one it doesn't list is dropped |
| `explain.js` | exchange wording (pure): each stamp's words, each note in full with its lead-in word ("Places.", "Your major."), the `semester` note as an action, each source with its "updated as at" date, why a typed code is hidden (its own stored reasons) and its stamp, the partial-code empty state, the typed codes past the three that pin, and the count line for a query of codes only |
| `detail.js` | a card's detail, inline, from `/module/:code` (fetched once per page): its head (code, title, units, department; "Opened from …" after an "Also as" link), description, prerequisites and preclusions as NUS states them with codes linked to a search, exams, workload, exchange availability per semester, the NUSMods link for class times |
| `keys.js` | Enter submits only outside IME composition |
| `intents.js`, `intent-chips.js` | the phrases `/search` read from the query (5F's `interpreted`) as chip labels (pure), and the chip row under the count, each chip's button re-running the search with `ignore=` that phrase (`PARSE_PHRASES` is on since L8) |
| `icons.js` | the stamps' and controls' small line icons, built as SVG nodes, all decorative (`aria-hidden`) |
| `dom.js`, `render.js`, `app.js` | DOM nodes only (lint bans `innerHTML` and the other HTML sinks in `public/`); the entries (an APG disclosure each: a heading holding one button that controls the detail; the exchange stamp for the chosen semester, or one per semester when planning both, with the notes both share said once; no score), the hidden-codes box and the status area, with the sentence each answer gives the live region; the controller (the set-up screen, the rail's semester segment, the chips, the filters dialog, the skip link, the live region, focus after Escape and Back) |

`npm run typecheck` checks it with `tsconfig.web.json` (the DOM lib) and the Playwright specs
with `tsconfig.ui.json` (Node plus the DOM lib, for their `page.evaluate` callbacks); the pure
modules are unit-tested in Node (`test/web/`).

**Run it locally:**

```bash
npm run dev        # node scripts/ui-server.mjs: prints http://127.0.0.1:<port>; Ctrl-C stops it
```

`scripts/ui-server.mjs` runs `wrangler dev --local` on `test/wrangler.ui.jsonc`:
`test/ui/worker.js` (the Worker with `FakeAI`, the fixture bundle's embedder, and
`FakeRateLimit`) behind `public/`, over a fresh local D1 in a temporary directory. It applies
the migrations, seeds the fixture through `/admin/ingest?d1Only=1`, the catalogue-only rows
through `/admin/catalogue` and the NG list through `/admin/facets`, with a one-off
`INGEST_SECRET` in its own temporary env file (never `.dev.vars`), and deletes it all on exit.
No binding in that config reaches Cloudflare. It picks a free port (`--port N` to choose one;
8787 and 8799 are refused).

**UI tests** (Playwright, Chromium and WebKit, with `@axe-core/playwright`; `test/ui/*.spec.js`):

```bash
npx playwright install chromium webkit   # once
npm run test:ui                          # starts its own ui-server on a free port
VNM_UI_URL=http://127.0.0.1:<port> npm run test:ui   # or reuse a running `npm run dev`
```

Failure states (timeout, 429, an HTML error page, `/facets` down, keyword-only), a raw
workload, a failed `/module` and a 4th typed code that is neither shown nor hidden use request
interception; the cards, the detail (`?q=CODE&open=CODE`), the hidden-code lines and the
partial-code states run on the fixture. 5D's specs: `setup.spec.js` (the first screen),
`mobile.spec.js` (F10 and the chips), `fold.spec.js` (the 390×664 fold check, also as an
iPhone 13, after a shared link and a typed search) and `fonts.spec.js` (self-hosting, weights,
the plain zero); 5F's `intents.spec.js` tests the phrase chips on intercepted answers. SC8's
specs (5E): `a11y.spec.js` (axe with every rule on 24 states, 34 with 6C's, both themes, 1280 and 390×664, no
violation allowed; the experimental and off-by-default rules are on too, all but AAA's 7:1
contrast, since the bar is AA; the states the fixture lacks are intercepted), `keyboard.spec.js` (the whole
task keyboard-only at both widths, each stop's order and computed focus ring; in WebKit on a Mac
it presses Option+Tab, as Safari needs unless "Press Tab to highlight each item" is on),
`live.spec.js` (the live region's sentences, `aria-busy`, the never-disabled button, every
control's accessible name) and `aria.spec.js` (accessibility snapshots, committed in
`test/ui/aria.spec.js-snapshots/` and compared exactly; after a deliberate change,
`VNM_ARIA_UPDATE=1 npx playwright test aria --project chromium` rewrites them). `shots.spec.js` saves the
five mockup states from the real page in both themes to `docs/evidence/phase5/shots/` when
asked (`VNM_SHOTS=1 npx playwright test shots --project chromium`). 5G's: `sc2.spec.js` (SC2:
every fixture code, 434, through `?q=CODE&open=CODE`, each field with the fixture's value or its
"not listed" text, read by `test/ui/sc2-fields.mjs`, which the live checks share; about 25 s in
both browsers) and `mockup.spec.js` (the hidden-code stamps and "Switch to Sem 2", "Also as"
links and "Opened from", the detail's head, the code-only count line). Phase 6 6C's
`shortlist.spec.js` drives the toggles, the button, every row control by keyboard at both widths
(focus asserted in view and uncovered after each), the view's history (a 429 and a 500 behind
it, Escape, Back and Forward, a submit from it), rows arriving, each 404 kind, Try again, the
export question, Copy link, the invitation, Restore and Forget and a refused history write; 6C
adds its states to `a11y`, `aria`, `keyboard`, `live`, `fold`, `mobile` and `headers`. 6D's
`export.spec.js` downloads the CSV and reads it back with a strict RFC 4180 reader
(`test/web/rfc4180.node.mjs`) over every fixture NG code and the fixture's NG-listed codes at ug2
and grad, stubs `print()`, presses before the rows are in, checks Ctrl+P before and after the
export question and the print page under print media (only it shows, full width, AA on paper in
dark mode, axe), and reads Chromium's tagged PDF back (`test/ui/pdf-text.mjs`, no dependency:
Chromium's objects, Flate streams and ToUnicode maps); `test/web/csv.node.test.js` tests the
document and the CSV in Node. `VNM_EVIDENCE=<dir>` keeps the PDF. SC1 over
the shortlist is `test/shortlist-sc1.js`: every fixture code in `npm test`, every pinned code in
`test/sc1/paths.test.js`. CI's `ui` job runs them when `public/`, `src/`, `test/ui/`, the configs, the
fixtures, `data/` or the lockfile change (`scripts/ci-changes.mjs`, "CI" below). The Phase 4 page is kept frozen as
`docs/evidence/phase0/page-phase4.html` for the findings tests (`test/findings/frontend.node.test.js`).

## CI

`.github/workflows/ci.yml` runs on every push to `main`, every ready PR and by hand, with no path
filter: every job starts, so a change that only touches docs still runs `npm test` (whose tests
read README.md, EVAL.md, REFERENCE.md and other docs under `eval/`, `docs/year-refresh/`,
`docs/evidence/` and `docs/decisions/`; `test/docs-facts.node.test.js` holds the first three to the
system), and a red `main` shows. Draft PRs run nothing.

| Job | Runs | Skips |
|---|---|---|
| `changes` | `scripts/ci-changes.mjs`: the diff rule below | never |
| `check` | lint, typecheck, types drift, `npm test`, `test:eval`, `eval:verify`, `db:rebuild-check` | never |
| `eval-gate` | the ranking lock (below): fast path, else a recompute | never |
| `full-corpus` | `test/full` over the pinned corpus and bundle; the lexical grid in full or a 1-in-10 sample | by steps, when `code` is false |
| `sc1` | `test/sc1` (Vitest projects `sc1` and `sc1-node`) over production: `current` restored from its release asset, the production bundle and data files, after `npm run corpus -- check`; fails on any skipped test. SC1's two pinned-corpus facts (the standby's recall floor, the 3G ruling) run in `full-corpus` (`test/full/sc1-pinned.test.js`) | by steps, when `code` is false |
| `ui (chromium)`, `ui (webkit)` | the Playwright suite in Playwright's image | by steps, when `ui` is false |
| `rollover` | the year-switch rehearsal (`scripts/rollover.mjs`, 7E): the pinned corpus relabelled as next year's in a temp copy, then `year next`, the builders, `year check`, a local Worker switched by `ingest --d1-only --allow-year-change --write-budget 80000`, `verify --pre-deploy`, SC1 against next year's oracle, and the variant with Sem 2 unpublished | by steps, when `rollover` is false |

`scripts/ci-changes.mjs` diffs a PR against its base, and a push to `main` against the newest `main`
commit whose CI run succeeded and which HEAD contains (`gh run list`, hence `actions: read`). `code`
is any change outside `docs/` and the root `*.md` files; `ui` and `grid` are the paths those suites
cover; `rollover` follows `code`. A manual run, an API error, no green
run, an unreachable base, a failed diff, or a change to `ci.yml` or the script itself runs
everything. A heavy job whose `changes` failed runs in full (a missing output is not `false`), and
every heavy job's check name always reports. Runs on `main` are grouped per sha, so none cancels
another; a PR's new push cancels its superseded run. `test/ci-workflow.node.test.js` holds this shape.

## Deploying

```bash
npm run deploy                    # preflight, guard, upload, startup gate, promote, tag, triggers
npm run deploy -- --preflight     # the preflight alone: before any D1 write (runbook step 3)
npm run deploy -- --behind-ok     # a HEAD behind origin/main's tip (logged; see below)
```

This is the only supported way to deploy, from the Mac or from GitHub Actions (below).
`scripts/deploy.mjs`:

1. **the preflight** (`scripts/preflight.mjs`), every check but D1's, stopping at the first that
   fails:
   - `git`: the working tree is clean (new, untracked run records under `docs/evidence/ops/runs/`
     aside; a modified tracked file there still refuses), nothing is hidden by assume-unchanged or
     skip-worktree, and `HEAD` is on `origin/main` at its tip. A `HEAD` behind the tip refuses
     unless `--behind-ok` (for when D1 was already written for `HEAD` and an unrelated PR merged
     since); the flag is logged in the run record;
   - `ci`: `HEAD`'s own `CI` and `Findings` push runs succeeded (`gh api …/actions/runs?head_sha=`).
     A run in progress names `gh run watch <id> --exit-status`; a failed or cancelled one,
     `gh run rerun <id>`;
   - `vars`: `wrangler.jsonc`'s vars hold only `DENSE_BACKEND`. The file is read as JSONC
     (`scripts/jsonc.mjs`), so an object-valued var counts like any other, and a file or `vars`
     it can't read fails the check (red team L-2);
   - `bundle`: the production bundle `data/vectors.json` records (downloaded from its release if
     absent), sha256-checked, at `src/data-version.json`'s data version; never the fixture or
     pinned bundle;
   - `corpus manifest` (7D, `scripts/corpus.mjs`): restores `current` (`npm run corpus --
     restore`, sha-checked), then `npm run corpus -- check`: `src/data-version.json`, the bundled
     catalogue file's `catalogueKey` and the 3B files follow it;
   - `year check` in its CI mode (7E, `scripts/year.mjs` `preflight()`): the year's sources agree
     (the three year places, the data files' years and dates against the source manifest), no stub
     remains, the per-corpus files are production's, the counts, an oracle for the year, and every
     indexed NUS quote still in its file;
   - `source inputs`: when `HEAD` changes a source-derived input (`data/ng-*` but
     `data/ng-unscheduled.json`, which follows the corpus; `scripts/ng-overlay/`; a quoted NUS
     sentence counts through the quote index) since the live commit (the newest `deploy/*` or `rollback/*` tag), a
     committed `year check --full` run record (7E) whose `details.sourceInputsHash` is those
     inputs' hash at `HEAD` and whose `details.ngList.result` is `byte-identical` (a record from
     before the red team's H-1 fix doesn't count) (`sourceInputsHash` in `scripts/preflight.mjs`: sha256 over their
     `git ls-tree` lines). A hotfix that touches none needs no sources key;
   - `startup`: `wrangler check startup` locally with the bundle aliased in;
2. **the guard** (`scripts/guard.mjs`): reads D1 over the D1 REST query endpoint
   (`scripts/d1-rest.mjs`, ~6.8k module and ~14.4k catalogue rows read, the count taken from the
   answers' `meta.rows_read`) and computes what `GET /admin/hashes` would answer, with the same
   code (`src/admin-hashes.js`). Every row is read with every column and its hash recomputed from
   them with the functions ingest writes it with (`src/rowhash.js`; red team M-1), never taken
   from the stored `row_hash`; D1 bills rows, not columns, so the read costs the same. It refuses
   unless D1's (code, `text_hash`) pairs hash to the bundle's `rowsKey`, D1's data version (over
   the recomputed hashes) is the committed one, every `modules` row's stored `row_hash` is its
   columns' hash (`rowHashes`), D1's `catalogueKey` (its `catalogue_only` codes, 7D) is the
   bundled catalogue file's (`data/catalogue-codes.json`), and every `catalogue_only` row's
   stored `row_hash` is its columns' hash, the year included (`catalogueRows`). No Worker session
   starts and no secret is bound. The checks are a list (`GUARD_CHECKS`); one with a `field`
   (`dataVersion`, `catalogueKey`) also goes into the deploy tag and rollback's data check, and
   one marked `integrity` (`rowHashes`, `catalogueRows`) runs in rollback's data check too;
3. `wrangler versions upload --tag <short sha> --message "<sha> <subject>"`, and refuses to
   promote a version whose reported startup time is missing or over 200 ms;
4. **the intent record**: the version id, the previous one (`wrangler deployments status
   --json`), the data version and the startup time, printed and put in the run record before
   the promote. If the live deployment can't be read, it doesn't promote;
5. `wrangler versions deploy <id>@100%`, then **the tag**: an annotated
   `deploy/<UTC yyyymmddThhmmssZ>-<version id, first 8>` on `HEAD`, one `key: value` paragraph
   per field (`versionId`, `previousVersionId`, `commit`, `dataVersion`, the guard's fields,
   `startupMs`, and `actionsRun` from Actions), pushed to origin. A failed push prints the
   command to retry; the version is live either way. Then `wrangler triggers deploy` for the
   Custom Domain. A SIGINT, SIGTERM or SIGHUP after the promote finishes the tag and the record,
   skips the triggers (it prints the command) and exits 130, 143 or 129.

Every run, refused or live, writes one run record (see "Operations" below) with the preflight's
checks, the guard's read, the version ids, the tag and the outcome; `--preflight` writes a
`deploy:preflight` record, which `ingest` looks for. The tags are the deploy trace in git:
`/health`'s `versionTag` is the commit of the newest `deploy/*` or `rollback/*` tag.

**The D1 REST reads.** The client sends one statement per request and refuses, in code and
before anything leaves, any statement but one `SELECT` or one schema-reading `PRAGMA`
(`table_info`, `index_list` and the like, never an `=` form). After comments and literals are
stripped, no write keyword (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `DROP`, `ALTER`,
`ATTACH`, `DETACH`, `VACUUM`, `REINDEX`, `RETURNING`) may appear anywhere, and no `$`, `@`, `:` or
`#` at all: SQLite's named and TCL-style parameters can swallow a quote and hide a second
statement (red team M-3). Every caller sends a constant with `?` parameters. The token is
`CLOUDFLARE_API_TOKEN`, else `npx wrangler auth token --json` captured in-process (the Mac's
wrangler login); it is never printed, logged, put in an error or recorded. The account is
`CLOUDFLARE_ACCOUNT_ID`, else the account wrangler cached
(`node_modules/.cache/wrangler/wrangler-account.json`), else the one account `wrangler whoami`
lists; set the variable if none gives one. The
database is the `d1_databases` entry bound as `DB` in `wrangler.jsonc`, wherever it is listed;
none, or two, is refused (red team L-3). Rollback and `d1:restore` read through the same client.

**Deploying from GitHub Actions** (`.github/workflows/deploy.yml`, ADR 0011 G1). It runs on
`workflow_run` when `CI` or `Findings` completes on `main`, and `scripts/deploy-gate.mjs` lets
it deploy only when that sha's `CI` and `Findings` push runs both succeeded, the sha is still
`main`'s tip (otherwise the newer commit's runs deploy it), and no `deploy/*` tag names it yet
(the second event finds the first's tag). It checks out exactly that sha and runs
`npm run deploy`, the same command as above, in the `deploy-production` concurrency group (never
cancelled mid-run). Then it smokes the deployed commit (`npm run smoke -- --expect <sha>`, below),
and a failed smoke fails the job, which GitHub reports. The smoke step has no secret and no token:
the deploy step has already put the production bundle in `.data/vectors/` and restored `current`
to `.data/prod/`, so smoke's own restores are no-ops (if the step ever moves before the deploy, it
needs `GH_TOKEN`). Permissions: `contents: write` (the tag push) and `actions: read`. Only the
deploy step sees `CLOUDFLARE_API_TOKEN` (a secret) and `CLOUDFLARE_ACCOUNT_ID` (a repo
variable). The run records (the deploy's and the smoke's) are kept as an artifact for 90 days and the
deploy writes a job summary;
nothing is ever committed to `main` from CI, which would start CI and then a deploy in a loop.
The pushed tag is the durable trace. Re-ingests (D1 writes) stay on the Mac: if the guard finds
D1 differs from the bundle, the job fails, says the re-ingest runs on the Mac through the
runbook, and deploys nothing; that deploy then runs on the Mac.

**The kill switch:** the job runs only when the repo variable `DEPLOY_FROM_ACTIONS` is `true`.
It has been `true` since the first watched Actions deploy (7G, 2026-11-12, run 43209550016). Unset
it to stop Actions deploys at once; the Mac's `npm run deploy` is unaffected. With it on, every push
to `main` deploys once its CI is green, a docs-only one too (the guard's ~21k rows read each time).

**The deploy token** (an account-owned API token, the dashboard's "API token for external
CI/CD"), stored as the repo secret `CLOUDFLARE_API_TOKEN`:
- Workers Scripts: Edit, on the `nusmodfinder` Worker only (`versions upload`, `versions
  deploy`, `deployments status`);
- Workers Routes: Edit, on the `rcn.sh` zone (`wrangler triggers deploy`, the Custom Domain);
- D1: Read, for the account (the guard's REST query).

7-0 proved it answers a `SELECT` over the D1 REST query. `versions upload`, `versions deploy`
and `triggers deploy` with it are proven by the first watched Actions deploy.

**Rollback.**

```bash
npm run rollback                         # to the deployment before the live one
npm run rollback -- --to <version id>    # or its first 8
```

`scripts/rollback.mjs` takes the target's commit and data version from its `deploy/*` tag, reads
D1 directly over the REST query (no Worker session, no working-tree code; ~21k rows) and
refuses unless every tagged field (`dataVersion`, `catalogueKey`) equals D1's and every row's
stored `row_hash` is its columns' hash (the guard's `integrity` checks); a tag without one of the
fields is refused too. A deliberate
mismatch needs `--accept-data-mismatch`, which prints the risk; the usual path across a data
change is `npm run d1:restore` first, then rollback. It asks before acting (or `--yes`), runs
`wrangler rollback <id> --message "rollback to <tag>" -y`, tags `rollback/<time>-<id8>` on the
target's commit and pushes it (a failed tag is reported, not fatal), and prints
`npm run smoke -- --expect <target sha>`. It needs no clean tree and no CI. The Vectorize standby
is not rolled back: if it matters (a `DENSE_BACKEND` flip), rerun `npm run remote -- vectors
standby` from the target commit. Wrangler leaves bound resources alone, so a rollback is code
only. The rename made a new Worker: nothing before `59986aa3` is a target.

**D1 bookmarks and restores.**

```bash
npm run d1:bookmark                      # D1's current Time Travel bookmark, recorded (a read)
npm run d1:restore                       # back to the newest recorded bookmark (a D1 write)
npm run d1:restore -- --bookmark <id>
```

`d1:bookmark` runs `wrangler d1 time-travel info nusmods-apac --json` and records the bookmark;
the next `ingest` copies it into its own record. `d1:restore` takes the newest bookmark record
(or `--bookmark`), prints it, its age and the ingest it came before, asks (or `--yes`), runs
`wrangler d1 time-travel restore nusmods-apac --bookmark <id> --json`, records the restore with
the bookmark that undoes it, and re-reads D1's data version over the REST query. The code stays
where it is: this undoes "ingest done, deploy refused". Bookmarks reach back 30 days, and an
older one is refused. A restore rewrites the database in place but isn't billed as rows written.

**Smoke.**

```bash
npm run smoke                            # against HEAD's files
npm run smoke -- --expect <sha>          # after a rollback, the target's
```

`scripts/smoke.mjs` sends five requests, one at a time, each at least 4 s after the last answer:
`/health` (the tag is a prefix of the commit, the data version is its `src/data-version.json`, the
bundle is `production`), `/` (200 with the CSP header), `/module/<code>` for a code in no group
whose title is unique in that commit's corpus and bundle, `/search` for the title `/module`
gave (`cache;desc=miss`, not degraded, the code in the top 5) and `/facets`. The data version,
the groups and the bundle's codes come from the expected commit's files; titles come from its
production corpus, `current` in its `data/corpus.json` (restored and sha-checked; a commit from
before the manifest uses the working tree's, and says so). The URL is `wrangler.jsonc`'s
Custom Domain at that commit, or `--url`. Every Actions deploy runs it as its last step; after a
deploy or a rollback from the Mac, run it by hand. It costs 5 GETs and one uncached search
(about 0.03 neurons).

**Back-filled tags.** The two Phase 6 deploys predate the tags; `node scripts/deploy-tag.mjs
backfill` prints the commands that create and push them (`deploy/20261111T183946Z-f8aefeab` on
`0b5f360`, `deploy/20261111T235933Z-b0834844` on `a23601d`, both at data version
`d820d578cf81` and `catalogueKey` `5b1e2f06e559`, marked `backfilled: true`). It runs nothing.
Their `catalogueKey` is computed, not read: when they were cut, D1 had been loaded from
`prod-2026-2027-20261104` (then `current`) and not written since, so it is that corpus's
catalogue-only key; the first
`catalogueKey` read of D1 after 7D checks it.

Plain `npx wrangler deploy` would ship the fixture bundle. Don't use it.

To check what's live: every Worker response carries `x-app-version` (the tag, else the version
id), and `GET /health` returns `{ ok, versionId, versionTag, dataVersion, vectors }` without
touching D1. `vectors` is the bundle's `{ corpus, count, dataVersion }`, so after a deploy it
must say `production`. The page (`/` and the files in `public/`) is static assets, answered
without running the Worker, so it carries no `x-app-version`: `GET /health` is the version
trace for `/`, and a deploy ships the page and the Worker as one version.

**Live checks after a page ship** (Phase 5 5G). After a deploy that changes `public/`, from the
deployed commit on `main`, after the smoke:

```bash
node scripts/p5-live.mjs --dry-run   # the draw; sends nothing
node scripts/p5-live.mjs             # about 7 min; exit 0 only if every check passes
git add docs/evidence/phase5/p5-live.jsonl   # commit the log
```

It checks the live page in Chromium (and WebKit for the iPhone 13 fold):
- SC2 on 20 codes drawn with seed 5 from `current` (`data/corpus.json`, restored into
  `.data/prod/<sha256>.json`), normalised as ingest does, 4 each with exams in two semesters, a cohort-only
  prerequisite, no workload, two or more notes, and none of those;
- axe (every rule but AAA's 7:1) on the first screen, an open detail and a hidden code, light
  and dark, at 1280 and 390×664;
- the 390×664 fold, in Chromium and as an iPhone 13 in WebKit;
- the hidden-code explanation for 3 drawn closed codes (off the NG list, listed for the other
  semester only, closed by a restriction: line, stamp and switch as the page's rules give them
  from each code's `/module` answer) and 1 drawn partial code;
- `/health`: `versionTag` is a prefix of `HEAD`, the data version is `src/data-version.json`'s,
  and the bundle is `production`.

Every request it or its browsers send starts at least 4 s after the last (about 100 requests).
The page's files, `/facets` and any answer already fetched are fetched once and then served to
the browsers from memory. Each request, sent or served from memory, is a line in the JSONL log
(`--log`, default `docs/evidence/phase5/p5-live.jsonl`), with a summary line at the end. A 429
is waited out and re-sent twice at most. Against `npm run dev`, `--url http://127.0.0.1:<port>`
draws from the fixture and expects no version tag.

**Shortlist live checks** (Phase 6 6E). After the deploy that ships the shortlist, from the
deployed commit on `main`:

```bash
node scripts/p6-live.mjs --plan   # the draw and the 12 calls; sends nothing
node scripts/p6-live.mjs          # about 4 min; exit 0 only if every check passes
git add docs/evidence/phase6/p6-live.jsonl   # commit the log
```

It first fetches, from Node, every answer the check needs: `/facets`, the shortlist's 8
`/module` answers and 3 404 codes' (one `ng-listed`, one `catalogue-only`, `CS9999` as
`unknown`), one call in flight and each at least 4 s after the last. Then Chromium and WebKit
load the page, their `/module` and `/facets` calls served from that memory (any other API call
is refused and fails the run), so the page's 10 s timeout never fires and nothing is sent twice.
The page's files come from the network through the same queue, once each (31 on the local
stack; 43 requests in all). The shortlist is drawn with seed 6 from the production-normalised
modules: 6 picks and 2 backups over Sem 1 and Sem 2 at `ug2`, with a counted, a to-confirm, a
Business ("only if invited") and a closed entry, no two in one group. Each entry's standing
comes from the independent reference (`test/web/shortlist-reference.node.mjs`, which 6B's
property test also runs) and its status from the SC1 oracle. Checks: the view's rows and stamps;
the view's totals equal the reference's, and the downloaded CSV's equal the view's; the CSV
reads back strictly; Chromium's tagged PDF holds every description; axe on the view, light and
dark, in both engines; the 390×664 fold on the view (header, search bar, the view's heading and
its export buttons), in Chromium and as an iPhone 13; each 404 answers its kind. Every call,
sent or served from memory, is a line in the log (`--log`, default
`docs/evidence/phase6/p6-live.jsonl`) with a summary line at the end. Against `npm run dev`,
`--url http://127.0.0.1:<port>` draws from the fixture.

**Instrumentation.** `/search`, `/module/:code` and `/facets` responses carry a
`Server-Timing` header. `/search` has spans `cache` (`desc=hit|miss`), `limit`, `pin`,
`embed`, `vector`, `fts` and `hydrate` for the stages that ran (pin, `fts` and
`embed`→`vector` run concurrently; the header keeps that order), `degraded`
(`desc=<source>-<reason>`) on a keyword-only fallback, plus `total` from fetch entry. `/module` and `/facets` have `d1` and `total`. workerd's clock only advances across
I/O, so the spans measure waiting on bindings, not CPU. A cache hit gets fresh spans,
never the stored ones. Each `/search` also writes one JSON log line (`"event":"search"`)
with the status, cache result, the query (first 100 characters) and its length, the mode,
filters, result counts, the fallback (`degraded`), spans, D1 rows read and serving region
(`d1.servedByRegion`, `d1.servedByPrimary`), and the colo. The `search` and `d1_error` lines
hold no header or IP (the `unhandled` line, below, carries the `cf-ray`). A D1 failure on `/module/:code` or `/facets` writes one line
`{"event":"d1_error","route","error"}`: the route pattern and the error, no URL, code, query or IP.

**What is kept about visitors** (ADR 0012 G3 (a): kept as it is, and said in
`public/privacy.html`). `observability` is on with no `logs` block, so Workers Logs keep an
invocation log for every Worker request (the request URL, so the search text and filters, and the
request's metadata and headers, `cf-connecting-ip` among them) beside the Worker's own lines, for
7 days on Workers Paid (Cloudflare's Workers Logs docs; Workers Logs move to Observability pricing
on 2026-12-01, and the note promises nothing past today's retention). Cloudflare's zone analytics
keep sampled request records, the page's own `/?q=…` included, which the Worker can't turn off.
The page keeps the year of study and the last edited shortlist in `localStorage` and sets no
cookies. A change to any of these changes the note in the same PR.

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
catalogue update, a re-embedding, a row-only change. Step by step for the two common cases:
[`docs/year-refresh/README.md`](year-refresh/README.md), "A corpus-only refresh" (NUSMods
changed; the weekly drift issue links there) and "A year switch". The deploy guard refuses any commit whose
manifest D1 does not yet hold, so the manifest merges first and D1 is written before the deploy.
Vectorize, the standby, is written last.

```bash
# 0. A new corpus (a catalogue update, a new acad year): fetch it, then publish it as the next
#    entry of data/corpus.json (the corpus manifest, below). --new-data-version because its
#    rows differ from what src/data-version.json records; step 1 writes the new one.
npm run corpus -- fetch [<year>]
npm run corpus -- publish --new-data-version
#    Any other change starts from the corpus production already has:
npm run corpus -- restore
# 1. Offline, on a branch: the production bundle and the data version D1 will have.
node scripts/vectors.mjs data-version                              # what ingest would write
node scripts/vectors.mjs build --corpus production --expect-count <rows>
#    If texts are missing from the eval asset, it writes .data/vectors/missing-production.json
#    and stops; embed them (neurons logged), then rebuild with --extra:
npm run eval:embed -- --texts .data/vectors/missing-production.json --out .data/vectors/extra-production.json
node scripts/vectors.mjs build --corpus production --expect-count <rows> --extra .data/vectors/extra-production.json
gh release create <release> .data/vectors/<asset> --title <asset> --notes "vectors bundle, sha256 <sha256>"
#    For a new acad year, rebuild the reason texts from that year's rules file first:
node scripts/build-ng-reasons.mjs
#    The build rewrites 6A's NG-listed codes with no classes too; both checks must pass:
node scripts/build-groups.mjs --corpus production --check
node scripts/build-ng-unscheduled.mjs --corpus production --check
npm run corpus -- check   # the data version and catalogueKey follow current; the 3B files are fresh
git add data/corpus.json data/vectors.json src/data-version.json data/vocabulary.json data/groups.json data/ng-unscheduled.json data/ng-reasons.json data/prefixes.json data/catalogue-codes.json data/catalogue-only.json   # the build rewrites 3C's vocabulary, 3F's groups, 6A's file and the 3B catalogue files too; plus any code the change needs; open a PR
#    A new acad year changes DEFAULT_ACAD_YEAR in scripts/lib.mjs, public/year.js and the header
#    in public/index.html, the only places in code a year is written (test/year-scan.node.test.js
#    fails on any other and checks those three agree; a year's own overlay and oracle files are
#    exempt). The docs' <!-- year:live --> sentences change too (test/docs-facts.node.test.js;
#    docs/year-refresh/README.md step 7). The
#    whole year switch, sources to standby, is docs/year-refresh/README.md; it passes
#    --write-budget 80000 at step 4, since every module and catalogue_only row is rewritten.
# 2. Merge it. Nothing deploys yet: the guard refuses until D1 matches.
# 3. On merged main, before any D1 write: the preflight (every check but D1's), then D1's
#    Time Travel bookmark, recorded (ingest copies it; d1:restore returns to it for 30 days).
npm run deploy -- --preflight
npm run d1:bookmark
#    Steps 4, 5 and 8 each start their own wrangler dev --remote session through npm run remote:
#    a free port, a one-off INGEST_SECRET in a temp env file, code 10021 retried for up to 30 min,
#    the session stopped when the command ends. Nothing reads or writes .dev.vars.
# 4. D1 only: no Workers AI, no Vectorize. Reads only current (restored, sha-checked); refuses
#    unless it hashes to the committed data version.
npm run remote -- ingest --d1-only
# 5. D1 against the manifest and the bundle, before the deploy. Reads no Vectorize. 6A: also
#    data/ng-reasons.json's and data/ng-unscheduled.json's acadYear equal D1's acad_year, and the
#    latter holds exactly the NG codes with no D1 row. 7D: and D1's catalogueKey (its
#    catalogue_only codes) equals data/catalogue-codes.json's; the deploy guard checks it too.
npm run remote -- verify --pre-deploy
# 6. Preflight, guard (over the D1 REST query; no session), startup gate, promote, tag, triggers.
npm run deploy
# 7. Smoke: five requests, >= 4 s apart. On failure: npm run d1:restore, then npm run rollback,
#    then npm run smoke -- --expect <target sha>. Deploy refused after step 4: npm run d1:restore,
#    fix the cause, resume from step 3.
npm run smoke
# 8. The standby: upsert every code (bundle values, D1 metadata, ≤ 1,000 a batch), delete
#    every index id D1 no longer holds, wait for the mutation, then verify, values included.
npm run remote -- vectors standby
```

Steps 4, 5, 6 and 8 leave run records (`npm run remote` writes one for the session, and the
command its own); commit them with the change that follows. Steps 3, 6 and 7 leave theirs too
(`deploy:preflight`, `d1:bookmark`, `deploy`, `smoke`); `ingest` warns when `HEAD` has no
preflight record. Between steps 4 and 6 the
live Worker searches its old bundle against the new D1, so `/search` re-checks every dense-only
candidate's filters against its fresh D1 row after hydrate and drops those that fail. Its old
groups and `ng-unscheduled.json` sit beside the new rows too: a code that gained a row answers
from the row, and `otherCodes` is only compared within one shortlist.

`npm run ingest` without `--d1-only` still embeds and upserts as described below, for a
database with no bundle to match (a local one, or a cold load).

Before any remote write, estimate it and check the month's account-wide D1 usage
(`docs/decisions/0004-workers-paid-and-single-judge.md`): proceed only if the estimate × 1.5
fits in the remaining included writes.

A run for a different acad year than D1 holds is refused unless you pass
`--allow-year-change` (it rewrites every row to the new year). Pass `--allow-mass-delete`
as well if more than 5% of the codes D1 holds leave the corpus, in `modules` or in
`catalogue_only` (red team L-1); without it the run is refused before any write.

**What a run does.** It compares two hashes per module with what D1 holds
(`GET /admin/hashes`): `text_hash` (embedding model + embedded-text version + text) and
`row_hash` (normaliser version + every column D1 stores + the Vectorize metadata).
`/admin/hashes` and `GET /admin/catalogue` recompute each stored row's hash from its columns and
answer null where the stored `row_hash` differs, so a row changed behind its hash (a hand
`d1 execute`) is rewritten by the next run (red team M-1).

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
local D1 ([`ingest-cost.md`](evidence/phase1/ingest-cost.md) "Remote estimate"). A
forced re-ingest of rows this script wrote costs the same.

**Do not cold-load the remote database with the default budget.** Loading an empty
database writes ~48k table and index rows plus ~89k FTS5 shadow rows, about 137k in all.
That fits the Workers Paid allowance (50M a month, ADR 0004), but the budget charges ~149k
and stops a run at the 40k default, so pass `--write-budget` explicitly. The remote billing of
FTS writes on inserts has not been measured
([`ingest-cost.md`](evidence/phase1/ingest-cost.md)).

**The corpus manifest** (Phase 7 7D). `data/corpus.json` lists every production corpus by its
GitHub release asset (`prod-<year>-<yyyymmdd>`, the gzipped moduleInfo.json, ADR 0011 for the
licence) with its sha256, size and the time NUSMods served it, and names `current`, the one
production runs on. Ingest, `vectors.mjs build --corpus production`, `vectors.mjs data-version`,
every per-corpus builder (`build-vocabulary`, `build-groups`, `build-ng-unscheduled`,
`build-3b-data --corpus production`) and the live probes read only `current`, from
`.data/prod/<sha256>.json`, sha-checked, with the NG files of its year; none fetches from
NUSMods, and a missing or mismatched file is refused with the command that fixes it.

```bash
npm run corpus -- restore            # current from its release asset into .data/prod/ (gh, sha-checked); any worktree
npm run corpus -- check              # CI: data version and catalogueKey follow current; the 3B files are fresh
npm run corpus -- fetch [<year>]     # NUSMods' moduleInfo.json into .data/staging/ (the only fetch)
npm run corpus -- publish [--file <path>] [--fetched-at <iso>] [--new-data-version]
                                     # the staged (or --file) corpus as the next release asset and current
```

`publish` refuses a corpus whose data version (with HEAD's NG files) is not
`src/data-version.json` unless `--new-data-version`, and a release the manifest already
lists; it writes a run record. Commit `data/corpus.json` after it. The eval's pinned
snapshot (`.data/2026-2027-moduleInfo.json`, `scripts/pinned-corpus.mjs`) is separate and
never moves. `scripts/probe.mjs` and `eval/v1/` still use the old `.data/cache/` download.

**The catalogue files follow production.** `data/prefixes.json`, `data/catalogue-codes.json`
(the `catalogue-codes-data` and `prefixes-data` aliases) and `data/catalogue-only.json` are
built from `current`; `data/pinned/` holds the pinned corpus's two files, which the eval, the
workers and full-corpus tests read. `catalogueKey` (`src/rowhash.js`) is the sha256 of the
sorted catalogue codes; `/admin/hashes` and `verify --pre-deploy` report D1's, from its
`catalogue_only` codes, and the deploy guard and `verify --pre-deploy` refuse one that is not
the bundled file's (`scripts/catalogue-check.mjs`).

Other flags: `--force` (re-embed and rewrite everything), `--batch`, `--concurrency` and
`--wait-timeout` (default `10m`). Exit codes: 0 done, 1 refused or failed, 2 stopped by
the budget, 3 Vectorize did not confirm the last mutation in time (D1 is complete; rerun
the same command later, then verify).

**The admin routes do not exist in production.** `/admin/*` returns 404 unless an
`INGEST_SECRET` is bound, and the deployed Worker has none. Ingest is run locally against
`wrangler dev --remote`. Do not `wrangler secret put INGEST_SECRET` unless you intend to
expose a write endpoint on the public URL.

## Operations

**`npm run remote -- [--port <n>] <command…>`** (`scripts/remote.mjs`, Phase 7 7C) runs one
command against production D1, Vectorize and Workers AI through a fresh `wrangler dev --remote`
session (`scripts/remote-session.mjs`; the deploy guard no longer uses one, it reads D1 over REST):

- `wrangler dev --remote --ip 127.0.0.1` on a free port; 8787 and 8799 belong to other projects
  on the dev Mac and are never used;
- a one-off `INGEST_SECRET` in a 0600 env file in a fresh temp dir, passed with `--env-file`, so
  wrangler never loads `.dev.vars` (and neither does the script);
- `/health` polled until it answers; Cloudflare's `code 10021` (a session that failed to
  generate its D1 binding) is retried every 30 s for up to 30 minutes, each try logged;
- the command runs with `WORKER_URL` and `INGEST_SECRET` set; `ingest`, `verify` and
  `vectors` name `scripts/<name>.mjs`, anything else runs as given, without a shell;
- the session is stopped (its process group, SIGKILL after 5 s) and the temp dir deleted when
  the command ends, on a throw, and at exit. A first Ctrl-C goes to the command, which stops
  cleanly (ingest records its in-flight mutations), and the session stays up until it has; a
  SIGTERM sent to `npm run remote` alone is passed on to the command. A second signal, or a
  SIGHUP (a closed terminal), stops the session and the command at once.

The exit code is the command's (1 when the session never answered, 2 on a usage error).

**No default URL.** `ingest`, `verify` and `vectors standby` refuse to run without `--url` or
`WORKER_URL`, and refuse ports 8787 and 8799, before sending anything.

**Run records** (`scripts/run-record.mjs`). Every script that touches a remote writes one JSON
file per run, on every exit path, at `docs/evidence/ops/runs/<UTC yyyymmddThhmmssZ>-<script>-<4
hex>.json`. Unique names mean two worktrees never conflict. Commit them; `npm run deploy`
ignores new, untracked ones when it checks the tree is clean. Writers today: `deploy` (and
`deploy:preflight`), `remote`, `ingest`, `verify`, `vectors standby`, `smoke`, `rollback`,
`d1:bookmark`, `d1:restore`, `eval:embed` (which keeps `neurons.tsv` too), `ops:report`, `p5-live`
and `p6-live` against a live URL (not `localhost`), `corpus publish`, `sources publish` (the
archive's release and sha256) and `year check --full` (mode `full`, the source-derived inputs' hash,
the archive's sha256; the deploy preflight reads it). The schema capture (`docs/evidence/phase7/schema/`) is
`wrangler d1 execute` output and has no run record. An Actions deploy's record is a workflow artifact, not a commit.

The record (schema `vnm-run/1`):

| Field | What |
|---|---|
| `time`, `finishedAt` | ISO UTC; `time` is the start and names the file |
| `script`, `args` | e.g. `ingest`, `["--d1-only"]` (never a secret) |
| `commit` | `{ sha, dirty, diffSha256 }`: HEAD, whether the tree is dirty (new run records aside), and when it is, the sha256 of `git diff HEAD --binary` |
| `target` | the URL, the Worker or the service the run touched |
| `read`, `written` | lists of `{ what, estimate, actual }` (D1 rows, Vectorize vectors, neurons) |
| `requests` | live requests sent, by path (no query string, no account id), plus one `wrangler <command>` entry per wrangler command that calls Cloudflare's API (each try of a `wrangler dev --remote` session, `versions upload`, each `vectorize list-vectors` page) |
| `versions` | version id, tag, data version, mutation id: whatever the run made or saw |
| `bookmark` | a D1 Time Travel bookmark, or null |
| `details` | anything else (the session's port and tries, a mode) |
| `outcome`, `exitCode`, `message` | `ok`, `refused` (stopped at a check before writing), `failed`, `partial` (stopped part-way, resumable) or `interrupted`; the exit code; one line |

A writer starts the record once it reaches for the remote (a usage error before that leaves
none) and finishes it on every return:

```js
import { startRun } from './run-record.mjs';
const run = startRun('d1:bookmark', { target: 'nusmods-apac', args: argv });
run.guardExit();                         // at exit, or on SIGINT/SIGTERM/SIGHUP (then exits 130/143/129),
                                         // writes it if nothing else did; { signals: false } if the
                                         // script handles signals itself (ingest)
run.read('D1 Time Travel info', { estimate: 0, actual: 0 });
run.setBookmark(bookmark);
run.finish('ok', { exitCode: 0 });       // once; a second call is a no-op
```

`run.countingFetch(fetch)` counts each request by path; `run.request(path)` counts one by hand.
Records go to `$VNM_RUNS_DIR` when it is set (the node test project sets a temp dir), and the
module refuses the repo's dir under Vitest. `npm run check:findings` validates every file there:
the schema, an ISO UTC time (and `finishedAt`) not in the future, an outcome, every field above
with its type, and a name matching the record.

**`npm run ops:requests`** prints live-call totals from `docs/evidence/requests.tsv` (rows
1–131, typed by hand, plus the back-fill of the ADR 0009 and rename deploys and two correction
rows) and from the run records, by script and path. A `ref` row in the TSV counts only the
calls it states first, so that half is a lower bound: the rows that state no count are listed,
and so are the rows that describe more calls than their count (a `/health` before the deploy,
"plus 7 re-sends"). Phase 7's
7-0 reads, made before this tooling, are in `docs/evidence/phase7/remote-ops.md`.

**`npm run ops:report -- [--month <yyyy-mm>]`** (`scripts/ops-report.mjs`, Phase 7 7F) writes
the month's usage report to `docs/evidence/ops/<month>.md`, with a run record. Run it on the Mac
monthly (the monthly reminder issue asks for last month's) and after a ship that changes the
search path, then commit both files. The month defaults to the current UTC one.

- **What it reads.** Cloudflare's GraphQL Analytics API: two calls, one combined query for the
  month and one for the month before, at least 4 s apart. Account-wide Worker requests and CPU
  (`workersInvocationsAdaptive`), D1 rows read and written (`d1AnalyticsAdaptiveGroups`) and
  Workers AI neurons by day (`aiInferenceAdaptiveGroups`), each against Workers Paid's allowance
  (`ALLOWANCES` in the script, which cites the pricing pages). Then this Worker's share: requests,
  CPU, CPU per request p50 and p99, exceptions, requests by HTTP status, and `nusmods-apac`'s rows.
- **Flags:** anything above 25% of its allowance, and anything that grew on the month before:
  the account-wide measures, and this Worker's requests, CPU, CPU p50 and p99, exceptions, 4xx
  and 5xx responses and database rows. Totals in a month in progress are projected over the whole
  month before they are compared; the busiest neuron day and the quantiles are not.
- **Missing is not zero.** A dataset GraphQL couldn't answer is written as `missing: <why>`, and
  the run exits 1 with outcome `failed`; an empty dataset is zero.
- **The month is the calendar month.** The subscription's renewal date, which starts the billing
  month, isn't readable with these scopes, and the report says so.
- **Auth,** as the deploy's D1 reads (`scripts/d1-read.mjs`): the token is `CLOUDFLARE_API_TOKEN`,
  else `npx wrangler auth token --json` (the wrangler login); the account is
  `CLOUDFLARE_ACCOUNT_ID`, else wrangler's cached account, else the one `wrangler whoami` lists.
  The token goes only in the `Authorization` header: never into the report, the record, a log line
  or an error (an API error that echoes it is redacted). Neither the token nor the account id is
  recorded; the record counts each call as `/client/v4/graphql`.

Workers Logs keep every event (`head_sampling_rate` unset), 7 days. Paid includes 20 million
events a month; from 2026-12-01 Workers Logs move to Cloudflare Observability pricing (50 GB of
ingestion and 10 GB-month of storage included a billing cycle). This Worker's volume is far inside
either (`docs/evidence/phase7/measure.md`). The privacy note states that retention
(above, "What is kept about visitors").

**Drift and reminder issues** (`.github/workflows/drift.yml`, `scripts/drift.mjs`, Phase 7 7F,
G3 (a) in ADR 0011). The workflow has `contents: read` and `issues: write`, reads only NUSMods'
public API, and makes no Cloudflare or live-site call. It needs no secret but the run's
`GITHUB_TOKEN`.

- **Weekly (Monday 01:17 UTC).** A conditional GET of this year's `moduleInfo.json`, with the last
  copy and its ETag kept by `actions/cache` (`.data/drift-cache/`; a miss costs one full fetch),
  and a GET of next year's `moduleList.json`. It computes the data version offline as ingest does
  (`offeredModules` over HEAD's NG files, `rowHash`, `dataVersion`) and compares it with
  `src/data-version.json`.
  - **`drift:pending`:** one issue, kept updated while they differ, with a row per check: courses
    added, removed and changed against the copy the check before saw, the D1 columns that changed,
    and catalogue-only counts. The check closes it once production's data version matches.
  - **`drift:next-year`:** opened once when next year's list appears. The check never closes it.
  - **`drift:failure`:** its own failure (a NUSMods shape change, an HTTP error, or a failed step
    before the check). Repeats comment on the open one; the next good run closes it.
- **Monthly (the 1st, 01:41 UTC), `drift:reminder`:** one issue a month to check the Registrar's
  NG list and restrictions and YST's pages, and to run last month's usage report. When the last
  commit is more than 45 days old it adds that GitHub stops a public repo's schedules after 60
  days with no activity; committing the usage report keeps the repo active. A monthly run alone
  can miss the window between day 45 and day 60, so the weekly run also opens that warning as its
  own `drift:reminder` issue, once per quiet stretch (keyed by the last commit).

Issues are found by their label and a hidden marker in the body (`<!-- vnm-drift:… -->`), never by
title. NUSMods controls the codes the pending issue names, so only codes of the course-code shape
(`MODULE_CODE_RE`) are shown; any other is counted ("N codes not in the course-code shape"). The
issue's history is read from the last `vnm-drift:state` block of its body, keeping only entries of
the shape the check writes, and is written with `<` and `>` escaped, so no value can forge it (red
team M-2). To see what a check would do without touching GitHub, run `node scripts/drift.mjs weekly
--dry-run` (it does fetch NUSMods) or `monthly --dry-run`. The crons in `drift.yml` must match
`SCHEDULES` in the script; `test/drift-workflow.node.test.js` checks that.

**The uptime check** (`.github/workflows/uptime.yml`, `scripts/uptime.mjs`, Phase 8 8C, G4 in
ADR 0012). Hourly at minute 37 UTC, and by hand (`workflow_dispatch`). Each run sends three GETs
to `wrangler.jsonc`'s Custom Domain, each at least 4 s after the last answer, since Actions
runners share addresses and the site's limit is per address:

- `/health`: 200 with `ok: true`;
- `/module/<code>`: 200 with that code. The code is drawn by the hour from the checkout's
  `data/groups.json`, so no course is named in the script. `main` can be ahead of the deploy (a
  refresh is merged before D1 is re-ingested; a rollback), so a 404 that names its kind of miss
  (`unknown`, `catalogue-only`, `ng-listed`) passes too, with a note: the Worker read D1 to give
  it, and a D1 failure is a 502;
- `/search` for a plain-English topic from `QUERIES` in the script, rotating by the hour: 200,
  `cache;desc=miss` (as smoke requires), not `degraded`, at least one result. On a cache hit it
  takes the next query, up to 3. Checking the miss and `degraded` catches the keyword-only
  fallback, which still answers 200.

A failure is checked again 90 s later, with queries not yet sent; nothing is kept between runs.
A pass pings the healthchecks.io check; two failures ping its `/fail` with a one-line reason as the
body: the route and the status (`/search HTTP 502`, `/search degraded (embed-timeout)`), never a
visitor's data. healthchecks.io alerts Jacob through Pushover, at once on `/fail`, and after the
check's 12 h grace when runs stop arriving (GitHub may delay or drop scheduled runs, and pauses a
public repo's after 60 quiet days). The check (period 1 h, grace 12 h) is in Jacob's
healthchecks.io account; its ping URL is the repo secret `HC_UPTIME_URL`, the workflow's only
secret, with `contents: read` and nothing else. The script never prints the URL: every line
shows it as `<HC_UPTIME_URL>`. The run exits 0 once the report reached healthchecks.io, up or
down (a red run every hour of an outage would only add emails), 1 when the ping itself failed,
and 2 on a missing or non-https `HC_UPTIME_URL`, before any request. It writes no run record: the
history is healthchecks.io's. `node scripts/uptime.mjs --dry-run [--url <url>]` checks a site and
prints what it would ping, pinging nothing. The cron must match `SCHEDULE` in the script;
`test/uptime.node.test.js` checks it, the permissions and the secret.

**When the site is down,** the order matters, because Actions redeploys `main` on every green push:
check `/health`, a search, `wrangler deployments status` and the last deploy tag; then set
`DEPLOY_FROM_ACTIONS` to anything but `true` (or revert the cause on `main`); wait for or cancel any
queued or running Deploy job (the concurrency group never cancels one, so it could overwrite the
rollback); then `npm run rollback` and `npm run smoke -- --expect <sha>`; and turn the switch back
on before merging the fix, since a merge while it is off is skipped and turning it on starts
nothing. [`docs/launch.md`](launch.md) has the runbook with its commands, and what each uptime
alert means.

## Evaluation

The eval runs the actual Worker inside workerd and scores it against blind judgments with
nDCG@10, P@5 and MRR, paired bootstrap CIs and a pre-committed gate. Its D1 holds the full pinned
corpus; the dense half searches a vectors bundle built for the run from `bge-small-en-v1.5` corpus
embeddings (release assets, sha-checked against `eval/embeddings.json`) (only `eval-v0`, which predates the bundle, searches a fake
Vectorize, `eval/runner/run.mjs` `writeBundle`); a fake AI returns the committed query embeddings.
No live traffic, no Cloudflare calls at run time. EVAL.md has the results and what they don't show.

<!-- pointer --> The shipped ranker, the baseline each change is compared with, is the commit
`SHIPPED_BASELINE` names in `eval/lib/baseline.mjs`. SC5 compared with `eval-v0` (`PINNED_BASELINE`)
once, on the sealed test set.

```bash
npm run eval -- --variant v0 --ref eval-v0 --embedding emb-bge-small-v0   # the Phase 2 baseline ranker, dev set
npm run eval -- --variant shipped --ref <the shipped pin's ref>           # the shipped ranker, dev set
npm run eval -- --variant head --baseline shipped                         # the working tree vs it, with the dev screen's verdict
npm run eval:report -- --run head --baseline shipped                      # recompute metrics from run files only
npm run test:eval                                                         # harness self-test on the fixture set (CI)
```

A ranker before 3A-2 needs its own corpus embedding (`--embedding emb-bge-small-v0` for
`eval-v0`): the runner refuses a ranker whose corpus texts the embedding lacks. Details, file
formats and holdout custody: [`eval/README.md`](../eval/README.md). The v1 eval (regex relevance,
recall@10) is history, with its write-up, in [`eval/v1/`](../eval/v1/README.md).

### The ranking lock (CI's eval gate)

`eval/ranking-lock.json` holds, for each open-set query, the sha256 of its HTTP status and ordered
result codes: the dev set on the pinned corpus filtered, `--strip ng` and `--unfiltered`, and the
fixture set on its own corpus in the same three modes (327 lists). It also records `inputsHash`
(the git objects of `LOCK_INPUTS` in `eval/lib/ranking-lock.mjs`: the ranker, the runner's import
closure, the fakes, the eval config, the sets, the embeddings manifest and `package-lock.json`), the
embedding version, the corpus release and the evidence for its lists.

```bash
npm run eval:lock -- --check [--base <rev>]       # the gate (CI's eval-gate; base: merge base with origin/main)
npm run eval:lock -- --diff-ref <ref>             # <ref>'s ranker against HEAD's lock (e.g. the shipped pin)
npm run eval:lock -- --evidence <kind> <ref>      # write changed lists, with their evidence
npm run eval:lock                                 # rewrite for a new embedding version or corpus; refused if the lists change
```

- **Fast path.** HEAD's lock equals the base's, and HEAD's `inputsHash` equals the lock's or the
  base's (the PR base, or `main`'s last green). Seconds, with no `npm ci`. Any lock edit skips it.
- **Recompute.** Otherwise the eval runner recomputes the lists at HEAD (about 30 s locally, no
  Cloudflare call: the pinned corpus and the corpus embeddings are sha-checked release assets). They
  must equal HEAD's lock, or the gate fails naming each changed query with its statuses. A neutral
  change passes and leaves the lock as it is, so PRs never conflict on it.
- **A ranking change** rewrites the lock with evidence written after the base lock, checked against
  the base commit's lock: `holdout-pass <n>` (row n of `eval/holdout-ledger.md`, verdict `pass`,
  against the base commit's `SHIPPED_BASELINE`), `no-look <n>` (row n of `eval/count-log.md`, whose
  `route` names an ADR 0003 no-look route, written by `eval:count -- --route` or
  `eval:representatives -- --route`), or `revert <commit>` (the lists of an earlier lock). Commit the
  row first; each row is cited once. An unchanged evidence and an ADR pin line are refused (pin lines
  are written after the merge); `bootstrap` is allowed only when the base has no lock.
- **What it does not cover.** It compares open sets only: the custodian's holdout count at a ship
  stays. It guards against accidents, not against false evidence; a lock change shows in every diff.
- The lock never runs in the `sc1` Vitest project, and `test/eval/ranking-lock.node.test.js` fails
  if the runner's import closure (read with acorn) reaches a file outside `LOCK_INPUTS`, or a dynamic
  import it cannot resolve to a listed path.

## Cost

The account is on **Workers Paid** ($5/month, ADR 0004). Going over an included allowance there is
billed, not refused, and ADR 0004 allows no overage (ADR 0012, G5 (b)). Nothing in the Worker caps
its own use. **Since 3-0, Vectorize is off the search path, so the binding limit is Workers CPU or
Workers AI neurons, not Vectorize queried dimensions.**

| | Workers Paid, included | cost here |
|---|---|---|
| D1 rows read | 25,000,000,000 / month | per search, Phase 3's SC7 run on production: p50 255, max 1,403; unfiltered p50 240, filtered p50 613.5 ([`sc7.md`](evidence/phase3/sc7.md)); the local grid's worst filtered search 7,772 ([`lexical-cost.md`](evidence/phase1/lexical-cost.md)); 1 per page load (`/facets`); 1 per `/module/:code` (2 on a 404 for a code outside `data/ng-unscheduled.json`); ~21k per deploy (the guard reads every module and catalogue row) and one per module for a standby refresh |
| D1 rows written | 50,000,000 / month | 34,383 per forced full re-ingest, measured against production on 2026-11-04 ([`remote-ops.md`](evidence/phase1/remote-ops.md)); a rerun with nothing changed writes 2; the standby refresh writes 0 |
| Vectorize stored dims | 10,000,000 | <!-- pointer --> the standby holds one vector per module the database holds, the production bundle's count in `data/vectors.json`. At 384 dimensions each that is about a quarter of the allowance |
| Vectorize queried dims | 50,000,000 / month | **~0 per search** (only under `DENSE_BACKEND=vectorize`); the stored term still counts once a month |
| **Workers CPU** | **30,000,000 ms / month** | live, version `343ea371`: **p50 9.1 ms, p75 15.5 ms** CPU per request (first 18 requests after the cutover, `/health` included), 33–34 ms on a fresh isolate's first search ([`3-0-cutover.md`](evidence/phase3/3-0-cutover.md)); the exact search alone is 1.44 ms locally and 3.4 ms on a CI runner ([`3-0.md`](evidence/phase3/3-0.md)) |
| **Workers AI** | **10,000 neurons / day, shared by the account** | 0.033 per typical uncached search, 0.066 when 3C corrects a word (a second embedding), up to ~0.88 for a whole-query catalogue-only code's `related` (*est.*), at 1,841 neurons per million tokens; ~2,400 per forced re-ingest (measured); a bundle build embeds only texts the eval asset lacks |
| CPU per request | 30 s | as above |

The arithmetic. **The limit is CPU or the shared neurons.** At the measured ~12 ms of CPU a
request, 30M CPU-ms cover **~2.5M searches a month**. Workers AI's 10,000 neurons a day cover
150,000 to 300,000 uncached searches a day (4.5M to 9M a month) at 0.066 to 0.033 each, if this
project had them alone. It doesn't: on the month's busiest day (2026-11-06) the account used 6,805
neurons (68%), about 4,300 of them this project's two corpus embeds and about 2,500 other
projects' ([`ops/2026-11.md`](evidence/ops/2026-11.md), [`neurons.tsv`](evidence/neurons.tsv)).
With no corpus embed or re-ingest that day, about 110,000 uncached searches fit beside other
projects' ~2,500; on a day with one, far fewer, so a launch week has none (ADR 0012). At 2.5M
searches a month, D1's 25 billion reads cover ~10,000 rows read per search; SC7's p50 (255) and
max (1,403) are well inside that, and the worst filtered search on the local grid (7,772 rows) is
not. Cached repeats cost none of these.

**The live checks.** The uptime check sends about 70 requests a day (24 runs of `/health`,
`/module` and one uncached `/search`): about 6k D1 rows read (24 searches at SC7's p50 of 255, plus
24 `/module` rows) and about 1 neuron. Each Actions deploy's smoke adds 5 GETs and one uncached
search (about 0.03 neurons).

**No overage (ADR 0004; ADR 0012, G5 (b)).** Nothing in Cloudflare caps Workers AI or D1 spending
automatically. Jacob sets a Cloudflare budget alert at the lowest amount: it emails the day after
a billed day and caps nothing. What keeps the project inside the allowances is the rule in
[`docs/launch.md`](launch.md): no corpus embed or forced re-ingest in a week with a post, since a
forced re-ingest spends about 2,400 of the 10,000 daily neurons.

**A spike** (Phase 8 plan §1, *est.* where marked):

| Uncached searches | Neurons | CPU (*est.* 12 ms each) | D1 rows (*est.* 500 each) | What happens |
|---|---|---|---|---|
| 1,000 a day | 33–66 | 12k ms | 0.5M | nothing |
| 10,000 a day | 330–660 | 120k ms (0.4% of a month) | 5M (0.02%) | nothing |
| 50,000 a day | 1.7k–3.3k | 600k ms (2%) | 25M | nothing, unless this project embeds its corpus that day too (~2–4k neurons) |
| 100,000 a day | 3.3k–6.6k | 1.2M ms (4%) | 50M | with other projects at ~2,500, inside; with a corpus embed the same day, up to ~3.4k neurons over, billed at $0.011 per 1,000 (about $0.04), which ADR 0004 doesn't allow |
| 1,500–3,000 in one **minute** | — | — | — | past Workers AI's 3,000 requests a minute for embedding models (a corrected search makes two), embeddings fail and searches go keyword-only, perhaps other projects' too |

### History: the binding limit before 3-0 (FINDINGS B9)

Before 3-0 every uncached search queried 384 dimensions, billed as (queries + stored vectors) × 384
against 50,000,000 a month: 50,000,000 / 384 − 6,771 ≈ **123,400 uncached searches a month**, about
4,100 a day (FINDINGS B9). CPU's ~2.5M a month is about 20 times that.

### How D1 reads per search were brought down

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
the v1 evaluation ([`eval/v1/README.md`](../eval/v1/README.md)) measured the `OR` version.

**Past an allowance**, Workers Paid bills the overage and no request fails for it. A D1 error
of any kind is a 502 with the upstream message, never a silently empty answer (R7).

**The caveat:** the allowances are per *account*, not per project, and the one other use reaches
is Workers AI's: other projects' embeddings and this project's own corpus embeds share its 10,000
neurons a day. The `/search` rate limits (40 per 10 s and 200 per 60 s per IP, Phase 8 8B) are burst guards —
per-colo and eventually consistent — and do not protect the daily account-wide budget against
traffic spread over many addresses.

## Data source

[NUSMods API](https://api.nusmods.com/v2/) — statically generated JSON, scraped daily from
NUS's own systems. It is **community-maintained and unofficial; NUS does not run it.** The
ingest script validates that the expected keys are present and aborts rather than writing
malformed rows if the shape changes.

Only modules with at least one `semesterData` entry are indexed; the rest are catalogue entries
not offered this year (D1's `catalogue_only`, 7D). <!-- year:pinned --> In the pinned 2026/27
snapshot that is 6,771 of the 21,130 records in `moduleInfo.json`. Production's counts follow
`current` in `data/corpus.json`.

### When a source changes

The NG list, the restrictions PDF, the self-funded programme list, YST's non-music-majors
pages and the Law compulsory-course list all change without notice. A new copy of any of them is
a revision of the year's source manifest, and repeats Phase 4's gate for the changed sections:
a new archive (`npm run sources -- publish --from <dir>`), two transcriptions of what changed and
the id map, rulings in the register, the overlay and builders, a fresh oracle author for the
changed sections, `npm run year -- check --full` (commit its record: the deploy preflight needs
it whenever a source-derived input changed), and a row-only re-ingest and ship. The steps are
"A mid-year revision" in [`docs/year-refresh/README.md`](year-refresh/README.md).

## Known limitations

- **One acad year.** The site serves one year at a time and switches in July
  ([`docs/year-refresh/README.md`](year-refresh/README.md)). Two years would double the vectors
  bundle the Worker loads and the standby's stored dimensions.
- **Exchange mode is a manual snapshot.** The NG list and restrictions come from PDFs and
  pages that must be downloaded by hand (NUS blocks automated fetching) and re-checked when
  NUS updates them. The UI names each source with its date so staleness is visible. YST's Sem 2
  list is last year's until YST publishes this year's (`year check` says so), and from the July
  switch until NUS publishes Sem 2's NG list, Sem 2 shows last year's list, each course "to
  confirm" (G2).
- **The year's sources need one key.** NUS's documents are archived encrypted per revision; the
  key is backed up in Bitwarden. Without it the next source change can't be checked
  (`year check --full`), though deploys that touch no source-derived input still work.
- **Exchange mode covers Semesters 1 and 2.** The NG list has no special-term data.
- **Only some constraints are read from the query.** *No final exam*, *S/U*, *light workload*
  and level phrases become filters (3H, 5F). Others, such as "no Friday classes", are not
  understood, and there is no filter for class days.
- **The PDF is the browser's print.** Only Chromium's is checked as a PDF (tagged, real text);
  WebKit's print page by screenshot; iOS's Share, Print path is untested on a phone. A system
  font draws U+2010 and U+2011, which the Plex subsets lack; on macOS its text layer reads them
  as "-". A 40-entry list prints in about 15 to 19 A4 pages.
- **No scheduled re-ingest.** Refresh is a manual command run on the Mac. Detection is
  scheduled: the drift workflow opens an issue when NUSMods' data no longer matches
  production's, or next year appears (see "Operations").
- **The ranking is measured offline.** On a pinned corpus, with one judge model and queries
  written for personas; see EVAL.md, "What the numbers don't show".
