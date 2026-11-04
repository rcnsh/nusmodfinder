# 0004: Workers Paid quotas, and one relevance judge

Status: accepted (Jacob, 2026-11-04). Amends ADR 0002 (write cap and ordering) and ADR 0003 and
`docs/plans/phase2.md` §3 (judges).

## 1. The account is on Workers Paid

### Context
The brief and ADR 0002 assumed the Free limits. Those are D1 at 100k rows written and 5M read
**a day**, account-wide, with every query failing once either is reached, and 10 ms CPU per
request. The vault already recorded Workers Paid. Jacob confirmed it on 2026-11-04.

### Included allowances on Paid
Checked against the Cloudflare docs on 2026-11-04:

| | included | above it |
|---|---|---|
| D1 rows read | 25 billion / month | $0.001 / million |
| D1 rows written | 50 million / month | $1.00 / million |
| Vectorize queried dims | 50 million / month | $0.01 / million |
| Vectorize stored dims | 10 million | $0.05 / 100 million |
| Workers AI | 10,000 neurons / day (as on Free) | $0.011 / 1,000 neurons |
| Worker CPU per HTTP request | 30 s default (up to 5 min) | 30M CPU-ms / month included |
| D1 Time Travel | 30 days | — |

Going over an allowance on Paid is **billed**, not refused. Monthly allowances reset on the
subscription renewal day, not at 00:00 UTC.

### Decision
- **No spending.** The brief's "spend money" rule now means staying inside the included
  allowances above; it does not mean the Free limits. Nothing in this project may run up an
  overage.
- **The daily write cap is gone.** ADR 0002's rule that 0006 and the forced re-ingest run on
  different UTC days no longer applies. The headroom rule becomes: before a remote D1 write,
  estimate it, check month-to-date account usage, and proceed only if `estimate × 1.5` fits
  in the month's remaining included writes. In practice every operation here is under 0.3% of
  50M.
- **The brief's other hard rules stand:**
  - estimate and log every remote D1 operation;
  - measure on a small batch before any forced or full re-ingest;
  - keep live traffic light.
- **The binding limit is Vectorize queried dims.** At 50M / 384 − 6,771 that is about **123,400
  uncached searches a month**, about 4,100 a day. Workers AI embeds a query for ~0.03 neurons,
  so its 10k/day limit allows ~350k queries a day and is not binding. A forced re-ingest
  (~2–3k neurons) is the only large daily AI cost, so at most one runs per UTC day.
- **The 10 ms CPU concern is retired.** The production p99 of 18.5 ms (PROGRESS, Phase 1
  baseline) is far under 30 s.
- **The ingest `--write-budget` default stays at 40k** as a runaway guard, now well inside the
  allowance. A cold load (~137k writes) is affordable; pass a larger budget explicitly.

## 2. One relevance judge

### Context
ADR 0003 and the Phase 2 plan named two judges from different model families: judge A
`claude-opus-5-5` and judge B `gemini-3.1-pro-low`. Disagreements were to go to a
`claude-sonnet-5-5` adjudicator, and quadratic κ and Krippendorff α were to be reported
between the judges. Judge B could not run: the proxy answered "400 unknown provider for model
gemini-3.1-pro-low" twice. Judge A finished all 1,671 dev items of round r1, with exact
agreement on 80 of 80 planted repeats.

### Decision (Jacob)
No second judge. The final grade of a pair is the mechanical rule grade where one applies,
else judge A's grade. There is no adjudicator.

### Consequences
- **Inter-judge agreement (κ, α) is not reported**, and the plan's κ ≥ 0.6 target lapses.
- **The quality checks on the grades** are:
  - planted-repeat self-consistency (a lower bound, because a repeat sits in the same packet
    as its original);
  - the drift re-judge sample in later rounds;
  - **Jacob's human calibration** (`eval:judge calibrate`, ~150 stratified pairs). This is
    now the only independent check on judge A, so it stays a decision-gate item and should
    run before Phase 3 gates rely on the qrels.
- **Same-family risk.** Plan objection 9 ("same-family judges"), answered by Opus plus Gemini,
  is now open by choice. Judge A and any Claude-based ranking change could share blind spots.
  The human calibration subset is the mitigation, and its Δ-sign check (final vs human) is
  reported with every gate verdict that uses those qrels.
- **Holdout judging** is single-judge too, through the custodian as before. The Gemini-only
  `delegate_task` isolation path in ADR 0003 is moot.
- The round-r1 B packets are discarded unjudged. `drop-judge` records the slot, judge and
  reason in the round state, and the merged qrels record `mode: single`.

### Amendment (Jacob, 2026-11-04): model cross-check instead of human calibration
Jacob chose not to grade the calibration sheet himself. Instead:
- a different-family model (`gemini-3.8-flash-high`) graded the same 150 stratified pairs blind to A;
- fresh Claude Sonnet verifiers checked every Gemini grade, also blind to A.

Verified grades vs A: raw agreement 0.880, quadratic κ 0.915, α 0.915. A is slightly lenient
(12 higher, 6 lower, never 0 against 2), and the Δ sign matches on the subset. Details are in
`docs/evidence/phase2/calibration/`.

This lowers the same-family risk above but does not remove it. The verifiers are Claude, and no
human has graded any pair.

### Dissent
None recorded. The planning critics' preference for two families (Phase 2 plan, objection 9)
is the overridden position.
