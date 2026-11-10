# 4B: two transcriptions of the restrictions PDF, diffed

Plan step 4B. Two fresh subagents, each reading only
`non-graduating-course-restrictions.pdf` (31 Aug 2026, sha256 in `sources.md`) and its text, wrote
`transcription-a.json` and `transcription-b.json` to the same schema without seeing each other.
`scripts/transcription-diff.mjs` compares them as facts: (code, pattern or school) × kind ×
students × levels.

## Result
- Both: 132 rules, with identical counts per kind (73 closed, 11 info, 11 note-approval, 9
  note-graded, 7 open-only-for, 6 note-major, 5 note-partner, 4 note-quota, 2 note-fee, 2
  whitelist, 1 note-letter, 1 note-audition).
- 615 facts each, 585 shared. **Every explicit course code agrees** on kind, students and levels,
  and no course title differs between them.
- The 30 differences on each side are encoding choices, resolved by the lead against the PDF:

| difference | resolution |
|---|---|
| Rule D keyed as a pattern (A) or by section (B) | same rule: levels 5000–6000 closed to exchange students unless specified |
| E and F keyed differently | same: `info` |
| ELTS "Level 5000 and 6000 Graduate Courses – approval … Only open to NG graduate students": students `all-ng` (A) vs `ng-graduate` (B) | **B**: the quote limits it to graduate students |
| Business: major and no-late-add rules keyed by pattern (A) or school (B) | same rules: `note-major` for Business courses; the no-late-add sentence is why rule E can't apply to Business (plan §2 step 1) |
| Computing's "FT/IT/BT/CS/IS/CP level 5000 and 6000" wording | same rule, printed three times (Dean's Office, CS, ISA) |
| CEE/ISEM "No appeal … not listed in the NG course offerings list" wording | same: these departments' levels 1000–4000 off the NG list stay closed under any Q7 answer |
| "CE and ESE" as one pattern (A) or two (B) | two prefixes, CE and ESE, levels 5000–6000 closed |
| Law: whitelist `LL4XXXX` and major rules keyed differently | same: only LL4 electives open; Law major note; compulsory LLB closed (`law-compulsory-llb-courses.png`: 48 LC codes, none on the NG list) |
| Music: core-course partner rule and the electives whitelist keyed differently | same: the YST lists are the whitelist (`sources.md`) |
| LKYSPP and USP partner rules: students free text | same rules |
| FST, QF, MA, ST/DSS level-5000 pattern wording | same rules |
| `MA4288P/O` and `PC4288, PC4288A/Q/N` kept as patterns (A) or expanded (B) | **B**: MA4288P, MA4288O; PC4288, PC4288A, PC4288Q, PC4288N |

## Doubts both transcribers raised
They go to the interpretations register (`interpretations.md`) with a decision each:
Psychology's level-4000 contradiction; CNM listing NM4102 while closing level 4000; the
duplicated Materials Science table; DSA under both Mathematics and Statistics; GEH under
Mathematics vs GEH1057 under Materials Science; "suffix 'SEA'"; what rule D's "specified" means;
section B's X-suffix scope; the six tables with no heading; Built Environment's per-semester quota
lists; the PF1107/IPM1102 pair printed with two titles; pages 21–22 blank with a 19 March 2025
footer.
