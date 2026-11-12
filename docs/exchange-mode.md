# Exchange mode

Which courses an exchange (Non-Graduating, NG) student may take, and how the site knows. The
decision behind the design is ADR 0007; the yearly and mid-year refresh procedures are in
[year-refresh/](year-refresh/README.md).

## Where the data comes from

Exchange availability is **not in the NUSMods API**. NUS publishes it as Registrar PDFs (the NG
course list, per semester, and the course restrictions for NG students), plus a few pages (the
self-funded programme list, YST's non-music-majors pages, the Law compulsory-course list), behind
bot protection that blocks programmatic fetching. So they are downloaded by hand and extracted
into committed files.

**The NG list.** Download `ng-courses.pdf` from the
[NUS Non-Graduating page](https://www.nus.edu.sg/registrar/prospective-students/non-graduating),
then:

```bash
python3 -m venv .venv && .venv/bin/pip install pypdf
.venv/bin/python scripts/extract-ng.py <dir>/ng-courses.pdf --year <yyyy-yyyy>
```

<!-- year:live --> The live 2026/27 list (`data/ng-courses-2026-2027.json`) has 730 codes for Sem 1
and 750 for Sem 2, 1,207 codes in all. The extractor writes `data/ng-courses-<acadYear>.json`,
keeping only the sections whose heading names that year (NUS prepends the next year's Sem 1 above
this year's Sem 2), and fails when a semester the year's source manifest marks published has no
section or a section has no rows (`--from-text` reads text already extracted, with no `pypdf`).
Ingest picks it up and sets `modules.ng` plus the `ng` Vectorize metadata property. A missing or
stub file is refused: exchange mode would show every course closed. `year check --full` re-runs
the extractor with `.venv/bin/python` on the archived PDF and requires the committed file byte for
byte, so a hand edit to it can't pass; keep the venv above in the repo.

The list's `updatedAsAt` date reaches `/facets` (and so the page) through ingest: the ingest
script posts it to `/admin/facets`, which stores it as `meta.ng_list`. Re-run ingest after
regenerating the extract; there is no copy of the date to bump by hand.

**Cross-checked against the pinned corpus** (`test/full/corpus.test.js` asserts these).
<!-- year:pinned --> For the pinned AY2026/2027 snapshot, of 1,207 course codes in the PDF, **1,175
(97.3%)** exist in the NUSMods corpus, and the other 32 are not offered that year. Where both
sources state a semester they agree on **1,411 of 1,447 (97.5%)**; the ~2.5% disagreement is a
snapshot-against-daily-scrape artifact.

## The source manifest

Each year's sources are listed in `data/ng-sources-<year>.json`: the revisions of NUS's documents
(name, URL, file, sha256, "updated as at"), each revision's encrypted archive (a release asset;
`npm run sources`), which semesters NUS has published, the transcription, overlay
(`scripts/ng-overlay/<year>.mjs`), oracle and register paths, and the quote index (every NUS
sentence copied by hand into `src/` or `public/`, with its document). Every document's `file` and
`text` is a plain base name, and each `text` extraction carries a `textSha256`, which
`sources publish` writes and restore, `--full` and the restrictions builder check.

`npm run year -- check` checks the year's files agree with the manifest (the deploy preflight runs
it). `--full`, on the Mac with the sources key, finds every quote in its document, re-extracts
`data/ng-courses-<year>.json` from the archived NG list PDF and rebuilds the rules file, each byte
for byte; while a semester is unpublished it re-extracts last year's list (which exchange mode
shows for it) from last year's archive too, and refuses when there is none.

## Restrictions

Being on the NG list isn't enough: the restrictions PDF closes schools, levels and single
courses, and adds conditions (a major at home, a partner university, approval, a quota, graded
only). These are data, not code: `data/ng-restrictions-<year>.json`, built by
`scripts/build-ng-restrictions.mjs` from the documents the year's source manifest lists (archived
encrypted; `npm run sources -- restore` unpacks them) and the year's overlay, with every reading
the sources leave open decided in the year's register
([`year-refresh/registers/2026-2027.md`](year-refresh/registers/2026-2027.md)). The PDF is
transcribed twice, independently ([`year-refresh/transcriptions/`](year-refresh/transcriptions/)),
and the transcriptions are diffed (`scripts/transcription-diff.mjs`).

**At ingest**, `src/eligibility.js` runs over every module for every (semester, year of study)
and stores a 15-bit allow mask (`modules.ng_allow`) and the rule ids behind each answer
(`modules.ng_rules`); the Worker runs no rule logic. Every search path tests the one bit for the
request; a zero or missing mask is closed. Reason texts ship with the Worker
(`data/ng-reasons.json`, built by `scripts/build-ng-reasons.mjs`), so rewording one rewrites no
rows.

**Verification.** An independent oracle for the year (`test/oracle/oracle-<year>.node.mjs`,
picked by the selector `test/oracle/oracle.mjs`) checks the rules on every module, and the
`oracle` CI job (`npm run test:oracle`) checks every search path against it over the production
corpus. Over the shortlist, `test/shortlist-oracle.js` checks every fixture code in `npm test` and
every pinned code in `test/oracle/paths.test.js`.

## A semester NUS hasn't published

The site moves to a new year once NUSMods has it and NUS has published the Sem 1 list (July;
ADR 0015). Until NUS publishes Sem 2's, the manifest marks it unpublished, `scripts/lib.mjs` takes
last year's Sem 2 list for it and marks every module `ngUnpublished: [2]`, and
`src/eligibility.js` gives a course on that list the note `ng:unpublished-sem` (kind `ask`: "On
NUS's <last year> list; NUS hasn't published <this year>'s yet."), never open; the shortlist
counts it "to confirm with NUS". A course not on last year's Sem 2 list is closed there with
`ng:unpublished-sem-unlisted` ("Not on last year's NG list for Sem 2"), not "only in the other
semester". With every semester published, nothing changes.

## Notes read per request

Two notes are read from a row's own fields on every request (no stored column, no data change),
and never close, open or reorder anything. `exchangeAt` in `src/ng-reasons.js` adds them, so
every `/search` path and `/module/:code` get them.

**The year-of-study note** (`src/year-note.js`). A NUS prerequisite that requires an
undergraduate year ("If undertaking an Undergraduate Degree THEN must be Year 4") doesn't change a
course's exchange status, but an undergraduate whose year of study during the exchange is below
that year gets one more note, `{ id: "prereq:year-of-study", kind: "year" }`: "NUS lists this
course for Year 4 students. Ask the department whether your year of study during your exchange
counts." An open course with it is `note`; a closed one stays closed without it. `/module/:code`
reads the row's `prerequisite`, and `/search`'s hydrate reads it as `year_prereq`, only where it
mentions a year. Only unambiguous texts give it: one undergraduate branch (or none) and a year
item that no OR sits beside at any level. A year that is one alternative ("GPA of 3.2 or greater
OR must be Year 4"), several "if undertaking" branches, or a graduate student give none. The
oracle reads the prerequisite on its own (`prereqYears`, `oracleShown`).

**The level-4000 note** (`src/level-note.js`). NUS Global's (GRO's) sentence on higher-level
undergraduate courses is a condition, like a quota: a level 4000 course outside Law that an
undergraduate (`ug1` to `ug4`) is shown gets `{ id: "gro:level-4000", kind: "supply" }`, whose
text is GRO's sentence word for word after "GRO: " ("Higher level undergraduate courses (e.g.
course code starting from 4000 & above) have very limited supply and are usually NOT available to
exchange students. …"); the page leads it with "Places." and cites "GRO, Incoming Exchange
Students". An open course with it is `note` ("Open, with 1 note"); the shortlist counts `supply`
as it counts `quota` ("Counted, if NUS accepts you"). Level 4 only: NUS's undergraduate courses
run from 1000 to 4000 (the brochure's "4000: Honours courses"; 5000 and 6000 are graduate
courses, which the restrictions and departments govern). No note for a graduate student or a Law
course (NUS Law opens only its LL4 electives and registers its own invitees). The oracle reads it
from the code and faculty on its own (`levelNoteOf`). Over the pinned corpus 245 offered courses
carry it, all on the NG list (952 level 4000 courses outside Law; the rest are closed to every
undergraduate).

## When a source changes

The NG list, the restrictions PDF, the self-funded programme list, YST's non-music-majors pages
and the Law compulsory-course list all change without notice. A new copy of any of them is a
revision of the year's source manifest, and repeats the whole check for the changed sections: a
new archive (`npm run sources -- publish --from <dir>`), two transcriptions of what changed and
the id map, rulings in the register, the overlay and builders, a fresh oracle author for the
changed sections, `npm run year -- check --full` (commit its run record: the deploy preflight
needs it whenever a source-derived input changed), and a row-only re-ingest and deploy. The steps
are "A mid-year revision" in [year-refresh/README.md](year-refresh/README.md).
