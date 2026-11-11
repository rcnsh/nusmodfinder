# Phase 5 red team kit (5G)

Committed before any persona ran: `personas.json` (each persona's context and brief facts),
`rules.mjs` (the brief-to-answer rules, plan §3 5G's table), `expected.mjs` → `expected.json`
(every persona's expected answer for every offered course, from the oracle and the brief
alone), and the briefs. Then: `session.mjs` (the persona's paced browser), `act.mjs` (its only
interface), `diff.mjs` (persona answers vs expected). The write-up is `../redteam.md`.

- `briefs/common.md` + `briefs/<id>.md`: what each persona read, and nothing else.
- `requests-<id>.jsonl`: every request to the live site (sent, from cache, or refused).
- `answers/<id>.json`, `actions/<id>.jsonl`, `reports/<id>.md`: each persona's answers, every
  command it ran, and its final report.
