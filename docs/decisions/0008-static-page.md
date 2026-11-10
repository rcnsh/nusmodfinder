# 0008: Phase 5 frontend plan

Status: accepted by the lead (2026-11-11). The plan converged at r3.1 after three critic rounds
(frontend and accessibility; data, eval and ship; the product for exchange students).
`docs/plans/phase5.md` §7 logs every objection and where it landed. No objection was declined,
so there is no dissent. Jacob's answers to D1–D4 are added below as they come.

## Context
SC2 wants every result card to open onto what a student needs to decide; SC8 wants zero axe
violations, working keyboard and screen-reader flows, and the first result above the fold at
390px. The page is one 14.9 kB HTML file with ten open frontend findings (F1–F10), a visual
critique (V1) and a provenance gap (P3). SC4's parsed-phrase items carry over from Phase 4.

## Decisions
- **Exam dates are data.** Migration 0010 stores them; since the row hash covers every column,
  this is a data-version change with its own full runbook cycle and deploy, shipped before and
  apart from the page.
- **The page is static assets**, native ES modules with `// @ts-check`, no framework and no build
  step, rendering DOM nodes only (`innerHTML` and friends banned by lint). State lives in the URL
  with a fixed transition table; `pick` and `alt` are reserved for Phase 6.
- **`/search` gains ranking-neutral fields** the page can't compute: `hiddenPins` and
  `notOffered` (every typed code, not only the three pinned), `exchangeBySem`, `examDates`.
- **A hidden typed code is explained with its own stored reasons**, never listed as a result,
  so SC1's "never shows" holds (subject to Jacob's D4).
- **Every exchange note shows in full on the card.**
- **The UI test stack** is a Worker entry with the fake AI and rate limiter over a locally seeded
  D1, under Playwright with axe running every rule; the vocabulary and groups become bare-name
  aliases, pointed at each eval run's workspace by the eval config.
- **SC8 is measured** by axe on every state × theme × width, a keyboard-only task at 1280 and
  390×664, live-region assertions, a VoiceOver checklist locally and live, and the fold at
  390×664 (`iPhone 13`), in CI and live.
- **Phrase parsing** returns only under a compliance-aware rule committed before any count or
  look: constraint-filtered qrels for both candidate and pin, a reference parse frozen at tag
  `3h`, the constraint block gated, counts inside the verdict path only, a dev screen first, and
  one look (L8 of 12) with no retry. The rule also says how exchange-mode removals are scored
  for every later look. The holdout misparse risk is accepted in writing.
- **The red team** is three exchange-student personas whose expected answers (yes / yes if / no
  / ask NUS) are fixed per note kind before the run; disagreements are classified, and exit needs
  zero page defects.

## Jacob's answers (2026-11-11)
- **D2, first screen: exchange set-up first.** The page asks the semester (Sem 1, Sem 2 or both)
  and the year of study before the first search; "browse all courses" leads to the full
  catalogue, whose cards keep a marker of the semesters a course is on the exchange list for.
- **D3, working name: "Exchange Course Finder (unofficial, for NUS)"** in the title and the
  visible header at every width, until Phase 8's name gate.
- **D4, hidden codes: say why**, from each code's own stored reasons; the course is never listed
  as a result.
- **D1, design direction: D, "Annotated catalogue"** (2026-11-11). Jacob saw A ("Registrar's
  ledger"), B ("Planner") and C ("Field guide") and asked for "a middle ground between A and C,
  with less bold"; D was built to that and picked. It takes C's structure (a "Your exchange" rail
  with the semester, year and key on desktop; results as entries with code, details and status
  columns; notes as plain guidance with a lead-in word; one accent) and A's type and precision
  (IBM Plex Sans with Plex Mono for codes, units and exam times; an outlined status stamp with a
  shape, a word and a colour, one per semester). It drops C's display headwords, thick rules and
  filled black chips, and A's dense zebra table: nothing heavier than 600, 1px rules, outlined or
  lightly tinted chips and stamps, a near-white ground and a muted plum accent. The mockup is
  `docs/design/phase5-direction-d.html` (contrast script beside it); the four directions are in
  the ephemera set `vector-nusmods-phase-5-design-directions-tk3piy`, with D picked and A–C
  rejected. 5D builds D in both themes.

## Lead decision 2026-11-11: SC8's axe gate is WCAG AA
SC8's "axe-core zero violations" runs every axe rule, the AAA ones included, except
`color-contrast-enhanced` (WCAG AAA's 7:1). The plan's contrast bar is WCAG AA (§3 5D: 4.5:1 text,
3:1 large text and UI), which `npm run contrast` checks for every pair in both themes; design D's
lowest text pair is 6.21:1. Reaching 7:1 would mean darkening D's status colours, which Jacob
picked, for a level the plan never set. axe ships that rule disabled by default for the same
reason.

## Consequences
- Two production deploys before 5F: the data change, then the page (code-only, rolled back
  alone). Each moves the shipped-ranker pin as ranking-neutral.
- One new CI job (`ui`) with two browsers.
- At most one holdout look this phase.
- Prerequisite text stays in NUS's rule language; class times stay on NUSMods.
