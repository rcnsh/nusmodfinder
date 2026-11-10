# VoiceOver checklist (Phase 5 5E, SC8)

The screen-reader walkthrough for SC8 (`docs/plans/phase5.md` §3 5E). A person runs it in
**macOS Safari with VoiceOver**, once on the local UI server before 5G's deploy and once live.
It follows the same task as the keyboard test (`test/ui/keyboard.spec.js`): the set-up, a search,
a filter, the set-up changed in the rail, a detail, a link in it, Back, and Escape. Playwright
already asserts the live region's text, every control's name and the accessibility tree
(`test/ui/live.spec.js`, `test/ui/aria.spec.js`); this checklist checks that VoiceOver actually
says them.

## Before you start

1. `npm run dev` and open the printed `http://127.0.0.1:<port>` in a **private** Safari window
   (no remembered year of study). Live: the production URL, also in a private window.
2. Safari → Settings → Advanced → turn on **Press Tab to highlight each item** (or press
   Option+Tab wherever this list says Tab).
3. Turn VoiceOver on (Cmd+F5). VO means Control+Option.

Wording varies a little between macOS versions and VoiceOver verbosity settings; a step passes
when what you hear carries the words in quotes, in that order, and nothing is read twice or
skipped. A status message (marked *status*) is spoken a moment after the focus announcement.

## The walkthrough

| # | Do | VoiceOver says | Pass? |
|---|---|---|---|
| 1 | Load the page | "Exchange Course Finder (unofficial, for NUS)", then the page | |
| 2 | Tab | "Skip to main content, link" (the link appears top left) | |
| 3 | Return | "Find the NUS courses you can take on exchange, main" | |
| 4 | Tab | "Sem 1, Aug–Dec 2026, radio button, 1 of 3", "Which semester will you study at NUS?, group" | |
| 5 | Space | "selected, Sem 1" | |
| 6 | Tab | "1st year, radio button, 1 of 5", "Your year of study at your home university, group" | |
| 7 | Right Arrow | "2nd year, selected, radio button, 2 of 5" | |
| 8 | Tab | "What do you want to study?, search text field", "A subject in your own words, a course name, or codes" | |
| 9 | Type `CS2104`, Return | "Search courses, search text field, CS2104"; *status* "N courses match “CS2104”." | |
| 10 | VO+U, Left/Right Arrow to Landmarks, then Escape | Landmarks: "banner", "Your exchange and filters, complementary", "Search and results, main", "Search courses, search", "content information" | |
| 11 | VO+U, Headings, then Escape | One level 1, "Exchange Course Finder (unofficial, for NUS)"; level 2 "Your exchange", "Filters", "Key" and one per course ("CS2104 Programming Language Concepts" first) | |
| 12 | Shift+Tab three times | "Faculty, Any faculty, pop-up button", "Units, Any units, pop-up button", "Level, Any level, pop-up button" | |
| 13 | Type `LL` (or VO+Space, choose "Level 2000", Return) | "Level 2000"; *status* "N courses match “CS2104”." again | |
| 14 | Shift+Tab twice | "Year of study at home, 2nd year, pop-up button", then "Sem 1, selected, radio button, 1 of 3, Semester at NUS" | |
| 15 | Right Arrow, then Left Arrow | "Sem 2, selected" then *status*; "Sem 1, selected" then *status* | |
| 16 | Tab until the first course | Stops on the selects, "Search courses", "Search, button", "Remove filter: Sem 1, button", "Remove filter: Exchange students, button", "Remove filter: Level 2000, button", then "CS2104 Programming Language Concepts, collapsed, button, heading level 2" | |
| 17 | Return | "expanded" | |
| 18 | VO+Right Arrow through the detail, then back with Tab | Reads "Course details", "Close details, button", "Can you take it?, heading level 3", "As a 2nd-year exchange student", each semester's status and notes, "Check with NUS before you register.", the sources with their dates, "Class times and timetable on NUSMods, link" | |
| 19 | Tab until "CS2030, link" (in the prerequisites), Return | "Search courses, search text field, CS2030"; *status* "N courses match “CS2030”." | |
| 20 | Cmd+[ (Back) | "CS2104 Programming Language Concepts, expanded, button" | |
| 21 | Escape | "collapsed"; focus stays on the CS2104 button | |
| 22 | Shift+Tab to "Search courses", type `CS2030 CS3244 CS5562 AR5801` over the query, Return | *status* "N courses match “CS2030 CS3244 CS5562 AR5801”. 3 of the 4 codes you typed aren't shown: CS3244, CS5562, AR5801." | |
| 23 | Type `qwzx vbnm` over the query, Return | *status* "Nothing in the catalogue matches “qwzx vbnm”. Try other words for the topic." | |
| 24 | Local only: stop `npm run dev` (Ctrl-C), type `networks`, Return | *status* "Could not reach the search service. Check your connection and try again." | |

**On a phone width** (Safari → Develop → Enter Responsive Design Mode, 390×664; restart
`npm run dev` and repeat steps 1–9 first):

| # | Do | VoiceOver says | Pass? |
|---|---|---|---|
| 25 | Tab past "Search, button" | "Filters (3), button" (VoiceOver may add "pop-up" or "dialog") | |
| 26 | Return | "Your exchange and filters, dialog", then "Only courses open to exchange students, checked, checkbox" | |
| 27 | Tab around the dialog | Never leaves it; "Done, button" comes before the checkbox again | |
| 28 | Escape | "Filters (3), button" | |

Not in this walkthrough: a 429 (the local server's rate limiter can't be tripped from the page,
and tripping production's isn't worth it). `test/ui/live.spec.js` asserts its sentence, "Too
many searches from your connection. Try again in 30 seconds."

## Record

The lead records each run below: who ran it, the date, macOS and Safari versions, where (local
or live), and any step that failed with what VoiceOver said instead.

| Run | Who | Date | macOS / Safari | Where | Result |
|---|---|---|---|---|---|
| | | | | local | |
| | | | | live | |
