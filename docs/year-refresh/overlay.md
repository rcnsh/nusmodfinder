# The year's overlay

`scripts/ng-overlay/<year>.mjs` holds what the restrictions builder adds to the transcription for
one year: each rule's effect and match, the department map, the dual-coded twins, the decided
openings and Law's compulsory list. The builder reads it through the manifest's `overlay` path
(`scripts/build-ng-restrictions.mjs`).

## Exports

- `DEPT`, `FAC`: PDF heading → NUSMods `department` / `faculty`. A transcription fact: the oracle's
  author may read these two, and nothing else here.
- `OVERLAY`: rule id → its effect (`closed`, `note`, `open`, `info`), match (`departments`,
  `faculties`, `codes`, `prefixes`, `levels`, `titles`), note kind and reason. An array gives a
  rule several parts (`suffix` names each).
- `TWINS`, `DECIDED`, `LAW_COMPULSORY`: the dual-coded pairs (C4), the openings the register
  decided, and the 48 compulsory LLB codes (I10).

## New ids

Rule ids come from the transcription (`brief-transcription.md`). After
`node scripts/transcription-diff.mjs <new> --map-to <last year's>`:

- **renamed**: rename the transcription's id to last year's, and the overlay entry carries over;
- **ambiguous**: two of last year's rules share the quote and the place; pick by hand;
- **new**: a new overlay entry, and a register row if its reading is open;
- **dropped**: remove its overlay entry. The builder fails on an overlay id the transcription
  doesn't have, and on a transcription rule with no overlay entry.

## Roles

Two rules are found by role, not id, so a new year can rename them:

- `self-funded-list` (rule A's self-funded programmes): its codes come from the self-funded list's
  text extraction;
- `off-list-rule` (rule E): `public/shortlist.js` reads it from `/facets`' `offListRules` by role.

Each must appear exactly once (`rolesOf` in the builder): a missing, doubled or unknown role fails
the build.

## Department renames

When NUSMods renames a department or faculty, change the map, not the rules:
`test/sc1/oracle.node.test.js` fails when a name a rule uses is missing from the production corpus,
which would otherwise leave a closed rule matching nothing.
