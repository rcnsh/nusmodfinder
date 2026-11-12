# 0008: The page is static, framework-free and accessible to WCAG AA

Status: accepted. The page's modules and tests are described in [docs/page.md](../page.md).

## Decision
- **Static assets, no build step.** `public/` is native ES modules with `// @ts-check` and
  JSDoc, served by Workers Static Assets (no Worker CPU). No framework.
- **DOM nodes only.** Lint bans `innerHTML` and the other HTML sinks in `public/`, and a CSP with
  `default-src 'none'` allows only the page's own scripts, styles, fonts and API. Nothing is
  loaded from another origin, fonts included.
- **State lives in the URL** with a fixed transition table (`public/nav.js`), so every view is a
  link and Back works.
- **The page serves NUS and exchange students alike** ([ADR 0017](0017-first-screen-for-everyone.md)).
- **A hidden typed code is explained with its own stored reasons**, never listed as a result, so
  exchange mode never shows a course the student can't take.
- **Every exchange note shows in full on the card**, after a lead-in word.
- **`/search` carries ranking-neutral fields the page can't compute** (`hiddenPins`,
  `notOffered`, `exchangeBySem`, `examDates`), and exam dates are stored data (migration 0010).
- **The design is "Annotated catalogue":** IBM Plex Sans with Plex Mono for codes, units and exam
  times; nothing heavier than 600; 1px rules; outlined or lightly tinted chips and stamps; a
  near-white ground and one muted plum accent; a matching dark theme by system setting. Every
  colour is a token at the top of `public/styles.css`.
- **The accessibility bar is WCAG AA.** axe runs every rule, the experimental and
  off-by-default ones included, except `color-contrast-enhanced` (AAA's 7:1), on every state,
  theme and width; `npm run contrast` checks every text and boundary pair against 4.5:1 and 3:1.
  The lowest text pair is 6.21:1. Reaching 7:1 would mean darkening the status colours for a level
  the project never set; axe ships that rule off by default for the same reason.
- **The screen-reader flow rests on automated checks** (the accessibility-tree snapshots, the
  live-region specs and axe), not a manual walkthrough.
- **The UI test stack** is the real Worker with the fake AI and rate limiter over a locally
  seeded D1, under Playwright in Chromium and WebKit; the first result is above the fold at
  390×664 (iPhone 13), checked in CI and live.

## Consequences
- Prerequisite text stays in NUS's rule language, and class times stay on NUSMods.
- The `ui` CI job runs two browsers.
