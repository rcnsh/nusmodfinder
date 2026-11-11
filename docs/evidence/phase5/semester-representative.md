# The semester representative: gate evidence (no look)

The change: with a semester named, 3F's collapse shows each duplicate group as its
highest-ranked member that passes the filters and is on NUSMods' timetable that semester
(ADR 0006, amendment 2026-11-11). The gate is ADR 0003's draft amendment 2026-11-11,
"representative-only changes are gated without a look". The lead adopts the amendment, runs
the holdout count and moves the pin.

- Pin: `SHIPPED_BASELINE` `fdec96f`.
- Candidate: the ranker commit `3ab3335`, ranker `treeHash` `c06e08f56728…`. The runs were made
  at `5591a2f`, the same commit before a rebase onto `main`, with the same `treeHash`. It adds the
  review's fix (a typed code past the pin cap is never swapped) to the first candidate
  `567ebdc`. Its results equal `567ebdc`'s byte for byte in every mode below. Later commits on
  the branch touch only tests, eval tooling and docs, so the ranker files are unchanged.
- All runs are local (`npm run eval -- --ref <sha>`), clean ranker and runner. The fixture
  runs use `--set fixture --set-dir <a copy of eval/fixtures>`.

## 1. Group identity (`npm run eval:representatives`)

| run pair | lists | lists changed | codes changed | problems | pin results sha256 (first 16) | candidate results sha256 (first 16) |
|---|---|---|---|---|---|---|
| dev, the queries' filters | 98 | 4 | 5 | 0 | `8229314651577034` | `b9901f1809d8093f` |
| dev, `--strip ng` | 98 | 0 | 0 | 0 | `ae4f077e0ad06ef2` | `ae4f077e0ad06ef2` |
| dev, `--unfiltered` | 98 | 0 | 0 | 0 | `8fde32e1783d6d6b` | `8fde32e1783d6d6b` |
| fixture, `--strip ng` | 11 | 0 | 0 | 0 | `ce4f61e83ce5a52f` | `ce4f61e83ce5a52f` |

The pin's four hashes are the ones 5G recorded (`gates.md`, "5G"), so the baseline runs
reproduce. Outside exchange mode `sem` filters on the timetable, so nothing can swap there, and
the three unchanged modes are byte-identical.

Every change is in exchange mode, Sem 1, and moves the group to a member taught in Sem 1:

| query | filters | rank | pin | candidate |
|---|---|---|---|---|
| d-006 "backup option if I don't get the investment course, …" | `ng`, `sem=1` | 8 | FIN3701B (Sem 2) | FIN3701A (Sems 1 and 2) |
| d-010 "advanced financial modelling excel" | `ng`, `sem=1` | 10 | FIN3701B | FIN3701A |
| d-010 | | 15 | ACC1701XB (Sem 2) | ACC1701XC (Sem 1) |
| d-011 "intro accounting no prerequisites" | `ng`, `sem=1` | 10 | FIN3701B | FIN3701A |
| d-099 "intro accunting no prerqeuisites" | `ng`, `sem=1` | 11 | FIN3701B | FIN3701A |

## 2. Dev `no-loss`

`npm run eval:report -- --set dev --run rep2-cand --baseline rep-pin --change-kind no-loss`
(`qrels-dev-v10`, 85 primary answerable queries):

| metric | pin | candidate | Δ | BCa 95% CI |
|---|---|---|---|---|
| nDCG@10 | 0.768 | 0.770 | +0.002 | [0.000, 0.007] |
| P@5 | 0.661 | 0.661 | +0.000 | [0.000, 0.000] |
| MRR@10 | 0.923 | 0.923 | +0.000 | [0.000, 0.000] |
| violations@10 (total) | 7 | 4 | | |
| judged@10 | 98.9% | 99.2% | | |
| non-200 responses | 4 | 4 | | |

By shape, `alternatives` gains +0.020 and `level` +0.009. Every other shape is unchanged.

Gate output: **FAIL**, on `judged@10 = 100%` alone. The `no-loss` rule (ΔnDCG@10 ≥ 0) passes
at +0.0019, and so do no new errors, ≥ 10 queries and no exact-code regression.

**Why judged@10 fails.** The pin's own run is 98.9% judged on `qrels-dev-v10`: 10 top-10
documents have no grade. The candidate has 7, a strict subset of the pin's: d-003 IE4220, d-016
MA4211, d-021 HSI2014, d-050 GL2102, d-054 CM3296, d-066 CS4212, d-086 EE4435. The change adds
no unjudged document. It replaces three unjudged FIN3701B hits with the judged FIN3701A. The
earlier dev screens reached 100% with a pooling and judging round
(`eval:pool --runs rep-pin,rep2-cand --unjudged`, then `eval:judge`, giving `qrels-dev-v11`).
That round is the lead's to run, and it was not run here.

## 3. Suites

- SC1 (`FULL_CORPUS=1 npm run test:sc1`): green, 7 of 7. `test/sc1/identity.test.js` now
  rebuilds each page with the semester representative.
- Full corpus (`FULL_CORPUS=1 npm run test:full`): green, 99 of 99.
- The rule's tests: `test/search-semester-rep.test.js` covers the fixture's own case (NGN2001F,
  Sem 2 only, above NGN2001G, Sem 1, for "nus college" with `ng=1&sem=1`), an ACC1701X-shaped
  group, pins and typed codes past the pin cap, `COLLAPSE_GROUPS=off`, and every path (hybrid,
  lexical, vector, the standby, and the mask in dense and code order). `test/groups.node.test.js` covers the pure rule.

## 4. Holdout (the custodian)

Store the candidate with `--store-only` at `3ab3335` (or the merge commit, whose ranker files
are the same), then run:

```
npm run eval:count -- --custodian --holdout --lists-differing --by-group --run <candidate> --baseline shipped-fdec96f
```

Run by the lead, 2026-11-11: `run-cand-3f96d79` stored with `--store-only` at `3f96d79` (the
PR head; its ranker files are `3ab3335`'s), 81 queries, no verdict and no ledger row.
- `eval:count --lists-differing --by-group --run cand-3f96d79 --baseline shipped-fdec96f`:
  **0** (the gate).
- `eval:count --lists-differing --run cand-3f96d79 --baseline shipped-fdec96f`: 3, the lists
  whose representative changed (reported, not gated).

Holdout looks stay at 7 of 12.

## 5. The judging round and the gate, rerun (lead, 2026-11-11)

Round `p5a` (dev, single judge A, `claude-opus-5-5`): the 15 documents no qrels graded in the
top 10 of four dev runs (`p5v-pin` at `fdec96f`, `p5v-cand` at `3f96d79`, `p5v-phr` at
`ebacaa3`, and the first 5F candidate `5f-screen1-cand` at `11b1699`). 12 were graded 0 by
rule (hard constraints; ACC1701XB on d-011 and d-099, and FIN3701B on d-010, among them, since
neither is on Sem 1's timetable), and judge A graded 3 (all 0). Planted repeat: exact agreement
1.000; drift sample of 118 stored pairs: agreement 0.949, mean Δ +0.034. Merged as
`qrels-dev-v11`.

`no-loss` on dev with `qrels-dev-v11`, `p5v-cand` against `p5v-pin`: **PASS**. nDCG@10 0.768 →
0.770 (Δ +0.002 [0.000, 0.007]); P@5 and MRR@10 unchanged; judged@10 100.0% both; no new
errors; no exact-code regression.

Every check of the amendment holds (§1 group identity, §2 `no-loss`, §3 suites, §4 count 0),
and ADR 0003's amendment is adopted.

## 6. Shipped (2026-11-11)

Merged as `c645e85` (PR #80) and deployed as version `91c09381`. The custodian stored
`run-shipped-c645e85` with `--store-only` (81 queries, no ledger row): its `--by-group` count
against `shipped-fdec96f` is **0**, and its plain count against the gated candidate
`cand-3f96d79` is 0 (the merge shipped the ranker the gate judged). `SHIPPED_BASELINE` is
`c645e85`; holdout looks stay at 7 of 12.
