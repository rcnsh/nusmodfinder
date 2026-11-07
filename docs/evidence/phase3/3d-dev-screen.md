# 3D dev screen: the bundle (rules + α 0.35 + β 0.1) goes to L5 (2026-11-07)

3D reads level phrases as hard windows and adds two ranking priors (plan §2 3D, prereg §5). They
are the beginner prior α, and β, a default penalty on level 5+ when no level intent is parsed. Round 1
screened seven grid points against the shipped ranker `89cb10e`:
- **α points, rules on:** `3d-a0`, `3d-a10`, `3d-a20` and `3d-a35`, screened on the targeted route
  with target `level`.
- **β points, rules off:** `3d-b10`, `3d-b20` and `3d-b35`, the shipped ranker plus β, screened
  under the general CI rule.

The selections:
- **α\* = 0.35:** the largest level-target gain among passing points.
- **β\* = 0.1:** it ties 0.2 to 3 decimals, and the tie goes to the smaller change.

Because β\* passed dev alone, the bundle went through its own dev-only round. It passes, and it
goes to L5. The named retry is the pre-registered fallback, `a0` (the rules with α = 0 and no β),
which fails the dev screen (below).

## Round 1 (qrels-dev-v7, 85 primary answerable queries, judged@10 100% for every run)
| | nDCG@10 | Δ | BCa 95% CI | target `level` (7) Δ | gate |
|---|---|---|---|---|---|
| shipped `89cb10e` | 0.771 | | | | |
| 3d-a0 (rules, α 0) | 0.773 | +0.003 | [−0.001, 0.014] | −0.002 | **fail** (targeted; tripwire) |
| 3d-a10 | 0.775 | +0.005 | [−0.000, 0.016] | +0.006 | pass (targeted) |
| 3d-a20 | 0.776 | +0.006 | [0.000, 0.017] | +0.014 | pass (targeted) |
| **3d-a35** | 0.775 | +0.004 | [−0.007, 0.015] | **+0.036** | **pass** (targeted) |
| 3d-b10 | 0.771 | +0.0002 | [0.0000, 0.0006] | | pass (general) |
| 3d-b20 | 0.771 | +0.0002 | [0.0000, 0.0006] | | pass (general) |
| 3d-b35 | 0.771 | −0.0001 | [−0.0013, 0.0002] | | fail (general) |

- **β is close to inert.** It changes the top 10 of 6 dev queries. β 0.1 and 0.2 pass on the
  letter of the CI rule, with a lower bound just above 0.
- **The rules alone move 10 queries' top 10s and cost the level target a little** (0.595 →
  0.593), enough for the tripwire's one-sided upper bound to fall below 0. α recovers it and more.

## Round 2: the bundle (dev-only, one run)
`3d-a35b10`, rules + α 0.35 + β 0.1, pooled 0 unjudged documents, so the round had nothing to judge.

| | nDCG@10 | Δ | BCa 95% CI | P@5 Δ | MRR@10 Δ | target `level` | gate |
|---|---|---|---|---|---|---|---|
| **3d-a35b10** | 0.775 | +0.005 | [−0.007, 0.015] | +0.000 | +0.000 | 0.595 → 0.631 (+0.036) | **pass** (targeted) |

- **Checks:** no exact-code query lost its rank-1 hit, and errors are unchanged (4 and 4).
- **SC4:** on `3d-a35b10`, `test/full/sc4.test.js` passes 73 of 73. Every item 3D owns passes;
  sc4-031 also needs 3H's prerequisite intent, so it is listed as waiting.

## The named retry fails dev
Prereg §8 names the 3D retry as the rules with α = 0 and no β, and requires it to pass SC4 on
dev, which it does. It fails the dev screen, though, and every candidate must pass the dev screen
before its look (plan §3). If L5 fails, no eligible retry exists, and the change goes to Jacob
(plan §3, Q4).

## No cross-family check (deviation, Jacob's sign-off)
ADR 0004's amendment requires the check for 3D. It was not run:
- **Pairs:** the export gave 102 non-rule pairs in the symmetric difference of `3d-a35b10`'s and
  shipped's dev top 10s, with 2 rule pairs excluded.
- **Attempts:** `gemini-3.8-flash-high` hit its rate limit on three attempts at 21:19–21:25 SGT
  (two chunks of 51 in parallel, then one alone), before grading any pair.
- **Decision:** Jacob chose to skip the check rather than use `gemini-3.1-pro-low` or wait. The
  deviation is recorded in ADR 0004. L5 is judged by judge A alone, as L3 and L4 were.

## Pre-registration notes added during 3D (before any dev score was read)
These are in `phase3-prereg.md` §5:
- **β's form:** α's form with p = 1. "Alone" means the shipped ranker plus β, with the rules off.
- **A query of only level phrases keeps them in the lexical text**, so `mode=lexical` and the
  keyword-only fallback still answer.
- **A joined code that routes nothing is not masked**, and the negation window counts tokens on
  the unmasked text.

The last two came from the fresh-context review of the PR. Its three findings each had a failing
input, and all are fixed with tests.

## How it was measured
- **Runs:** `npm run eval -- --variant 3d-<k> --ref 3d-<k> --baseline shipped-89cb10e` for each
  grid point. Each tag differs from the branch only in `LEVEL_VARIANT`. The shipped dev run is
  `--variant shipped-89cb10e --ref 89cb10e…`.
- **Pool:** one round over shipped and the seven points (`eval:pool --runs … --unjudged`) found
  21 documents.
- **Judging:**
  - Round `p3d` used judge A (`claude-opus-5-5`), one fresh subagent per packet (6), and graded
    138 of 138 items.
  - Planted repeats agreed exactly (4).
  - On the 114-pair drift sample, A agreed with the stored grade 0.921 of the time (mean Δ
    +0.061).
  - The round merged as `qrels-dev-v7` (20 A grades and 1 rule grade). The typo diagnostic set
    was rebuilt from it.
- **Reports:** `npm run eval:report -- --run 3d-<k> --baseline shipped-89cb10e`, with
  `--target-shapes level` for the α points and the bundle.
- **No remote call.**

## L5 holdout look (custodian, 2026-11-07): fail, look 4 of 12
- **Store:** `npm run eval -- --holdout --variant 3d --ref 3d --store-only` stored the bundle's
  run (`55f41d2`) on 81 queries, with no look. The baseline is `run-shipped-89cb10e`, already
  stored and fully judged.
- **Pool:** `eval:pool --holdout --custodian --unjudged --runs shipped-89cb10e,3d` found 19
  documents.
- **Judge:** round `h5` used judge A, with one fresh subagent for the single packet. It graded 20
  of 20 items, and the planted repeat agreed exactly. The round merged as `qrels-holdout-v6` (19 A
  grades), and its plaintext directory is deleted.
- **Verdict:** `eval:report --holdout --run 3d --baseline shipped-89cb10e --target-shapes level`
  gives **fail**. The holdout rule needs both point estimates ≥ 0.

| | Δ | BCa 95% CI |
|---|---|---|
| nDCG@10 | −0.005 | [−0.020, 0.004] |
| P@5 | −0.020 | [−0.045, 0.003] |

Both intervals include 0, and both point estimates are below it. The named retry `a0` fails the
dev screen, so the decision goes to Jacob (plan §3, Q4). The look made no remote request.
