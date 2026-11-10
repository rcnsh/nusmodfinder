# Phase 4 plan: exchange mode that is correct (draft r2, for critics)

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

r2 applies every round-1 objection (§9). The main changes from r1:
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
| — not specified anywhere: AR5221, AR5321, AR5601, AR5801, AR5802, CM5223, CM5225, CM5244, CM5268, PC5202, PC5206, PC5211 | closed by D, yet on the NG list | 12 (conflict) |
| 1: dept closes level 4000 to NG undergraduates (Chinese Studies, ELTS, Geography, Political Science, Social Work, Sociology; CNM, Psychology and Economics close it to graduates too) | closed for ug1–ug4 | 7 |
| 1: level 4000 only for 3rd/4th-year undergraduates (Malay, South Asian, SE Asian) | closed for ug1–ug2 | 3 |
| 1: Economics 1000–3000 closed to NG graduates | closed for grad | 25 (incl. GEC, GESS, GEX hosted by Economics: scope in the register) |
| 1, 4: Geography and Built Environment 1000–4000 closed to NG graduates | closed for grad | 39 |
| 5: Law needs a Law major; LL4011V closed | note; closed | 91; 1 |
| 2: Business needs a business major | note | 41 |
| 6: Music core courses for YST partner institutions only | note-partner | MUA4161, MUA3219 |
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
1. **Semester.** `closed` unless the module is on the NG list for `sem`. Where the NG list says
   open in N but NUSMods doesn't offer it in N, the outcome follows §8 Q5 (lead default: `note`,
   "the NG list says Sem N; the NUSMods timetable doesn't list it", because the NG list is the
   Registrar's availability statement and NUSMods' semesters are a scrape).
2. **Rule D as a default.** Level 5000+ is `closed` for every `study` unless a department rule
   specifies otherwise for that `study` (C-1, C-3). The 12 unspecified codes follow Q1.
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
- `ng_rules` (JSON): per bit, the status and rule ids with reason text. `/module/:code` and
  result cards read it, so the Worker runs no rule logic (B-9).
- Both fields join `ROW_COLUMNS`/`boundTuple` (`src/rowhash.js:37-53`), so a rules-only change
  re-hashes every affected row and reaches D1, the data version and the deploy guard (B-6).

**Paths** (each filters on the one bit for (sem, study)):
- D1 lexical: `+m.ng_allow & ?1 != 0` as a non-driver predicate beside `m.ng = 1`. No new index:
  SQLite can't use one for a bitmask, and `idx_ng` already drives the query (B-5).
- Bundle: `ng_allow` in reserved bytes 6–7, stride stays 32 bytes (B-4). `BUNDLE_SCHEMA` bumps,
  `decodeFilterRow` reads it, and verify's field compare includes it.
- Vectorize standby: no new metadata (B-1). It keeps the yearly `ng` filter, reads deeper under
  `ng=1` (as `STANDBY_RELATED_DEPTH`), and every dense candidate passes the D1 recheck.
- D1 recheck `localMatchesFilters`: tests `(row.ng_allow ?? 0) & bit`. `ng_allow` is added to
  `RESULT_COLUMNS` and `VARIANT_COLUMNS`. `related` is rechecked whenever `ng=1` (B-2).
- The cache key carries `study`.

`sem=N` without `ng=1` keeps its meaning (NUSMods semesters).

## 3. Workstreams

### 4A Per-semester NG and the allow mask on every path (P1, P2)
- Implements §2's storage and paths. Migration adds `ng_allow` and `ng_rules`.
- Unit tests: a row without `ng_allow` is never shown (each path); the three `[P1 known-bug]`
  tests flip to `[P1 fixed]`; `[P2 known-bug]` flips to `[P2 fixed]`.
- Fixture: the 36 mismatch modules, the 12 special-term modules and the 28 level-5000 modules,
  each with its expected status for all 15 combinations, listed in the test file (A-5).

### 4B Restrictions as data
- `data/ng-restrictions-2026-2027.json`: every rule from the restrictions PDF and the other
  sources, each with its kind (`closed-code`, `closed-prefix`, `closed-school`, `level-for-study`,
  `note-major`, `note-partner`, `note-approval`, `note-quota`, `note-graded`, `note-audition`),
  its scope (codes, prefixes with level ranges, departments), and its citation (section, page).
- **Interpretations register** (`docs/evidence/phase4/interpretations.md`): one row per ambiguous
  rule with the decision and reason, and a fixture case for each. It starts with:
  - blanket rules' scope (CG, DSA, GEH under one department's section): global or section-only;
  - rule B: the 7 listed codes only, not every `…X` code (else 8 Business courses close, C-5);
  - renamed codes: the PDF's AR4220/AR4321 vs NUSMods' AR5221/AR5321 with the same titles;
  - Economics' rules over GE courses it hosts (GEC, GESS, GEX);
  - Psychology's self-contradiction (level 4000 by appeal vs all 4000 closed);
  - Industrial Design's notes scoped by the `ID` prefix, not the "Design" department (C-10);
  - USP's partner rule and NUS College's 63 NG-listed codes (§8 Q6).
- **Department map:** PDF department names to NUSMods `department` strings, explicit; unmapped
  names fail the build. The NG PDF's own Faculty and Department columns are a second check: for
  all 1,207 codes they must match the map apart from spelling.
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
  - Run over **every corpus module** (6,778) and all 1,207 NG codes × 3 `sem` × 5 `study`
    (~120k cases): `eligibility()` must agree with the oracle on status (A-3, C-7).
- **Path test** (same file), for each of the 15 combinations, on each path (lexical, bundle,
  standby with recheck, pins, variants, `related`):
  - **set equality**: an exhaustive filtered listing equals the oracle's `open ∪ note` set, so
    neither a leak nor an over-hide passes (A-4);
  - a code search for every NG code returns it exactly when the oracle shows it.
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
  2. **Per-retriever identity on dev** (A-2): a new dev run records each half's list at depth
     50, unfiltered by the new rules and filtered. For every query, each half's filtered list
     must equal its unfiltered list with the oracle's closed modules removed, exactly; and the
     shipped page must equal `fuse()` of those projected halves, exactly. Any difference fails.
  3. **Unfiltered guard** (A-1): dev with `ng` stripped and `sem` kept, dev with `--unfiltered`,
     the SC4 suite and the fixture all return byte-identical results to the baseline.
  4. `eval:report` on dev, reported and not a gate.
- **Eval bookkeeping** (A-7):
  - the runner adds `study` per persona when it builds each query (P1, P2, P5 are 3rd-years:
    `ug3`; P3, P4, P6 are 2nd-years: `ug2`), so the locked query files don't change;
  - the ship PR moves `SHIPPED_BASELINE` with a pin line ("no look: SC1, per-retriever identity,
    unfiltered guard"), and the custodian stores the new holdout baseline with `--store-only`.
- Holdout looks stay at 7 of 12 used. Any search-quality change from §6 that wants a look needs a
  compliance-aware rule written before the look.

## 5. Cost, ops and risks
- **Migrations:** `ng_allow` and `ng_rules`; no index.
- **Ingest:** every NG module's row hash changes. The write cost is measured on a small local
  batch first, as ADR 0004 requires, and the run passes an explicit `--write-budget`. A full
  rewrite measured 34,383 rows written (README:392); Workers Paid has no daily write cap, only
  the monthly allowance with the estimate × 1.5 rule (ADR 0004).
- **Ship:** a full runbook ship. The bundle keeps its size (reserved bytes). The vector text is
  unchanged, so there's no corpus embedding pass. Vectorize needs no recreation.
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
- **Persona red team** (A-8): 5 personas fixed in advance (ug1, ug3 and ug4 undergraduates from
  different faculties, one graduate, one Law major), each with 10 fresh queries across both
  semesters, reading the sources and the register and using the live site.
  - A finding is a shown course that is `closed` under the sources plus Jacob's answers to Q1,
    Q5 and Q6, or a hidden course that is open. A noted course shown with its reason is a pass.
  - Exit needs zero findings, or each finding fixed and re-checked.
- P1 and P2 are `fixed`. FINDINGS gains rows for anything the red team finds.
- README, `/facets` and the vault describe exchange mode as it is.

## 8. Gate questions for Jacob (asked after the critic rounds)
- **Before 4B starts:** Jacob downloads the self-funded programmes PDF, the YST electives page
  and the Law compulsory-course list (C-2).
- **Q1. NG-listed courses a restrictions rule closes:** the blanket CG/DSA/GEH rules (whose
  owning departments don't close these codes), Medicine non-LSM (3), Logistics Institute (2),
  LL4011V, and the 12 level-5000 codes no department specifies. Per group: hide, or show with a
  "listed as open, but restricted elsewhere; check with NUS" note?
- **Q2. Study level required** in exchange mode (the lead's default), or a default level?
- **Q3. S/U in exchange mode:** keep `su=1` working with a graded-only note where a department
  requires it, or hide `su=1` in exchange mode until NUS says NG students may S/U?
- **Q4. Carried items:** confirm §6 (S6 via study level; 3D stays dropped; phrase parsing
  pre-registered here and shipped in Phase 5; S2–S4 left open).
- **Q5. NG list vs NUSMods semesters** (36 modules): note (default) or hide when NUSMods doesn't
  offer the course in the NG-listed semester?
- **Q6. NUS College and USP:** the restrictions PDF limits USP to partner universities; USP is now
  part of NUS College, which has 63 NG-listed codes. Treat them as open, or `note-partner`?

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
