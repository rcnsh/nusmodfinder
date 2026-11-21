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

## In the code

**The page's copies of the Worker.** A static page with no build step can't import `src/`, so it
keeps its own copies:
- `public/state.js` `IGNORABLE` (`src/query-intent.js` `IGNORABLE_INTENTS`) and `MAX_QUERY_CHARS`
  (`src/search.js`), and `public/intents.js` `PHRASE_INTENTS` (a subset of `INTERPRETED_KEYS`).
  `test/web/state.node.test.js` and `test/web/intents.node.test.js` compare these with `src/`, so
  a change to one side fails until both match.
- `public/state.js` `keepList`'s cap of 12 values (`src/search.js` `MAX_FILTER_VALUES`) and `ng`'s
  truthiness (anything but empty, `0` or `false`, as in `parseFilters()`), `public/explain.js`
  `MAX_PINS` (3) and `MAX_CODES` (10) (`src/query-intent.js`), and `public/list.js` `CODE`
  (`src/modules.js` `MODULE_CODE_RE`). No test compares these, so change them with the Worker's
  in the same commit, or add them to `test/web/state.node.test.js`.
- The faculty names come from `/facets` (`src/modules.js`), never a hardcoded list, because the
  faculty filter matches only the exact strings D1 stores.

**Requests and messages**
- `public/api.js` returns every request as an outcome, never a rejection, and never passes on the
  server's `message`: callers get a code, and `public/messages.js` gives every code and `noMatch`
  reason a sentence (`test/web/messages.node.test.js` reads `src/` and fails on a code with
  none). `createSearchClient()` aborts the call before it, so a stale answer settles as
  `superseded` and is never drawn. `fetchSearch()`, the partial-code state's other-semester
  probe, takes its own controller so it never cancels the search on screen.
  `createModuleClient()` keeps a 404 (an answer, whose `detail.kind` says which miss) and drops
  any other failure so asking again retries. `fetchFacets()` resolves null on failure, so nothing
  waits on `/facets`.
- `public/format.js` computes Singapore time with a fixed UTC+8 offset (no daylight saving there)
  rather than `Intl` or `toLocaleString`, so exam days and times read the same in every browser
  and in Node whatever their locale data. The unit tests and the exports depend on it.
- `public/format.js` `cleanPrereq()` changes only spacing in NUS's rule text: a THEN, AND or OR
  is split off only where it runs into a lower-case letter or "(" ("DegreeTHENmust", "DANDmust",
  ")OR("), so capitals that merely contain one ("MAJOR", "STANDARD", "THENCEFORTH", "BACHELOR(")
  stay whole. `CODE_IN_TEXT` matches letters then four digits, so a programme code, which starts
  with its digits (0200ACCHON), never links.

**Focus**
- `public/app.js` never leaves focus on `<body>`. An action that replaces the answer under the
  student's focus (the semester switch, an "Also as" link) focuses the new entry, or the search
  box, only if the student hasn't acted since. Re-showing the answer already on screen changes
  only the detail, so focus and scroll stay. A semester control hidden by a mode change hands
  focus to the segment, and when the focused control went with the old answer, focus moves to the
  shown `<main>`, so the next Tab is the search box.
- `public/shortlist-view.js` updates in place and never moves the focused element: rows are kept
  by code with their controls made once, `place()` moves a focused row's neighbours around it,
  `semButtons()` reuses the focused button first, and the export question's parts stay once
  asked. Moving or removing a focused element drops focus to `<body>` in Chromium and WebKit, so
  a rebuild would lose the keyboard user's place on every Move up or answer. The view's actions
  (Copy link, the exports) come before the lists, so a long list never puts them hundreds of Tab
  stops away.
- The skip link `preventDefault`s and focuses its target itself, because following the `#main`
  fragment would add a history entry and break the transition table's Back.
- `announce()` clears the live region and sets the same text again 150 ms later, because a live
  region whose text doesn't change says nothing, and a re-run search with the same answer would
  go unconfirmed.

**Structure for assistive tech**
- `public/detail.js` puts the code inside the detail's one `h3`, so the heading's name is the code
  and title, and puts "can you take it" before the facts in the DOM, so a screen reader and a phone
  (where it stacks above them) reach it first. CSS alone places it beside them on a wide screen.
- `public/render.js` keeps a card's shortlist toggle outside its `h2`, whose one button is the APG
  disclosure, in the units column, so the heading's name stays the code and title and toggling
  never shifts the exchange stamps.
- `public/icons.js` icons are `aria-hidden` and never carry meaning alone: the words beside them
  say it. The shortlist bookmark is outlined off and filled on, so the pressed toggle differs by
  shape as well as colour (WCAG 1.4.1).
- `public/choice.js` keeps `change` meaning "the student chose". `pillGroup()` adds its
  multi-select listener on the root before `app.js` adds its own, so "Any" and the figures are
  squared up before the page reads `.value`; `combobox()` stops the text box's native `change`
  (fired on leaving after typing) and fires its own only from a choice, and cancels `mousedown`
  on the list so the box never blurs (which resets the list) before the option's `click`.
- `scripts/contrast.mjs` reads both themes from `public/styles.css`'s own tokens, so a colour is
  checked where it changes. The decorative hairline (`--rule`) and the dialog backdrop carry no
  meaning and stay out of `PAIRS`; a token that starts carrying meaning joins them.

**Browser quirks the page and its tests work around.** Each looks removable and isn't:
- IME: `public/keys.js` `isSubmitEnter()` and `isCloseEscape()` ignore a keydown while
  `isComposing` or with `keyCode === 229`, which Safari sends for the candidate-confirming keydown
  after `compositionend`. `public/app.js` binds Enter on the query box and `preventDefault`s that
  keydown so the form's implicit submission doesn't fire either. Without the 229 check, Safari
  submits a half-typed Chinese, Japanese or Korean query or closes the detail on a cancelled
  candidate; `test/ui/search.spec.js` sends that event.
- WebKit focus: WebKit focuses a checkbox after its label's activation on Linux, so `app.js` moves
  focus to the year of study in a `setTimeout`. Its Tab skips radios and checkboxes and Shift+Tab
  leaves a modal dialog, so `app.js` wraps Tab inside the filters dialog itself (landing on the
  exchange checkbox), and remembers the focused control before a resize closes it, since the
  browser moves focus before `close`. It doesn't treat arrow-key moves in a radio group as
  `:focus-visible`, so `app.js` marks keyboard use on `keydown`. `choice.js`'s combobox selects
  its name on `mouseup`, not focus, since WebKit's mouseup puts the caret back and a press on an
  already focused box fires no focus event, and it scrolls itself into view on focus, which WebKit
  skips for a box Tab reached.
- WebKit lists: `shortlist-view.js` gives the pick and backup `<ol>`s `role="list"`, because WebKit
  drops the list role under `list-style: none` and VoiceOver would stop announcing count and
  position.
- History and downloads: `app.js` sets `history.scrollRestoration = 'manual'`, because the
  browser's restoration runs after popstate and would scroll a just-focused card away, and revokes
  a CSV's object URL a minute after the click, since revoking at once can cancel the download.
- CSP: `public/index.html`'s one inline script sets `data-view="results"` when the URL has a query
  string, before the modules load, so a shared link never flashes the first screen; `app.js`
  removes it on taking over. The CSP (`public/_headers`) allows it by sha256, so changing it means
  re-pinning the hash `test/web/source.node.test.js` prints. The page has no native `<select>`
  because WebKit reports `style-src-attr` against a select's own styling, and
  `test/ui/headers.spec.js` fails on any CSP report. `test/ui/fonts.spec.js` decodes its probe
  font from base64 in the page, because `connect-src 'self'` refuses a `data:` fetch and loosening
  the CSP would test a different policy.
- In the specs: WebKit, like Safari, doesn't focus a button or radio on click, doesn't scroll for
  a programmatic `focus()`, and scrolls a newly focused control into view a moment after the key,
  so the specs that assert focus (`keyboard`, `shortlist`, `export`, `detail`, `code-links`)
  activate by focus plus Enter or Space and poll their in-view checks. `fonts.spec.js` accepts
  `font-family` with or without quotes, because WebKit drops them around `IBM Plex Sans`.
  `headers.spec.js` turns off Chromium's Local Network Access check, which blocks one loopback
  origin framing another and would let the framing test pass for the wrong reason.

**Tests and tooling**
- `test/ui/aria.spec.js` compares each snapshot as exact text as well as with
  `toMatchAriaSnapshot`, and rewrites them only under `VNM_ARIA_UPDATE=1`. Playwright's
  `--update-snapshots` writes a loosened template (numbers as patterns) that the exact comparison
  rejects, and that would let a changed count or name through.
- `test/ui/live.spec.js` reads a control's name from Playwright's aria-snapshot line, which
  YAML-quotes the whole key when the name holds a quote or colon and gives `<summary>` no role.
  A plain `role "name"` regex would report every such control as unnamed.
- `test/ui/mobile.spec.js` runs one no-sideways-scroll test per width: forty page loads in one
  test ran past Playwright's 30 s budget on a loaded runner.
- `eslint.config.mjs` bans each HTML sink by property, identifier and string literal, so
  `el.innerHTML = …`, `el['innerHTML']` and `{ innerHTML: … }` all fail. Matching member
  assignment alone lets the other two through.
- `scripts/ui-server.mjs` runs wrangler without the Cloudflare account id, with metrics and the
  update notifier off, so the local stack sends nothing off the machine.
