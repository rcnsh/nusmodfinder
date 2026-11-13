# The page

The frontend: what it shows, its modules, how to run it and how it is tested. The decisions are
ADR 0008 (static, accessible), ADR 0009 (name) and ADR 0010 (shortlist).

## What it shows

The page is **NUS Mod Finder (unofficial)** at nusmodfinder.rcn.sh; "unofficial" is in its title
and visible header at every width, and its footer links NUSMods, the NG list, the restrictions
and the Registrar's vacancy report.

**The design is "Annotated catalogue":** IBM Plex Sans, with Plex Mono for codes, units and exam
times; nothing heavier than 600; 1px rules; outlined or lightly tinted chips and stamps; a
near-white ground and one muted plum accent. Light is the primary theme; a dark theme built to
match follows the system setting (`prefers-color-scheme`). Every colour is a token at the top of
`styles.css`, and `npm run contrast` (`scripts/contrast.mjs`, also run by `npm test`) checks every
text/background and boundary pair in both themes against WCAG AA.

- **The first screen is the search, for NUS and exchange students alike:** "Who are you searching
  as?" (NUS student or exchange student, pre-selected from this device's last search), then what
  to study. An NUS student searches every course. An exchange student also answers the exchange
  set-up, shown only to them with the sources it rests on: the semester at NUS (Sem 1, Sem 2 or
  both) and the year of study (pre-filled from this device); the search then runs in exchange
  mode. "Browse all courses instead" leads to the search with no query, in exchange mode for an
  exchange student (with the answers given so far). A link with any state skips it. The site
  name in the header links home, to the first screen.
- **What students say** (ADR 0018): a card whose course has at least three reviews on NUSMods
  shows, in its right-hand column (under the exchange status in exchange mode), the overall score
  out of 5 with a word, a five-segment meter each for workload, difficulty and teaching (each
  meter's accessible name carries its number), the review count and latest academic year, and a
  link to read the reviews on NUSMods.
- **NUS student or exchange student** is `ng`: an NUS student's pages say nothing about exchange
  (no exchange line on a card; the detail's all-years exchange table is a collapsed "For exchange
  students: who may take it" after the facts), and the shortlist is a plain plan (below).
- **Results:** a rail on the left ("Searching as": NUS student or exchange student, the same
  answer as the first screen's; for an exchange student the semester and year; the filters; the
  key in exchange mode) beside the search
  bar, the filter chips (each removes its filter; the semester and year exchange mode needs are
  changed in the rail), and the entries in three columns: code and units; title, department,
  timetable semesters, exam day and time (Singapore) and other codes; the exchange stamp per
  semester (an icon, a word and a colour) with every note in full after a lead-in word. Below
  1040px the status drops under the title. An entry's other codes ("Also as") are links: each
  opens that code's own search with its detail open (`open=`), whose head says "Opened from
  `<code>`" (`from=`); Back returns to the list. For a query of course codes only, the count line
  names the typed codes shown ("20 courses shown: CS2030, then 19 other matches").
- **The filters are no native selects** (`public/choice.js`). A short list is a radio group drawn
  as pills, every choice in sight: the semester (Any, Sem 1, Sem 2 as a segment, the special terms
  as pills under it), the level and units (the figure alone, with the rest of the chip's label,
  "Level 2000" or "4 units", visually hidden so a screen reader says the same), and the year of
  study; arrow keys move and choose, as in any radio group. Level and units take several at once:
  their pills are checkboxes, "Any" clears the rest, choosing a figure clears "Any", and clearing
  the last figure checks "Any" again. The URL names them comma-separated (`level=3,4`), and each
  chosen figure is its own chip. The faculty list is too long for
  that: it is a combobox (the APG pattern, `aria-activedescendant`) whose list opens in the
  flow under the box rather than over the page, so in the phone's dialog it scrolls with the
  dialog and the keyboard never covers it; the box scrolls to the dialog's top as it opens.
  Typing narrows the list (a name that starts with the text first, then a word that does, then
  any part); Up, Down and Enter or a click choose; Escape closes the list only (not the
  dialog), and Escape, Tab or leaving puts the chosen name back. Its `data-value` is the
  choice; the box shows its name, quoted for a link's faculty /facets hasn't vouched for. On a
  phone the pills and options grow to thumb size.
- **Typed codes not shown** are explained above the entries: each with its title, a stamp ("Not
  on the NG list for Sem 1", "Not for exchange students", "Not open in Sem 1", "Outside your
  filters", or "Not this year" for a code not offered this year), and why, from its own stored
  reasons. Where the other semester is open to the student and nothing else hides the course,
  "Switch to Sem 2 to see CS3244" changes the semester and focuses the course's entry.
- **Parsed phrases** (*no final exam*, *S/U*, *light workload*, levels) show as chips under the
  count; each chip's button re-runs the search with `ignore=` that phrase.
- **On a phone** (≤ 640px) the form is one bar (query and Search), and the rail opens as a modal
  `<dialog>` from "Filters (n)": its controls move into the dialog while it is open, so there is
  one copy of each; focus stays inside, Escape or Done closes it, and focus returns to the button.
  Inputs are 16px, so iOS doesn't zoom.
- **The detail** opens as a sheet under its entry: its head repeats the code and title (one
  heading) with the units and department, then "can you take it" (per semester, every note with
  its source and date, "check with NUS", the NUSMods link) beside the course facts, and above them
  on a narrow screen.
- **Accessibility:** a skip link is the first Tab stop and moves focus to the shown `<main>`; one
  `<h1>`; landmarks for the header, the rail, the search and the footer. One polite live region
  (`#live`, in the header, and in the filters dialog while it is open, since a modal dialog makes
  the rest of the page inert) says each answer once in a sentence: the count, why there are none
  and the next step, the typed codes not shown, errors and 429. The list is `aria-busy` while a
  search runs; the Search button is never disabled (a second press aborts the first). Escape
  closes the open detail and focus returns to its button, as it does after Back to an open
  detail. Every control shows a 2px plum focus ring, and nothing covers it (the sticky header
  leaves a scroll padding of its height). The screen-reader flow rests on the aria snapshots, the
  live-region specs and axe.
- **Fonts** are self-hosted (`public/fonts/`, IBM's own Latin1 WOFF2 subsets, SIL OFL in
  `public/fonts/OFL.txt`) with `font-display: swap` and a system fallback stack; the page makes no
  request to any other origin. Plex Mono draws a dotted zero, so mono text sets its stylistic set
  4, the plain one.

### The shortlist

**Its state.** The list lives in the URL with no account: `pick` (primary) and `alt` (backup),
each repeated in rank order, each `CODE.S` (S is 1 or 2) or an untagged `CODE`, then `ay`, `inv`
and `view`, e.g.
`/?q=networks&sem=1&ng=1&study=ug2&pick=CS2113.1&pick=CS2030.2&alt=GE2101.1&ay=2026-2027&inv=biz&view=shortlist`.
Tags are kept as written; parsing upper-cases, drops malformed values and other tags, keeps the
first of duplicates (a code in both lists stays a pick), and keeps at most 20 entries a tagged
semester and 40 in all. `ay` (as `acad_year` writes it) is written with the first edit or Copy
link once a `/module` row has loaded, never on load alone; `inv` (`biz`, `law`) only when ticked;
`view=shortlist` opens the view and drops `open`. The list is page-wide, not per history entry:
Back and Forward keep it and write it into the entry they reach. An edit replaces the entry at
once and never searches. Every `pushState` and `replaceState` goes through one writer
(`history.js`), which keeps under WebKit's 100 writes in 10 s. Links the page renders carry no
list, so a new tab starts without one. The last list the student edited is kept on this device
(`localStorage` `vnm.shortlist`) for "Restore your last shortlist"; opening a link never
overwrites it. `shortlist.js` works the list out (what counts, to confirm with NUS, or not and
why; the same course twice; NUS's form order per semester against 40 units; totals; exam and
preclusion flags; NUS's notes), for the view and the exports. Some specs drive the list through
test hooks the page installs only when `globalThis.vnmTest` is set before it loads.

**The view.** Each card and the detail's head carry a "Shortlist" toggle (`aria-pressed`, named
"Shortlist, CODE"); adding a card's course tags it with the semester the results show, and the
live region says the semester's units picked so far once its row has loaded ("…, 1 course still
loading" past 2 s). Taking a card off says so with Undo. The shortlist button sits at the foot of
the rail and, on a phone, in a row under the search bar; it names the units picked per semester
(on two lines when it must) and opens the view (`view=shortlist`, a pushed entry; "Back to
results", Escape or browser Back close it, and focus returns to the button). The view hides the
results and status, keeps the search bar and rail, and lists primary picks then backups, each row
with its title, units, exam, workload, its stamp at its own semester, every note, NUS's notes on
the course and its flags, and Move up, Move down, Make backup or primary, a semester button and
Remove (with Undo at the top of the list). Under them: per-semester totals (counted, to confirm,
only if invited, hours, NUS's limits said once), NUS's form order, the CourseReg box and the
applicant lines. Rows load four at a time; a failed one offers Try again, a 404 reads as its
`kind` says. The invitation checkbox shows only for the faculty the list holds (Business or
Law). In exchange mode with no year of study yet, or with untagged entries, an export question
asks the year of study and each entry's semester first. **An NUS student's list** (not exchange
mode) is a plain plan: each pick counts by its units if taught in its semester, with the totals,
hours and the exam, preclusion and same-title flags, and no year-of-study question, invitation,
form order, CourseReg box, NUS's exchange notes or applicant lines; its exports drop the
exchange columns and lines too, and its file is `shortlist-….csv`. Copy link writes `shortlistUrl` to the clipboard within the click;
if the browser refuses, a selected field labelled "Shortlist link" holds it. The view moves no
focused row: a moved row's neighbours move around it, and rows that load later never take focus.
While the view is shown, a search under it says nothing; the view says its own sentences (each
edit, "Loading N courses" and "N courses loaded", Restore and Forget).

**The exports.** "Download CSV" and "Print or save as PDF" sit in the view's actions, with the
hint "On a phone: Share, then Print, then pinch out the preview to save the PDF. Excel shows one
column? Use Data › From Text/CSV." Both draw one document (`export.js`), built from the same rows
as the view, each entry at its own semester: the head (what it plans on which year's data, the
year of study during the exchange, the date, the shortlist link at
`https://nusmodfinder.rcn.sh`, the later-year line, NUS Mod Finder's name); each semester present,
Sem 1 then Sem 2, its primary picks then its backups in rank order, then its totals; "Closed, or
not on NUS's exchange list, in that semester"; "Not placed in a semester" (untagged, special
terms only, catalogue-only and unknown 404s); then the foot (the form order per semester, the
lines for applicants, the CourseReg box, the Canvas line, transfer of units, the lists' dates,
what isn't checked, "Unofficial"). Each course carries its form number, list and rank, units,
department, faculty, level (the brochure's bands), grading when not "Graded", whether it counts
and why, its stamp and every note with its source and date, NUS's notes, its exam in Singapore
time, NUSMods' workload with each part labelled, the estimate at NUS's 2.5 hours a week per unit,
"Course description (NUS, via NUSMods)", NUS's prerequisite and preclusion, its flags and its
NUSMods link. The CSV (`csv.js`) is RFC 4180: the header first, one row per entry, then a padded
empty row and the head, totals and foot as label/value rows (the Excel hint last); every field
quoted, CRLF, UTF-8 with a BOM, and a field starting with `=`, `+`, `-`, `@`, a tab or a CR given a
leading `'`. Its name is `exchange-shortlist-sem1-sem2-2026-27-courses.csv` (the semesters
present; the rows' year). The PDF is the browser's own print of `#slPrint` (`print.js`), which
the screen never shows: print shows it alone, light on white whatever the theme (the dark tokens
apply to screen only), when `html.print-shortlist` is on. That class is derived from state (the
view shown, every row settled, the export question answered or not needed), so Ctrl+P prints the
shortlist then and the screen otherwise; printing sets the title to the file name and
`afterprint` restores it. A press before every row is in keeps the button's name, says "Loading 7
of 12 courses" on the line it points to (`aria-describedby`) and in the live region, then "Ready:
press again to download" (or "to print"), so the download or `print()` comes from the user's own
click. An export writes `ay` into the URL. The print fonts load when the view opens.

## The files

`public/` is the whole frontend: `index.html`, `styles.css` and native ES modules with
`// @ts-check` and JSDoc, served by Workers Static Assets (the `assets` block in `wrangler.jsonc`,
no binding). No file there matches an API path, so `/search`, `/facets`, `/module/:code`,
`/health` and `/admin/*` still reach the Worker. `public/_headers` sends every page file with
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and a CSP: `default-src 'none'`, the
page's own scripts, styles, fonts and API (`'self'`), `frame-ancestors 'none'`, and the one inline
script in `index.html` by its sha256. Change that script and `test/web/source.node.test.js` names
the new hash; `test/ui/headers.spec.js` checks the headers on the local stack (which applies
`_headers` as production does), that another origin can't frame the page, and that no flow trips
the CSP.

| module | does |
|---|---|
| `state.js` | the state ↔ URL mapping (pure). In exchange mode `ng=1` and `study` are always in the URL; `open=` names the one open detail, and `from=` the entry whose "Also as" link opened it (kept only beside `open=`, and only while it is one of the open entry's own other codes: `app.js` drops any other, so a link can't claim two courses are one); `view=shortlist`; `urlFor(state, list, path)` writes the state and the shortlist together, and `shortlistUrl` Copy link's URL (no `q`, filters or detail) |
| `list.js` | the shortlist's half of the URL (pure): parsing with its caps, and every edit (add, remove and Undo, Move up and down, Make backup or primary, a semester, an invitation, `ay` once), each refusing past a cap with the reason |
| `history.js` | the one history writer: a sliding 10 s budget of 80 writes; past it, writes are held and go out 300 ms after the last, each replace folded into the write before it (a flood of edits is one write) and each push kept as its own; each write in `try`, a refusal retried with backoff (1 s … 10 s) with later writes queued behind it; `flush()` before `act()`, Copy link, exports, on hidden and `pagehide`; `cancel()` on popstate |
| `shortlist.js`, `preclusion.js` | the shortlist worked out (pure): each entry at its own semester; counted, to confirm with NUS, only if invited (Business and Law), or not counted and why; the same course listed twice (one group, both on the NG list or a preclusion naming the other, compared only with entries kept); NUS's form order per semester against 40 units; totals in tenths with the hours at NUS's rate; exam-overlap, preclusion and same-title flags; NUS's notes on particular courses; the cited lines (applicants, the CourseReg box, the maximum in NUS's words, with a semester above 20 flagged). `preclusion.js` reads whether NUS's text names a code, skipping cohort-only branches and, at `grad`, undergraduate-only rules |
| `shortlist-view.js` | the view's DOM: the heading, actions, export question, invitation, both lists' keyed rows (updated in place, never moving the focused row), the totals, the form order and the boxes, from the model `app.js` builds out of `shortlist.js`'s result; its buttons are handled by delegation (`data-act`) |
| `export.js`, `csv.js`, `print.js` | the exports: `export.js` works `shortlist.js`'s result into one document (head, sections by semester, closed, not placed, foot; pure); `csv.js` writes it as RFC 4180 with the formula guard (pure); `print.js` draws it into `#slPrint`, the print page |
| `saved.js`, `year.js` | the list on this device (save on the page's own edits, restore only when a link has none, forget); the acad year before any row loads |
| `nav.js` | the history transitions (pure): submit pushes, filter changes replace and drop `open=`, closing a detail goes `back()` only from the entry the page pushed, an "Also as" link pushes that code's search with its detail open; every action that changes `open=` drops `from=`. No transition touches the list; settings while the view is shown keep it and the submitted `q`; a submit closes it; opening and closing the view; `searchAgain`, whether Back or Forward searches (a changed search, or the same one after a network or server error, never after a 429) |
| `api.js` | the fetch layer: each search aborts the previous one, 10 s timeout, non-JSON bodies caught before parsing, `Retry-After` read on 429 |
| `messages.js` | a plain sentence for every error code and `noMatch` reason; raw codes are never shown |
| `format.js` | semester names, workload, exams in Singapore time, NUS prerequisite and preclusion spacing, the cohort-only prerequisite line, course codes in NUS's text, and the student's own text as the page's sentences repeat it (`quoteUser`: no bidi, zero-width or control characters, no quote mark or lookalike inside (one apostrophe instead), at most 60 characters, in curly quotes). A link's faculty is quoted the same way, in its chip and option, until `/facets` lists it; one it doesn't list is dropped |
| `explain.js` | exchange wording (pure): each stamp's words, each note in full with its lead-in word ("Places.", "Your major."), the `semester` note as an action, each source with its "updated as at" date, why a typed code is hidden (its own stored reasons) and its stamp, the partial-code empty state, the typed codes past the three that pin, and the count line for a query of codes only |
| `detail.js` | a card's detail, inline, from `/module/:code` (fetched once per page): its head (code, title, units, department; "Opened from …" after an "Also as" link), description, prerequisites and preclusions as NUS states them with codes linked to a search, exams, workload, exchange availability per semester, the NUSMods link for class times |
| `keys.js` | Enter submits only outside IME composition |
| `intents.js`, `intent-chips.js` | the phrases `/search` read from the query (`interpreted`) as chip labels (pure), and the chip row under the count, each chip's button re-running the search with `ignore=` that phrase |
| `icons.js` | the stamps' and controls' small line icons, built as SVG nodes, all decorative (`aria-hidden`) |
| `choice.js` | the rail's filter controls in place of native selects: `pillGroup` (a radio group drawn as pills, or a segment and pills) and `combobox` (the faculty list), each with `.value`, `focus()` and a bubbling `change`, as the selects had |
| `dom.js`, `render.js`, `app.js` | DOM nodes only (lint bans `innerHTML` and the other HTML sinks in `public/`); the entries (an APG disclosure each: a heading holding one button that controls the detail; the exchange stamp for the chosen semester, or one per semester when planning both, with the notes both share said once; what students say (`reviewsPanel`); no search score), the hidden-codes box and the status area, with the sentence each answer gives the live region; the controller (the set-up screen, the rail's semester segment, the chips, the filters dialog, the skip link, the live region, focus after Escape and Back) |

`npm run typecheck` checks it with `tsconfig.web.json` (the DOM lib) and the Playwright specs with
`tsconfig.ui.json` (Node plus the DOM lib, for their `page.evaluate` callbacks); the pure modules
are unit-tested in Node (`test/web/`).

## Run it locally

```bash
npm run dev        # node scripts/ui-server.mjs: prints http://127.0.0.1:<port>; Ctrl-C stops it
```

`scripts/ui-server.mjs` runs `wrangler dev --local` on `test/wrangler.ui.jsonc`:
`test/ui/worker.js` (the Worker with `FakeAI`, the fixture bundle's embedder, and
`FakeRateLimit`) behind `public/`, over a fresh local D1 in a temporary directory. It applies the
migrations, seeds the fixture through `/admin/ingest?d1Only=1`, the catalogue-only rows through
`/admin/catalogue` and the NG list through `/admin/facets`, with a one-off `INGEST_SECRET` in its
own temporary env file (never `.dev.vars`), and deletes it all on exit. No binding in that config
reaches Cloudflare. It picks a free port (`--port N` to choose one; 8787 and 8799 are refused).
Its ranking is not production's: a few hundred fixture courses and a fake embedder.

## UI tests

Playwright, Chromium and WebKit, with `@axe-core/playwright`; `test/ui/*.spec.js`:

```bash
npx playwright install chromium webkit                  # once
npm run test:ui                                         # starts its own ui-server on a free port
VNM_UI_URL=http://127.0.0.1:<port> npm run test:ui      # or reuse a running `npm run dev`
```

Failure states (timeout, 429, an HTML error page, `/facets` down, keyword-only), a raw workload, a
failed `/module` and a 4th typed code that is neither shown nor hidden use request interception;
the cards, the detail (`?q=CODE&open=CODE`), the hidden-code lines and the partial-code states run
on the fixture.

| spec | checks |
|---|---|
| `search.spec.js` | the search, the exchange set-up, DOM-only rendering and IME handling |
| `detail.spec.js` | the card's disclosure, the exchange status per semester, every note in full, the detail from `/module/:code` |
| `hidden.spec.js` | typed codes not shown: each with its own reasons and sources, codes not offered this year, a partial code exchange mode empties |
| `history.spec.js` | the transition table (`public/nav.js`) in the browser, with focus back on the card's button |
| `failures.spec.js` | a hung search, 429, an HTML error page, the network gone, `/facets` down or slow, a keyword-only answer: a plain sentence, never a raw code |
| `routes.spec.js` | `/` is the page from `public/`, and every API path still reaches the Worker |
| `visitor.spec.js` | the no-JavaScript sentence, the year line at every width, the 404 page |
| `setup.spec.js` | the first screen: who is searching, the exchange set-up, what each search sends |
| `mobile.spec.js` | the phone layout, the filters dialog and the chips |
| `fold.spec.js` | the 390×664 fold, also as an iPhone 13, after a shared link and a typed search |
| `fonts.spec.js` | self-hosting, weights, the plain zero |
| `intents.spec.js` | the phrase chips, on intercepted answers |
| `a11y.spec.js` | axe with every rule on every state, both themes, 1280 and 390×664, no violation allowed; the experimental and off-by-default rules are on too, all but AAA's 7:1 contrast, since the bar is AA; states the fixture lacks are intercepted |
| `keyboard.spec.js` | the whole task keyboard-only at both widths, each stop's order and computed focus ring; in WebKit on a Mac it presses Option+Tab, as Safari needs unless "Press Tab to highlight each item" is on |
| `live.spec.js` | the live region's sentences, `aria-busy`, the never-disabled button, every control's accessible name |
| `aria.spec.js` | accessibility snapshots, committed in `test/ui/aria.spec.js-snapshots/` and compared exactly; after a deliberate change, `VNM_ARIA_UPDATE=1 npx playwright test aria --project chromium` rewrites them |
| `detail-fields.spec.js` | every fixture code through `?q=CODE&open=CODE`, each field with the fixture's value or its "not listed" text, read by `test/ui/detail-fields.mjs`, which the live checks share (about 25 s in both browsers) |
| `code-links.spec.js` | the hidden-code stamps and "Switch to Sem 2", "Also as" links and "Opened from", the detail's head, the code-only count line |
| `branding.spec.js` | the title, "unofficial" and the footer's provenance line |
| `headers.spec.js` | `_headers` on the local stack, framing, no CSP violation in any flow |
| `shortlist.spec.js` | the toggles, the button, every row control by keyboard at both widths (focus asserted in view and uncovered after each), the view's history (a 429 and a 500 behind it, Escape, Back and Forward, a submit from it), rows arriving, each 404 kind, Try again, the export question, Copy link, the invitation, Restore and Forget, a refused history write |
| `export.spec.js` | downloads the CSV and reads it back with a strict RFC 4180 reader (`test/web/rfc4180.node.mjs`) over every fixture NG code and the fixture's NG-listed codes at ug2 and grad; stubs `print()`; presses before the rows are in; Ctrl+P before and after the export question; the print page under print media (only it shows, full width, AA on paper in dark mode, axe); Chromium's tagged PDF read back (`test/ui/pdf-text.mjs`, no dependency). `VNM_EVIDENCE=<dir>` keeps the PDF |
| `shots.spec.js` | screenshots of the main states in both themes to `test-results/shots/`, only when asked: `VNM_SHOTS=1 npx playwright test shots --project chromium` |

`test/web/csv.node.test.js` tests the document and the CSV in Node. CI's `ui` job runs the suite
when `public/`, `src/`, `test/ui/`, the configs, the fixtures, `data/` or the lockfile change
(`scripts/ci-changes.mjs`, [operations.md](operations.md#ci)).
