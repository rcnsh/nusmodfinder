# Phase 5 exit: where each criterion stands (2026-11-11)

Exit criteria: `docs/plans/phase5.md` §5. The page is live as version `0b81c82e` (tag `8a86bf6`),
data version `d820d578cf81`. The shipped-ranker pin is `8a86bf6` (PR #85).

| criterion | status | evidence |
|---|---|---|
| 5A shipped; data version and pin moved; dev and fixture identical; the pin's holdout run stored, 0 lists differing | **met** | `gates.md` "5A"; data version `d820d578cf81`; pin `f798542`, then moved on with each ship |
| SC2: every fixture code opens in CI; 20 stratified codes live | **met** | the `ui` job (434 fixture codes); `p5-live.mjs` 32 of 32 on `810c903b` and again on `0b81c82e` (`remote-ops.md`) |
| SC8: axe zero violations in CI on every state × theme × width and once live; keyboard at both widths; live-region assertions; fold in CI and live | **met** | `test:ui` (axe every rule at the AA bar, keyboard, live, fold specs); `p5-live.mjs` live, both themes, Chromium and WebKit fold |
| SC8: the VoiceOver checklist, locally and live | **dropped by Jacob** | Jacob, 2026-11-11: no manual screen-reader walkthrough (ADR 0008). The screen-reader flow rests on the automated checks: every control's name and the accessibility tree (`aria.spec.js` snapshots) and what the live region says (`live.spec.js`) |
| F1–F10, V1 and P3 `fixed`, their tests rewritten as correctness tests | **met** | `docs/FINDINGS.md`; `npm run check:findings` |
| The design gate passed | **met** | ADR 0008: direction D, Jacob's pick |
| 5F shipped under the rule, or recorded as not shipped | **met: shipped** | `gates.md` "L8": PASS under the compliance rule (look 8 of 12); live in `75ca23c`; SC4's 14 parsed-intent items pass (76 of 76) |
| The red team: zero page defects open; any source ambiguity ruled by Jacob | **met** | `redteam.md`: R3 ruled by Jacob (the Year N note); PD1, PD2, S1–S3 and 26 plain-language findings fixed in PR #84 and re-checked live |
| README and the vault page describe the frontend as it is | **met** | README "The page"; vault page `vector-nusmods`. The repo has no `CLAUDE.md`; the README is the maintainer's guide |

Holdout looks: 8 of 12 (L8, the only look Phase 5 spent). The test set's one look stays spent.

## Left open, recorded
- The Year N note covers a year rule that stands on its own or in an "If undertaking an
  Undergraduate Degree" branch (231 of 945 prerequisites that name a year). Where the year is one
  alternative beside an OR (678, mostly "GPA ≥ 3.2 OR Year 4") the page shows NUS's text with no
  note (`redteam.md`, PR #84).
- Plain-language rows 28 (jargon across many rule texts), 30 ("pay in full", not verifiable from
  the source) and 37 (naming across the page) are not done.
- S2, S3 and S4 in `docs/FINDINGS.md` (older findings, carried since Phase 4) stay `reproduced`.
  The red team's S4 (a link's `study=` overrides the saved year without notice) is information
  only.
- SC4's level items stay unmet in general search; exchange mode's `study` covers them where it
  matters (Phase 4's carry).
