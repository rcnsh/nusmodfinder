# The register of readings

Every place a year's sources leave a reading open, with the decision and its reason. The rules and
the oracle both follow it; neither decides an open reading on its own. 2026/27's register is
`docs/evidence/phase4/interpretations.md`; each later year's is `registers/<year>.md`.

## How a year's register starts

`npm run year -- next <year>` copies last year's register under a stub marker, with every row that
names a course code flagged "(re-verify)": the code may have moved department, been renamed, or
left the list. The rest carry over as rulings.

## Rulings

- **Who rules.** The maintainer rules on each open reading (Jacob's rows are marked **Jacob**; the
  lead's rows **the lead**). The transcribers' `doubts` and the id map's new and ambiguous rules
  are where open readings come from.
- **When.** Every ruling is logged before the oracle's author starts, so the oracle is written
  from the register, not from the rules.
- **The oracle's own readings** (`D1`–`D24` for 2026/27) are rows too, marked as the lead's
  rulings: where the oracle's author had to decide something the register didn't say, it becomes
  a row for the next year.
- **A row** is `| # | question | decision | reason |`, the question quoting the source, the reason
  naming who ruled and why.

Remove the stub marker once every flagged row is re-verified; `year check` fails while it remains.
