# Phase 4 plan: exchange mode that is correct (converged r3.1, 3 critic rounds)

Goal (exit): **SC1** is met and a persona red team finds no shown course an exchange student
can't take.
- SC1: exchange mode never shows a course the user can't take in the chosen semester at the
  chosen study level, verified by an automated test over the whole NG list.
- Findings in scope: P1 (exchange filter is a yearly boolean), P2 (graduate courses shown to
  undergraduates). P3 (no source links) is fixed here only for the exchange sources; the rest of
  P3 is Phase 5.
- Carried from Phase 3 (Jacob, 2026-11-10): SC4's level and parsed-intent items and findings S2,
  S3, S4 and S6. §6 says which of them this phase takes on.

Scope decision already made (Jacob, 2026-11-10): exchange mode applies **the NG list and the
course-restrictions PDF**. It hides what is closed to the student. Courses that need a home
major, a partner institution or case-by-case approval stay visible with a note. The rules are a
reviewed, versioned data file, tested over the whole NG list.

This plan changes no code. Every number marked *est.* is an estimate; every other number comes
from a script on the pinned corpus (critic scripts are re-run and committed at 4B).

r3.1 is the final draft. It applies every round-3 objection (§9); no critic pass follows it.
The changes from r3:
- `sem` is skipped under `ng=1` in all four filter sites, not only `parseFilters` (B3-1);
- the rules reach `eligibility()` as an argument, read with `readFileSync`; no JSON import from
  `scripts/` (B3-2);
- the identity gate fetches full depth, cuts at the pipeline's own depths, bypasses the cache,
  and its trace switch can't be live in production (A3-1 to A3-3);
- the ship order is written out, with the migration and its guards (B3-4);
- Q7 is framed as an amendment to Jacob's scope decision, Business joins the "closed under any
  answer" list, and every §8 question has a lead default (C3-1 to C3-3);
- the red team gets Jacob's answers and its calls are diffed against the oracle mechanically
  (C3-4).

r3 applied every round-2 objection. The main changes from r2:
- under `ng=1`, `sem` only selects the allow bit; no path also tests NUSMods semesters (B2-1);
- the standby reads 100 under `ng=1` and is held to no leaks plus a recall floor (B2-2);
- the dev gate compares against the shipped pipeline's own lists through a test-only switch,
  with pins, code lists, the mask route, 3F and 3G accounted for (A2-2);
- every eval query gets a `study`, including code and typo queries, by a hashed map (A2-1);
- `eligibility()` lives in `src/` so the eval and the Worker build use it (A2-4);
- SC1 gets its own CI job, and its listings are filters over every row (A2-5);
- rule E (case-by-case approval for courses not on the NG list) becomes Q7 (C2-1);
- dual-coded Architecture pairs, title checks, Q1 split into three, and a red team chosen by
  semester × level with pre-drawn code lookups (C2-2 to C2-5).

r2 applied every round-1 objection. The main changes from r1:
- the filter stores **allow** bits, so zero or a missing column means closed (A-3, B-3);
- Vectorize gets no new metadata; the standby relies on the D1 recheck (B-1, B-2);
- the mask uses the bundle's reserved bytes, keeping the 32-byte stride (B-4);
- rule D (no level 5000+) applies to graduates too, as a default that department rules
  override (C-1, C-3);
- blanket rules get an explicit scope, recorded in an interpretations register (C-4, C-5);
- `study` is required in exchange mode, with no default (C-6);
- the dev gate is per-retriever identity with exact equality, plus set-equality path tests and
  an unfiltered guard (A-1, A-2, A-4);
- a third source (the self-funded programmes list) and two linked pages are needed (C-2).

## 1. Facts gathered

**Sources** (downloaded by Jacob on 2026-11-10; nus.edu.sg blocks programmatic fetching). Copies
are kept outside the repo in `~/.config/vnm/sources/<date>/`; the repo records their hashes in
`docs/evidence/phase4/sources.md`, as for the NG list before.

| file | updated as at | sha256 | have it |
|---|---|---|---|
| `ng-courses.pdf` (courses offered to NG students, per semester; has Faculty and Department columns) | 01 Sep 2026 | `4e0281be…92e89a4` | yes |
| `non-graduating-course-restrictions.pdf` | 31 Aug 2026 | `362ba277…71c43b92` | yes |
| `self-funded-graduate-courses.pdf` (rule A: closed to everyone; linked from the restrictions PDF) | ? | — | **no** |
| YST Conservatory "Music electives for NG students" page (section 6) | ? | — | **no** |
| Law compulsory LLB course list (section 5, "See HERE") | ? | — | **no** |

- The NG list re-extracts byte-identical to the committed `data/ng-courses-2026-2027.json`
  (1,207 codes: 730 in Sem 1, 750 in Sem 2). 32 aren't offered in NUSMods this year.
- Neither PDF has a publication schedule. Both say they change without notice. The NG list is a
  day newer than the restrictions PDF.
- NUSMods has no NG, exchange or study-level field. Level is the code's first digit.

**What the code does today** (HEAD `e57da3c`). P1 is live on every path. `ng=1` is the yearly
boolean, and `sem` is checked against `semesters`, never `ng_semesters`:
- lexical `src/lexical.js:115-123`; the bundle mask `src/vector-bundle.js:290-307` (byte 3 holds
  the NG semesters, unused; bytes 6–7 are reserved); the Vectorize standby metadata
  `src/rowhash.js:59-71` (8 of the 10 metadata indexes used, README:101-103); the D1 recheck
  `localMatchesFilters`, `src/search.js:275-277`, used by dense candidates, pins, variants and
  `related` (the latter only when a 3H param is set, `src/search.js:755`);
- `parseFilters` accepts `sem` 1–4 (`src/search.js:128`);
- there is no study-level input. `level=` means one exact level.

**The data, joined on the pinned corpus** (recomputed independently by critics A and C):
- 934 of 1,207 NG codes are open in one semester only. 32 courses are offered in both semesters
  but NG-open in one (CS3244, CG3201): the P1 leak cases.
- 36 offered courses have NG semesters that aren't a subset of their NUSMods semesters. Five
  share no semester at all (NG vs NUSMods): PC3270 (1 vs 2), PC3294 (2 vs 1), LI5202 (1 vs 2),
  MUA4161 (1 vs 2), SN2278 (1 vs 2).
- 12 NG modules are also offered in special terms (sem 3 or 4). The NG list has no special-term
  data.
- 28 NG codes are level 5000+, none 6000+.

**What the restrictions PDF does to NG-list courses** (counts are NG-list courses touched now):

| rule (PDF section) | effect | NG-list courses |
|---|---|---|
| D: levels 5000–6000 closed to exchange students "unless specified in the list below" | closed for all, unless a department rule specifies | 28 |
| — of which specified: SE Asian "Level 5000 … only open to 4th year & postgraduate" (CAS5101: open to ug4 and grad); Malay graduate courses case-by-case (MS5101, MS5201: note for grad); PP for graduates from LKYSPP partners (11: note-partner for grad) | per department | 14 |
| — dual-coded with an Architecture-majors 4000 twin the restrictions PDF names (AR5221/AR4220, AR5321/AR4321, AR5601/AR4601, linked by preclusion; C2-2) | Q1c | 3 |
| — not specified anywhere: AR5801, AR5802, CM5223, CM5225, CM5244, CM5268, PC5202, PC5206, PC5211 | closed by D, yet on the NG list | 9 (Q1c) |
| — Logistics Institute (section 12, "All courses are not open"): LI5202, LI5204 | explicit closure | 2 (Q1a) |
| 1: dept closes level 4000 to NG undergraduates (Chinese Studies, ELTS, Geography, Political Science, Social Work, Sociology; CNM, Psychology and Economics close it to graduates too) | closed for ug1–ug4 | 7 |
| 1: level 4000 only for 3rd/4th-year undergraduates (Malay, South Asian, SE Asian) | closed for ug1–ug2 | 3 |
| 1: Economics 1000–3000 closed to NG graduates | closed for grad | 25 (incl. GEC, GESS, GEX hosted by Economics: scope in the register) |
| 1, 4: Geography and Built Environment 1000–4000 closed to NG graduates | closed for grad | 39 |
| 5: Law needs a Law major; LL4011V closed | note; closed | 91; 1 |
| 2: Business needs a business major | note | 41 |
| 6: non-partner students may read only the electives "listed HERE"; the rest is for YST partners | note-partner, pending the electives page | up to 16 MU-coded (C2-6) |
| 4: Architecture, Landscape, Industrial Design majors-only lists; design-year letter | note | ~20 *est.* |
| limited-quota lists (Geography, History, Built Environment) | note | ~30 *est.* |

**Blanket rules that conflict with the NG list.** Critic C (C-4) showed each sits under one
department's section, and the owning department's own section doesn't close these codes:
- "All CG coded courses are NOT open" (under the School of Computing Dean's Office): CG2023,
  CG2027, CG2028, CG3201, CG3207, CG4002 belong to the Multidisciplinary Programme, whose section
  closes only CG1111A, CG2111A, CG2271;
- "DSAXXXX" (under Mathematics): DSA4211, DSA4212 belong to Statistics & Data Science, whose 27
  listed closures don't include them;
- "GEHXXXX" (under Mathematics): GEH1018 is Physics, GEH1043 Medicine;
- rule A, Medicine except LSM: GEC1011, GEH1043, HSI2003; Logistics Institute "all courses":
  LI5202, LI5204.
Rules that touch no NG-list code this year (UROP, the X list, NM…Y, SPH graduate-only,
FMA120XH, the PL list, MA15XX, LSM33xx, SCALE, Dentistry, Nursing, ISS, RMI) are still
transcribed, so a refresh catches them.

**S/U for exchange students (C-12, carried from Phase 3).** Neither PDF says whether NG students
may S/U. Several departments require graded basis (language courses, LKYSPP, Built Environment,
Industrial Design). §8 Q3.

## 2. The eligibility model

One pure function, run at ingest, decides every case:

```
eligibility(module, { sem, study }) → { status: 'open' | 'note' | 'closed', reasons: [ruleId…] }
sem   ∈ { 1, 2, any }                 // `any` = NG-open in at least one of Sem 1 and 2
study ∈ { ug1, ug2, ug3, ug4, grad }  // ug4 = "4th year or later"
```

**Order of evaluation:**
1. **Semester.** A module not on the NG list for `sem` follows §8 Q7 (rule E: "Approval for
   any other courses not listed … will be granted on a case-by-case basis … may be available
   during Course registration"). Jacob's scope decision keeps case-by-case courses visible
   with a note, so `closed` here would amend it; Q7 asks him. Lead default: `closed`, pending
   his answer. If he answers `note`, those courses' bits come from NUSMods `semesters`, since
   they have no NG semester. Closed under any answer: Civil and Environmental Engineering and
   Industrial Systems Engineering levels 1000–4000 not on the NG list ("No appeal will be
   accepted"), and Business courses not on the NG list ("you will not be able to add the Course
   during the Submit Course Requests period", section 2). Where the NG list says
   open in N but NUSMods doesn't offer it in N, the outcome follows §8 Q5 (lead default: `note`,
   "the NG list says Sem N; the NUSMods timetable doesn't list it", because the NG list is the
   Registrar's availability statement and NUSMods' semesters are a scrape).
2. **Rule D as a default.** Level 5000+ is `closed` for every `study` unless a department rule
   specifies otherwise for that `study` (C-1, C-3). The dual-coded AR pairs and the 9
   unspecified codes follow Q1c.
3. **Department and code rules**, each with the scope the interpretations register gives it
   (§3, 4B). `closed` wins over `note`; notes accumulate.
4. Otherwise `open`.

**Exchange mode** (`ng=1`) hides `closed` and shows each `note` with its reason text.
- `study` is required with `ng=1`. Without it the API answers 400 `study-required` (C-6). The
  UI asks for study level before the first exchange search. The eval runner sets it per persona
  (§4).
- `ng=1` with `sem` 3 or 4 answers `count: 0` with `noMatch: { reason: "ng-special-term" }`: the
  NG list has no special-term data (B-7).

**Storage.** For 3 `sem` × 5 `study` values, ingest writes:
- `ng_allow` (INTEGER, 15 bits): bit set = shown in exchange mode (`open` or `note`). **Zero,
  NULL or a missing column means closed** (A-3, B-3). Non-NG modules get 0.
- `ng_rules` (JSON): per bit, the status and **rule ids only** (B2-6). Reason texts live in a
  bundled data module keyed by rule id, so a wording edit doesn't rewrite rows. `/search`
  returns only the requested bit's reasons; `/module/:code` returns all 15. The Worker runs no
  rule logic (B-9).
- `eligibility(module, ctx, rules)` lives in `src/eligibility.js` and takes the rules as an
  argument. `offeredModules` (`scripts/lib.mjs`) reads `data/ng-restrictions-<year>.json` with
  `readFileSync`, as `loadNgCourses` does, and calls it. So the eval workspace, the baseline
  tree hash and the fixture corpus carry it, and nothing imports JSON from `scripts/` (a bare
  JSON import throws in Node; `with { type: 'json' }` fails `tsc` here, B3-2). Nothing
  `src/index.js` imports reaches `eligibility.js`.
- The reason-text module is Worker-only, like `group-data.js`. An id it doesn't know renders a
  generic "restricted; see the source document" text, with a test, and `verify --pre-deploy`
  checks every stored id is in the module (B3-5).
- Both fields join `ROW_COLUMNS`/`boundTuple` (`src/rowhash.js:37-53`), so a rules-only change
  re-hashes every affected row and reaches D1, the data version and the deploy guard (B-6).

**Paths** (each filters on the one bit for (sem, study)):
- **`sem` under `ng=1` only selects the bit** (B2-1, B3-1). `echo.sem` stays (the bit choice,
  `exam=0`, the cache key and the echo read it), and the NUSMods semester test is skipped when
  `echo.ng` in all four sites: `parseFilters` (`src/search.js:116`), `filterSql`
  (`src/lexical.js:115-118`, also used by `rangeMembers`), `compileMask`
  (`src/vector-bundle.js:294-297`) and `localMatchesFilters` (`src/search.js:277`).
  - `exam=0&sem=N` under `ng=1`, for a module NUSMods doesn't offer in N (the Q5 notes): there is
    no exam data for N, so `exam=0` excludes it, as for any unknown.
  - Tests: a cache-key test that `ng=1&sem=1` and `ng=1&sem=2` differ; path tests over the 36
    mismatch modules.
- D1 lexical: `+m.ng_allow & <bit> != 0`, the bit interpolated as a validated integer literal
  (`?1` is the MATCH text, B2-7), a non-driver predicate beside `m.ng = 1`. No new index: SQLite
  can't use one for a bitmask, and `idx_ng` already drives the query (B-5).
- Bundle: `ng_allow` in reserved bytes 6–7, stride stays 32 bytes (B-4). `BUNDLE_SCHEMA` bumps,
  `decodeFilterRow` reads it, and verify's field compare includes it.
- Vectorize standby: no new metadata (B-1). It keeps the yearly `ng` filter, queries topK 100
  (the limit without values or metadata) under `ng=1`, and every dense candidate passes the D1
  recheck. A local simulation over the 98 dev queries gave recall@50 0.998 for a level-cut bit
  and 0.892 (worst query 0.04) for a ug1-like bit at depth 100 (B2-2). The standby is a
  fallback; §5 records the loss.
- D1 recheck `localMatchesFilters`: tests `(row.ng_allow ?? 0) & bit`. `ng_allow` and `ng_rules`
  are added to `RESULT_COLUMNS` and `VARIANT_COLUMNS`, so result cards carry the bit's note ids
  (B3-3). `related` is rechecked whenever `ng=1` (B-2).
- The cache key carries `study` only when `ng=1`, with a key test (B2-3); `study` is echoed in
  `filters` only when `ng=1` too, so the key and the body agree (B3-6).

`sem=N` without `ng=1` keeps its meaning (NUSMods semesters).

## 3. Workstreams

### 4A Per-semester NG and the allow mask on every path (P1, P2)
- **First, its own commit:** extend the fixture with the remaining 25 level-5000 NG modules and
  the 9 special-term NG modules it lacks, and re-store the fixture baseline there, so the guard
  compares against it (B2-5, B3-7).
- Implements §2's storage and paths. Migration adds `ng_allow` and `ng_rules`.
- 4A–4D ship together: the 400 `study-required` would break the current page, shared links and
  the eval otherwise. The SC7 query file's 10 `ng=1` rows gain a `study` (B2-3).
- Unit tests: a row without `ng_allow` is never shown (each path); the three `[P1 known-bug]`
  tests flip to `[P1 fixed]`; `[P2 known-bug]` flips to `[P2 fixed]`.
- Fixture: the 36 mismatch modules, the 12 special-term modules and the 28 level-5000 modules,
  each with its expected status for all 15 combinations, listed in the test file (A-5).

### 4B Restrictions as data
- `data/ng-restrictions-2026-2027.json`: every rule from the restrictions PDF and the other
  sources, each with its kind (`closed-code`, `closed-prefix`, `closed-school`, `level-for-study`,
  `note-major`, `note-partner`, `note-approval`, `note-quota`, `note-graded`, `note-audition`),
  its scope (codes, prefixes with level ranges, departments), its citation (section, page), and
  for every code-level rule the **title as the PDF gives it**. The check script compares it with
  the NG list and NUSMods titles; each mismatch is a register row (C2-3: ID2114 is "Form,
  Materials & Making" in the restrictions PDF and "The Appreciation of Wood Craft" elsewhere).
- **Interpretations register** (`docs/evidence/phase4/interpretations.md`): one row per ambiguous
  rule with the decision and reason, and a fixture case for each. It starts with:
  - blanket rules' scope (CG, DSA, GEH under one department's section): global or section-only;
  - rule B: the 7 listed codes only, not every `…X` code (else 8 Business courses close, C-5);
  - dual-coded pairs linked by preclusion (AR4220/AR5221, AR4321/AR5321, AR4601/AR5601): a rule
    on one code applies to its twin (C2-2);
  - "closes 5000/6000 to undergraduate students" in five departments: whether it opens them to
    graduates (C2-7);
  - Built Environment's quota lists name semesters that conflict with the NG list (PF3504 under
    "Semester 1" but NG Sem 2 only; PF2505 under "Semester 2" but NG Sem 1 only) (C3-5);
  - course tables without a "NOT available" heading (Language Studies, CNM, ELTS, Japanese
    Studies, Chemistry, Science Dean's Office): what they mean (C2-7);
  - Economics' rules over GE courses it hosts (GEC, GESS, GEX);
  - Psychology's self-contradiction (level 4000 by appeal vs all 4000 closed);
  - Industrial Design's notes scoped by the `ID` prefix, not the "Design" department (C-10);
  - USP's partner rule and NUS College's 63 NG-listed codes (§8 Q6).
- **Department map:** PDF department names to NUSMods `department` strings, explicit; unmapped
  names fail the build. The NG PDF's own Faculty and Department columns are a second check: for
  all 1,207 codes they must match the map apart from spelling. A code may carry a set of NG
  department names (18 codes are listed under two names in different semesters, C2-7).
- **Transcription check:** two independent transcriptions by fresh subagents that read only the
  sources, diffed by script. The lead resolves each disagreement against the PDF and logs it.
  A third subagent audits a random 20% of rules.
- `scripts/check-ng-restrictions.mjs` records the source hashes and fails if the data file's
  `sourceSha256` values don't match `docs/evidence/phase4/sources.md`.

### 4C Study-level input
- API: `study=ug1|ug2|ug3|ug4|grad`, required with `ng=1`, echoed in `filters`, ignored without
  `ng=1`. `level=` keeps its meaning (one exact level) and composes with `study`.
- `/module/:code` returns `ng_rules`, so a card can say why a course is closed or noted for each
  semester and level.

### 4D Exchange-mode UI and sources (P3, exchange part)
- `src/page.html`: study level asked before the first exchange search; semester select; note
  badges with reason text; links to the source documents with their "updated as at" dates (from
  `/facets`).
- The NG badge shows the NG semesters, never `semesters`.
- Phase 5 redesigns the page; this is the minimum that makes exchange mode usable and honest.

### 4E SC1 verification
- **Oracle** (`test/full/sc1.test.js`): an independent `oracle(module, sem, study)` written by a
  subagent that sees the sources and the interpretations register, never §2, 4B's data file or
  its department map. It builds its own scope mapping; the two maps are diffed and every
  disagreement logged (A-6, C-5).
  - Run over **every pinned-corpus module** (6,771) and all 1,207 NG codes × 3 `sem` × 5
    `study` (~120k pure calls): `eligibility()` must agree with the oracle on status (A-3, C-7).
  - **At the ship**, the oracle also runs over the production-normalised modules (the
    2026-11-04 catalogue, 6,778) against the `ng_allow` ingest computed, locally before any D1
    write (A2-6).
- **Path test** (`test/sc1/`, its own CI job with its own timeout, A2-5), for each of the 15
  combinations:
  - **set equality** for each path's filter applied to every row (A-4, A2-5): the lexical filter
    SQL without a search term over the seeded corpus; `decodeFilterRow` + `compileMask` over
    every bundle row; and `localMatchesFilters` over every row. Each must equal the oracle's
    `open ∪ note` set;
  - the standby (fake Vectorize at full depth, then the recheck): no leaks, and recall@50 above a
    floor set from the simulation in §2 (B2-2);
  - pins, variants and `related`: a code search for every NG code returns it exactly when the
    oracle shows it; every group with a closed member shows no closed variant; `related` shows
    no closed module. Measured cost: ~3.3 ms per search locally, ~18k searches *est.* 3 min
    per backend on CI.
- **Unit:** a missing or zero `ng_allow` is closed on every path.
- **Live check** at the ship: 30 calls with fresh texts across the 15 combinations, every result
  checked against the oracle (`docs/evidence/phase4/sc1-live.mjs`).

### 4F Data refresh
- O4 (no scheduled refresh) stays Phase 7. Here, `/facets` shows each source's date, and the
  README runbook gets a "new source" procedure that repeats the whole gate (A-9): download,
  record hashes, re-extract, two fresh transcriptions of changed sections and a diff, a fresh
  oracle author for the changed sections, the full SC1 test, then a ship.

## 4. Eval and gates
- The dev and holdout queries come from undergraduate exchange personas, and all 98 dev queries
  set `ng` (35 with Sem 1, 32 with Sem 2, 31 with no semester). 4A–4B change most of their
  result lists by design. The judges never saw NG semesters or restrictions, so a relevance-only
  look would score correct removals as loss, the lesson from 3H.
- **No holdout look gates Phase 4's correctness changes.** They are gated by:
  1. **SC1's oracle and path tests** (4E).
  2. **Per-list identity on dev** (A-2, A2-2, A3-1 to A3-4). A test-only switch
     (`env.SC1_TRACE`) makes `/search` return its internal lists: pins, the lexical, dense and
     code lists, the mask-route list, and `topCosine`.
     - **Depth:** with the switch also set to ignore `ng_allow` (yearly `ng`, no `sem`
       predicate), each list is fetched at full depth (the bundle and lexical paths take any
       depth with a total order). Projected by the oracle's bit for the query's (sem, study), it
       is cut at the depth the pipeline used: 50 for the fused and code lists
       (`src/search.js:674`), `maskDepth` for the mask route (`:783`). It must equal the filtered
       list exactly; a projection shorter than its filtered list fails.
     - **Page:** the page must equal the first `topK` of `collapse(pins ++ fuse(filtered lists)
       − pins)`, recomputed offline with the exported `fuse` and collapse step (Phase 4 doesn't
       change them; gate 3 covers them).
     - **Cache:** trace requests skip `cache.match` and `cache.put` and are sent `no-store`. The
       runner makes the page call, the trace call and the ignore-mode call separately, and a
       runner test checks the ignore-mode body differs from the filtered one on a query whose
       unfiltered top 50 holds a closed module.
     - **Never live:** the switch is honoured only when `TEST_MIGRATIONS` is also bound, which
       only the vitest configs bind. A unit test asserts `wrangler.jsonc` `vars` holds only
       `DENSE_BACKEND`, and `npm run deploy` refuses otherwise.
     - **3G:** queries whose filtered `topCosine` crosses τ into `no-signal` are listed with
       their `topCosine`. Each needs Jacob's ruling; an unruled one fails the gate. 3G's rule (no
       dev query outside the no-answer tags returns `no-signal`) is re-run.
  3. **Unfiltered guard** (A-1, A2-3): dev with `ng` stripped and `sem` kept (a new runner
     option, `--strip ng`), dev with `--unfiltered`, and the fixture queries with `ng` stripped
     all return byte-identical results to the baseline. The SC4 suite must stay green (it sets
     no `ng`).
  4. `eval:report` on dev, reported and not a gate.
- **Eval bookkeeping** (A-7):
  - the runner adds `study` per query from a committed map, so the locked query files don't
    change (A2-1): P1, P2, P5 are 3rd-years (`ug3`); P3, P4, P6 2nd-years (`ug2`); code queries
    (`persona: mech`, dev d-082–d-092 and the holdout's 7) take `ug2`; persona-less typo
    diagnostics take `ug2`; fixture personas get explicit entries. The runner throws on any `ng`
    query whose persona isn't mapped. The map's hash goes in the run `config`, and
    `assertBaselineAt` checks it;
  - the ship PR moves `SHIPPED_BASELINE` with a pin line ("no look: SC1, per-retriever identity,
    unfiltered guard"), and the custodian stores the new holdout baseline with `--store-only`.
- Holdout looks stay at 7 of 12 used. Any search-quality change from §6 that wants a look needs a
  compliance-aware rule written before the look.
- **ADR 0003 amendment, "Phase 4 is gated without a look"** (A2-7), before 4A ships: the three
  gates above, the `study` map and its hash check, and the look budget from Phase 4 on (the 5
  remaining looks need a pre-registered rule each; ADR 0003 line 98 covers Phase 3 only).

## 5. Cost, ops and risks
- **Migrations:** `ng_allow` and `ng_rules`; no index.
- **Ingest:** every row's hash changes, NG or not, because the tuple gains two columns (B2-4).
  That is a full rewrite: 34,383 rows written when last measured (README:392). The run passes
  `--write-budget` of that × 1.5, after a small local batch confirms the per-row cost (ADR
  0004). Workers Paid has no daily write cap, only the monthly allowance.
- **Ship:** a full runbook ship. The bundle keeps its size (reserved bytes), but the
  `BUNDLE_SCHEMA` bump means three bundles are rebuilt: the fixture (`test/fixtures/vectors.bin`),
  the pinned release asset with `data/vectors.json` (a new pinned release, which full-corpus CI
  reads), and production. The vector text is unchanged, so there's no corpus embedding pass.
  Vectorize needs no recreation.
- **Ship order** (B3-4): (1) build the bundles and create both releases (pinned and production);
  (2) merge; (3) record the D1 Time Travel bookmark; (4) `remote-migration.mjs` for the new
  migration, after the bookmark so restoring it undoes the migration; (5) the ship-time oracle
  over the production-normalised modules (4E), locally; (6) ingest `--d1-only`; (7) `verify
  --pre-deploy`; (8) `npm run deploy`; (9) smoke and the SC1 live check; (10) refresh the
  standby. Before the ship: the upsert's `ON CONFLICT … SET` list is built from `ROW_COLUMNS`
  (it is hand-written today, `src/ingest.js:283-291`, so a missed column would keep old values
  under a new hash); the ingest schema guard (`scripts/ingest-core.mjs:631-636`) checks the new
  columns; and verify's `fieldsFromRow` includes them.
- **Standby recall** under `ng=1` is lower than the bundle's (§2, simulation): accepted, because
  the standby serves only when the bundle path fails.
- **Remote ops** are logged in `requests.tsv` and `remote-ops.md` as before.
- **Risks:**
  - mis-transcribed rules: two transcriptions, a diff and an audit (4B), plus the independent
    oracle and its own scope map (4E);
  - a shared misreading: the register makes every ambiguous call explicit, and Jacob sees the
    contested ones (Q1, Q5, Q6);
  - department-name mismatches: the map fails closed, and the NG PDF's own columns cross-check it;
  - the sources change without notice: dates shown to users; the refresh repeats the gate;
  - over-hiding: as bad for a student as a leak. Set-equality path tests and the red team check
    both directions.

## 6. Carried items: what Phase 4 takes on
- **S6 (graduate flood) and SC4's level items:** in exchange mode, `study` closes 5000+ for
  undergraduates, which removes the flood where it matters. The general (non-exchange) search
  keeps 3D dropped. SC4's level items stay unmet unless Jacob reopens 3D (Q4).
- **SC4's parsed-intent items (3H phrases):** need a compliance-aware rule first. Proposed:
  pre-register in this phase, ship in Phase 5 with the frontend that shows parsed filters. Q4.
- **S2, S3, S4:** search-quality changes unrelated to exchange correctness. Proposed: left open
  for a later phase, not attempted here. Q4.

## 7. Exit criteria
- SC1's oracle and path tests are green in CI on the shipped commit. The live check agrees.
- **Persona red team** (A-8, C2-5): personas chosen by the inputs the system takes, semester ×
  study level (ug2, ug3, ug4 and grad, each in both semesters: 8 runs), with home faculties where
  the rules are densest (Architecture, Business, FASS level 4000, Music).
  - Each persona runs 10 fresh queries and looks up by code a sample drawn in advance: every Q1
    and Q5 code, the AR pairs, 20 random NG codes, and for Q7 20 random non-NG courses plus 5
    Business and 5 CE/ISE ones, so hidden courses are checked too.
  - The red team reads the sources and Jacob's answers verbatim, never the register or this
    plan. For every course it sees or looks up, it records its own `open`/`note`/`closed` call.
  - Its calls are diffed against the oracle mechanically. A disagreement is a finding unless a
    Jacob answer covers it; a disagreement on a register call Jacob never ruled on stays a
    finding until he rules.
  - Exit needs zero findings, or each finding fixed and re-checked.
- P1 and P2 are `fixed`. FINDINGS gains rows for anything the red team finds.
- README, `/facets` and the vault describe exchange mode as it is.

## 8. Gate questions for Jacob (asked after the critic rounds)
**Answered (Jacob, 2026-11-10): every lead default accepted.**
- Q1a hide; Q1b section's department only (open, with a note quoting the blanket rule); Q1c AR
  pairs note-major, PC5202/5206/5211 open for grad only, CM four and AR5801/AR5802 closed.
- Q2 study level required. Q3 `su=1` kept, with graded-only and general S/U notes. Q4 §6 as
  written. Q5 note. Q6 NUS College open.
- Q7: the scope decision is amended. Courses not on the NG list are hidden in exchange mode,
  and the page explains rule E.
- Still needed before 4B: the self-funded programmes PDF, the YST electives page and the Law
  compulsory-course list.

The questions as they were asked:

- **Before 4B starts:** Jacob downloads the self-funded programmes PDF, the YST electives page
  and the Law compulsory-course list (C-2).
- **Q1. NG-listed courses a restrictions rule closes** (C2-4). The NG list's cover says "Take
  note of the various course restrictions here", deferring to the restrictions PDF.
  - **Q1a, explicit closures:** LL4011V (in Law's own closed list; the only explicit code
    closure on the NG list), Medicine non-LSM GEC1011, GEH1043, HSI2003 (rule A), LI5202 and
    LI5204 (section 12, "All courses are not open"). Lead default: **hide**, since the NG list
    defers to the restrictions.
  - **Q1b, scope:** "All CG coded courses" (under Computing's Dean's Office; the owning
    Multidisciplinary Programme closes only CG1111A, CG2111A, CG2271), "DSAXXXX" and "GEHXXXX"
    (under Mathematics; DSA4211/4212 belong to Statistics & Data Science, which doesn't list
    them; GEH1018 is Physics, GEH1043 Medicine). Global, or only the section's department? Lead
    default: **section's department only**, since each owning department's own section is
    silent on these codes; they stay open, with a note quoting the blanket rule.
  - **Q1c, level 5000 the departments don't specify:** the three AR pairs (4000 twin open to
    Architecture majors), PC5202, PC5206, PC5211 (Physics lists 25 PC5 codes as closed, 22 of
    them offered this year, and not these three), CM5223, CM5225, CM5244, CM5268 (Chemistry is
    silent on level 5000), AR5801, AR5802. Per subgroup: closed by rule D, or open (or noted)
    because the NG list offers them? Lead default: AR pairs **note-major** (Architecture
    majors, from the twin); PC three **open for grad, closed for undergraduates** (Physics
    left them off a deliberate closed list, but rule D still bars undergraduates); CM four and
    AR5801/AR5802 **closed** by rule D.
- **Q2. Study level required** in exchange mode, or a default level? Lead default: **required**
  (ug2 and grad differ on 64 NG codes, so no default is fail-safe).
- **Q3. S/U in exchange mode:** keep `su=1` working with a graded-only note where a department
  requires it, or hide `su=1` in exchange mode until NUS says NG students may S/U? Lead default:
  **keep it, with a "graded basis only" note** where a department requires grading and a general
  note that S/U eligibility for exchange students is set by NUS and the home university.
- **Q4. Carried items:** confirm §6 (S6 via study level; 3D stays dropped; phrase parsing
  pre-registered here and shipped in Phase 5; S2–S4 left open).
- **Q5. NG list vs NUSMods semesters** (36 modules; the full list is committed at 4B as
  `docs/evidence/phase4/semester-mismatch.md`). Five share no semester: PC3270, PC3294, LI5202,
  MUA4161, SN2278; the other 31 are NG [1, 2] but offered in one. Note or hide when NUSMods
  doesn't offer the course in the NG-listed semester? Lead default: **note**.
- **Q7. Amend the scope decision for courses not on the NG list?** (C2-1, C3-1) Your decision:
  "courses that need … case-by-case approval stay visible with a note". Rule E: "Approval for
  any other courses not listed in this document will be granted on a case-by-case basis … may be
  available during Course registration." Taken literally, your decision shows them. That is
  5,476 Sem 1/2 courses (2,442 at levels 1000–4000) beside 1,207 NG codes. Showing them with a
  note uses NUSMods semesters. Civil Engineering, Industrial Systems Engineering (levels
  1000–4000) and Business stay hidden either way. Lead default: **amend; hide them**, so exchange
  mode lists what can be requested at application, with rule E explained on the page.
- **Q6. NUS College and USP:** the restrictions PDF limits USP to partner universities; USP is now
  part of NUS College, which has 63 NG-listed codes. The NG PDF lists all 63 under "NUS College",
  never "University Scholars Programme". Treat them as open, or `note-partner`? Lead default:
  **open**.

## 9. Objection log

### Round 1 (r1, PR #64 head `0ec5b22`)
Three critics: A on eval and gates, B on data, ingest, paths and cost, C on the rules against the
sources. All objections were accepted and applied in r2.

| id | objection | disposition |
|---|---|---|
| A-1 | No dev query lacks `ng`, so the unfiltered guard tested nothing | applied: guard runs dev with `ng` stripped, `--unfiltered`, SC4 suite and fixture (§4) |
| A-2 | Projection identity can't hold after RRF; no fail condition; runs keep only 20 | applied: per-retriever identity at depth 50, exact (§4) |
| A-3 | Oracle covered NG codes only; closed bits fail open | applied: oracle over every module; allow bits, zero = closed (§2, 4E) |
| A-4 | Path test catches leaks only | applied: set equality per path and combination (4E) |
| A-5 | The 36 mismatch modules had no expected result | applied: semester rule in §2 step 1 (Q5); fixture lists expected statuses (4A) |
| A-6 | Oracle could share 4B's scope map | applied: oracle builds its own map; maps diffed (4E) |
| A-7 | No pin move; `study` placement breaks locks; personas are partly 3rd-years | applied: runner adds `study` per persona; pin line and `--store-only` (§4) |
| A-8 | Exit criterion fails by definition on notes; red team unsized | applied: findings defined; 5 personas × 10 queries (§7) |
| A-9 | Refresh had no gate | applied: refresh repeats the whole gate (4F) |
| B-1 | Vectorize allows 10 metadata indexes and 8 are used | applied: no new metadata; D1 recheck (§2) |
| B-2 | Standby `related` rechecks only for 3H params | applied: recheck whenever `ng=1` (§2) |
| B-3 | A column missing from the SELECT passes everything | applied: allow bits, `?? 0`, both column lists, unit test (§2, 4E) |
| B-4 | A 34-byte stride breaks Float32Array alignment | applied: reserved bytes 6–7, schema bump, verify compare (§2) |
| B-5 | No index can serve a bitmask predicate | applied: non-driver predicate, no index (§2) |
| B-6 | Write estimate 5× low; no daily cap on Paid; rules must enter the row hash | applied (§2, §5) |
| B-7 | `sem` 3/4 had no mask entry | applied: `ng-special-term` no-match (§2) |
| B-8 | Whether `semesters` still applies under `ng=1` was undefined | applied: §2 step 1 and Q5 |
| B-9 | `/module` had no stored reasons | applied: `ng_rules` JSON (§2) |
| C-1 | Rule D applies to graduates too | applied: D as a default for all; 12 unspecified codes in Q1 (§1, §2) |
| C-2 | Self-funded list and two linked pages missing | applied: source table; Jacob downloads them before 4B (§1, §8) |
| C-3 | CAS5101 is open to 4th-years | applied: D overridden by department rules; fixture case (§2) |
| C-4 | Blanket rules belong to one department's section | applied: scope per rule in the register; Q1 shows the evidence (§1, 4B) |
| C-5 | Ambiguous readings would be shared by oracle and code | applied: interpretations register; oracle sees it, never §2 (4B, 4E) |
| C-6 | `ug2` default isn't fail-safe; ug1 = ug2 today | applied: `study` required; `ug4` = 4th year or later (§2) |
| C-7 | No rule for NG vs NUSMods semester disagreement; oracle dropped 32 | applied: §2 step 1, Q5; oracle over all 1,207 (4E) |
| C-8 | CNM, Psychology, Economics close 4000 to graduates too | applied: scopes corrected (§1 table, 4B) |
| C-9 | No kind for partner-institution rules; USP/NUS College undecided | applied: `note-partner`; Q6 |
| C-10 | Industrial Design scoped by department would tag two Design courses | applied: `ID` prefix scope; NG PDF columns cross-check the map (4B) |

### Round 2 (r2, PR #64 head `bc792c9`)
Three fresh critics with the same lenses. Critic A and C's first runs were cancelled by a T3
server restart and re-run on the same head; critic B's round-2 findings were given to them so
they didn't repeat. All objections were accepted and applied in r3.

| id | objection | disposition |
|---|---|---|
| B2-1 | Under `ng=1`, every path still tests NUSMods semesters, hiding Q5's notes | applied: `sem` only selects the bit under `ng=1` (§2) |
| B2-2 | Standby "deeper" is 50, as before; set equality impossible at topK ≤ 100 | applied: topK 100; no leaks + recall floor; loss recorded (§2, 4E, §5) |
| B2-3 | 400 `study-required` breaks the page, eval whitelist, SC7 queries | applied: 4A–4D ship together; SC7 file updated; key carries `study` only under `ng=1` (§2, 4A) |
| B2-4 | Every row re-hashes; three bundles rebuild | applied (§5) |
| B2-5 | Extending the fixture breaks the byte-identical guard | applied: fixture extended and re-baselined in its own commit first (4A) |
| B2-6 | `ng_rules` text bloats every hydrate and rewrites rows on wording edits | applied: ids only; texts in a bundled module (§2) |
| B2-7 | `?1` is the MATCH text | applied: validated integer literal (§2) |
| A2-1 | Code and typo queries have no persona, so no `study` | applied: full map, throw on unmapped, hash in config (§4) |
| A2-2 | Identity gate fails correct changes; page isn't fuse of two halves | applied: test-only trace switch; per-list projection at depth 100; offline page recompute; 3G re-run (§4) |
| A2-3 | Fixture can't be byte-identical; no strip option; SC4 has no baseline | applied: `--strip ng`; fixture without `ng`; SC4 green (§4) |
| A2-4 | The eval workspace may never see `eligibility()` | applied: lives in `src/`, called from `offeredModules` (§2) |
| A2-5 | Path tests via `/search` can't list 730 codes and overrun CI | applied: per-path filters over every row; own CI job (4E) |
| A2-6 | CI corpus isn't production's | applied: ship-time oracle over production-normalised modules (4E) |
| A2-7 | No ADR 0003 amendment; no look budget after Phase 3 | applied (§4) |
| C2-1 | Rule E allows non-NG courses case by case | applied: Q7; CE/ISE exception (§2, §8) |
| C2-2 | AR pairs are dual-coded; 5000 breakdown summed to 26 | applied: register entry; 3 + 9 + 2 + 14 = 28 (§1, 4B) |
| C2-3 | Code-only rules can land on a renamed course (ID2114) | applied: titles transcribed and checked (4B) |
| C2-4 | Q1 mixed three kinds of conflict without evidence | applied: Q1a/b/c with quotes (§8) |
| C2-5 | Red team varied inputs the system ignores; couldn't find over-hiding | applied: semester × level personas; pre-drawn code lookups; sources only (§7) |
| C2-6 | Music non-partner rule is a whitelist | applied: up to 16, pending the electives page (§1) |
| C2-7 | Map must accept name sets; two register entries missing | applied (4B) |

### Round 3 (r3, PR #64 head `62bf601`), the final round
Three fresh critics with the same lenses. Critic A's first run failed on an API connection error
and was re-run on the same head, with B's and C's findings listed so it didn't repeat them. All
objections were accepted and applied in r3.1. No objection was declined, so no dissent is
recorded.

| id | objection | disposition |
|---|---|---|
| A3-1 | Depth 100 cut to 50 fails correct changes on most ug2 queries | applied: full depth, cut at the pipeline's depths, shorter projection fails (§4) |
| A3-2 | The cache makes the gate vacuous or failing | applied: trace bypasses the cache, `no-store`; separate calls; runner test (§4) |
| A3-3 | "Never bound in production" isn't enforced | applied: honoured only with `TEST_MIGRATIONS`; vars test; deploy refuses (§4) |
| A3-4 | 3G re-run has no fail condition; `fuse`'s tiebreak is private | applied: Jacob rules each flip; `fuse` and collapse exported (§4) |
| B3-1 | `sem` skip only in `parseFilters`; `exam=0` vacuous for Q5 notes | applied: four sites; `exam=0` excludes unknown; cache-key test (§2) |
| B3-2 | JSON import from `scripts/` breaks Node or `tsc` | applied: rules passed as an argument, read with `readFileSync` (§2) |
| B3-3 | Result cards can't carry note reasons | applied: `ng_rules` in both column lists (§2) |
| B3-4 | No migration step; hand-written upsert SET list | applied: ship order written out; SET from `ROW_COLUMNS`; guards (§5) |
| B3-5 | Rule-id drift between D1 and the Worker's text module | applied: generic fallback text; pre-deploy id check (§2) |
| B3-6 | `study` echo vs cache key | applied: echoed only under `ng=1` (§2) |
| B3-7 | Special-term modules missing from the fixture | applied: added in the same first commit (4A) |
| C3-1 | Q7's default contradicts the scope decision; no counts or semester source | applied: Q7 framed as an amendment with counts and semester source (§2, §8) |
| C3-2 | Business shuts rule E's registration route | applied: closed under any answer (§2, §8) |
| C3-3 | Five questions lacked defaults; Q5 and Q6 lacked evidence | applied (§8) |
| C3-4 | Red-team verdicts ill-defined; Q7 sample unnamed | applied: Jacob's answers given; mechanical diff; sample defined (§7) |
| C3-5 | Physics count wording; Built Environment semester conflicts | applied (§8, 4B) |
