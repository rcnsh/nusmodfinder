# HTTP API

Every route the Worker answers, with its parameters and responses. How `/search` produces its
answer is in [architecture.md](architecture.md).

**Live:** https://nusmodfinder.rcn.sh

| Route | Purpose |
|---|---|
| `GET /` | The page: `public/`, served as Workers Static Assets (no Worker CPU); see [page.md](page.md) |
| `GET /search?q=&sem=&level=&credits=&faculty=&ng=&study=&exam=&su=&hoursBelow=&prereq=&ignore=&topK=&mode=` | Ranked results as JSON (below) |
| `GET /module/:code` | The full D1 row for one module, with its exchange-mode status for every semester and year of study, its exams, its workload, its NUSMods link, its grading basis and its other codes; a 404 says which kind of miss it is (below) |
| `GET /facets` | Distinct faculties and levels, with counts, for the filter UI; the exchange-mode sources with their dates; NUS's rules about courses off the exchange list (`offListRules`, below) |
| `GET /health` | `{ ok, versionId, versionTag, dataVersion, vectors }`, without touching D1 ([operations.md](operations.md#checking-whats-live)) |
| `GET /privacy` | The privacy note (`public/privacy.html`, a static asset): what Cloudflare's logs and the site's own log line keep, what stays on the device, no cookies |
| any other path | JSON 404 `{ error: "not_found", message }`; for a browser (`GET` or `HEAD` whose `Accept` prefers `text/html`), the 404 page instead (below) |

`/admin/*` exists only when an `INGEST_SECRET` is bound, which production never has
([data.md](data.md#the-admin-routes)).

## `/search`

### Parameters
- `q`: the query, at most 200 characters (longer is a 400).
- `sem=1|2|3|4`, `level`, `credits`, `faculty`: filters. `level` and `credits` also take a
  comma-separated list (`level=3,4`), which matches a course at any of them; `filters` echoes one
  value as a number and several as a sorted array (`"level": [3, 4]`).
- `ng=1` is **exchange mode**: only courses an exchange (Non-Graduating) student may take, under
  the Registrar's NG course list and course restrictions ([exchange-mode.md](exchange-mode.md)).
  It needs `study=ug1|ug2|ug3|ug4|grad`, the student's year of study during the exchange (`ug4` =
  4th year or later); without it `/search` answers 400 `study-required`. Under `ng=1`, `sem=1|2`
  picks the semester the student would come in (the NG list's semesters, not NUSMods'), no `sem`
  means either, and `sem=3|4` answers no courses with `noMatch: { reason: "ng-special-term" }`:
  the NG list has no special-term data. Only `ng=1` narrows: `ng=0` is ignored, and `study` is
  ignored without `ng=1`.
- **Constraints**, each a hard filter: `exam=0` (no final exam listed, in the `sem` asked for when
  there is one), `su=1` (S/U-able, or graded CS/CU), `hoursBelow=N` (NUSMods' weekly workload
  below N hours, 1 to 99) and `prereq=none` (no prerequisite). The same constraints are read from
  the query's own words (*no final exam*, *S/U*, *light workload*; the tighter hour limit holds),
  with level phrases. `ignore=` names parsed phrases to undo, as the page's chips do
  (`parseFilters`, `parseIgnore` in `src/search.js`). Every one is part of the cache key.
- `topK`: results returned, 20 by default, at most 50 (the candidate depth of each retriever).
- `mode`: `hybrid` (default), `vector` or `lexical`. It lets the eval measure each retriever on
  its own.

### Response
Ranked results, each with its row's fields. In exchange mode each result carries
`exchange: { status: "open" | "note", reasons: [{ id, kind, text }] }`, including the
year-of-study and level-4000 notes ([exchange-mode.md](exchange-mode.md#notes-read-per-request)).
Collapsed duplicate-group members ride as `variants`. `interpreted` echoes every constraint,
level and code range read from the query.

On every 200 `/search` also answers what the page needs to explain a typed code. None of it
changes which results show or their order:
- `hiddenPins: [code]`: the typed codes, in query order, whose row the filters, `ng`/`study` and
  the parsed constraints remove. Every code-shaped token counts (up to 10), not only the 3 that
  pin. A code with no row, or one that passes but whose duplicate group already shows, is never
  listed. Empty on routes that pin nothing (a whole-query partial code or prefix, `noMatch`).
- `notOffered: [code]`: the typed codes that are in the catalogue but not offered this year, also
  inside a longer query (a whole-query one still answers `noMatch: { reason: "not-offered" }`).
  An NG-listed code with no classes (`data/ng-unscheduled.json`) counts as not offered here even
  where the bundled catalogue lacks it, and as a whole query answers
  `noMatch: { reason: "ng-unscheduled", code, title, ngSemesters, related }`; the page says "NUS
  lists EE4438 (Solar Cells and Modules) for Sem 2, but NUSMods shows no classes for it this
  academic year."
- each result's `examDates`, as `/module/:code` gives them (`[]` for none);
- each result's `reviews`: `{ n, latest, overall, workload, difficulty, teaching }` from
  `data/reviews.json` (ADR 0018): the number of student reviews on NUSMods, the latest academic
  year one is about (`"AY25/26"`), and each age-weighted 1-5 score or `null` where reviews don't
  say; `null` for a course with no review. Ranking never reads it;
- under `ng=1` with no `sem`, each result's `exchangeBySem: { "1": …, "2": … }`: the
  `{ status: "open" | "note" | "closed", reasons }` for each semester at the `study` level, beside
  `exchange` (the either-semester value), so a student planning both sees one value per semester.

`noMatch.reason` is one of `unknown-code`, `not-offered`, `ng-unscheduled`, `no-signal` and
`ng-special-term`; the page has a sentence for each (`public/messages.js`).

### Refusals and limits
- **Other sites' pages are refused.** A request with `Sec-Fetch-Site: cross-site` and any
  `Sec-Fetch-Dest` but `document` answers 403 `{ error: "cross_site", message }` with `no-store`,
  before the cache, the rate limits and any binding, so another site's fetch, image or hidden
  iframe can't spend this account's Workers AI through its visitors' browsers. A link a student
  follows (`navigate` + `document`), the page itself (`same-origin`), a bookmark (`none`), and
  callers that send no `Sec-Fetch-Site` (Node's `fetch`, the eval, `curl`) are served. `/module`
  and `/facets` don't refuse, and `access-control-allow-origin: *` stays.
- **Two per-IP rate limits:** `SEARCH_LIMIT`, 40 per 10 s, and `SEARCH_LIMIT_MINUTE`, 200 per
  60 s, both keyed by `cf-connecting-ip` and asked together (one `limit` span) after the cache and
  before any other binding. Either refusing answers 429 `{ error: "rate_limited", message }` with
  `retry-after: 60`; each fails open on its own. A cache hit skips them.
- **Caching.** A 200 is cached for an hour, a keyword-only answer (`x-search-degraded: 1`) for
  60 s. A hit is re-sent with its own TTL, `public, max-age=3600` or 60: the copy Cloudflare's
  cache returns would otherwise carry the zone's Browser Cache TTL (4 hours).
- **Degraded answers.** If embedding or the dense half fails, `/search` answers with the keyword
  results alone and says so: `"degraded": { "source", "reason" }`
  ([architecture.md](architecture.md#failure-behaviour)).

## `/module/:code`
Besides the row's columns:
- `examDates`: one `{ sem, date, durationMins }` per semester with an exam (`date` ISO UTC as
  NUSMods gives it; `[]` for none);
- `workload` as `{ lecture, tutorial, lab, project, prep, total }` hours a week, `{ raw }` when
  NUSMods gives something other than its 5-number array (two modules give a string), or `null`
  when not listed (absent or all zero);
- `nusmodsUrl`, where the class times are;
- `prereqCohortOnly`: the prerequisite names only NUS intake years or programmes;
- `gradingBasis` (NUSMods' text, e.g. `"Graded"` or `"Completed Satisfactory/Unsatisfactory"`);
- `otherCodes`: the course's duplicate group other than itself (`src/group-data.js`), `[]` when
  none.

It is cached `public, max-age=300` on a 200, `public, max-age=60` on a 404 and `no-store` on a
5xx, with no ETag.

A 404 is `{ error: "not_found", kind, message, acadYear, … }`, `kind` one of:
- `ng-listed`: on the NG list but with no classes in NUSMods this year (`EE4407`, for one), from
  `data/ng-unscheduled.json`, with no D1 read past the row's. It carries the fields a row has
  (`code`, `title`, `description`, `credits`, `faculty`, `department`, `level`, `ngSemesters`,
  `workload`, `prerequisite`, `preclusion`, `gradingBasis`, `otherCodes`), `semesters: []`,
  `ng: true`, `examDates: []`, `nusmodsUrl`, and `exchange` built from the file's allow mask by
  the same function a row's uses, so it reads like a row with no classes;
- `catalogue-only`: a `catalogue_only` row (in the catalogue, not offered this year), with its
  `code`, `title` and `description`;
- `unknown`: neither, or no `catalogue_only` table yet.

`acadYear` is the file's, the catalogue row's, else `data/ng-reasons.json`'s. A row always wins
over the file. A 404 not in the file costs a second D1 read, timed under the same `d1` span; any
failed read but a missing table is a 5xx with `no-store`. An answer without `kind` reads as
`unknown`. The page's fetch layer (`public/api.js`) passes a JSON error body's fields, its
`message` left out, through as `error.detail`, and keeps a 404 as final.

## `/facets`
Faculties and levels with counts, and `ngSources` (each exchange-mode source with its "updated as
at" date; ingest posts the NG list's date, [exchange-mode.md](exchange-mode.md)). `offListRules:
[{ id, text, scope }]` holds NUS's four rules about courses off the exchange list
(`E-offerings-list`, `2-biz-no-late-add`, `4-cee-no-appeal`, `4-isem-no-appeal`), each quoted from
the restrictions PDF, with the scope it states (`{ departments, levels }` or `{ faculties }`,
matched on a row's fields, never by code prefix; `{}` for every course). They are the rules file's
`info` entries with a `text`, passed through `data/ng-reasons.json`.

## The 404 page
`src/404.html`, a Text module, sent with status 404 and the CSP, `X-Frame-Options` and
`X-Content-Type-Options` of `public/_headers`' `/*` rule, since Cloudflare applies `_headers` to
static assets only. `src/not-found.js` holds a copy of the three, so the Worker (and the ranking
lock's inputs) reaches no file outside `src/`; `test/visitor.test.js` parses `public/_headers`
and fails when the copy differs. It is static: nothing from the request is written into it.
`curl` and Node's `fetch` (`*/*`) and the page's own fetches (`application/json`) keep the JSON;
so does any `Accept` that ranks HTML below JSON or `*/*`. It lives in `src/`, so it is never also
served as `/404.html`. `/favicon.ico` is a static file (the 32 px PNG in an ICO), so a browser's
request for it never runs the Worker.

## Errors
A D1 failure is a 502 with the upstream message, never a silently empty answer. `mode=vector`
answers 502 when the dense half fails. Anything unhandled is a JSON 500 with a `requestId` (the
`cf-ray`) that matches the `"event":"unhandled"` log line.
