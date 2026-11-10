# 4B: the rules file, audited and checked against an independent oracle

`data/ng-restrictions-2026-2027.json` is built by `scripts/build-ng-restrictions.mjs` from
transcription B (`transcription.md`), the sources (`sources.md`) and the register
(`interpretations.md`): 136 rules, 13 transcribed rules recorded as info only, 2,451 self-funded
codes, and YST elective lists of 42 (Sem 1) and 37 (Sem 2) codes.

## Audit (a fresh subagent; plan 4B)
The rules whose `sha256('audit:' + id)` starts 0–3 (33 of 136), plus `A-self-funded` and
`6-music-electives-whitelist`: 35 rules. Codes, effects, note kinds, study levels, levels,
department and faculty names, regexes (tested against every NUSMods code) and cite pages were
checked against the PDF and the register. The self-funded list was re-extracted independently:
2,451 codes, no difference.

Three defects, none affecting a course on the NG list this year, all fixed:

| rule | defect | fix |
|---|---|---|
| `7-pp-ug-closed`, `7-pp-partner` (and the unsampled `7-pp-partner:open`, `7-pp-graded`) | `^PP\d` missed LKYSPP's 36 `PPX` courses and matched PP2131, a Medicine course | LKY School of Public Policy faculty and `^PP` |
| `6-music-electives-whitelist` (`lists.ystElectives`) | took every code on the YST pages, including codes named only as prerequisites, co-requisites or preclusions (MUL1107–1110 in Sem 1; CFA2101A, CFA2111A, MUL1105, MUL2107, MUL2109 in Sem 2) | headings only: codes leading a "(N Units" line or the line just above it, plus codes in the page's orange heading spans (each method alone misses some headings) |

Noted, not defects: two tables run onto the page after the cited one; `4-arch-dep5102-no-audit`
never shows because DEP5102 is also closed.

## Independent oracle (plan 4E)
A fresh subagent wrote `test/sc1/oracle.node.mjs` from the sources and the register only, never
seeing the rules file, its builder, `src/eligibility.js`, the transcriptions or the plan. Its
decisions where the register is silent (D1–D24) are in its header.

`test/full/sc1-oracle.node.test.js` compares the two on every pinned module (6,771) × 3 semesters
× 5 study levels: 101,565 cases.
- First run: 2 modules differed, PH3207 and PS3880H. The rules matched UROP case-insensitively, so
  "European" counted as UROP. Fixed (register I11); the oracle's author had flagged the same trap.
- Now: **0 differences.** Every course off the NG list is closed everywhere.

Shown NG courses (open or note) out of the 1,175 the pinned corpus offers: Sem 1, 686 (ug1, ug2)
to 658 (grad); Sem 2, 722 to 686; either semester, 1,136 (ug1, ug2) to 1,100 (grad).
