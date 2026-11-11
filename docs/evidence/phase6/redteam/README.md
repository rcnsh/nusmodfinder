# Phase 6 red team kit (6E)

Phase 5's kit (`../../phase5/redteam/`) extended per `docs/plans/phase6.md` §3 6E "Red team".

Committed and pushed before any persona ran:
- `personas.json`: each persona's context and brief facts (p3, the advisor, knows none; its
  study level and invitations come from the link it is given, `rules.mjs` `advisorBrief`).
- `rules.mjs`: the brief-to-answer rules, Phase 5's table with the plan's rows added: Business
  and Law "yes if invited, or already given", `audition` "ask NUS: apply separately", an
  NG-listed 404 "ask NUS"; R3's `year` note as Jacob ruled after Phase 5 (ask NUS); and a brief
  fact the persona doesn't know is "yes if".
- `expected.mjs` → `expected.json`: every persona's expected answer for every course offered in
  2026/27 (6,778, production-normalised as `p5-live --corpus production` does) and every
  NG-listed code with no classes (40, `data/ng-unscheduled.json`), at each of its semesters,
  from the SC1 oracle (`test/sc1/oracle.node.mjs` `explainShown`) and the brief alone.
- `advisor.mjs`: how the advisor's answers are worked out from the link it gets (order on NUS's
  form, department, level, units, hours, description, open or not, year), over production's rows
  and the independent reference (`test/web/shortlist-reference.node.mjs`).
- `totals.mjs`: the live totals (each export's CSV, the view at the moment of printing, the PDF)
  against the reference.
- `diff.mjs`: persona answers against expected, mechanically; refuses to run if a p1/p2 answer
  differs from the pushed `expected.json`.
- `session.mjs` (the persona's paced browser) and `act.mjs` (its only interface); `briefs/`.

After the run: `requests-<id>.jsonl` (every request to the live site: sent, from cache or
refused), `answers/<id>.json`, `actions/<id>.jsonl`, `reports/<id>.md` (each persona's
answers, every command it ran, its final report verbatim), `artifacts/` (the CSVs, PDFs, the
view's text at printing, the copied link and the two things the advisor got), `diff.json`,
`totals.json`. The write-up is `../redteam.md`.

## Running it
The kit the personas see is a copy of `act.mjs` only, in `~/.local/share/vnm-redteam6/kit`
(K); the session's state (the request gate and shared cache) is in
`~/.local/share/vnm-redteam6/state` (S). Per persona, one after another:

    node docs/evidence/phase6/redteam/session.mjs <id> --kit K --state S   # the lead, in the background
    # a fresh subagent given only briefs/common.md + briefs/<id>.md (p3: briefs/p3.md alone, filled in)
    node K/act.mjs __stop                                                 # (sent as {"cmd":"__stop"})
