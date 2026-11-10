# Phase 5 plan: frontend and design overhaul (converged r3.1, 3 critic rounds)

Goal (exit): **SC2** and **SC8** are met, the design gate is passed, and a red team of exchange
students on the live page can tell, for every course they pick, whether they may take it.
- **SC2:** every result card can be opened: description, prereqs and preclusions, exam date,
  workload in hours per week, exchange availability per semester, and "Open in NUSMods".
- **SC8:** axe-core zero violations. Keyboard-only and screen-reader flows work. Mobile at 390px
  shows the first result above the fold.
- Findings in scope: F1–F10, V1, and the rest of P3 (the title, the cards, the vacancy report).
- Carried from Phase 4 (Jacob's Q4): SC4's parsed-intent items (3H phrases), shipped with a
  frontend that shows what was parsed and lets the student undo it, under a compliance-aware rule
  committed before any look (§3 5F). SC4's level items, S2, S3 and S4 stay out of scope.

This plan changes no code. Every number marked *est.* is an estimate; every other number comes
from a script on the 2026-11-04 production catalogue (`.data/cache/2026-2027-moduleInfo.json`,
6,778 offered modules) or a cited evidence file.

r3.1 is the final draft. It applies every round-3 objection (§7); no critic pass follows it. The
changes from r3:
- the eval's Vitest config aliases the vocabulary and groups to each run's workspace, so the bare
  aliases can't make an eval rank with the wrong vocabulary (A3-1, B3-2);
- the reference parse is tag `3h` (2476012), and the verdict path throws, before any ledger
  row, if the candidate's parse differs from it on any query (B3-1); an empty constraint block
  is a recorded vacuous pass (B3-3);
- every typed code is checked, not only the three that are pinned; codes not offered this year
  are reported inside a list too (A3-2);
- each hidden-code line uses that code's own stored reason; the examples are corrected to the
  data (C3-1, C3-2);
- red-team answers are yes / yes if / no / ask NUS, fixed per note kind in advance (C3-3);
- the page ship moves the shipped-ranker pin as ranking-neutral, and L8's baseline follows it
  (B3-6).

r3 applied every round-2 objection. The main changes from r2:
- `/search` gains three additive, ranking-neutral fields the page can't compute itself:
  `hiddenPins`, `exchangeBySem` and `examDates` (A2-3, C2-1, C2-8), in their own PR, 5C-api;
- the hidden-code explanation covers several codes, codes not offered this year and partial codes
  (C2-4); D4 is reworded;
- the design gate is lighter: D2, D3 and D4 are asked first, then each direction renders four
  states, each passing contrast and the fold check (C2-6, A2-6);
- every exchange note shows in full on the card (C2-3);
- 5F's rule freezes a reference parse, names the source of every constraint field, gates the
  constraint block too, and keeps its counts inside the verdict path (B2-1 to B2-6);
- the UI stack imports the fixture's vocabulary and groups through bare aliases (A2-1);
- the red team's expected calls are fixed in advance and its disagreements classified (C2-5).

## 1. Facts gathered
- **The page today** is `src/page.html`: 14.9 kB, one file, inline CSS and JS, imported by the
  Worker as a text module and served for `/`. Phase 4 (4D) added the minimum exchange UI.
- **`/module/:code`** returns every `modules` column, including `description`, `prerequisite`,
  `preclusion` (free text), `workload` (JSON), `semesters`, the NG fields and `exchange` (status
  and reasons for every semester × study level). Nothing calls it today.
- **Not stored:** the exam date. D1 keeps `exam_semesters` but not the date or duration. 1,593
  of 6,778 offered modules have an exam date; 279 have one in more than one semester. Of the
  684 courses shown to a 2nd-year in Sem 1, 347 have one.
- **Not stored and not in moduleInfo:** class times (no lesson field among moduleInfo's keys).
- **Workload:** 6,719 modules give NUSMods' 5-number array (lecture, tutorial, lab, project,
  preparation hours per week); 2 give a string (`3-.5-0--0-6.5`), stored as a JSON string; 57
  give none. The fixture (434 modules) has no string case.
- **Prereq and preclusion text:** 2,580 and 2,827 modules. Of the 1,152 NG courses, 638 have a
  prerequisite, 576 in NUS's rule language, some with missing spaces
  (`Undergraduate DegreeTHENmust`); 11 are cohort-only (`prereq_cohort_only`).
- **Exchange notes:** a reason has `id`, `kind`, `text` (`src/ng-reasons.js:10`). Shown notes run
  14–124 characters; condition texts 33–113. No real card carries two condition notes; the
  worst cards are **ACC1701XB** (semester, quota and major notes, 244 characters) and **CG2023**
  (semester and restricted-elsewhere, the longest condition text). Both are in the fixture.
- **Without `sem`, exchange status is the `any` bit:** one status for "either semester"
  (`src/ng-bit.js`, `src/modules.js:76`). At 2nd year, 857 of the 1,128 courses shown for either
  semester are open in only one.
- **Hidden codes:** a pinned code that fails the filters is dropped silently
  (`src/search.js:957-958`); `parsed.pins` is an array. A code not offered this year (14,359
  catalogue-only codes) answers `noMatch` with its title and related courses
  (`src/search.js:804-846`), which today's page renders as "No modules matched". Of 1,472
  two-digit prefixes, 1,200 show nothing to a 2nd-year in Sem 1. Of 6,094 courses hidden at ug2
  Sem 1, 5,611 are not on the NG list, 444 are open in Sem 2, and 30 have more than one closing
  reason. The code parser's data lives only on the server (`src/intent-data.js:13-17`).
- **The row hash covers every column** (`src/rowhash.js:55-63`): a new column changes every
  row's hash and the data version, which the bundle, the deploy guard and the D1-only ingest all
  check. The pinned bundle's data version changes too, though its moduleInfo doesn't
  (`scripts/vectors.mjs:106,199`). Every-row rewrites measured 34,425 rows written, 37,310
  charged (`docs/evidence/phase4/remote-ops.md:16`).
- **The test config has no AI binding,** so every test-config search is degraded and no-signal
  can't occur (`src/search.js:394-402, 741-742, 993`). `test/fakes.js` imports nothing from
  `cloudflare:test`, so a `wrangler dev` entry can import `FakeAI` (which reproduces the fixture
  bundle's `hashEmbed`) and `FakeRateLimit`.
- **Wrangler can't alias relative imports:** `src/intent-data.js:18` and `src/group-data.js:8`
  import `../data/vocabulary.json` and `../data/groups.json`; esbuild rejects relative alias keys
  (`Invalid alias name`), so only vitest can swap them today.
- **`PARSE_PHRASES` is a constant `false`** (`src/intents.js:29`); no config turns it on.
- **The findings tests** read `src/page.html` at load and match its exact source
  (`test/findings/source.node.test.js:13-23, 79-94`); `check-findings` requires cited evidence
  paths to exist.
- **axe tags:** `landmark-one-main` and `region` (F5) are `best-practice`, not `wcag*`.
- **Workers Static Assets:** an `assets` block without a binding adds nothing to `Env`; the
  deploy guard reads only `vars` (`scripts/deploy.mjs:53`); asset responses skip the Worker, so
  `/` loses `x-app-version` (`test/instrument.test.js:180`, README:180).
- **"Open in NUSMods":** `https://nusmods.com/courses/<CODE>` (HTTP 200 for CS3244). NUSMods has
  the class times.
- **Eval run files** carry only level, semesters, ng, ngSemesters, credits and faculty per
  document (`eval/lib/metrics.mjs:50,161`); the pinned snapshot normalised by `scripts/lib.mjs`
  has every constraint field and every judged dev code (2,461 of 2,461).
- **3H's failure and a rough re-score:** under (ii) nothing was exempt by the all-fail rule; dev
  no-loss failed at −0.0044 and L7 at −0.024. Re-scored with constraint-filtered qrels (critic
  B's approximation on pre-Phase-4 runs, `/tmp`, not committed), (ii)-stripped moves from
  −0.0027 to +0.0045 nDCG@10 and −0.0071 to +0.0047 P@5; (i)-stripped still fails (−0.0099).
  `FEATURE_GAP_SHAPES = ['constraint']` (`metrics.mjs:31`) keeps the five exam queries out of
  the primary set; d-081 is −0.154 even filtered.

## 2. The design gate (5-0)
V1's "template look" and "off-brand" are judgements, so Jacob decides the direction. It runs in
two steps so the mockups are few and deep, not many and shallow (C2-6):
1. **D2, D3 and D4 first** (§6): product questions Jacob answers in words.
2. **Three directions**, each rendering four states with real data, at 390×664 and 1280, in the
   direction's own primary theme:
   - the first screen D2 chose;
   - exchange results, 2nd year, with ACC1701XB among them, for Sem 1 and for both semesters
     (the full-year student's view and the densest card, C3-5);
   - ACC1701XB's detail (three notes, a rule-language prerequisite, its exam);
   - the hidden-code explanation as D4 chose it, for a query of four codes, two hidden for
     different reasons (one on the NG list for the other semester only, one not on it).

   Each passes the contrast script and the 390×664 fold check (the "unofficial" header, the
   collapsed bar, the first card's code, title and exchange status in view, on both results
   states) before Jacob sees
   it (A2-6). axe runs on the winner in 5D.
- The directions differ in intent. Working titles:
  - **A, "Registrar's ledger":** dense, tabular; the catalogue as a reference document.
  - **B, "Planner":** calm and card-led, built around the semester being planned.
  - **C, "Field guide":** editorial; strong type, one accent, the detail reads like an entry.
- Jacob picks one, or a blend naming which parts of which direction. The pick and its reason go
  in ADR 0008 as an amendment; 5D builds it, the second theme included.
- Published as one private artifact set (the ephemera gallery is unreachable: `p.rcn.sh` does
  not resolve).

## 3. Workstreams
| WS | Scope | Branch | Depends on |
|---|---|---|---|
| 5-0 | D2–D4, then three directions; Jacob's pick | — | critic rounds |
| 5A | exam dates: data version, bundles, `/module`; own runbook cycle | `phase5/exam-dates` | — |
| 5B | frontend foundation: static assets, modules, state, fetch, test stack, findings tests | `phase5/foundation` | — |
| 5C-api | `/search` additions: `hiddenPins`, `exchangeBySem`, `examDates` | `phase5/search-fields` | 5A shipped |
| 5C | cards, detail and hidden-code explanations (SC2, F1, P3, D4) | `phase5/detail` | 5B, 5C-api |
| 5D | the chosen design, mobile (V1, F6, F10) | `phase5/design` | 5-0, 5B |
| 5E | accessibility (F5, SC8) | `phase5/a11y` | 5C, 5D |
| 5F | phrase parsing: chips, the rule, tooling, L8 | `phase5/phrases` | 5B; L8 after 5E |
| 5G | page ship, live checks, red team | — | 5A–5E |

### 5A Exam dates (a data change)
- Migration `0010_exam_dates.sql`: `exam_dates TEXT NOT NULL DEFAULT '[]'`, a JSON array of
  `{ sem, date, durationMins }` from `semesterData[].examDate/examDuration`.
- The row hash covers it, so every row's hash and the data version change. 5A runs the README
  runbook in full:
  1. **Files** (B2-7, B3-4): `scripts/lib.mjs` (normalise), `src/rowhash.js` (`ROW_COLUMNS`,
     `boundTuple`, `fieldsFromRow`), `src/ingest.js`, `scripts/corpus-types.d.ts`,
     `scripts/verify-core.mjs`'s field compare (so `verify --pre-deploy` checks the new column),
     `src/modules.js`, `test/fixtures/schema-0006.json` (`db:rebuild-check`),
     `test/runbook.test.js`.
  2. **Bundles** (B2-8): rebuild the production, pinned and fixture bundles, reusing the
     committed vectors (no embedding pass). Upload `vec-pinned-<dv>-emb-bge-small-v1` and
     `vec-production-<dv>-emb-bge-small-v1-x286f04a3` **before** the PR's CI runs (CI fetches
     the pinned bundle). Update `data/vectors.json`, `src/data-version.json`,
     `data/vocabulary.json`, `data/groups.json`, `test/fixtures/vectors.bin` and its manifest
     sha, `test/fixtures/vocabulary.json` and `groups.json` (they record the fixture's data
     version).
  3. **Fixture:** regenerate `test/fixtures/corpus.json` from source so it carries exam dates.
     `scripts/build-vocabulary.mjs`'s fixture branch adds the 3H phrase words that are absent
     (B-7, B2-9), so `under N hours` parses on the fixture. Not `src/vocabulary.js`'s
     `buildVocabulary`, which builds every eval run's vocabulary; the production vocabulary
     already has every phrase word, and the vocabulary is not in the row hash, so the data
     version is unaffected.
  4. **Remote:** bookmark, migration, ingest with `--write-budget 55000`, verify, deploy, smoke,
     standby (step 8 upserts as the runbook says; `vectorMetadata` does not change).
- **D1 cost *est.*:** 35–50k rows written; reads ≈ 7k each for the hash diff,
  `verify --pre-deploy` and the deploy guard, plus the migration (< 20). Inside Paid's included
  allowance.
- **Ranking:** the embedding text and `/search` don't change. Gate: dev, and the eval's fixture
  set (`eval/fixtures/corpus.json`, untouched), run at the 5A commit, are byte-identical to the
  shipped-ranker pin `9d91605`'s. `SHIPPED_BASELINE` moves with a "ranking-neutral" line, no
  look. The custodian then stores the 5A pin's holdout run with `--store-only` and counts its
  lists that differ from `run-shipped-9d91605` (expected 0) with a new `eval:count
  --lists-differing --run A --baseline B` kind that prints the count only (B2-10, B3-5).
- **`/module/:code`** adds `examDates` (ISO UTC; the page shows Singapore time), `workload` as
  `{ lecture, tutorial, lab, project, prep, total }`, `{ raw }` when unparseable, or `null`, and
  `nusmodsUrl`. Additive.
- **Caching:** `Cache-Control: public, max-age=300` on 200s only, `max-age=60` on 404,
  `no-store` on 5xx; no ETag; no edge cache.
- **Rollback:** a Worker rollback comes before any Time Travel restore, since 5A's `/module`
  selects `exam_dates` and a pre-0010 bookmark lacks the column.

### 5B Frontend foundation (F2, F3, F4, F7, F8, F9)
- **Static assets.** The page moves to `public/` (`index.html`, ES modules, `styles.css`), served
  by Workers Static Assets with no binding; no file in `public/` matches an API path. Asset
  requests use no Worker CPU. `/health` stays the version trace for `/`; `test/instrument.test.js`
  and README:180 change to say so. A Playwright test asserts `/` serves the page and every API
  path still reaches the Worker.
- **No build step, no framework.** Native ES modules with `// @ts-check` and JSDoc;
  `tsconfig.web.json` (DOM lib) added to `npm run typecheck`; an ESLint block for `public/` with
  browser globals and `no-restricted-properties`/`no-restricted-syntax` banning `innerHTML`,
  `outerHTML` and `insertAdjacentHTML` (F8). Rendering builds DOM nodes with `textContent`.
- **State in the URL**, one pure `state ↔ URLSearchParams` module, unit-tested in Node:
  - in exchange mode `ng=1`, `sem` (absent for both semesters) and `study` are always in the
    URL; localStorage only pre-fills the set-up;
  - Phase 6's names are reserved now: `pick` and `alt`;
  - at most one detail is open; opening another replaces `open=` (A2-4);
  - **transitions**, tested in Node and Playwright:

    | action | history | Back restores |
    |---|---|---|
    | submit a query | push | the previous query's results |
    | change a filter, exchange setting, or remove a chip (`ignore=`) | replace; drops `open=` and closes any detail (A3-3) | — |
    | open a detail (`open=CODE`) with none open | push | the list, detail closed, focus on its button |
    | open another detail while one is open | replace | the list |
    | close a detail (button or Escape) | `history.back()` while the current entry is the one this page pushed for it, else replace | — |
    | clear the query | push (empty URL) | the cleared results |

    `popstate` restores the state and re-renders from an in-memory cache, re-fetching only on a
    miss (F3).
- **Filters don't wait on `/facets` (F4).** Semester, credits, level and study level are static
  option lists; faculty comes from `/facets`, and a faculty from the URL not in the list is
  added as an option. The first search starts at once.
- **Fetch layer (F2, F7):** each search aborts the previous; a 10 s timeout; non-JSON bodies
  handled before parsing; `429` reads `Retry-After`; every error code and every `noMatch`
  reason maps to a plain sentence; raw codes are never shown.
- **IME (F9):** Enter submits only when `!e.isComposing && e.keyCode !== 229`.
- **The findings tests** (A-3, A2-5): the Phase 4 page is committed frozen as
  `docs/evidence/phase0/page-phase4.html`; the frontend characterisation tests move to
  `test/findings/frontend.node.test.js` and read that copy; each becomes a correctness test
  against `public/` in the workstream that fixes it. FINDINGS evidence paths are updated so
  `check-findings` passes.
- **UI test stack:**
  - `src/intent-data.js` and `src/group-data.js` import bare names `vocabulary-data` and
    `groups-data` (A2-1). Aliases: `wrangler.jsonc` points them at `./data/` (production);
    wrangler merges config and CLI aliases, so deploy adds no `--alias` and
    `test/deploy.node.test.js`'s argv assertions stand. `vitest.config.mjs`'s regex aliases
    become bare-name aliases; **`vitest.eval.config.mjs` aliases both to
    `join(ws, 'data/…')`, each run's own workspace copies** (A3-1, B3-2), asserted in
    `test/vectors.node.test.js`. The 5F dev screen checks that the vocabulary sha a run records
    is the one the ranker loaded.
  - `test/ui/worker.js` wraps `src/index.js` and passes `{ ...env, AI: FakeAI, SEARCH_LIMIT:
    FakeRateLimit }`; `test/wrangler.ui.jsonc` adds the assets block and the fixture aliases.
    `npm run dev` points at it.
  - `scripts/ui-server.mjs`: a temporary `--persist-to` directory and `--env-file` with a
    one-off `INGEST_SECRET`, `d1 migrations apply --local`, seeding through
    `/admin/ingest?d1Only=1` in batches of 100, `/admin/catalogue` with the fixture's
    catalogue-only rows (A3-4), then `/admin/facets` with `NG_LIST` (A2-9).
    Nothing remote; the secret never touches `.dev.vars`.
  - Playwright (`@playwright/test`, Chromium and WebKit) with `@axe-core/playwright`; specs are
    `test/ui/*.spec.js`, under `tsconfig.node.json` and the Node lint block, outside every vitest
    project (A2-7). Failure states (timeout, 429, HTML error page, `/facets` down, keyword-only
    `degraded`), parsed-phrase chips (A2-2) and the raw-workload case (A2-8) use request
    interception.
  - Node unit tests for the pure modules (URL state, error and noMatch mapping, workload and
    exam formatting, prereq cleanup).
  - CI job `ui`: a diff step like `full-corpus`'s decides whether it runs, over `public/`,
    `src/`, `test/ui/`, `test/fakes.js`, `scripts/ui-server.mjs`, the wrangler and Playwright
    configs, `migrations/`, `test/fixtures/`, `data/`, `package.json`, `package-lock.json`.

### 5C-api `/search` additions (ranking-neutral)
- **`hiddenPins: [code]`** (A2-3, A3-2): the parser also records `codes`, every code-shaped
  token in the query (up to 10); `pins` stays at `MAX_PINS = 3`, so ranking doesn't move. The
  existing pin `IN (...)` statement widens to every offered code in `codes` (the same statement,
  a few more rows), and `hiddenPins` lists those the filters remove. A code with no row, or a pin
  skipped because its group's member is already shown (`src/search.js:959-963`), is never
  listed as hidden.
- **`notOffered: [code]`:** codes in `codes` that are catalogue-only, from `ctx.catalogue` (no
  read), so a not-offered code inside a list is reported too, not only a whole-query code.
- **`exchangeBySem: { 1, 2 }`** on each result under `ng=1` with no `sem` (C2-1), built from the
  row's stored `ng_allow`/`ng_rules` (no extra read). An SC1 path test proves each semester's
  status equals the oracle's.
- **`examDates`** on each result (C2-8): `exam_dates` joins `RESULT_COLUMNS` in
  `src/modules.js` and the hydrate column list (`src/search.js:544`), for the card's meta line.
- Gate: every dev and fixture result list byte-identical to the 5A pin's in ranking; the only
  change is the new fields. Eval run files read only codes and doc metadata, and the SC1 tests
  compare code lists, so only whole-body tests change. Code-only; ships with the page.

### 5C Cards, detail and hidden-code explanations (SC2, F1, P3, D4)
- **The card** (APG disclosure pattern): a heading holding one button (code and title) with
  `aria-expanded`/`aria-controls`; units, department, semesters and the exam ("Exam 26 Nov" or
  "No final exam") as plain text; the detail region outside the button. No raw score (F1).
- **Exchange status on the card:** for the chosen semester, or per semester when planning both
  (from `exchangeBySem`), never one merged value. **Every note shows in full** (C2-3); the
  `semester` note is worded as an action ("Not on NUSMods' timetable for Sem 2: check with the
  department"). The fold check runs on ACC1701XB.
- **The detail** opens inline below the card and fetches `/module/:code` once (memory cache):
  - description;
  - **prerequisites and preclusions:** a cohort-only prerequisite reads "No course prerequisite
    (the rule names NUS intake years only)"; otherwise the NUS text with spaces restored around
    THEN/AND/OR, labelled "as NUS states it", course codes linked to a search. No plain-English
    rewrite of the rule language in this phase (a recorded limit);
  - exam per semester in Singapore time with duration, or "No final exam listed";
  - workload: total hours per week and the split, or "Workload not listed", or NUS's raw text;
  - **exchange availability per semester:** in exchange mode, Sem 1 and Sem 2 for the chosen
    year, each open, noted (every reason) or not open, with the rule's source and its "updated
    as at" date; outside exchange mode, the table for all five years;
  - "Check with NUS before you register" beside the exchange status;
  - "Class times and timetable on NUSMods" (the "Open in NUSMods" link), with a line that class
    times aren't shown here.
- **Hidden codes (D4, C2-4)**, as Jacob answers D4:
  - **each code in `hiddenPins`** gets a line with that code's own stored reasons (C3-1), each
    with its source and "updated as at" date, from `/module/:code`'s `exchange` at the chosen
    semester and year. E.g. CS3244 at 2nd year, Sem 1: "CS3244 is open to exchange students
    only in Sem 2 (NG list, updated 01 Sep 2026)." Of the 6,094 courses hidden at ug2 Sem 1,
    5,611 are not on the NG list, 444 are on it for the other semester only, and 39 are closed
    by a restriction; the line says which. The course is never listed as a result, so SC1
    holds;
  - **each code in `notOffered`**: "CS1001 isn't offered in 2026/27" (a catalogue-only code),
    with related courses when it was the whole query, as today's API returns them;
  - **a partial code** that exchange mode empties (C3-2): if the other semester has results,
    "No CS32xx course is open to exchange students in Sem 1 at 2nd year" with a button to see
    Sem 2; otherwise, or when both semesters are chosen, "No CS52xx course is open to exchange
    students in either semester at 2nd year", with no button (1,154 of the 1,200 prefixes empty
    at ug2 Sem 1 are empty in Sem 2 too). Never "loosen a filter" when the filter is exchange
    eligibility.
- **P3:** the `<title>` and the visible header say "unofficial" at every width; the working name
  doesn't put NUS forward as the brand (D3). The footer links NUSMods, the NG list, the
  restrictions and the Registrar's vacancy report. The P3 test asserts "unofficial" is in view
  at 390×664.

### 5D The chosen design (V1, F6, F10)
- Built from the 5-0 pick, both themes: tokens, a type scale, consistent filter labels ("Sem 2",
  "Level 2000"), removable filter chips, and an empty state that names the next step.
- A script checks every text/background pair in both themes against WCAG AA (4.5:1 text, 3:1
  large text and UI), replacing F6's characterisation test.
- **Mobile (F10):** 16px inputs; after the first search the form collapses to one bar that keeps
  the query field and the submit button visible; filters open in a modal `<dialog>` from a
  "Filters (n)" button, focus trapped, Escape closes, focus returns to the button.

### 5E Accessibility (F5, SC8)
- `<main>`, `role="search"`, a skip link, one `<h1>`; `aria-busy` on the list while loading; one
  polite live region for "N results for …", no match, hidden codes, errors and 429; the submit
  button is never disabled while focused (a second submit aborts the first).
- Escape closes the open detail and returns focus to its button.
- **SC8 measured:**
  - **axe with every rule** (no tag filter) on each state × both themes × 1280 and 390×664:
    first screen, results, exchange results (one semester and both), detail open, hidden codes,
    not offered, partial-code empty, chips (intercepted), no match, error, keyword-only, filters
    dialog. Zero violations, in CI.
  - **Keyboard:** Playwright runs the whole task keyboard-only at 1280 and at 390×664 (search,
    filter, exchange set-up, open a detail, follow a link, Back) and asserts focus order and a
    visible focus ring.
  - **Screen reader:** Playwright asserts the live region's text after search, no match, hidden
    codes, error and 429, and every control's accessible name; accessibility snapshots catch
    drift. A VoiceOver walkthrough (macOS Safari) follows a committed checklist
    (`docs/evidence/phase5/voiceover-checklist.md`), on the local UI server before the deploy
    and again live. It is scripted where VoiceOver's AppleScript control can be turned on
    (reading the last spoken phrase into a transcript); otherwise Jacob runs the checklist and
    the lead records it (A2-10).
  - **Mobile fold:** at `devices['iPhone 13']` (390×664) in WebKit and at 390×664 in Chromium,
    the first result's code, title and exchange status are wholly in view, after a typed search
    and on a shared-link load; in CI on the fixture and once live.

### 5F Phrase parsing (SC4's parsed-intent items)
- 3H's parser stays as built (`PARSE_PHRASES`, variant (ii)).
- **The UI:** each parsed phrase becomes a chip ("No final exam", "Under 10 h a week", "No
  prerequisites") with a remove button that re-runs with `ignore=<intent>`. Tested with an
  intercepted response before L8 (the flag is off), and live in the ship PR's checks.
- **The compliance-aware rule**, committed as an ADR 0003 amendment before any count or look:
  - **The reference parse is frozen** (B2-1, B3-1): 3H's pass A at tag `3h` (`2476012`, which
    predates the `PARSE_PHRASES` flag, so its phrases always compile), run over the eval's
    pinned vocabulary, decides each query's constraints for scoring, independent of the
    candidate. The gate refuses to run if the reference parses 0 dev queries, and the verdict
    path throws, before the ledger row is written (`eval/cli.mjs:325-366`), if the candidate's
    parse differs from the reference's on any query, so a parse mismatch stops the run without
    spending the look. On dev, every query it parses is listed and confirmed by hand before the screen.
    On the holdout no one checks the parse; a misparse there would remove relevant documents
    from both lists and the ideal ranking and go unseen. The amendment accepts that risk in
    writing, bounded by the dev hand-check and SC4's suite.
  - **The constraint fields' source** (B2-2): the pinned snapshot normalised by the candidate's
    `scripts/lib.mjs`; the exchange bit from `src/ng-bit.js` and `eval/study-map.json`. The gate
    throws on any judged or returned code missing from it.
  - **Constraint-filtered qrels:** for a query with constraints (a parsed phrase, and in
    exchange mode its `sem`/`study`), a judged document counts as relevant only if it satisfies
    every constraint, in DCG and IDCG alike. A query left with no compliant relevant document is
    unscored, exactly as `scoredSet` treats a query with no relevant document (B2-6). Both the
    candidate and the pin are scored on the same filtered qrels. Exchange-mode removals are
    scored the same way, which answers the 2026-11-10 amendment for every later look.
  - **Pass iff, on the holdout:** ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 over the primary set's scored
    queries; **and** ΔnDCG@10 ≥ 0 over the constraint block's scored queries (B2-3), a recorded
    vacuous pass if the block has none (B3-3: `mean([])` is NaN); the exact-
    code check holds, on raw qrels (B2-6); compliance is 100% (every shown result of a
    parsed query satisfies its constraint); every query the reference parse leaves unparsed has
    its top 10 byte-identical to the pin.
  - **The dev screen before the look:** the same rule on dev, plus SC4's 14 parsed-intent items.
    L8 is taken only if it passes; otherwise phrases stay off, SC4's parsed items stay unmet,
    and no look is spent.
  - **A diagnostic, no gate** (B2-4): on dev, the candidate against the pin run with the parsed
    constraints passed as explicit params, which isolates the parse and the strip from the
    filter itself. Reported.
  - **One look, L8 of 12, no retry.**
- **Tooling:** `no-loss` and `--exempt` are refused on encrypted sets today. 5F adds a holdout
  rule kind to `eval/lib/gate.mjs` that applies the reference parse, filters qrels, and checks
  compliance and identity inside the verdict path, printing only the verdict, the Δ lines and
  counts (scored, unscored, parsed), never ids or queries. Counts come only from that verdict
  run, never from a separate tool, so no candidate is re-counted without spending the look
  (B2-6). Tested on dev and fixture sets before the amendment names it.
- **L8's baseline** is the pin after the page ship (5G), with its stored `--store-only` holdout
  run and a differing-lists count (B3-6).
- **If L8 passes, the ship PR:** turns `PARSE_PHRASES` on, moves `SHIPPED_BASELINE` with an ADR
  pin line ("L8 pass"), re-enables the 14 pending SC4 items, and ships exactly the ranker L8
  judged. Code-only.

### 5G Page ship, live checks, red team
- **Order:** 5A ships first as its own runbook cycle and deploy. 5C-api and 5B–5E then ship as
  one code-only deploy, whose rollback is `wrangler rollback` alone; it moves
  `SHIPPED_BASELINE` with a "ranking-neutral" line (dev and eval fixture identical), and the
  custodian stores its holdout run with `--store-only` and counts differing lists (expected 0,
  B3-6). 5F ships after L8, code-only.
- **Live checks**, at most one call per 4 s, logged in `requests.tsv`:
  - SC2 on 20 codes drawn stratified (exams in two semesters, cohort-only prerequisite, no
    workload, two or more notes, plain), each field present or its "not listed" text;
  - axe on the live page; the 390×664 fold check;
  - the hidden-code explanation for 3 drawn closed codes and 1 partial code;
  - `/health` traces the commit.
- **SC2 in CI:** for every fixture code, load `?q=CODE&open=CODE` and find each field or its
  "not listed" text; the raw workload case by interception (A2-8).
- **Red team** (fresh contexts that never see this plan), on the live page through Playwright,
  each with an exchange brief:
  - a non-business major who meets `major` notes, keyboard only;
  - a student with a home-university list of four codes, two of them closed, screen-reader tree
    only;
  - a full-year student on a 390px phone;
  - each answers **yes / yes if <condition> / no / ask NUS** for every course they pick (C3-3).
    The expected answer is fixed before the run, from the oracle's status and the persona's
    brief, by this table:

    | oracle status or note kind | expected |
    |---|---|
    | closed | no |
    | open, no note | yes |
    | `quota`, `approval`, `audition` | yes if (the condition) |
    | `graded`, `fee` | yes if the brief accepts the condition, else no |
    | `major` | yes if the brief's major meets it, else no |
    | `letter` | yes if the brief has the letter, else no |
    | `partner` | set by the brief if it says whether the home school is a partner, else ask NUS |
    | `restricted-elsewhere`, `semester`, unknown | ask NUS |

    With several notes the most restrictive answer wins (no > ask NUS > yes if > yes);
  - every disagreement is classified as a page defect (fixed and re-run), a source ambiguity
    (Jacob rules) or a persona error. Exit needs zero page defects open;
  - a plain-language pass over every reason text, noMatch sentence and error sentence, by a
    reviewer writing for non-native readers;
  - a security reviewer of `public/` (injection, link targets, open redirects).

## 4. Cost, ops and risks
- **D1:** 5A only. The page ship and 5F write nothing.
- **Workers:** static assets cost nothing; `/module` adds one request per opened card, browser
  cached for 5 minutes.
- **CI:** the `ui` job adds Playwright with two browsers (*est.* 4–6 min); minutes are free.
- **Holdout:** at most one look (L8 of 12), plus no-look `--store-only` runs.
- **Risks:**
  - Static assets change how `/` is served; the deploy guard, smoke and `/health` must pass.
  - Prereq text stays in NUS's rule language; only spacing and the cohort case are fixed.
  - Class times are not shown; the detail links to NUSMods for them.
  - The working name is temporary; Phase 8 renames it.
  - A holdout misparse would go unseen (accepted in the amendment).
  - Phrase parsing may fail its dev screen or L8; then it stays off for good.

## 5. Exit criteria
- 5A shipped; data version and pin moved; dev and the eval fixture identical to `9d91605`'s
  rankings; the 5A pin's holdout run stored, 0 lists differing.
- SC2: every fixture code passes `?q=CODE&open=CODE` in CI; live, 20 stratified codes pass.
- SC8: axe (all rules) zero violations in CI on every state × theme × width and once live; the
  keyboard test passes at both widths; the live-region assertions pass; the VoiceOver checklist
  completes locally and live; the fold check passes in CI and live.
- F1–F10, V1 and P3 `fixed`; their characterisation tests rewritten as correctness tests.
- The design gate passed (ADR 0008).
- 5F: shipped under the rule, or recorded as not shipped (dev screen or L8 failed).
- The red team: zero page defects open; any source ambiguity ruled by Jacob.
- README, `CLAUDE.md` and the vault page describe the frontend as it is.

## 6. Gate questions for Jacob
Asked after the critic rounds: D2, D3 and D4 first, D1 once the mockups exist.
- **D1. Design direction:** A, B or C (mockups linked), or a blend naming which parts of which.
- **D2. First screen:** open in exchange mode (semester, or both, and year of study first, with
  "browse all courses" as the way out), or open on general search with exchange as a switch, as
  today? Either way, browse-all cards keep a small marker of the semesters a course is on the
  exchange list for, as today's "NG" badge does (C3-4). Lead default: **exchange first**, since
  the site is for incoming exchange students.
- **D3. Working name** until Phase 8, marked unofficial, without NUS as the brand. Lead default:
  "Exchange Course Finder (unofficial, for NUS)".
- **D4. When a student types course codes exchange mode hides,** say why for each ("CS3244 is
  open to exchange students only in Sem 2"), or show nothing? Lead default: **say why**; the
  course is never listed as a result.

## 7. Critic log
### Round 1 (critics A frontend and accessibility, B data/eval/ship, C product)
| # | Critic | Objection | Resolution |
|---|---|---|---|
| A-1 | A (blocking) | no AI binding: every search degraded, no-signal unreachable | `test/ui/worker.js` injects FakeAI and FakeRateLimit; keyword-only a named state |
| A-2 | A (blocking) | no route to seed local D1; fixture lacks exam dates | `scripts/ui-server.mjs`; fixture regenerated in 5A |
| A-3 | A (blocking) | deleting `src/page.html` breaks findings tests and check-findings | tests move in the 5B PR; evidence paths updated |
| A-4 | A (blocking) | WCAG tags skip F5's best-practice rules | axe runs every rule |
| A-5 | A (blocking) | collapsed form hides the focused button; sheet focus unspecified | bar keeps the button; modal `<dialog>`; keyboard test at both widths |
| A-6 | A | 390×844 ignores browser chrome; state unspecified | 390×664 (`iPhone 13`), typed search and shared link |
| A-7 | A | snapshots don't prove announcements; VoiceOver only after ship | live-region assertions; VoiceOver locally before deploy and live |
| A-8 | A | button-like card nests interactives | APG disclosure pattern |
| A-9 | A | history transitions unspecified | transition table, tested |
| A-10 | A | assets: `x-app-version` on `/`, typecheck, ESLint, CI filter | each listed in 5B |
| B-1 | B (blocking) | new column changes every row hash and the data version | 5A is a data change: bundles, release assets, fixture; identity vs `9d91605` |
| B-2 | B | D1 estimate 5× low; reads missing | 35–50k written, `--write-budget 55000`, reads listed |
| B-3 | B (blocking) | ship order breaks the runbook; one rollback for data and page | 5A its own cycle and deploy; page ship code-only; rollback order stated |
| B-4 | B | ETag stale and unused; errors cached; no edge cache | status-specific Cache-Control, no ETag |
| B-5 | B (blocking) | rule 3 is the rule 3H failed; look gated without it | constraint-filtered qrels; dev screen before L8; P@5 and exact-code kept; exchange removals scored the same way |
| B-6 | B (blocking) | tools refuse no-loss/--exempt on encrypted sets; output limit | gate.mjs holdout rule kind printing counts only; eval:count kinds; tested |
| B-7 | B | fixture vocabulary corrects `hours` | phrase words added to the fixture vocabulary |
| B-8 | B | flag flip changes the ranker | pin move, SC4 items, exact ranker in the ship PR |
| C-1 | C (blocking) | hidden typed code dropped silently | explanation via `/module`; D4 |
| C-2 | C (blocking) | "short form" hides conditions | full text for condition kinds on the card |
| C-3 | C (blocking) | "unofficial" moved to the footer; NUS as brand; "check with NUS" dropped | header and title at every width; D3 without NUS as brand; line kept |
| C-4 | C | verbatim rule language | cohort case and spacing fixed; rewrite deferred, recorded |
| C-5 | C | mockups tangle D1 with D2, omit hard cases | every direction renders both first screens and the worst cases |
| C-6 | C | full-year students | "both semesters" in the set-up; status per semester |
| C-7 | C | URL meaning varies by device; Phase 6 names | `study` always in the URL in exchange mode; `pick`/`alt` reserved |
| C-8 | C | class times missing | link labelled for class times; limit stated |
| C-9 | C | red team tests access modes, not exchange decisions | exchange briefs, oracle-diffed calls, plain-language pass |

### Round 2 (fresh critics on r2: A frontend and accessibility, B data/eval/ship, C product)
Found sound by round 2: A-1 (injection), A-2, A-4, A-6, A-8, A-10 (deploy side); B-2, B-3, B-4,
B-8; C-3, C-4, C-7, C-8, and C-2 in substance.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A2-1 | A (blocking) | wrangler can't alias the relative vocabulary/groups imports | bare-name aliases `vocabulary-data`, `groups-data` in every config and deploy |
| A2-2 | A (blocking) | chips state unrenderable while `PARSE_PHRASES` is false | intercepted response; live check in 5F's ship PR |
| A2-3 | A (blocking) | page can't tell which typed codes were hidden | `/search` `hiddenPins` (5C-api) |
| A2-4 | A | close-by-replace makes Back look dead; several open details | `history.back()` when pushed; one open detail |
| A2-5 | A | known-bug tests can't assert old bugs on `public/` | frozen `page-phase4.html` under evidence |
| A2-6 | A | mockups skip the fold check | fold check on each mockup |
| A2-7 | A | spec naming, tsconfig/lint, CI filter, `npm run dev` | `*.spec.js` under Node config; diff step; dev → UI config |
| A2-8 | A | SC2 evidence undefined; raw workload absent from fixture | `?q=CODE&open=CODE` per code; interception; stratified live draw |
| A2-9 | A | `/admin/facets` posted without `NG_LIST` | posted |
| A2-10 | A | VoiceOver method undefined | committed checklist; scripted via AppleScript or run by Jacob |
| B2-1 | B (blocking) | candidate's own parse filters the qrels (circular) | frozen reference parse; dev hand-check; holdout risk accepted in writing |
| B2-2 | B (blocking) | run files lack constraint fields | source named: pinned snapshot via candidate's `lib.mjs`; throws on missing |
| B2-3 | B (blocking) | exam queries sit outside the primary set | constraint block ΔnDCG@10 ≥ 0 on dev and holdout |
| B2-4 | B | filtered qrels favour the candidate over the pin | dev diagnostic against the pin with explicit params |
| B2-5 | B | dev screen passes only thinly | recorded in §1; decided by the real run |
| B2-6 | B | exempt, exact-code and identity definitions; re-countable counts | exempt = unscored; raw qrels; counts only inside the verdict run |
| B2-7 | B | 5A misses files | listed |
| B2-8 | B | release assets, pinned data version, eval fixture | named; uploaded before CI; eval fixture untouched |
| B2-9 | B | hand-added fixture words lost on regeneration | the generator unions the phrase words |
| B2-10 | B | L8's baseline run missing | `--store-only` run of the 5A pin, differing lists counted |
| C2-1 | C (blocking) | no per-semester data for "both semesters" | `/search` `exchangeBySem`, SC1 path test |
| C2-2 | C (blocking) | two condition notes never occur | ACC1701XB and CG2023 named; both in the fixture |
| C2-3 | C | short labels save nothing | every note in full; `semester` worded as an action |
| C2-4 | C (blocking) | several codes, not-offered and partial codes uncovered | all three states in 5C and D4 |
| C2-5 | C (blocking) | red-team exit undefined and unreachable | expected answers fixed in advance; disagreements classified; zero page defects |
| C2-6 | C | gate too heavy for good mockups | D2–D4 first; four states per direction; axe on the winner; no shortlist slot |
| C2-7 | C | D4 phrasing; blends | reworded; blend names parts |
| C2-8 | C | exam date only in the detail | on the card's meta line via `/search` `examDates` |

### Round 3 (fresh critics on r3; final)
Found sound by round 3: A2-1's mechanism (a bare alias to a JSON file bundles under wrangler
4.157.0, and config and CLI aliases merge), A2-3 for up to three codes, A2-5, A2-7, A2-9, C2-1,
C2-8 and cache safety; B2-2 to B2-10 in substance; C2-2, C2-3, C2-6, C2-7.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A3-1 | A (blocking) | bare aliases break every eval run, or point it at the wrong vocabulary | `vitest.eval.config.mjs` aliases to the run's workspace; asserted; dev-screen sha check |
| A3-2 | A (blocking) | only 3 codes are pinned; a not-offered code in a list is dropped | parser records `codes` (≤ 10); `hiddenPins` over all; `notOffered`; exclusions stated |
| A3-3 | A | filter change while a detail is open, then close, undoes the filter | the replace drops `open=`; `back()` only while on the pushed entry |
| A3-4 | A | UI server never seeds `catalogue_only` | `/admin/catalogue` seeded |
| B3-1 | B (blocking) | any commit on `main` parses nothing (`PARSE_PHRASES` off) | reference parse at tag `3h`; 0-parse refusal; mismatch throws before the ledger row |
| B3-2 | B (blocking) | = A3-1 | as A3-1, plus `vitest.config.mjs` regex aliases |
| B3-3 | B (blocking) | empty constraint block gives NaN and fails L8 | recorded vacuous pass |
| B3-4 | B | 5A list misses `rowhash.js`, `RESULT_COLUMNS`, hydrate columns | listed (5A, 5C-api) |
| B3-5 | B | no tool prints a differing-lists count | `eval:count --lists-differing` |
| B3-6 | B | unstated whether the page ship moves the pin | it moves; stored run and count before L8 |
| C3-1 | C (blocking) | D4's example false for its own code; wrong date | each code's stored reasons; examples corrected to the data |
| C3-2 | C (blocking) | not-offered and partial-code examples false; dead-end button | catalogue-only example; button only when the other semester has results; both-semesters sentence |
| C3-3 | C (blocking) | yes/no undefined for most note kinds | four answers, a fixed table per kind |
| C3-4 | C | D2 silent on browse-all markers | marker kept; stated in D2 |
| C3-5 | C | no both-semesters mockup state | state 2 renders both, with the fold check |

**Convergence (round 3 of 3):** every blocking objection from all three rounds was accepted and
the plan changed. None was declined, so ADR 0008 records no dissent.
