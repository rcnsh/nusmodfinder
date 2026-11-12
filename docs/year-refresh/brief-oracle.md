# Brief: the SC1 oracle for a year

For the author of `test/sc1/oracle-<year>.node.mjs`. SC1 checks the shipped rules against an
oracle written independently from the same sources: if the rules and the oracle were written by
the same reader, they would share every misreading, and agreement would prove nothing.

## What you read, and what you never read

- **Read:** the year's PDFs and pages (restored with `npm run sources -- restore`; the manifest's
  newest revision lists them), the year's register (`docs/year-refresh/registers/<year>.md`, or for
  2026/27 `docs/evidence/phase4/interpretations.md`), last year's oracle, and the department map:
  the `DEPT` and `FAC` exports of `scripts/ng-overlay/<year>.mjs`, a transcription fact both sides
  may read (PDF heading → NUSMods department).
- **Never read:** `src/eligibility.js`, `scripts/build-ng-restrictions.mjs`, the rules file
  `data/ng-restrictions-<year>.json`, or anything else in the overlay module (`OVERLAY`, `DECIDED`,
  `TWINS`, the roles).
- **Where the register is silent**, decide, write the decision in the oracle's header as a new
  `D` reading, and send it to the maintainer to log in the register (`register.md`). Don't read
  the rules to see what they did.

## For a new year

1. `npm run year -- next <year>` wrote the oracle as a stub: last year's oracle with
   `export const stub = true;` on top. The selector (`test/sc1/oracle.mjs`) refuses a stub.
2. Diff the year's restrictions against last year's (`node scripts/transcription-diff.mjs
   <new transcription> --map-to <last year's>`, and the PDFs). Rewrite only the sections whose
   rules changed; keep the rest.
3. Re-verify each register row flagged "re-verify" (it names a course code): the code may have
   moved, been renamed or left the list.
4. Remove the `stub` line. Update the header: the sources and their dates, and any new `D`
   readings.

## What the file exports

The selector imports it as `./oracle-<year>.node.mjs` (never import it directly anywhere else;
`test/oracle-selector.node.test.js` fails on that):

- `explain(m, { sem, study })` → `{ result: 'open' | 'note' | 'closed', closed: string[], notes:
  string[] }`, and `oracle(m, ctx)` its `result`. `sem` is `1`, `2` or `'any'`; `study` is
  `ug1`–`ug4` or `grad`. `m` is a normalised module: `code`, `title`, `department`, `faculty`,
  `level`, `semesters`, `ng`, `ngSemesters`.
- `explainShown` and `oracleShown`: `explain` plus R3's year-of-study note and R6-2's level 4000
  note, from `test/sc1/oracle-shared.node.mjs` (those readings don't depend on a year's PDFs).
- `prereqYears`, `yearNoteOf`, `levelNoteOf`: re-exported from the shared module.

## The unpublished semester (G2), for the next fresh author

The selector, not the dated oracle, applies G2 (Jacob's answer, ADR 0011): in a semester the
manifest marks unpublished, a course on last year's list for it is "to confirm" (a note), never
open; one that wasn't stays closed; for either semester, D1's least restrictive per-semester
answer. The module carries the unpublished semesters in `ngUnpublished`, and its `ngSemesters`
holds such a semester exactly when the course was on last year's list for it.

That wrapper was written in Phase 7 by the author of the same state in `src/eligibility.js`, so it
is not independent. The next fresh oracle author re-derives it from the ruling above, without
reading `src/eligibility.js`, and replaces `withUnpublished` in `test/sc1/oracle.mjs` if theirs
differs; `test/unpublished-sem.node.test.js` and the rehearsal's Sem 2 variant then check the two
agree.

## Agreement

`npm run test:sc1` (and `test/full/sc1-oracle.node.test.js`) compare the oracle and
`eligibility()` on every code, semester and study level. Each disagreement is classified and fixed
at its source: a transcription error, a missing ruling, a rules bug, or an oracle bug. An oracle
bug goes to a fresh author (not whoever wrote the rules), with the case and the sources only.
