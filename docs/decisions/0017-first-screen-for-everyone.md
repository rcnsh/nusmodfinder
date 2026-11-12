# 0017: The page serves NUS and exchange students alike

Status: accepted. Refines ADR 0008's first screen; the page is described in [docs/page.md](../page.md).

## Decision
- **The first screen is the search, with one question first: "Who are you searching as?"** The
  two answers are "NUS student" (every NUS course) and "Exchange student" (only the courses open
  to them). NUS's own word for the second group is "non-graduating", and "non-exchange" names the
  first by what it isn't, so the page names each group as students say it.
- **An NUS student searches straight away**: what to study, then Search, with no exchange mode.
- **An exchange student answers the exchange set-up** (the semester at NUS, the year of study)
  before the first search, as before; those questions and the sources box show only once
  "Exchange student" is chosen, and the search runs in exchange mode.
- **The answer is remembered on this device** (`localStorage` `vnm.who`) and pre-selected next
  time; NUS student is the default. The URL holds no new state: `ng=1` already says exchange mode.
- **The answer holds on every page after the first.** The rail asks the same question ("Searching
  as"). An NUS student's cards carry no exchange line, the detail's exchange table is collapsed
  after the facts, and the shortlist is a plain plan: units, hours and the exam, preclusion and
  same-title flags, with none of the exchange application's questions, counting, form order,
  CourseReg rules or NUS's exchange notes, in the view and the exports alike.

## Why
The site searches every NUS course, and NUS students use it too. An exchange-first screen made
them dismiss questions that weren't theirs ("Browse all courses instead") before they could search.

## Consequences
- Every link format is unchanged; a link without `ng=1` now opens as an NUS student's, so an
  exchange student's shared shortlist link keeps `ng=1` (as `shortlistUrl` already writes it).
- The exchange application's shortlist logic runs only in exchange mode; with `ng=1` and no year
  of study yet, the export question still asks it.
