# Persona query-writing protocol (pre-registered)

Used for the dev+holdout pool (2026-11-04) and, unchanged, for the sealed test set written after
Phase 3 freezes. Seed for shape assignment: `vnm-2026-11-04` (dev/holdout); the test set uses
`vnm-test-<freeze date>`.

## Personas (all incoming undergraduate exchange students at NUS, AY2026/27)
- **P1 Lena** — 3rd-year business administration student from a German university, one semester
  (Sem 1). Needs finance, marketing, strategy courses her home school will credit; wants English
  taught, worried about workload and exam clustering. Home courses: "Corporate Finance II",
  "International Marketing", "Business Ethics".
- **P2 Marcus** — 3rd-year CS major from a US state university, Sem 2 only. Wants upper-division CS
  (ML, systems, security, HCI) and one fun elective; needs 4 courses ≈ 16 units; asks in American
  terms ("upper-division", "3 credit"). Home courses: "CS 4400 Operating Systems", "Intro to AI".
- **P3 Ji-woo** — 2nd-year mechanical engineering student from a Korean university, Sem 1. Needs
  thermodynamics/fluids/design equivalents, plus maybe a language course; writes slightly
  non-native English.
- **P4 Olivia** — 2nd-year arts/humanities student (history + politics) from an Australian
  university, full year. Interested in Southeast Asian history, politics, culture, Singapore
  society; wants courses with no final exam where possible.
- **P5 Camille** — 3rd-year life sciences student (biology/biochem) from a French university,
  Sem 2. Wants molecular biology, ecology, a lab course, and maybe beginner Mandarin; mentions
  ECTS ("6 ECTS").
- **P6 Sam** — 2nd-year computer science student from a UK university on a **full-year** exchange
  (both semesters). Wants security, concurrency, software design, data engineering, plus
  philosophy and an intro economics course; CS is oversubscribed for exchange students, so needs
  backups for picks that don't get allocated; maps home modules to get prerequisites waived;
  prefers courses with no final exam.

## Shapes written by personas (147 total)
| shape | total | notes |
|---|---|---|
| topical | 45 | what they want to study, in their own words |
| mapping | 20 | a home course title or a pasted description/outcomes (some > 200 chars) |
| alternatives | 10 | "like X but…", "backup for X", "something similar to X" |
| language | 8 | learning a language at NUS |
| sea | 8 | Singapore / Southeast Asia content |
| equivalence | 8 | level/credit equivalence ("third-year", "upper-division", "6 ECTS") |
| abbreviation | 12 | jargon/abbreviations ("ML", "OS", "HCI", "IR", "PDE", "intro econ") |
| ge | 6 | asks for general-education courses (students may have heard "GE" / pillar letters) |
| level | 12 | level intent ("for beginners", "advanced", "no prerequisites") |
| constraint | 10 | no exam, light workload, S/U, exam timing — feature-gap block |
| noanswer | 8 | things NUS plausibly doesn't offer to exchange students, or nonsense |

Per persona 20–28 queries (147 in all); assignment matrix generated from the seed.

## Mechanically generated shapes (33)
- **code** (18): seeded sample of NG-list codes → exact (`CS3244`), lower-case with space
  (`cs 3244`), partial prefix (`CS32`, `GEA`), plus 3 non-existent codes (no-answer by rule).
- **typo** (15): keyboard/phonetic noise model (adjacent-key substitution, transposition,
  deletion, doubled letter; 1–2 edits on words ≥ 4 letters) applied to 15 seeded clean
  persona queries; each typo query inherits its source's narrative and **its source's split**.

## Writer prompt (verbatim template)
See `eval/v2/writer-prompt.md`. Writers get only the persona card and their shape quota; they
never see the corpus, NUSMods, or search results, and use no tools.

## Each query record
`{ id, persona, shapes[], text, filters: { sem?, ng?, level? }, narrative: { relevant,
partial, notRelevant }, source? }`
`filters` = the UI state the persona would set (exchange students: `ng: true` and their
semester; full-year personas may leave sem unset).
