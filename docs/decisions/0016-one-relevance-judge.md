# 0016: One relevance judge, checked across model families

Status: accepted.

## Context
The eval's qrels need graded relevance for every pooled document (ADR 0003). Two judges from
different model families, with an adjudicator and inter-judge agreement, was the design, but the
second family's model could not be run through the available route. One judge had already graded
every dev item of the first round, with exact agreement on 80 of 80 planted repeats.

## Decision
- **One judge**, judge A (`claude-opus-5-5`). The final grade of a pair is the mechanical rule's
  grade where one applies (hard-constraint violations; the code-target rule,
  `eval/lib/code-rule.mjs`), else judge A's. There is no adjudicator, and merged qrels record
  `mode: single`. The protocol is [`eval/JUDGING.md`](../../eval/JUDGING.md).
- **Quality checks on the grades:**
  - planted-repeat self-consistency in every round (a lower bound: a repeat sits in the packet of
    its original). Measured: 80 of 80 on dev, 65 of 65 on the holdout;
  - a drift re-judge sample in later rounds;
  - **a cross-family check**: a different-family model grades a stratified sample blind to
    judge A, and fresh verifiers of another family check every grade, also blind to A. On 150
    stratified dev pairs, the verified grades agreed with A at raw 0.880, quadratic κ 0.915,
    Krippendorff α 0.915; A is slightly lenient (12 pairs higher, 6 lower, never 0 against 2),
    and the Δ sign matched. The check measures A and never replaces its grades.
- **Holdout judging** is single-judge too, through the custodian.

## Consequences
- Inter-judge agreement between equal judges is not reported.
- **Same-family risk.** Judge A and a Claude-built ranking change could share blind spots. The
  cross-family check lowers that risk but doesn't remove it, and no human has graded a pair.
- The tooling still supports two-judge rounds (`agree`, `adjudicate`, `drop-judge`), unused by the
  current protocol.

## In the code
- **Two-judge rounds stay sound** (`eval/judge.mjs`). Once adjudication starts, `collect` and
  `drop-judge` refuse: the adjudication was built from the grades as they stood, and a re-graded
  pair could leave a disagreement unadjudicated. Adjudication pass 1 closes once the pass-2
  packets, which show both judges' grades, exist. `buildRound` in `eval/lib/judging.mjs` gives
  judge A the same batches for a seed whatever the judge count, so `dropJudge` turns a two-judge
  round into a single-judge one without touching A's items or grades.
- **`merge --no-base` refuses to overwrite** existing qrels without `--force`, so starting over
  never silently drops earlier rounds' judgments or reuses their version.
- **Nothing a judge sees or writes can leak holdout words.** `renderJudgePacket` puts no query
  id, shape, persona, system, rank or score in a packet. `validateSectionOutput` names item ids
  and value types only and reports bad JSON as "not valid JSON", never the parser's message
  (which quotes the text); `safeKey` prints a key only when it has the item-id form.
- **`qrelsUnder` refuses a judge slot the qrels hold no grades from** (B in single-judge qrels)
  instead of falling back to the final grade, so a calibration report never shows A's grades
  under B's name as agreement.
- **`test/eval/agreement.node.test.js` pins each statistic** of `eval/lib/agreement.mjs`
  (quadratic and binary κ, Cohen κ, Krippendorff ordinal α) to an exact fraction worked by hand
  from the EX1 ratings and checked by an independent fractions-only script. Regenerating an
  expected value from the code's output makes the test circular.
