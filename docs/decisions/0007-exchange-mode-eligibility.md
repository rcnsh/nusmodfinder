# 0007: Exchange-mode eligibility is computed at ingest from NUS's rules as data

Status: accepted. How it works in detail is in [docs/exchange-mode.md](../exchange-mode.md).

## Context
Exchange mode must never show a course an exchange (Non-Graduating, NG) student can't take in the
chosen semester at their year of study. NUS states availability in two Registrar PDFs, the NG
course list (per semester) and the course restrictions list. Neither is in the NUSMods API, and
both sit behind a bot wall.

## Decision
- **Scope.** Exchange mode applies the NG list and the restrictions. A `closed` course is
  hidden. A course needing a home major, a partner institution, an audition, approval or a quota
  is shown with a note. A course not on the NG list is hidden.
- **One pure function, run at ingest.** `eligibility(module, { sem, study }, rules)` in
  `src/eligibility.js`; `study` is `ug1`–`ug4` or `grad`, and `/search` requires it with `ng=1`.
  Ingest stores a 15-bit **allow** mask (`modules.ng_allow`; zero or missing means closed) and the
  rule ids behind each answer (`modules.ng_rules`). The Worker runs no rule logic: every search
  path tests one bit, and under `ng=1`, `sem` only selects that bit. Reason texts ship with the
  Worker (`data/ng-reasons.json`), so rewording one rewrites no rows.
- **Rules are data.** `data/ng-restrictions-<year>.json`, with citations and titles, built from
  two independent transcriptions of the PDF diffed against each other, a 20% audit, and a register
  that rules on every reading the sources leave open (`docs/year-refresh/registers/<year>.md`).
- **Verification is independent.** An oracle written separately from the sources and the register
  (`test/oracle/oracle-<year>.node.mjs`) is run over every module × semester × year of study, and
  per-path set-equality tests check every search path against it, in their own CI job (`oracle`)
  over the production corpus. Correctness changes are gated without a holdout look (ADR 0003,
  `gated-without-a-look`).
- **Storage.** No new Vectorize metadata: the standby relies on the D1 recheck. The bundle keeps
  its 32-byte filter row.

## Notes read per request, never stored
Two of NUS's conditions are read from a row's own fields on every request, so they need no
column, no migration and no row-hash change, and they never close, open or reorder anything.
`exchangeAt` in `src/ng-reasons.js` adds them, so every `/search` path and `/module/:code` get
them the way they get the stored notes.

- **The year-of-study note** (`src/year-note.js`). A NUS prerequisite that requires an
  undergraduate year ("If undertaking an Undergraduate Degree THEN must be Year 4"; about 940
  courses carry one) doesn't change a course's exchange status. When the student's year of study
  during the exchange is below that year, the course carries an "ask NUS" note: NUS lists it for
  Year N students, so the student asks the department whether their year counts. Only
  unambiguous texts give it: one undergraduate branch, and a year item no OR sits beside.
  `/search`'s hydrate reads the prerequisite (`year_prereq`) only where it mentions a year.
- **The level-4000 note** (`src/level-note.js`, id `gro:level-4000`, kind `supply`). NUS Global's
  sentence that higher-level undergraduate courses are "usually NOT available to exchange
  students" is a condition, like a quota: such a course shows "Open, with 1 note", and the answer
  is "yes if there's a place". It applies to level 4000 only (NUS's undergraduate levels run to
  4000; 5000 and 6000 are graduate courses, which the restrictions and departments govern), to
  undergraduates only, and not to Law, which opens only its LL4 electives and registers its own
  invitees.

## Consequences
- Every source revision repeats the transcription, register, oracle and the `oracle` CI gate for
  what changed (docs/year-refresh/).
- Exchange mode covers Semesters 1 and 2 only: the NG list has no special-term data.

## In the code

**Eligibility and the stored bit**
- `src/eligibility.js` `eligibility()` applies rule D itself rather than from the rules file:
  level 5000 and above is closed unless an `open` rule names it for the student's study. The
  department and code rules run after it, closed winning and notes accumulating. With `sem`
  `'any'`, a course rates as its best NG-listed semester: confirmed only if one is both published
  and timetabled on NUSMods, else it gets `ng:unpublished-sem`. A course NG-listed in a semester
  NUSMods timetables no class for carries a note there, never plain open
  (`test/module-detail.test.js`).
- `matches()` lifts a `notInList` condition only for a listing in a semester the course is
  NG-listed in. A listing in a semester the student can't take it in lifts nothing.
- Exchange mode fails closed. `src/lexical.js` `filterSql()` interpolates the semester into a
  column name and the allow bit as an integer literal, so it throws `RangeError` on a semester
  outside 1–4 or a bit outside 0–0x7fff. A request with no study gives bit 0, which `filterSql()`
  and `src/vector-bundle.js` `compileMask()` both read as closed, never as unfiltered, even though
  `/search` already answers that request 400. A bundle row without `ngAllow` packs as 0.
  `test/vector-bundle.node.test.js` and `test/lexical-driver.test.js` hold both.
- `src/search.js` `parseFilters()` narrows only on a truthy `ng`. `ng=false`, `ng=0` and an empty
  `ng` are accepted and ignored: "courses an exchange student may not take" is a filter nobody
  wants.
- `src/ng-reasons.js` `reasonsFor()` gives a rule id the deployed build doesn't know (a row
  ingested under newer rules than the Worker's) a generic text of kind `unknown`, so a D1 write
  that runs ahead of its deploy never breaks a result card.

**Reading NUS's text**
- `src/year-note.js` `requiredYears()` first puts spaces back where NUS glues THEN, AND or OR to
  a lower-case letter, digit or bracket ("DegreeTHENmust", ")OR("), leaving capital words that
  merely contain one (MAJOR, STANDARD) whole. It then drops "or greater/higher/better/above/more",
  so "a GPA of 3.2 or greater" isn't read as an alternative to the year item. A level holding AND
  and OR with no brackets gives no note, since NUS states no precedence.
- `src/level-note.js` `GRO_LEVEL4` is GRO's sentence word for word. Reword it only when GRO's
  page does.
- `scripts/build-ng-restrictions.mjs` takes YST's elective list as the union of two markers,
  neither complete on NUS's pages: a line carrying "(N Units" (codes on it or up to three lines
  above, as titles wrap) and a code in an orange (`#ff5200`) span. Codes in Pre-requisite,
  Co-requisite and Preclusion lines carry neither, so they stay out.
- `scripts/build-ng-reasons.mjs` words the `GRAD_LEVELS` reason from the restrictions PDF ("NOT
  available to exchange students unless specified in the list below"). It offers no department
  approval, since the PDF offers none, and says "yours" because the list can open a course to some
  years of study only (`1-sea-l5-yr4-pg`).

**Ingest**
- `scripts/lib.mjs` `loadNgRestrictions()` reads the rules file with `readFileSync` (nothing
  imports JSON) and throws for a year with an NG list but no rules file, or a stub one. Without
  that, exchange mode would show courses as unchecked rather than refuse the build.
- `scripts/lib.mjs` `facetsPayload()` always carries `ngList`, nulled with a zero count when
  there is no NG list, so an ingest without one overwrites a stale `meta.ng_list` and `/facets`
  never shows an old date beside a zero count. `test/regressions/source.node.test.js` fails on a
  hand-kept copy of the date in the Worker.

**The page's wording**
- The exchange set-up is eligibility, not a preference. `public/app.js` `removableFilters` never
  counts exchange mode or its semester as a filter to remove. When exchange mode empties a list
  with no other filter, `public/render.js` `showResults()` says eligibility emptied it (not that no
  course matches) and suggests neither other words nor loosening the set-up, which would show
  courses the student can't take. `public/explain.js` `partialCodeLine()` never says "loosen a
  filter" either.
- `public/explain.js` never overstates what NUS allows. A semester whose reasons are of kind
  `ask` stamps "To confirm", never "Open", and `sourceNote()` cites it as "NG list" with no date,
  because the reason names last year's list and this year's isn't out. `filterMisses()` never
  blames the semester in exchange mode, where the NG list decides it (`src/search.js`
  `localMatchesFilters()`), not NUSMods' timetable. A code closed in both semesters says so before
  each semester's reasons, so the first line never reads as "switch semesters".
- `public/shortlist.js` finds rule E in `/facets`' `offListRules` by its `role: 'off-list-rule'`,
  never by id: the id comes from the year's overlay (`scripts/ng-overlay/<year>.mjs`) and can
  change at a year refresh, while `scripts/build-ng-reasons.mjs` writes the role every year.
  `covers()` matches a rule to a course by department (and level, as digits) or faculty, never by
  code prefix, because NUS's prefixes don't map to departments. Rule E's scope is `{}`: it covers
  nothing and is only the fallback line. Rule 4-cee is scoped by department for the same reason:
  one of the offered GEC codes is CEE's (`test/exchange-ingest.node.test.js`).
- `public/shortlist.js` copies `src/eligibility.js`'s unpublished-semester reason ids, which the
  static page can't import. An entry in an unpublished semester is to confirm when it was on last
  year's list (`ng:unpublished-sem`) and not counted when it wasn't
  (`ng:unpublished-sem-unlisted`), and its line says the listing is last year's. GRO's level 4000
  note counts among the row's exchange conditions, not NUS's course notes, so a row says it once.

**The oracle and its tests**
- `test/oracle/oracle-shared.node.mjs` holds the oracle's year-invariant readings, imported by
  every year's oracle and re-exported by `test/oracle/oracle.mjs`. `prereqYears()` reads the
  year-of-study note with its own tokenizer:
  - Y1: only unambiguous texts. No "if undertaking" and no graduate degree named, or exactly one
    "if undertaking (an) Undergraduate Degree then" at the start.
  - Y2: brackets give AND/OR groups. A group holding both AND and OR is ambiguous, and words side
    by side with no keyword read as AND.
  - Y3: a "must be (in) Year …" item binds only when every group around it is AND.
  - Y4: "or greater" (higher, better, above, more) is a comparison, never OR.
  - Y5: of several binding items the one with the highest lowest year wins, and the note fires
    when the home year (`ug1`–`ug4` as 1–4) is below it.

  `levelNoteOf()` reads GRO's note: a code whose first digit is 4 (G1), for `ug1`–`ug4` only
  (G2), never in NUSMods' faculty `Law`, whose §5 decides its own level 4000 electives (G3). Like
  `src/year-note.js`, `prereqYears()` splits NUS's glued keywords before parsing ("DANDmust",
  "Year 4AND") and never requires a word boundary before "must".
- `test/oracle/oracle.node.test.js` (through `scripts/ng-rule-names.mjs`) also asserts that
  every department and faculty a rule names exists in the production corpus. Rules and oracle
  both match on NUSMods' strings, so a rename would otherwise leave a closing rule matching
  nothing, the two agreeing, CI green and the courses shown open.
- `test/exchange.test.js` holds every `/search` path (D1 lexical, the bundle, the Vectorize
  standby, pins, mask routes, duplicate-group variants, a not-offered code's `related`) to exactly
  what the oracle calls open or noted, with D1's `ng_allow` deciding over the bundle's stored bit:
  a bundle that still says open while D1 says closed shows the course closed.
- `test/ui/detail-fields.mjs` is shared by `detail-fields.spec.js` (every fixture code) and
  `scripts/live-check.mjs` (drawn production codes). Its expected exchange status comes from the
  oracle, not the page's or Worker's code, so a field the page drops or fills from the wrong
  course fails instead of agreeing with itself.
- `STANDBY_RECALL_FLOOR` (0.85) in `test/full/oracle-pinned.test.js` sits below the worst mean
  recall@50 of a simulation over the 98 dev queries at depth 100 (0.998 for a level-cut bit, 0.892
  for a ug1-like bit, worst single query 0.04). It is a fact of the pinned corpus, so it lives in
  `test/full`, not in the production-corpus oracle tests.
