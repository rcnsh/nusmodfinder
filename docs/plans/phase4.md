# Phase 4 plan: exchange mode that is correct (draft r1, for critics)

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
major or case-by-case approval stay visible with a note. The rules are a reviewed, versioned
data file, tested over the whole NG list.

This plan changes no code. Every number marked *est.* is an estimate; every other number comes
from the scripts named beside it on the pinned corpus.

## 1. Facts gathered

**Sources** (downloaded by Jacob on 2026-11-10; nus.edu.sg blocks programmatic fetching). Copies
are kept outside the repo in `~/.config/vnm/sources/2026-11-10/`; the repo records only their
hashes, as for the NG list before.

| file | updated as at | sha256 |
|---|---|---|
| `ng-courses.pdf` (courses offered to NG students, per semester) | 01 Sep 2026 | `4e0281be…92e89a4` |
| `non-graduating-course-restrictions.pdf` | 31 Aug 2026 | `362ba277…71c43b92` |

- The NG list re-extracts byte-identical to the committed `data/ng-courses-2026-2027.json`
  (1,207 codes: 730 in Sem 1, 750 in Sem 2). 32 aren't offered in NUSMods this year.
- Neither PDF has a publication schedule. Both say they change without notice.
- NUSMods has no NG, exchange or study-level field. Level is the code's first digit.

**What the code does today** (HEAD `e57da3c`). P1 is live on every path. `ng=1` is the
yearly boolean, and `sem` is checked against `semesters`, never `ng_semesters`:
- lexical `src/lexical.js:115-123`; the bundle mask `src/vector-bundle.js:290-307` (byte 3 already
  holds the NG semesters, unused); the Vectorize standby metadata `src/rowhash.js:59-71` (no
  per-semester NG field); the D1 recheck `localMatchesFilters`, `src/search.js:275-277`, used by
  dense candidates, pins, variants and `related`;
- D1 has generated `ng_sem1`/`ng_sem2` columns (`migrations/0006`), unindexed, read only by
  `/facets`;
- there is no study-level input. `level=` means one exact level. The frontend has an
  "exchange students only" checkbox and no study level.

**The data, joined on the pinned corpus:**
- 934 of 1,207 NG codes are open in one semester only. 32 courses are offered in both semesters
  but NG-open in one (CS3244, CG3201): the P1 leak cases.
- 36 courses have NG semesters that aren't a subset of their NUSMods semesters. Five share no
  semester at all (PC3270, PC3294, LI5202, MUA4161, SN2278).
- 28 NG codes are level 5000+ and none is 6000+.

**What the restrictions PDF adds**, as counts of NG-list courses each rule touches:

| rule (PDF section) | applies to | NG-list courses |
|---|---|---|
| D: levels 5000–6000 closed to exchange students "unless specified" | undergraduates | 28 |
| 7: PP prefix closed to undergraduates | undergraduates | 11 (all inside the 28) |
| 1: department closes level 4000 to NG undergraduates (Chinese Studies, CNM, Economics, ELTS, Geography, Political Science, Psychology, Social Work, Sociology) | undergraduates | 7 |
| 1: level 4000 only for 3rd and 4th-year undergraduates (Malay, South Asian, Southeast Asian Studies) | years 1–2 | 3 |
| 1: Economics levels 1000–3000 closed to NG graduate students | graduates | 25 |
| 1, 4: Geography and Built Environment levels 1000–4000 closed to NG graduate students | graduates | 39 |
| 5: Law needs a Law major | everyone | 91 (note, not hidden) |
| 2: Business needs a business major | everyone | 41 *est.* by faculty (note, not hidden) |
| 4: Architecture, Landscape and Industrial Design majors-only lists; design-year letter | everyone | ~20 (note, not hidden) |
| limited-quota lists (Geography, History, Built Environment) | everyone | ~30 (note, not hidden) |

**Conflicts between the two PDFs.** These NG-list courses are closed by a restrictions rule:
- CG2023, CG2027, CG2028, CG3201, CG3207, CG4002 ("All CG coded courses are NOT open");
- DSA4211, DSA4212 ("Course codes DSAXXXX are NOT open"); GEH1018, GEH1043 ("GEHXXXX");
- LL4011V (listed closed);
- LI5202, LI5204 (Logistics Institute, "All courses are not open");
- Medicine's non-LSM codes on the NG list (GEC1011, GEH1043, HSI2003 and others; count in 4B).

The persona red team would read either PDF, so the plan needs a policy for these (§8, Q1).

**S/U for exchange students (C-12, carried from Phase 3).** Neither PDF says whether NG students
may S/U. Several departments require graded basis (language courses, LKYSPP, Built Environment,
Industrial Design). `su=1` in exchange mode shows those with a note, and the S/U question stays
open (§8, Q3).

## 2. The eligibility model

One pure function decides every case, and every search path uses its output:

```
eligibility(module, { sem, study }) → { status: 'open' | 'note' | 'closed', reasons: [ruleId…] }
study ∈ { ug1, ug2, ug3, ug4, grad }      // undergraduate year 1–4, or graduate
```

- **closed** when: the module isn't on the NG list for `sem` (or for any semester when `sem` is
  unset); a level rule or department rule closes it for `study`; a code, prefix or school rule
  closes it; or a §1 conflict resolves to closed under Q1.
- **note** when a rule needs something the planner can't check: a home major (Law, Business,
  Architecture, Landscape, Industrial Design), case-by-case approval, an audition, a design-year
  letter, limited quota, or graded basis only.
- **open** otherwise.

Exchange mode (`ng=1`) hides `closed` and shows the reasons for `note`. With `ng=1` and no
`study`, the API uses `ug2` *(default, §8 Q2)* and echoes it, so an omitted level fails safe
for the undergraduate majority the personas describe.

Because `study` has five values and `sem` three (1, 2, unset), the ingest precomputes
`closed` per module as a 15-bit mask (`ng_closed_mask`) and `note` reasons as a JSON column.
Every path then filters on one bit: D1 (`ng_closed_mask & ?1 = 0`), the bundle filter table (2
bytes per module), the Vectorize standby (15 boolean metadata keys, or a per-bit index *est.*,
see 4A) and the D1 recheck. Query time does no rule logic.

## 3. Workstreams

### 4A Per-semester NG on every path (P1)
- `ng=1&sem=N` means "NG-open in semester N" everywhere. `sem=N` alone is unchanged.
- Paths: lexical, bundle mask, Vectorize standby metadata, `localMatchesFilters`, pins, variants,
  `related`, `/facets` counts. The cache key carries `study`.
- The Vectorize standby can't take a 15-bit mask in one filter. Options, chosen at 4A by a
  measured test: 15 metadata booleans (`c0`…`c14`, within the per-vector metadata limit), or
  `ng_sem1`/`ng_sem2` plus the D1 recheck for the study-level rules. The bundle (production) path
  carries the full mask either way.
- Tests: the three `[P1 known-bug]` tests flip to `[P1 fixed]`. New fixture tests cover the 36
  mismatch modules on each path.

### 4B Restrictions as data
- `data/ng-restrictions-2026-2027.json`: every rule from the restrictions PDF, each with its kind
  (`closed-code`, `closed-prefix`, `closed-school`, `level-for-study`, `note-major`,
  `note-approval`, `note-quota`, `note-graded`, `note-audition`), its scope (codes, prefixes with
  level ranges, department names as NUSMods spells them), and its citation (PDF section and page).
- **Transcription check:** two independent transcriptions by fresh subagents that read only the
  PDF text, diffed by script. Every disagreement is resolved by the lead against the PDF, and the
  resolution is logged. Then a third subagent audits a random 20% of rules against the PDF.
- Department names are matched to NUSMods `department` strings by an explicit map. Unmapped
  names fail the build.
- `scripts/check-ng-restrictions.mjs` records the PDF hashes and fails if the file's
  `sourceSha256` doesn't match the hash in `docs/evidence/phase4/sources.md`.
- The data file is the only source of rules. `src/eligibility.js` is generic over rule kinds.

### 4C Study-level input
- API: `study=ug1…ug4|grad`, echoed in `filters`. Ignored without `ng=1`.
- `level=` keeps its meaning (one exact level) and composes with `study`.
- `/module/:code` returns `eligibility` for every (sem, study) pair, so a card can explain why a
  course is missing for another level.

### 4D Exchange-mode UI and sources (P3, exchange part)
- `src/page.html`: semester required in exchange mode, a study-level select, note badges with
  reason text, and links to both PDFs with their "updated as at" dates (from `/facets`).
- The NG badge shows the NG semesters, never `semesters`.
- Phase 5 redesigns the page; this is the minimum that makes exchange mode usable and honest.

### 4E SC1 verification
- **Oracle test** (`test/full/sc1.test.js`, full corpus): for every NG-list code × `sem` ∈
  {1, 2, unset} × all five `study` values, `eligibility()` agrees with an independent oracle
  written from the PDF text by a different author (a subagent that never sees
  `src/eligibility.js`). 1,175 × 3 × 5 = 17,625 cases.
- **Path test** (same file): for each of the 15 (sem, study) combinations, every search path
  returns no `closed` module:
  - a lexical, dense and hybrid search for each NG code's title, plus a pin search by code;
  - a wildcard filtered listing (`q` of each faculty name), a `related` path, and the variants of
    every group with a closed member.
- **Live check** at the ship: 30 calls with fresh texts across the 15 combinations, every result
  checked against the oracle (`docs/evidence/phase4/sc1-live.mjs`).

### 4F Data refresh
- O4 (no scheduled refresh) stays Phase 7. Here, `/facets` shows both PDFs' dates, and the
  README runbook gets a "new PDF" procedure: re-extract, diff, re-transcribe changed sections,
  re-run 4B's check, ship.

## 4. Eval and gates
- The dev and holdout queries come from undergraduate exchange personas, and most set `ng` with
  a semester. 4A and 4B change most of their result lists by design. The judges never saw NG
  semesters or restrictions, so a relevance-only holdout look would score correct removals as
  loss, the lesson from 3H.
- **No holdout look gates Phase 4's correctness changes.** They are gated by:
  1. SC1's oracle and path tests;
  2. **projection identity on dev**: with the dense half pinned, each dev query's candidate
     list equals the baseline's list at depth 50 with `closed` modules removed, re-cut to 10. Any
     difference beyond backfill is listed and explained in the PR. It spends no look;
  3. an unfiltered regression guard: queries without `ng=1` return byte-identical results;
  4. the `eval:report` on dev, reported and not a gate.
- The eval harness gains `study` in query filters (default `ug2` for the persona sets, Q2), so
  future looks score eligible results only. The qrels are unchanged.
- Holdout looks stay at 7 of 12 used. Any search-quality change from §6 that wants a look needs a
  compliance-aware rule written before the look.

## 5. Cost, ops and risks
- **Migrations:** `ng_closed_mask` and `ng_notes` columns, plus an index for the D1 filter. Ingest
  writes them. Every module row changes, so it's a full ingest within the daily D1 write
  allowance (6,778 rows *est.* well inside).
- **Ship:** a full runbook ship. The bundle's filter table grows by 2 bytes per module (~14 KB)
  and the vector text is unchanged, so there's no corpus embedding pass.
- **Remote ops** are logged in `requests.tsv` and `remote-ops.md` as before.
- **Risks:**
  - mis-transcribed rules: two transcriptions, a diff and an audit (4B), plus the independent
    oracle (4E);
  - department-name mismatches between the PDF and NUSMods: the explicit map fails closed;
  - the PDFs change without notice: the dates are shown to users, and the README procedure
    covers a refresh;
  - over-hiding: a wrongly `closed` course is as bad for a student as a leak. The oracle checks
    both directions, and the red team is asked to look for missing courses too;
  - the default `ug2` hides graduate-eligible courses from graduate students who don't set their
    level: the UI asks for study level before the first exchange search.

## 6. Carried items: what Phase 4 takes on
- **S6 (graduate flood) and SC4's level items:** in exchange mode, 4C's study level closes 5000+
  for undergraduates, which removes the flood where it matters. The general (non-exchange)
  search keeps 3D dropped. SC4's level items stay unmet unless Jacob reopens 3D (Q4).
- **SC4's parsed-intent items (3H phrases):** need a compliance-aware rule first. Proposed:
  pre-register in this phase, ship in Phase 5 with the frontend that shows parsed filters. Q4.
- **S2, S3, S4:** search-quality changes unrelated to exchange correctness. Proposed: left open
  for a later phase, not attempted here. Q4.

## 7. Exit criteria
- SC1's oracle and path tests are green in CI on the shipped commit. The live check agrees.
- A persona red team finds no shown course its persona can't take, and no hidden course its
  persona can take. Each team member reads both PDFs and uses the live site with fresh queries.
- P1 and P2 are `fixed`. FINDINGS gains rows for anything the red team finds.
- README, `/facets` and the vault describe exchange mode as it is.

## 8. Gate questions for Jacob (asked after the critic rounds)
- **Q1. Conflicts between the NG list and the restrictions PDF** (CG, DSA, GEH, LL4011V, LI5202/4,
  Medicine non-LSM). Hide (the restrictions are the more specific document), or show with a
  "listed as open but restricted; check with NUS" note?
- **Q2. Default study level** when exchange mode is on and none is given: `ug2`, or require it?
- **Q3. S/U in exchange mode:** keep `su=1` working with a graded-only note, or hide `su=1` in
  exchange mode until NUS says NG students may S/U?
- **Q4. Carried items:** confirm §6 (S6 via study level; 3D stays dropped; phrase parsing
  pre-registered here and shipped in Phase 5; S2–S4 left open).

## 9. Objection log
Filled in by the critic rounds.
