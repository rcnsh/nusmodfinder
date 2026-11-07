# 3B dev screen: 3B passes; stopwords-v2 is dropped (2026-11-07)

3B adds code joins, code resolution, partial-code and GE pillar masks, the third RRF list and
`noMatch` (PR #44; plan §2 3B, prereg §3). Three rankers were screened against the shipped ranker
`45bd716`:
- **`3b`** (`a3f9647`): 3B with today's stopwords.
- **`sw2`** (`797d94c`): main with only stopwords-v2.
- **`3b-sw2`** (`4dca8a6`): both.

`sw2` fails the dev screen alone, so stopwords-v2 does not join L3. `3b` passes the targeted rule
and goes to L3. The named retry is the pre-registered fallback, 3B without stopwords-v2, which is
`3b` itself. So a failed L3 goes to Jacob (plan §3, Q4).

## Result (qrels-dev-v5, 85 primary answerable queries, judged@10 100% for every run)
| | nDCG@10 | Δ | BCa 95% CI | P@5 | MRR@10 | gate |
|---|---|---|---|---|---|---|
| shipped `45bd716` | 0.695 | | | 0.598 | 0.857 | |
| **3b** | **0.744** | **+0.049** | **[0.017, 0.108]** | 0.609 | 0.895 | **pass** (targeted) |
| 3b-sw2 | 0.744 | +0.049 | [0.017, 0.108] | 0.612 | 0.886 | not eligible |
| sw2 | 0.695 | +0.000 | [−0.000, 0.000] | 0.600 | 0.856 | fail (general) |

3B's declared targets, with no A-5 drop because each has answerable queries:

| target | n | nDCG@10 shipped → 3b | Δ | tripwire |
|---|---|---|---|---|
| code-space | 3 | 0.462 → 1.000 | +0.538 | pass |
| code-partial | 3 | 0.631 → 0.909 | +0.278 | pass |
| ge | 6 | 0.536 → 0.838 | +0.301 | pass |
| abbreviation | 5 | 0.663 → 0.663 | 0.000 | pass under the 2026-11-07 amendment |

No exact-code query lost its rank-1 hit, and errors are unchanged (4 and 4).

## The abbreviation tripwire (decision record)
Under the gate as written, 3B failed only on the `abbreviation` tripwire. All 5 queries moved by
exactly 0, which gives a degenerate interval, and the gate counted that as a failure. The 0 is by
design: the collision list keeps `AI`, `js`, `pr` and `dsa` topical. The fallback is the same
ranker, so the question went to Jacob (plan §3, Q4). He chose to amend the rule for every change:
a target whose every query moved by exactly 0 passes its tripwire (ADR 0003 amendment 2026-11-07,
PR #45). The alternatives were screening 3B under the general rule or dropping the target after
the fact.

## How it was measured
- **Runs:** `npm run eval -- --variant <ref> --ref <ref> --baseline shipped-45bd716` for `sw2`,
  `3b` and `3b-sw2`. The shipped run is `--ref 45bd7169…`. Before pooling, judged@10 was 97.3% for
  `3b`.
- **Pool:** one round over all four runs (`eval:pool --runs shipped-45bd716,sw2,3b,3b-sw2
  --unjudged`) found 28 documents.
- **Judging:** round `p3b` used judge A (`claude-opus-5-5`), one fresh subagent per packet (6). It
  graded 141 of 141 items. Planted repeats agreed exactly (3). On the 111-pair drift sample, A
  agreed with the stored grade 0.955 of the time (mean Δ −0.009). The round merged as
  `qrels-dev-v5` (27 A grades and 1 rule grade).
- **Report:** `npm run eval:report -- --run 3b --baseline shipped-45bd716 --target-shapes
  code-space,code-partial,ge,abbreviation`.
- **SC4:** `test/full/sc4.test.js` on `3b` passes 52 of 52 tests. Every item 3B owns passes; the 40
  items owned by 3C, 3D, 3G and 3H are listed as waiting.
- **No cross-family check:** ADR 0004's amendment scopes it to 3A-2, 3D, 3E and the SC5 pool.
- **No remote call.**

## L3 holdout look (custodian, 2026-11-07): pass, look 2 of 12
- **Store:** `npm run eval -- --holdout --variant 3b --ref 3b --store-only` stored a run on 81
  queries, with no look. The baseline is `run-shipped-45bd716`, already stored and fully judged.
- **Pool:** `eval:pool --holdout --custodian --unjudged --runs shipped-45bd716,3b` found 8
  documents.
- **Judge:** round `h3` used judge A, with one fresh subagent for the single packet. It graded 8
  of 8 items, and the planted repeat agreed exactly. The round merged as `qrels-holdout-v4` (7 A
  grades and 1 rule grade), and its plaintext directory is deleted.
- **Verdict:** `eval:report --holdout --run 3b --baseline shipped-45bd716 --target-shapes
  code-space,code-partial,ge,abbreviation` gives **pass**. The holdout rule is point estimates
  ≥ 0, every pair judged and no exact-code regression.

| | Δ | BCa 95% CI |
|---|---|---|
| nDCG@10 | +0.013 | [0.003, 0.050] |
| P@5 | +0.003 | [0.000, 0.017] |

Both lower bounds are at or above 0. The look made no remote request.
