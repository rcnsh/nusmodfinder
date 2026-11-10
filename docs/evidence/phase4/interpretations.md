# Interpretations register (Phase 4, 4B)

Every place the sources leave a reading open, with the decision and its reason. The rules file
(`data/ng-restrictions-2026-2027.json`, built by `scripts/build-ng-restrictions.mjs`) follows these
rows, and `test/eligibility.node.test.js` has a case for each row that touches a course this year.
The SC1 oracle's author reads this file and the sources, never the rules file or
`src/eligibility.js`.

Rows marked **Jacob** are his answers (plan §8, 2026-11-10). The rest are the lead's, and the red
team (plan §7) reports where it disagrees with any of them.

## How the model reads the sources
| # | question | decision | reason |
|---|---|---|---|
| R1 | Courses not on the NG list (rule E: "case-by-case … may be available during Course registration") | closed | **Jacob** (Q7) |
| R2 | NG list says semester N, NUSMods doesn't offer the course in N | open, with a note "the NUSMods timetable doesn't list it in this semester" | **Jacob** (Q5) |
| R3 | `sem` unset ("either semester") | shown if NG-listed in Sem 1 or Sem 2; the R2 note if no NG semester is a NUSMods semester | the student hasn't chosen a semester yet |
| R4 | Rule D: levels 5000–6000 "NOT available to exchange students unless specified in the list below" | closed for every study level unless a department rule opens that level for that study level | C-1, C-3. "Specified" = a rule that says who **may** take them |
| R5 | Department rules that open graduate levels | Southeast Asian Studies level 5000 for 4th-years and graduates and level 6000 for graduates; ELTS, Sociology, Malay Studies, South Asian Studies graduate courses for graduates (with an approval note); PP, BMA, BMS for graduates (partner note) | each names who may take them |
| R6 | Five departments close 5000/6000 "to undergraduate students" only (Biomedical Engineering, Built Environment, Chinese Studies, Political Science, Social Work) | still closed to graduates by R4 | the sentence closes; it names no one it opens to |
| R7 | Closed and note rules on the same course | closed wins; notes accumulate on an open course | plan §2 |
| R8 | Study levels | `ug1`–`ug4` (`ug4` = 4th year or later) and `grad`, required in exchange mode | **Jacob** (Q2) |

## Conflicts with the NG list
| # | question | decision | reason |
|---|---|---|---|
| C1 | Explicit closures of NG-listed courses: LL4011V (Law's closed list), Medicine non-LSM GEC1011, GEH1043, HSI2003 (rule A), LI5202, LI5204 (§12) | closed | **Jacob** (Q1a) |
| C2 | Blanket "All CG coded courses" (under Computing's Dean's Office), "DSAXXXX" and "GEHXXXX" (under Mathematics) | closed only within the section's department; elsewhere open with a note quoting the blanket rule | **Jacob** (Q1b) |
| C3 | Level-5000 NG courses no department specifies: AR5801, AR5802, CM5223, CM5225, CM5244, CM5268 | closed by R4 | **Jacob** (Q1c) |
| C4 | Dual-coded AR5221/AR4220, AR5321/AR4321, AR5601/AR4601 (preclusions link them; the restrictions PDF names the 4000 codes as Architecture-majors-only, the NG list offers the 5000 codes) | open for every study level, with the 4000 twin's notes (Architecture major; AR5321 also no audit) | **Jacob** (Q1c), C2-2 |
| C5 | PC5202, PC5206, PC5211: Physics leaves them off its closed list, but the self-funded programmes list holds them (rule A) | closed | rule A is an explicit closure; Jacob's Q1a principle (`sources.md`) |
| C6 | NUS College (NHS, NST, NGN) and the USP partner rule | open | **Jacob** (Q6): the NG list names NUS College, never USP |

## Reading individual rules
| # | question | decision | reason |
|---|---|---|---|
| I1 | Rule B: "The Course codes below with suffix 'X'" | only the 7 listed codes | read as written; a pattern reading would close 8 Business X courses the NG list offers (C-5) |
| I2 | Six tables with no heading (Centre for Language Studies, CNM, ELTS, Japanese Studies, Science Dean's Office, Chemistry) | closed | every comparable table is headed "Courses NOT available"; the courses are internships, theses, independent study and core methods courses. None is on the NG list this year |
| I3 | Psychology: level 4000 "by appeal" vs "Courses NOT available: All Level 4000, 5000 and 6000 courses" | closed (R7) | the closed list is the more specific statement; no NG-listed Psychology course is level 4000 |
| I4 | CNM lists NM4102 in its table and closes all level 4000 | closed | both read closed |
| I5 | Economics rules over GE courses hosted by Economics (GEC, GESS, GEX) | the rules apply by NUSMods department, so they cover them | the PDF scopes by department; NUSMods says Economics hosts them |
| I6 | Southeast Asian Studies "SEA5XXX All courses with the suffix 'SEA'" | the prefix `SEA` | the example is a prefix |
| I7 | Southeast Asian Studies "All other Level 5000 courses" | department level 5000 courses not otherwise closed | "other" = not in the closed list above it |
| I8 | Business "must also be majoring in business" (in the bullet about levels 1000–4000) | a major note on every Business School course | the sentence itself has no level limit |
| I9 | Music: core courses for YST partners; non-partners may read "Music electives listed HERE" (dead link) | YST courses not on YST's "Courses for NUS Non-Music Majors" page for that semester get a partner note | YST's electives page now links there (`sources.md`); Sem 2 uses AY2025/26's page until YST publishes AY2026/27's |
| I10 | Law: "Only selective Law electives with course code LL4XXXX" and "All compulsory LLB courses" | Law courses not coded LL4 are closed; the 48 compulsory LC courses are closed; a Law major note on every Law course | read as written; the double-major sentence is covered by the major note |
| I11 | UROP in Arts & Social Sciences and Design & Engineering | matched by title, case-sensitive (`\bUROPS?\b` or "Undergraduate Research Opportunit…"), within those faculties; a case-insensitive `urop` matches "European" | NUSMods has no UROP field in the normalised module |
| I12 | Rule A schools | by NUSMods faculty (Dentistry, NUS-ISS, SCALE, Logistics Institute), department (Nursing), faculty minus `LSM` codes (Medicine), faculty at levels 5000+ (Public Health) | the PDF names schools |
| I13 | Industrial Design notes | the major note on the 15 listed codes; the graded note on every `ID` code | C-10: NUSMods' "Design" department also hosts non-ID courses |
| I14 | Code-level rules whose PDF title differs from the course's title in NUSMods (10 NG-listed codes: AR2227, AR3722, PF3211, PF3504, PF4309, PF3502, ID1121, ID1223, ID2114, LL4011V) | the rule applies by code | codes are what registration uses. Most are renames or notes inside the title. ID1223 ("History & Theory of Industrial Design" vs "Principles and Approaches to Design") and ID2114 ("Form, Materials & Making" vs "The Appreciation of Wood Craft") may be different courses; they carry only a major note, so the cost of a wrong reading is a note |
| I15 | Built Environment quota lists split by semester (PF3504 under Semester 1 but NG Sem 2 only; PF2505 under Semester 2 but NG Sem 1 only) | the quota note applies in every semester; the NG list governs semesters | C3-5 |
| I16 | Duplicates: the Materials Science table printed twice; EE2211 twice; DSE4101 under Mathematics and Statistics; the Computing level-5000 line three times; PF1107/IPM1102 with two titles | kept as printed | duplicates close the same courses |
| I17 | RMI: "limited and approval … case-by-case", "per Course tuition fees" | approval and fee notes on the Risk Management Institute department | read as written |
| I18 | Pages 21–22 blank, page 22 footer "19 March 2025" | no rules there | both transcribers found them blank |

## Department map (PDF heading → NUSMods `department`)
Spelling only, except: "Dean's Office, School of Computing" → `SoC Dean's Office`; "Multidisciplinary
Programme" → `Computing and Engineering Programme`; "Division of Industrial Design" → `Design` (see
I13); "Dean's Office (Faculty of Science)" → `FoS Dean's Office`; "Pharmacy" →
`PharmacyandPharmaceuticalScience`; "English, Linguistics & Theatre Studies" →
`English,Ling.andTheatre Studies`; "Alice Lee Centre for Nursing Studies" → `Alice Lee Center for
Nursing Studies`. The full map is `DEPT` and `FAC` in `scripts/build-ng-restrictions.mjs`;
`scripts/check-ng-restrictions.mjs` fails if a mapped name is missing from the pinned corpus.
