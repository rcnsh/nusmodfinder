# 0006: Phase 3 search-quality plan

Status: accepted (lead, 2026-11-04), pending Jacob's answers to Q1–Q4 (`docs/plans/phase3.md`
§10). The plan converged at r3.1 after three critic rounds (eval discipline; vectors, deploy and
cost; SC4 and student queries). Its §11 logs every objection and where it landed.

## Context
Phase 3 must meet SC4 (codes, GE pillars, typos, level and exam/S/U/workload intents, "no
matches") and SC5 (the shipped ranker beats the current one on held-out data), and re-measure
SC7, which failed at a pooled p50 of 351 ms. Warm searches spend ~232 ms in Vectorize, and the
holdout allows 12 looks.

## Decisions
- **In-Worker exact vectors, Vectorize as standby.** Dense search is a brute-force dot product
  over float32 corpus vectors bundled in the Worker as a `Data` module (10.4 MB of 64 MiB).
  - One keyed builder makes a pinned bundle for CI and SC4 and a production bundle for deploys.
    The manifest records `rowsKey`, and the deploy guard refuses any bundle that differs from D1.
  - Every corpus change follows one runbook. The manifest and an offline data version merge
    first, then D1 is written in a D1-only mode behind a bookmark, then the deploy and smoke.
    Vectorize is written last, with every code upserted and the mutation awaited.
  - Vectorize stays an identical cold standby behind `DENSE_BACKEND=vectorize`. That flip is
    degraded service: masks fall back to code order, and 3H applies after hydrate.
  - The cache key carries the deploy's version id and every new parameter.
- **Look budget.** Seven change looks (L1–L7: 3A-1, 3A-2, 3B, 3C, 3D, 3E, 3H). The reserve is
  5 under the sealed SC5 reading and 4 under the holdout reading, where L12 is the SC5 look.
  - Retries are named before each look, and the reserve funds at most one per failed change.
    Never a 13th look.
  - Each look's baseline is stored and judged, and the verdict comes from `eval:report` on
    fully judged runs.
  - A count from the custodian-only `eval:count` prints one integer, is logged outside the
    ledger, and is not a look. ADR 0003's look definition is amended to say so.
- **No-look gates.**
  - 3-0: identical result lists on dev and the fixture.
  - 3F: identity with the group-first projection, plus dev ΔnDCG@10 ≥ 0.
  - 3G must pass all of:
    - the SC4 suite;
    - ≥ 90% of a held-apart gibberish half;
    - no untagged dev query emptied;
    - dev answerable ΔnDCG@10 ≥ −0.01;
    - a custodian count of emptied untagged holdout queries equal to 0.
- **Hard beginner exclusion.** An explicit beginner phrase removes level ≥ 5 outright and adds a
  soft prior for levels 1–2. It is echoed in `interpreted` and undoable with `ignore=level`.
- **Year as a level window.** `3rd year` means 3 ≤ level ≤ 4, because d-064's answers are level
  4. `level 3000`, `3000 level` and `3k` stay exact. Several level phrases take the union.
- **groups-v1 is the product's duplicate rule**, the same rule the eval scores by (variant
  families and exact cross-listings). Collapsed members ride as `variants` with their credits.
- **The SC4 suite** is 90 pre-registered queries, each with an exact expected `interpreted`
  JSON.
  - It runs on the pinned bundle in CI, with partial codes at topK = 50, and is confirmed live
    by ≤ 20 fresh queries.
  - The custodian checks it against the holdout by count only.
- **3H's dev screen** exempts queries whose only relevant documents fail the parsed constraint
  (d-099 under both prereq semantics, d-011 under the literal one). L7's holdout rule has no
  such exemption.

## Consequences
- Production dense search becomes exact, so the replica-vs-production caveat narrows to the
  corpus pin. Vectorize queried dims drop to ~0, and the binding limit becomes Workers CPU or
  neurons, whichever measures smaller.
- Every corpus change needs a deploy, and the guard blocks deploys from `main` between the
  merge and the D1 write.
- 3-0's PR adds the measured bundle size, startup time and CPU per query to this ADR.

## Dissent
No objection was rejected outright. Four were applied in part:
1. **B-8 (round 1): delay the D1 write until the smoke passes.** The deploy guard needs D1 to
   match the manifest before the deploy, so the D1 write cannot wait. It runs behind a Time
   Travel bookmark and is restored, with the merge reverted, if the smoke fails. Every Vectorize
   write still waits for the smoke.
2. **A2-7 (round 2): a working fallback for every change SC4 needs.** Each has one, but some
   can coincide with the failed candidate or be ineligible (3B without `stopwords-v2`, 3C's other
   variant, 3D's α = 0 point, 3G's next τ). Those failures go straight to Jacob (Q4) rather than
   to new variants no critic has reviewed.
3. **A2-13 (round 2): cite the group-aware baseline on `docs/phase2-baseline`.** It is scored
   under `qrels-dev-v1`, which scores five answerable code queries as no-answer. The plan gates
   on the `qrels-dev-v2` baseline in `EVAL.md` (PR #30).
4. **A3-2 (round 3): the whole SC4 suite green at 3G's gate.** 3G can merge before 3H, and a
   change can be dropped under Q4, so the gate skips items owned by an unmerged or dropped
   workstream. It never skips the typo, gibberish, non-existent-code and guard items. SC4's exit
   check still needs the whole suite.
