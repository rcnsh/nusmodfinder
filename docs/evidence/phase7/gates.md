# Phase 7 exit checks

## 7A CI and the ranking lock (merged as `51851b6`, PR #103)

| Check | Evidence | Result |
|---|---|---|
| `main` green after the merge | CI run 43143948232 on `51851b6`: `changes`, `check`, `eval-gate`, `full-corpus`, `sc1`, `ui (chromium)`, `ui (webkit)` all succeeded; Findings succeeded | pass |
| A PR that edits only `docs/REFERENCE.md` runs `check`, and `eval-gate` takes its fast path | PR #104 (closed unmerged), CI run 43145128798: `check` ran in full (181 s, success); `eval-gate` took "Fast path (the lock and the eval's inputs unchanged)" in 9 s; `full-corpus`, `sc1` and both `ui` jobs started and skipped by steps (3–29 s) | pass |
| A PR that changes `RRF_K` fails `eval-gate` | PR #105 (closed unmerged), `src/search.js:98` `RRF_K` 60 → 30, CI run 43145138172: `eval-gate` failed in 71 s and named every changed query (dev filtered, `--strip ng` and unfiltered, plus fixture lists, e.g. `fixture filtered fx-01: status 200 -> 200 (codes or their order changed)`). `check` failed too, from the existing 1B differential test (`test/differential.test.js`, 289 differing requests), a second guard catching the same change | pass |
| The slow path within a 15-minute budget | PR #103's first `eval-gate` run: 46 s to recompute, 64 s for the job (timeout 12 min); PR #105: 71 s | pass |
| Production schema equals the full-chain snapshot | `scripts/schema-snapshot.mjs --compare-remote docs/evidence/phase7/schema`: equal in every section, same set of 10 migrations, applied 0008 before 0007 (PR #103 body) | pass |
