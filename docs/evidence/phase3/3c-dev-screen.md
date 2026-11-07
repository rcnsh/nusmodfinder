# 3C dev screen: 3C-2 selected (2026-11-07)

3C turns each pre-correction token with df 0 into an FTS prefix term (≥ 4 letters). Only if that
also matches nothing does it correct the token by OSA distance (≥ 5 letters) and keep the original
in the OR (PR #47; plan §2 3C, prereg §4). There are two pre-registered variants:
- **3C-1** (`3c1`, `21b52a2`) corrects the lexical half only.
- **3C-2** (`3c2`, `a9f634b`) also embeds the corrected text, in a second single-text call in
  parallel. The two dense lists merge by each module's better cosine.

Both pass the SC4 typo rule (T = 5), so both are eligible. Both pass the dev screen. The selection
statistic for a targeted change is the mean ΔnDCG@10 over the target's answerable queries, among
points with overall Δ ≥ 0. It picks **3C-2**. The named retry is the other eligible variant, 3C-1.

## Result (qrels-dev-v6, 85 primary answerable queries, judged@10 100% for every run)
| | nDCG@10 | Δ | BCa 95% CI | P@5 | typo (n 6) Δ | gate |
|---|---|---|---|---|---|---|
| shipped `ad8e10c` | 0.735 | | | 0.609 | | |
| 3C-1 | 0.751 | +0.016 | [0.005, 0.043] | 0.626 | +0.162 | pass (targeted: typo) |
| **3C-2** | **0.772** | **+0.036** | **[0.012, 0.085]** | 0.649 | **+0.390** | **pass** (targeted: typo) |

Both have no exact-code regression, the same errors (4 and 4), and a passing typo tripwire.

**SC4 typo items:** overlap@10 with the clean form, which must be ≥ T = 5.

| item | 3C-1 | 3C-2 |
|---|---|---|
| sc4-023 | 7 | 10 |
| sc4-024 | 6 | 10 |
| sc4-025 | 7 | 10 |
| sc4-027 | 7 | 7 |

sc4-026 waits on 3D.

## Typo diagnostic (`eval/diag/typo`, reported, never gated)
40 noise-model variants of clean dev queries. Their qrels are inherited from each source query,
so they are incomplete: judged@10 is 72.5% for shipped, 84.0% for 3C-1 and 95.3% for 3C-2.

| | nDCG@10 | Δ vs shipped |
|---|---|---|
| shipped | 0.519 | |
| 3C-1 | 0.634 | +0.115 [0.067, 0.182] |
| 3C-2 | 0.710 | +0.192 [0.113, 0.290] |

## How it was measured
- **Embeddings for 3C-2:** `npm run eval:embed -- --set dev --corrected-from-ref 3c2` (3 texts);
  the diagnostic set's queries (49) and corrected forms (35); the fixture's 1 corrected form. That
  is 1.7 neurons in total (`requests.tsv` 87). The SC4 corrected forms were already embedded.
- **Runs:** `npm run eval -- --variant <ref> --ref <ref> --baseline shipped-ad8e10c` for `3c1`
  and `3c2`. Before pooling, judged@10 was 98.2% and 97.0%.
- **Pool:** one round over shipped, 3c1 and 3c2 found 36 documents.
- **Judging:** round `p3c` used judge A, one fresh subagent per packet (6). It graded 151 of 151
  items, and the planted repeats agreed exactly (3). On the 112-pair drift sample, agreement with
  the stored grade was 0.902 (mean Δ +0.071). The round merged as `qrels-dev-v6` (36 A grades).
- **Report:** `npm run eval:report -- --run <ref> --baseline shipped-ad8e10c --target-shapes typo`.
- **No cross-family check:** it is out of scope for 3C (ADR 0004 amendment).
