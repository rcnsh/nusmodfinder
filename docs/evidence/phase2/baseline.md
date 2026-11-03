# Phase 2c (dev): query embeddings, baseline runs, embedding-noise bound

## 1. Dev query embeddings

- **Command:** `npm run eval:embed -- --set dev`, run once with no retry.
- **Texts:** 136, 2 requests (batches of 100 + 36), about 2,462 tokens, **≈ 4.5 neurons**
  (`neurons.tsv`). The 136 are 98 raw texts plus 38 canonical forms that differ from their raw
  text.
- **Output:** `eval/dev/embeddings.json` (136 vectors).
- **Raw vs canonical:** the vectors are bit-identical for all 38 pairs, because bge-small's
  tokenizer is uncased and splits on whitespace, so both forms give the same tokens.
- **Consequence:** PR #7's canonical query embedding changes nothing for the dense half, and these
  pairs carry no nondeterminism signal.

## 2. Baseline runs (dev v2.1, corpus `data-2026-2027-20260904`, embeddings `emb-bge-small-v0`)

| variant | command | ranker | treeHash | run file sha256 |
|---|---|---|---|---|
| `v0` | `npm run eval -- run --set dev --variant v0 --ref eval-v0` | eval-v0 = 7ac9841 | `9dc69d20…2e67` | `f115872202c582db17a415c77b72bdc38d6b6eaa98da4d72b0ac6321501b24ba` |
| `main-2ddf0aa` | `npm run eval -- run --set dev --variant main-2ddf0aa` | working tree at 2ddf0aa (clean) | `e71fbd5a…1a43` | `4a639c89f91bc3be0cd5bfaf7bf1dfbddc3cfb59645d247b9aafe24688054d89` |

- **Run files:** `eval/README.md` does not say dev run files are committed, so they are not. The
  table records their sha256s. Each file carries a `createdAt` timestamp, so a re-run reproduces
  the results but not the hash.
- **Scoring:** there are no qrels yet (2d), so there are no metrics.
- **Result counts:** 94 queries return 200 with 20 results each, on both variants.
- **Errors:** 4 queries return 400 on both variants: d-005, d-017, d-032 and d-042. These are
  home-course pastes of 340–452 characters, over the 200-character limit, the known gap the
  mapping shape exists to measure.
- **Degraded:** 0. The runner fails any degraded response, and all 98 query tests passed.
- **v0 vs main:** **0 of 98 queries differ in top-10, and 0 differ in the full top-20.** That is
  consistent with what has merged since eval-v0:
  - module split and instrumentation;
  - exact filtered lexical (B1/B3): the 200-row FTS cap only truncates a filtered lexical list's
    tail, which never reaches the fused top-20 on these queries;
  - the request-path fixes (B4–B7);
  - canonical query embedding, identical vectors as shown in item 1.

  A dev-gate comparison of the two would see Δ = 0 on every query.

## 3. Embedding nondeterminism → retrieval (eval-v0, `noise.mjs`, `noise.json`)

**Inputs.** Only vectors already on disk, plus **one** extra Workers AI request (`reembed.mjs`):
- the 20 raw texts of the 15 fidelity queries and 5 others (`ids.mjs`), one request;
- about 249 tokens, **≈ 0.46 neurons**, logged in `neurons.tsv`;
- vectors in `reembed-20.json`.

**Measured noise.**
- **Query side** (the same text, batch of 20 vs batch of 100): cosine **0.9785–0.99987**, median
  0.9988. Longer texts move more (d-073 at 123 characters: 0.9785; d-018 at 104 characters:
  0.9829).
- **Corpus side** (the 21 fixture texts that are also corpus texts, batch of 31 vs the corpus
  pass): cosine 0.9797–1.0, median 0.9957.

**Effect on top-10 (eval-v0, dev params, vs the unperturbed run).**

| condition | queries | top-10 order changed | top-10 set changed | mean overlap@10 | min overlap@10 |
|---|---|---|---|---|---|
| real re-embedding | 20 | **15** | **9** | 9.55 | 9 |
| query vectors at cos 0.9996 (5 draws) | 94 | 40–53 | 15–19 | 9.82 | 8 |
| query vectors at cos 0.9957 (5 draws) | 94 | 75–80 | 35–44 | 9.52 | 8 |
| query vectors at cos 0.9797 (5 draws) | 94 | 87–92 | 59–66 | 9.01 | 6 |
| corpus vectors at measured cosines (3 draws) | 94 | 88–93 | 58–69 | 9.04 | 6 |

- **Synthetic draws:** vectors are moved to the target cosine along real noise directions
  (re-embedding deltas for queries, fixture deltas for the corpus).
- **The bound:**
  - At the same-text-repeat level (cos ≈ 0.9996), about half of the dev queries reorder their
    top-10, and 15–19 of 94 change its membership.
  - At the measured re-embedding level, 9 of 20 change membership.
- **Why so sensitive:** RRF fuses ranks, and many fused scores tie or nearly tie. A one-place move
  in the dense list reorders the hybrid list.
- **Implications for gating:**
  - A dev comparison is only free of this noise when both runs use the same committed vectors.
    The harness enforces that: one cache, one corpus version, no live embedding.
  - A variant that re-embeds texts the baseline also embeds (new query forms, a new corpus
    version) can pick up about 1 top-10 swap on many queries from nondeterminism alone.
  - Per-query top-10 changes of 1–2 items driven by the dense half are within noise. Count a
    difference as real when it shows up in the lexical half, in rank-1 / exact-code behaviour, or
    across many queries consistently, which the paired CI tests.
