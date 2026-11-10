# Phase 5 gates

## 5A: exam dates are ranking-neutral (pin move, no look)

Plan §3 5A: the dev set and the eval's fixture set, run at the 5A commit, must be byte-identical
to the shipped-ranker pin `9d91605`'s. Then `SHIPPED_BASELINE` moves with a "ranking-neutral"
line, and the custodian counts the holdout lists that differ (expected 0).

5A changes ranker files (`src/`, `migrations/`, `scripts/lib.mjs`, `data/`), so `ranker.treeHash`
differs (`8e94e8274306` at `9d91605`, `5c790ef78d27` at `f798542`; both clean). The ranking does
not change.

Local eval runs, `--ref 9d91605` against `--ref f798542`, the HEAD runner, sha256 of each run's
`results` (first 16):

| run | queries | results sha256 (first 16) | identical |
|---|---|---|---|
| dev, the queries' filters | 98 | `8229314651577034` both | yes |
| dev, `--strip ng` | 98 | `ae4f077e0ad06ef2` both | yes |
| dev, `--unfiltered` | 98 | `8fde32e1783d6d6b` both | yes |
| fixture, `--strip ng` | 11 | `ce4f61e83ce5a52f` both | yes |

The `--strip ng`, `--unfiltered` and fixture hashes also equal Phase 4's (`docs/evidence/phase4/gates.md`
§3), so the lists have not moved since `238e721`.

Holdout, custodian only:
- `npm run eval -- --holdout --variant shipped-f798542 --ref f798542… --store-only`
  (`eval/holdout/run-shipped-f798542.json.enc`, 81 queries): no verdict, no ledger row;
- `npm run eval:count -- --custodian --holdout --lists-differing --run shipped-f798542 --baseline shipped-9d91605`
  printed `0` (`eval/count-log.md`). The new count kind prints one integer and is not a look
  (ADR 0003, "counts are not looks").

Holdout looks stay at 7 of 12. `SHIPPED_BASELINE` is `f798542`, with its ADR 0003 pin line.

## 5C-api: the `/search` additions are ranking-neutral (no pin move)

Plan §3 5C-api: every dev and fixture result list must be byte-identical in ranking to the
shipped-ranker pin `f798542`'s; the only change is the new fields (`hiddenPins`, `notOffered`,
`exchangeBySem`, `examDates`). Run files read only codes and doc metadata, so the lists must hash
the same.

5C-api changes ranker files (`src/`), so `ranker.treeHash` differs (`5c790ef78d27` at `f798542`,
`81ec88e18d9f` at `35cc497`; both clean). The ranking does not change.

Local eval runs, `--ref f798542` against `--ref 35cc497`, sha256 of each run's `results`
(first 16). The runner's `eval/` is the same at `a578ac7` and `35cc497` (5C-api touches none of it):

| run | queries | results sha256 (first 16) | identical |
|---|---|---|---|
| dev, the queries' filters | 98 | `8229314651577034` both | yes |
| dev, `--strip ng` | 98 | `ae4f077e0ad06ef2` both | yes |
| dev, `--unfiltered` | 98 | `8fde32e1783d6d6b` both | yes |
| fixture, `--strip ng` | 11 | `ce4f61e83ce5a52f` both | yes |

The four hashes also equal 5A's above, so the lists have not moved since `9d91605`.

No holdout run, no count and no look: the code ships with the page (5G), whose deploy moves
`SHIPPED_BASELINE` as ranking-neutral. Holdout looks stay at 7 of 12.

## 5F: the dev reference-parse list, confirmed by hand (2026-11-11)

`npm run eval:phrases -- list` (PR #73) parses 10 of 98 dev queries. The lead read every dev
query with a constraint-like word (exam, workload, hours, S/U, prerequisites, coursework,
assessment, easy) and confirms the list:
- **no exam** (`exam=0`): d-024 "no final exam, project based CS course", d-037 "… without final
  exam, project based", d-049 "no final exam, essay only assessment history", d-050 "politics
  courses with no exam", d-081 "… no final exam, 100% coursework or project";
- **no prerequisites** (`prereq=none`, (ii)): d-011, d-023, d-048, d-080, and d-099 "intro
  accunting no prerqeuisites" through 3C's correction.

No false positive and no miss: d-017's "Prereqs: data structures, …" describes a home course
and is rightly not a constraint; "easy" (d-022, d-047, d-078) is not one of 3H's constraints.
ADR 0003's 5F amendment is adopted on this basis. No count and no look have been taken under it;
holdout looks stay at 7 of 12.

## 5D: `prereqCohortOnly` on `/module/:code` is ranking-neutral (no pin move)

5D adds one boolean to `/module/:code` (`src/modules.js`); `/search` is untouched. That is a
ranker file, so `ranker.treeHash` differs (`5c790ef78d27` at `f798542`, `1cc8e0b466ac` at
`2fdbb6c`; both clean). The ranking does not change.

Local eval runs, `--ref f798542` against `--ref 2fdbb6c` (5D's last code commit, rebased on 5F),
the HEAD runner, sha256 of each run's `results` (first 16):

| run | queries | results sha256 (first 16) | identical |
|---|---|---|---|
| dev, the queries' filters | 98 | `8229314651577034` both | yes |
| dev, `--strip ng` | 98 | `ae4f077e0ad06ef2` both | yes |
| dev, `--unfiltered` | 98 | `8fde32e1783d6d6b` both | yes |
| fixture, `--strip ng` | 11 | `ce4f61e83ce5a52f` both | yes |

The four hashes equal 5A's and 5C-api's above. The same queries answer 400 on both sides
(d-005, d-017, d-032, d-042; fx-10). No holdout run, no count and no look; holdout looks stay at
7 of 12.

## 5F: the dev screen (2026-11-11): FAIL, so phrases stay off and no look is spent

Candidate `11b1699` (local branch `phase5/phrases-on`): `6270dd7` with `PARSE_PHRASES = true` in
`src/intents.js`, and `test/full/sc4.test.js` counting 3H as merged while the flag is on. Run
with `npm run eval:phrases -- screen --candidate 11b1699… --set dev --prefix 5f-screen1`
against the pin `f798542`; dev only, local, no count and no look.

| check | result |
|---|---|
| reference parse | 10 of 98 (the hand-checked list); candidate's vocabulary = the reference's |
| primary, filtered qrels (85) | nDCG@10 0.772 → 0.754, **Δ −0.018** [−0.071, 0.005]; P@5 Δ +0.000; MRR@10 Δ −0.016 |
| constraint block (5) | nDCG@10 0.372 → 0.606, Δ +0.234 |
| compliance | 100% (every parsed query's shown results meet the constraint) |
| identity | 0 of 88 unparsed queries' top 10 differ |
| new errors | 0 |
| SC4 (`test/full/sc4.test.js`, flag on, full corpus) | 76 of 76 pass, the 14 parsed-intent items included |
| **screen** | **FAIL** (primary ΔnDCG@10 < 0) |

B2-4 diagnostic (the candidate against the pin with the parsed constraints as explicit params,
not gated): primary ΔnDCG@10 −0.010, constraint block −0.009.

**Why it fails.** The whole primary loss is two prerequisite queries, d-011 "intro accounting no
prerequisites" and d-099 (its misspelt twin), each ΔnDCG@10 −1.000. The pin's list starts with
ACC1701XC (judged 2); the candidate, searching the stripped text "intro accounting", starts
with ACC1701XB, a variant in the same group that no judge graded, so it scores 0 and the group's
other judged members never earn gain. XB is the same course text as XC, but it is not on
NUSMods' Sem 1 timetable, and both queries ask for Sem 1, so the candidate's pick is genuinely a
little worse for the student, not only an unjudged gap.

Per the plan (§3 5F), L8 is not taken: `PARSE_PHRASES` stays off, SC4's 14 parsed-intent items
stay unmet in Phase 5, and holdout looks stay at 7 of 12.
