# Phase 4 exit: where each criterion stands (2026-11-10)

Exit criteria: `docs/plans/phase4.md` §7. Exchange mode is live as version `efd3dc25`
(tag `9d91605`), data version `62e5a0011231`. The shipped-ranker pin is `9d91605` (PR #67).

| criterion | status | evidence |
|---|---|---|
| SC1's oracle and path tests green in CI on the shipped commit | **met** | the `sc1` and `full-corpus` jobs pass on `9d91605` (PR #66) and on `c93fd2b`; `gates.md` §1 |
| The live check agrees | **met** | `gates.md` §5: 30 fresh exchange searches, every shown course one the oracle allows. The red team's 80 searches add 1,600 cards, each with the oracle's status |
| Persona red team: zero findings, or each fixed and re-checked | **met** | `redteam.md`: 8 personas, 1,975 calls, 0 leaks. Of 16 disagreements, 3 (R1) and 13 (R2) were resolved by Jacob's rulings for what is live; nothing to fix |
| P1 and P2 `fixed` | **met** | `FINDINGS.md`: tests and live |
| README, `/facets` and the vault describe exchange mode as it is | **met** | README "Exchange mode" and "When a source changes"; `/facets` `ngSources`; vault page `vector-nusmods` |

Holdout looks: 7 of 12, unchanged. Phase 4 spent none (ADR 0003 amendment). The test set's one
look stays spent.

## Carried into Phase 5 (Jacob's Q4 decisions)
- SC4's parsed-intent items (3H phrases): a compliance-aware rule, shipped with the frontend.
- SC4's level items stay unmet in general search; exchange mode's `study` covers S6 where it
  matters.
- S2, S3, S4 stay open for a later phase.
- P3 (no source links on the cards, title reads as official NUSMods) is Phase 5's.
