# Phase 7 exit: where each criterion stands (2026-11-12)

Exit criteria: `docs/plans/phase7.md` §4. Production is version `85b401bc` (tag `46c8d56`, data
version `7eb77cf0828b`) at https://nusmodfinder.rcn.sh, deployed after the first NUSMods refresh;
later docs-only pushes redeploy the same code from Actions. Per-workstream checks are in
`gates.md`; every remote step after 7C is a run record in `docs/evidence/ops/runs/`, tied together
in `remote-ops.md`.

| criterion | status | evidence |
|---|---|---|
| CI: every push to `main` and every ready PR runs `check` and `eval-gate`; heavy jobs skip only by the tested rule | **met** | 7A (#103): `gates.md` 7A, PR #104 (a REFERENCE-only PR runs `check`, `eval-gate` fast path) |
| CI: the throwaway `RRF_K` PR fails, `main` passes | **met** | PR #105, CI run 43145138172 (`eval-gate` and the 1B differential both failed); `main` green on every merge since |
| Migrations: `db:rebuild-check` passes; production's schema equals the full-chain snapshot, same migrations | **met** | `gates.md` 7A (equal in every section, 10 migrations); the snapshot is now `test/fixtures/schema-full.json`, 0 differences |
| Trace: `/health`'s tag is the newest `deploy/*` or `rollback/*` tag's commit | **met** | smoke checks it on every deploy and rollback (`…-smoke-19bb`, `-3fd0`, `-a179`, `-6b7a`) |
| Trace: deploy refuses a commit without green CI | **met** | `test/preflight.node.test.js`; live: the preflight refused 447e2e6 while its CI ran (11:24 UTC) |
| Trace: the rollback drill ran and has its records | **met** | `remote-ops.md` "7G": to `b0834844`, smoke, back to `b1ccf7db`, smoke; data check 4 of 4 both ways |
| Ops: no runbook step writes `.dev.vars`; no script has a default URL | **met** | `test/runbook.test.js`, `test/remote-session.node.test.js`, `test/worker-url.node.test.js` (7C, #102) |
| Ops: every remote operation after 7C has a run record; 7-0's are in `remote-ops.md` | **met, with one exception** | see "Exceptions" |
| Ops: ingest and the bundle read only the manifest's `current` corpus | **met** | 7D (#107); the refresh read `prod-2026-2027-20261112` only (`…-remote-4077`) |
| Year: `year check` passes in CI; `--full` passes on the Mac, record committed | **met** | CI `check`; `20261112T111300Z-year-check-9bb5` after the red team's H-1 fix: NG list re-extracted byte for byte (Sem 1 730, Sem 2 750), rules byte-identical, 19 quotes |
| Year: the rehearsal passes in CI; `docs/year-refresh/` holds the checklist and briefs; the 2026/27 sources archive is published | **met** | CI `rollover`; `docs/year-refresh/`; releases `sources-2026-2027-20261110` and `-20261112` |
| Year: B12-open is closed | **met** | `gates.md` 7D: the 162 codes (149 not-offered, 9 ng-unscheduled, 4 EX codes unparsed, recorded) |
| Observability: this month's report committed; the account inside every allowance | **met** | `docs/evidence/ops/2026-11.md`: every allowance under 16% except the account's busiest Workers AI day (68%, account-wide) |
| Docs as 7G lists | **met** | REFERENCE (Deploying, Rollback, Operations, A new academic year, Cost, Known limitations), `docs/year-refresh/`, FINDINGS S1 and O2 fixed and O4 reproduced by design, ADR 0003's two amendments, ADR 0011 accepted, PLAN.md, PROGRESS.md, the vault page |
| Fresh clone | **met** | a new worktree at `b6bbb96` with no `.data/`: `npm ci`, `npm test` (1,954 passed, 22 skipped), `db:rebuild-check`, `test:eval`, then `corpus restore` fetched `current` |
| Red team: every finding fixed | **met** | `redteam.md`: H-1, M-1–M-3, L-1–L-5 fixed in #112, each with its reproduction as a test |

## Shipped in Phase 7
- **Deploys:** `main` deploys from GitHub Actions once CI and Findings pass (`DEPLOY_FROM_ACTIONS`
  on since run 43209550016); the guard recomputes every row's hash from its columns over the D1
  REST client, read-only by a strict filter. Re-ingests stay on the Mac; the Actions deploy of a
  data change refuses until D1 holds it (seen live on 46c8d56).
- **The first NUSMods refresh** (#110, #113) ran through the corpus-only runbook: 6,778 → 6,818
  offered courses, 254 texts embedded (~89 neurons), 1,118 D1 rows written, deploy, smoke and
  standby.
- **Fixes found on the way:** list-vectors' cursor (`--cursor=<value>`, 5e06c41), tests that pinned
  the corpus' counts (#113), two tests' timeouts on a cold checkout (`b6bbb96`).

## Exceptions, recorded
- The 7F GraphQL introspection (2026-11-12 02:31 UTC) ran after 7C merged and was logged by hand in
  `remote-ops.md`, not as a run record.
- 7D's catalogue read (07:05:09) came before its preflight (07:05:30).
- A second `rollback --to b0834844` was started by mistake during the drill; it refused before any
  read or deploy (`…-rollback-a2fc`).
- Branch protection on `main` stays off (Jacob, 2026-11-12).

Holdout looks: 8 of 12, unchanged (Phase 7 spent none; every merge passed the ranking lock as
ranking-neutral). The test set's one look stays spent.

## Left open, recorded
- S2, S3, S4 and S6 stay known limits (G4).
- The four EX codes don't parse as a code (a parse rule older than 7D; changing it changes ranking).
- `pypdf` isn't pinned in `.venv`; `--full` names the version it ran with only through its output.
- YST hasn't published 2026/27's Sem 2 page; exchange mode shows 2025/26's, labelled.
