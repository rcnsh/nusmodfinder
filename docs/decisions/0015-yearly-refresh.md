# 0015: The academic year switches in July, through a rehearsed procedure

Status: accepted. The procedure is [docs/year-refresh/README.md](../year-refresh/README.md).

## Context
The site serves one academic year. A new year means new NUSMods data, a new NG list and
restrictions, and possibly new rules, every year, by whoever maintains the site then. NUS
publishes its Sem 1 exchange list before NUSMods' data settles and its Sem 2 list months later.

## Decision
- **Switch in July,** once NUSMods has the new year and NUS has published the new Sem 1 NG list.
- **A semester NUS hasn't published yet shows last year's list, marked.** Until NUS publishes
  Sem 2's list, a course on last year's Sem 2 list gets the note `ng:unpublished-sem` ("On NUS's
  <last year> list; NUS hasn't published <this year>'s yet"), is counted "to confirm" and is never
  open; a course not on it is closed with `ng:unpublished-sem-unlisted`. The year's source
  manifest says which semesters are published (`scripts/lib.mjs`, `src/eligibility.js`). Showing
  nothing for Sem 2 for months would serve applicants worse than last year's list, labelled.
- **Per-year files behind one selector:** a source manifest (`data/ng-sources-<year>.json`), an
  overlay module (`scripts/ng-overlay/<year>.mjs`), an oracle
  (`test/oracle/oracle-<year>.node.mjs`) and a register of rulings
  (`docs/year-refresh/registers/<year>.md`).
- **Stable rule ids.** Rules have a fixed id scheme mapped against last year's, and the overlay
  refers to rules by role, not by literal id, so a renumbered PDF doesn't silently break it.
- **The register carries every ruling** the oracle relies on, so a fresh oracle author reads the
  same decisions the rules builder did.
- **Extraction keeps only the target year's sections** of NUS's PDFs, which prepend next year's
  Sem 1 above this year's Sem 2.
- **`npm run year -- next <year>`** scaffolds the year as stubs that fail every check until
  written; **`npm run year -- check`** checks the year's files agree (the deploy preflight runs it),
  and `--full`, on the Mac with the sources key, re-extracts and rebuilds from the archived
  documents byte for byte.
- **The switch is rehearsed in CI** (`rollover`): the pinned corpus relabelled as next year's in a
  temp copy, taken through `year next`, the builders, `year check`, a local ingest and the oracle,
  with Sem 2 unpublished as a variant.
- **Years are written in code in three places only** (`scripts/lib.mjs`, `public/year.js`, the
  header in `public/index.html`); `test/year-scan.node.test.js` fails on any other.

## Consequences
- Two years at once would double the vectors bundle and the standby's stored dimensions, so the
  site serves one.
- A mid-year revision of any NUS source follows the same steps for the changed sections.
