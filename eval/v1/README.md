# eval v1 (historical)

Historical: the pre-Phase-2 eval (regex relevance over titles, recall@10, run against a live
URL). Kept so `EVAL.md` and finding S1 stay checkable. Not runnable from here (imports point at
`scripts/`) and not to be run: it calls the live site. The Phase 2 harness is in `eval/`.

## History note: finding S1 (the v1 eval was circular and mis-scoped)

Until Phase 7 a `[S1 known-bug]` test held these facts; S1 is now fixed (`docs/FINDINGS.md`), and
CI's eval gate locks the Phase 2 dev set's lists instead (`eval/ranking-lock.json`). As committed:
- 11 of the 12 held-out rules in `judge-holdout.mjs` are a regex over `m.title`; `h1` is a
  department check.
- `eval.mjs` defaults `K` to 10 (`const K = Number(arg('k', fixture.k ?? 10));`) and computes
  recall as `h / q.relevant.length`, which ignores order. Production returned 20 of a candidate
  depth of up to 50.
- `EVAL.md`'s held-out MRR row reads 0.833 / 0.674 / 0.903 / 0.820 (hybrid below lexical), and it
  says `ORDER BY rank` was not re-run against these fixtures.
