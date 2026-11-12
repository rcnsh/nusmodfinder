# Year refresh: the runbook

How the site takes a new NUSMods corpus for the same year (the most common refresh), moves to a new
acad year, and takes a new copy of an NUS source mid-year (Phase 7 7E, `docs/plans/phase7.md`). `npm run year -- next <yyyy-yyyy>` prints this checklist.
The CI job `rollover` rehearses steps 2–13 on every code change (`scripts/rollover.mjs`), so the
code has no year built in; it cannot show what a new PDF layout or new rules will break, which is
what steps 3–7 are for.

The other pages here:

- [`brief-transcription.md`](brief-transcription.md): the brief for the two transcribers.
- [`brief-oracle.md`](brief-oracle.md): the brief for the oracle's author.
- [`overlay.md`](overlay.md): the year's overlay module, its ids and roles.
- [`register.md`](register.md): the register of readings, and how rulings are logged.
- `registers/<year>.md`: each later year's register (2026/27's is
  `docs/evidence/phase4/interpretations.md`).

## What each year has

| file | what | written by |
|---|---|---|
| `data/ng-sources-<year>.json` | the source manifest: revisions and their documents (name, URL, file, sha256, "updated as at"), each revision's archive, which semesters are published, the transcription, overlay, oracle and register paths, and the quote index | hand, `sources publish` |
| `data/ng-courses-<year>.json` | the NG list | `scripts/extract-ng.py --year` |
| `data/ng-restrictions-<year>.json` | the rules | `scripts/build-ng-restrictions.mjs --sources <dir>` |
| `scripts/ng-overlay/<year>.mjs` | the overlay: rule effects, the department map, `DECIDED`, roles | hand ([overlay.md](overlay.md)) |
| `test/sc1/oracle-<year>.node.mjs` | the SC1 oracle | a fresh author ([brief-oracle.md](brief-oracle.md)) |
| `registers/<year>.md` | the register | the maintainer's rulings ([register.md](register.md)) |

`data/ng-reasons.json` (`node scripts/build-ng-reasons.mjs`) takes its dates from the manifest.
The year itself is written in three places only: `DEFAULT_ACAD_YEAR` in `scripts/lib.mjs`,
`public/year.js` and the header in `public/index.html` (`test/year-scan.node.test.js`).

## The sources archive and its key

NUS's documents can't be fetched by a script, and they are not in the repo. Each revision's set
goes into one AES-256-GCM archive, a GitHub release asset `sources-<year>-<yyyymmdd>`, whose sha256
and each file's sha256 the manifest lists (`scripts/sources.mjs`).

```bash
npm run sources -- keygen --out ~/.config/vnm/sources-archive.key   # once: a random 256-bit key, mode 0600, never printed
npm run sources -- hash --from <dir>                                # each file's sha256, for the manifest
npm run sources -- publish --from <dir> [<year>] [--revision <date>] # refuses a document still to confirm, a sha256 that differs, an archive that exists, a name that is a path
npm run sources -- restore [<year>] [--revision <date>] [--out <dir>] # unpacks into a temp dir and prints it
```

Every document's `file` and `text` is a plain base name: no `/`, `\`, `..`, absolute path or NUL
(red team L-4); `year check`, publish and restore refuse any other, and restore checks each archive
entry's name before writing. A document's `text` is its pdftotext extraction, archived with it;
publish writes its sha256 into the manifest as `textSha256` (red team L-5), and restore,
`year check --full` and the restrictions builder refuse a text that differs. List `text` in the
revision before publishing and leave `textSha256` out: publish fills it in.

The key is read from `--key <path>`, else `VNM_SOURCES_KEY_FILE`, else
`~/.config/vnm/sources-archive.key`; never from the holdout key's path. Back it up in Bitwarden
Secrets Manager as `nusmodfinder/sources-archive-key` (project `apps`) the day it is made.
Losing it blocks the next source change (`year check --full` and the builder need the documents),
not deploys: a hotfix that touches no source-derived input needs no key.

## A corpus-only refresh (NUSMods changed)

The most common refresh: NUSMods' data for the live year changed (courses added or dropped, a
timetable or a description edited) and no NUS document did. The weekly drift check opens the issue
"NUSMods data for <year> differs from production" and links here. The year, the NG files, the rules
and the oracle stay as they are, so there are no sources, no transcription, no key and no
`year check --full`.

1. **On a branch from `main`, on the Mac: the new corpus.**
   ```bash
   npm run corpus -- fetch                          # the live year's moduleInfo.json into .data/staging/
   npm run corpus -- publish --new-data-version     # a new release asset prod-<year>-<yyyymmdd>, made `current` in data/corpus.json
   ```
   `publish` leaves a run record; commit it with `data/corpus.json`.
2. **The bundle and the per-corpus files.**
   ```bash
   node scripts/vectors.mjs data-version                                  # "<rows> rows, data version <dv>": the rows ingest will write
   node scripts/vectors.mjs build --corpus production --expect-count <rows>
   ```
   New or edited course texts have no vector yet, so the first build stops: it writes
   `.data/vectors/missing-production.json` and prints the next two commands. Embed those texts
   (Workers AI; the neurons are logged, a few per text), then build again with the cache:
   ```bash
   npm run eval:embed -- --texts .data/vectors/missing-production.json --out .data/vectors/extra-production.json
   node scripts/vectors.mjs build --corpus production --expect-count <rows> --extra .data/vectors/extra-production.json
   ```
   Then upload the bundle with the `gh release create …` line the build prints. The build rewrites
   `data/vectors.json`, `src/data-version.json`, `data/vocabulary.json`, `data/groups.json`,
   `data/ng-unscheduled.json` and the 3B files (`data/prefixes.json`, `data/catalogue-codes.json`,
   `data/catalogue-only.json`).
3. **Checks.**
   ```bash
   node scripts/build-groups.mjs --corpus production --check
   node scripts/build-ng-unscheduled.mjs --corpus production --check
   npm run corpus -- check
   npm run year -- check
   ```
   `data/ng-unscheduled.json` follows the corpus, so its change needs no `year check --full`
   record. If the diff touches any other `data/ng-*` file or `scripts/ng-overlay/`, it is a source
   change: see "A mid-year revision" below.
4. **PR.** Commit the files above (`docs/REFERENCE.md`, "Re-ingesting for a new acad year", step 1,
   lists them). CI runs `sc1` over the new `current` and `rollover`. Merge when green. Nothing
   deploys yet: the deploy guard refuses until D1 matches.
5. **Before any D1 write**, on merged `main`:
   ```bash
   npm run deploy -- --preflight
   npm run d1:bookmark
   ```
6. **Ingest and verify.** Same year, so no `--allow-year-change`. Ingest rewrites only the rows
   whose hash changed, and the catalogue-only rows that changed. The default 40,000-row budget
   covers even a rewrite of every module (about 37.3k charged). If it stops at the budget (exit 2),
   rerun the same command: it resumes. If more than 5% of D1's codes leave the corpus, in the
   modules or in `catalogue_only`, it refuses before any write until you pass
   `--allow-mass-delete` for a drop you've checked.
   ```bash
   npm run remote -- ingest --d1-only
   npm run remote -- verify --pre-deploy
   ```
7. **Deploy and smoke.**
   ```bash
   npm run deploy
   npm run smoke
   ```
8. **Standby.**
   ```bash
   npm run remote -- vectors standby
   npm run remote -- verify
   ```
9. **The issue closes itself** at the next weekly check, once production's data version matches
   NUSMods'. Commit the run records the steps left.

On failure, as below: ingest done and deploy refused, `npm run d1:restore`, fix the cause, resume
from step 5; deploy done and smoke failing, `npm run d1:restore`, `npm run rollback`,
`npm run smoke -- --expect <target sha>`.

## A year switch

1. **When.** NUSMods has the new year, and NUS has published its Sem 1 NG list (July, G2). The
   monthly reminder issue prompts the check. Sem 2 may be unpublished: set
   `published.ngList["2"]` to `false` and exchange mode shows last year's Sem 2 list, each course
   "On NUS's <last> list; NUS hasn't published <this year>'s yet", to confirm, never open
   (`ng:unpublished-sem`). Courses not on last year's Sem 2 list stay hidden
   (`ng:unpublished-sem-unlisted`).
2. **Scaffold.** `npm run year -- next <yyyy-yyyy>` writes the year's manifest, NG files, overlay,
   oracle and register as stubs, each from last year's, and never overwrites a file. A stub fails
   `year check`, and ingest refuses a stub or missing NG file.
3. **Sources.** Save each document by hand into a new directory (never a default one).
   `npm run sources -- hash --from <dir>`; fill in the revision's documents and dates in the
   manifest; `npm run sources -- publish --from <dir>`; commit the manifest.
4. **Transcription.** Two transcribers, each with only the restrictions PDF and its text
   ([brief-transcription.md](brief-transcription.md)). Then:
   `node scripts/transcription-diff.mjs <a.json> <b.json>` (the facts they disagree on), and
   `node scripts/transcription-diff.mjs <new.json> --map-to <last year's>` (last year's id where
   the quote matches; renamed, ambiguous, new and dropped rules for review). Each open reading goes
   to the register with the maintainer's ruling, before the oracle's author starts
   ([register.md](register.md)).
5. **Corpus and rules.**
   ```bash
   npm run corpus -- fetch <yyyy-yyyy>
   npm run corpus -- publish --new-data-version
   python3 -m venv .venv && .venv/bin/pip install pypdf                     # once; --full needs it too
   .venv/bin/python scripts/extract-ng.py <dir>/ng-courses.pdf --year <yyyy-yyyy>   # keeps only the year's sections; fails on a published semester with none
   npm run sources -- restore                                               # prints <restored dir>
   node scripts/build-ng-restrictions.mjs --sources <restored dir>          # after the overlay (overlay.md)
   node scripts/build-ng-reasons.mjs
   ```
   Then `DEFAULT_ACAD_YEAR`, `public/year.js` and the header, and YST's text with
   `node scripts/yst-text.mjs <page.html> --out <page.txt>`.
6. **Oracle.** A fresh author rewrites the sections whose rules changed, from last year's oracle
   ([brief-oracle.md](brief-oracle.md)). Then agreement: `npm run test:sc1` must find no
   difference. Classify each disagreement and fix it at its source: a transcription error in the
   transcription, a ruling in the register, a rules bug in the overlay or builder, an oracle bug by
   a fresh oracle author (never by whoever wrote the rules).
7. **Checks.** `npm run year -- check --full` restores the archive, finds every indexed quote in
   its document word for word, re-extracts `data/ng-courses-<year>.json` from the archived NG list
   PDF with `.venv/bin/python scripts/extract-ng.py` and requires it byte for byte (its semester
   sections included; the record names each section's count), and rebuilds the rules file byte for
   byte. Without `.venv/bin/python` and `pypdf` it refuses, printing
   `python3 -m venv .venv && .venv/bin/pip install pypdf`. Commit the run record it writes (the
   deploy preflight needs it whenever a source-derived input changed). Then the bundle:
   `node scripts/vectors.mjs build --corpus production --expect-count <rows>` and the other
   builders (`docs/REFERENCE.md`, "Re-ingesting for a new acad year", step 1).
8. **PR.** CI runs `sc1` and `rollover` on the new year. Merge only when the PR is complete.
9. **Before any D1 write**, on merged `main`:
   ```bash
   npm run deploy -- --preflight
   npm run d1:bookmark
   ```
10. **Ingest and verify.** A year switch rewrites every module row and every `catalogue_only` row
    (their hash includes the year): about 66k rows charged against the 40k default, so pass
    80,000. If a run stops at the budget (exit 2), rerun the same command; the deploy's
    `catalogueKey` check refuses until it completes.
    ```bash
    npm run remote -- ingest --d1-only --allow-year-change --write-budget 80000
    npm run remote -- verify --pre-deploy
    ```
11. **Deploy and smoke.**
    ```bash
    npm run deploy
    npm run smoke
    ```
12. **Standby.**
    ```bash
    npm run remote -- vectors standby
    npm run remote -- verify
    ```
13. **Live checks** with the year's oracle (`docs/REFERENCE.md`, the live probes).

### When something fails

- **Ingest done, deploy refused:** `npm run d1:restore` (the code stays as it was), fix the cause,
  then resume from step 9.
- **Deploy done, smoke failing:** `npm run d1:restore`, then `npm run rollback`, then
  `npm run smoke -- --expect <target sha>`.
- **`year check` fails:** it names the file and the fix. A stale constant: the three year places.
  A date: the manifest or `node scripts/build-ng-reasons.mjs`. A count 25% away from last year's
  in a semester published both years: check the extraction filed each section under its semester.
- **`year check --full` fails on a quote:** NUS changed the sentence, or it was never verbatim. Fix
  the copy in `src/` or `public/` to NUS's words, or mark the quote `unarchived` with the reason
  when its page can't be archived.
- **`year check --full` fails on the NG list:** `data/ng-courses-<year>.json` is not what the
  archived PDF extracts to. Re-extract it from the PDF the revision archives (step 5) rather than
  editing it by hand; a course the extraction misses is a bug in `scripts/extract-ng.py`, fixed
  there (with a test) so `--full` reproduces the file.

## A mid-year revision

A new copy of any source (a new Sem 2 NG list, a new restrictions PDF, YST's Sem 2 page) is the
same list with these changes. A new Sem 2 list or YST page is a revision that sets that semester to
published (`published.ngList["2"]: true`, `published.yst["2"]: "<year>"`).

- **3:** a new revision in the manifest and `npm run sources -- publish --from <dir>`;
  `npm run sources -- restore --revision <previous date>` gives the old set to diff against.
- **4:** both transcribers redo only the changed sections, in a copy of the last transcription;
  the diff shows exactly those sections.
- **5:** the overlay for the changed rules, and the builders.
- **6:** the oracle sections for the changed rules, then agreement.
- **7:** `npm run year -- check --full`, then the bundle. The data version changes, because the
  row hash covers `ng_allow` and `ng_rules`.
- **10:** a row-only `npm run remote -- ingest --d1-only` (no `--allow-year-change`).
- **8, 9, 11–13:** as above.

## Time (*est.*)

A year switch: the source gate about a day, the builds about an hour, CI about 45 minutes, steps
9–13 about two hours; two working days in all, with the re-embed's neurons on a day with nothing
else. A revision: half a day.
