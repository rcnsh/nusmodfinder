# Phase 6 exit: where each criterion stands (2026-11-12)

Exit criteria: `docs/plans/phase6.md` §5. The shortlist and export are live as version `b0834844`
(tag `a23601d`) at https://nusmodfinder.rcn.sh. The shipped-ranker pin is `a23601d`.

| criterion | status | evidence |
|---|---|---|
| SC3: lists, ranks, semesters, `ay` and `view` round-trip through the URL, reload, Back, Forward and a fresh context | **met** | `test/web/list.node.test.js`, `test/web/state.node.test.js`, `test/ui/history.spec.js`, `test/ui/shortlist.spec.js` (Chromium and WebKit, in CI) |
| SC3: the totals equal the reference over 500 random shortlists and on the live link | **met** | `test/web/shortlist.node.test.js` (500 seeded lists against `shortlist-reference.node.mjs`); `p6-live.mjs` on production, 18 of 18 (`remote-ops.md`); the red team's exports all equal the reference (`redteam.md`) |
| SC3: the CSV and the PDF carry every course's description, its workload or the not-listed text, and the study-time estimate, in CI and once live | **met** | `test/web/csv.node.test.js`, `test/ui/export.spec.js` (tagged PDF text); `p6-live.mjs` live: the CSV read back strictly, Chromium's tagged PDF with all 8 descriptions |
| SC1 holds over the shortlist for every offered code | **met** | `test/sc1/paths.test.js` over all 6,771 offered codes plus the NG-listed codes with no classes, the level-4000 note included (CI `sc1`) |
| SC2 and SC8 hold: axe zero violations on the new states; keyboard, live-region, reflow and fold specs | **met** | `test:ui` (a11y, keyboard, live, mobile, fold specs, both browsers); `p6-live.mjs` axe and fold live |
| 6A shipped; pin moved ranking-neutral; 0 holdout lists differing | **met** | `gates.md`: pins `0b5f360` and `a23601d`, each with dev and fixture identical and 0 of 81 holdout lists differing |
| The red team: zero page defects open | **met** | `redteam.md`: RT6-PD1 fixed (#98) and re-checked live; R6-2 and RT6-SA1 ruled by Jacob, R6-1, R6-3 and RT6-SA2 by the lead; R6-2 shipped (#99) and re-checked live |
| `docs/REFERENCE.md`, `docs/PLAN.md` and the vault page describe the shortlist as it is | **met** | `docs/REFERENCE.md` "The page" (the shortlist, export, level-4000 note; the VoiceOver line corrected); `docs/PLAN.md`; vault page `nusmodfinder` |

Holdout looks: 8 of 12, unchanged (Phase 6 spent none). The test set's one look stays spent.

## Left open, recorded
- Safari's PDF, Chrome's own print-dialog PDF and the iOS print path are untested by a person
  (`docs/evidence/phase6/facts.md`, the 6D report); Chromium's `page.pdf` is checked in CI and live.
- The brochure's 4 and 10 are images in its PDF and were not read by eye.
- The full-year form order rests on NUS's 2018/19 sheet (G5, the lead's call per ADR 0010).
- 162 catalogue-only codes missing from `catalogue-codes.json` (B12-open in the plan's critic
  log): search calls them unknown while `/module` says "not offered in 2026/27". For Phase 7's
  data work.
