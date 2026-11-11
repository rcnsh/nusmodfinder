# Phase 6 6D: the exports

Made 2026-11-12 from the local stack (`scripts/ui-server.mjs`, the fixture; nothing reached the
live Worker or the custom domain), with Playwright 1.64.1's Chromium (Skia/PDF m156) and WebKit.

| file | what |
|---|---|
| `exchange-shortlist-sem1-2026-27-courses.csv` | Download CSV of the mockup's state-2 list (`ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1&pick=PC3270.1&pick=ACC1701XA.1&alt=CS3244.1&alt=EE4407.1`), as the page downloads it: UTF-8 with a BOM, RFC 4180 |
| `exchange-shortlist-sem1-2026-27-courses-tagged.pdf` | the same list, `page.pdf({ format: 'A4', margin: 10 mm, tagged: true })` of the print page: 4 pages |
| `exchange-shortlist-sem1-2026-27-courses-tagged.txt` | its text, `pdftotext -layout` |
| `print-pages-sem1.png` | its 4 pages side by side (60 dpi) |
| `shortlist-40-tagged.pdf`, `.json` | `test/ui/export.spec.js`'s 40-entry list (every third fixture NG code, with EN3264 and LL4407): 18 pages |
| `print-pages-40.png` | its 18 pages (40 dpi) |
| `print-media-webkit-dark.png` | WebKit, print media emulated in a dark colour scheme: the print page alone, light on white |

Written by `VNM_EVIDENCE=docs/evidence/phase6/export npx playwright test export` (the 40-entry
PDF, its JSON and the WebKit screenshot) and a one-off Playwright script (the CSV and the
4-page PDF); the PNGs reduced to 256 colours.

## The PDF check (plan §2 "PDFs saved from Chrome and Safari", 6D exit)

| | pages | structure tree (`StructTreeRoot`) | text selectable | fonts |
|---|---|---|---|---|
| state-2 list | 4 | **present** (`pdfinfo`: Tagged yes) | **yes**: `pdftotext` reads it, starting with the head's first line ("Courses planned for Sem 1, …") | IBM Plex Sans (Regular, Medium, SemiBold), Plex Mono (Regular, Medium) |
| 40-entry list | 18 | **present** | **yes**: every description, workload, stamp and the shortlist link found in the text (`export.spec.js`) | Plex, plus `.SFNS` and Helvetica Neue (macOS) for characters the Plex subsets lack |

- The page's own reader (`test/ui/pdf-text.mjs`, no dependency) gives the same characters as
  poppler's `pdftotext` on every page of both PDFs, but for the line-end hyphens `pdftotext`
  joins words across.
- **U+2010 and U+2011** (EN3264's "post‐colonial", LL4407) fall back to a system font, which
  on macOS (Helvetica Neue) maps them to "-" in the text layer, so copied text has an ASCII
  hyphen there. The spec folds them when it compares; CI's Linux image may use another font.
- The PDF's `/Title` is the file name stem (`exchange-shortlist-sem1-2026-27-courses`):
  `page.pdf()` fires `beforeprint`, which sets it while the print class is on.
- **Page count:** the plan's bound was 14 pages for 40 entries. Each course carries the
  section's full block (NUS's rule text for prerequisite and preclusion, every note with its
  source, the rate caveat, the description), so a representative 40-entry list prints in 15 to
  18 pages and a Business-heavy one (ACC1701X*, with NUS's long programme lists) in 19 at
  8.5 pt. The spec bounds it at 20, which still catches the regression the bound was for (the
  section in the rail's 210 px column: about 2.5 times as many pages), and checks the section
  fills 95% of the page's width directly.
- The fresh-context review of the diff found three things, each fixed or recorded here: the
  title and file name named a semester only a not-placed entry carried (fixed: only the
  semesters with an entry planned in them are named, and a closed-only semester gets no
  section); a site line came before the head's first line (fixed: the site's name is in the
  head's second line, "Made on … with NUS Mod Finder"); and the page count above.
- Not checked here (needs a person, as 6-0 recorded): Safari's "Export as PDF" and Chrome's own
  print-dialog "Save as PDF" (whether either tags), and iOS's Share, Print path.
