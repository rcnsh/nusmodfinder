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
