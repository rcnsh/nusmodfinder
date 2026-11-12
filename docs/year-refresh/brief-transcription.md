# Brief: transcribing the restrictions PDF

For each of the two transcribers of a year's (or a revision's) "Course Restrictions for
Non-Graduating Students" PDF. Phase 4 ran this as step 4B (`docs/evidence/phase4/transcription.md`);
this brief makes the id scheme fixed, so a later year's ids can be matched to last year's.

## What you get, and what you don't

- **You read:** the PDF and its text extraction (`pdftotext -layout`), from the revision's restored
  archive (`npm run sources -- restore`), and this brief.
- **You don't read:** the other transcription, `src/eligibility.js`, the rules file, the overlay
  (`scripts/ng-overlay/`), the oracle or the register. Two people reading the same page without
  seeing each other is how the diff finds a misreading.
- **For a revision:** start from a copy of the last transcription and redo only the sections the
  new PDF changed, so the diff shows exactly those.

## What you write

One JSON file, `{ source, rules, doubts }`, the same schema as
`docs/evidence/phase4/transcription-b.json`:

- `source`: the PDF's file name, sha256 and "updated as at" date.
- `rules`: one entry per rule as printed, in page order:
  - `id`: the id scheme below;
  - `section`: the PDF's section (`A` to `F` for the lettered rules, `1` to `12` for the numbered
    school sections);
  - `department`: the heading as printed, or `null` for a whole-section rule;
  - `page`: the PDF's page number;
  - `kind`: one of `closed`, `open-only-for`, `whitelist`, `info`, `note-approval`, `note-graded`,
    `note-major`, `note-partner`, `note-quota`, `note-fee`, `note-letter`, `note-audition`;
  - `scope`: `{ codes, patterns, levels, school }`: the codes as printed (expand `A/B` cells and
    `PC4288A/Q/N` suffix lists into every code), patterns as printed (`SEA5XXX`), levels as
    thousands (`[5000, 6000]`), the school as printed;
  - `students`: who the sentence applies to (`all-ng`, `ng-undergraduate`, `ng-graduate`, or the
    sentence's own words when it names a group);
  - `quote`: the sentence word for word, with the heading it sits under. The quote is what the id
    map matches years on, so copy it exactly; don't tidy its spelling or punctuation.
- `doubts`: every place the PDF leaves a reading open, each with the page and the two readings.
  Don't resolve them: the maintainer rules on them in the register.

## The id scheme

`<section>-<department>-<rule>`, lower case, hyphens only:

- `<section>`: the section letter or number (`A`, `1`, `12`).
- `<department>`: a short stable name for the heading (`econ`, `elts`, `cee`), left out for a
  whole-section rule (`A-dentistry`, `E-offerings-list`).
- `<rule>`: what the rule closes or notes, by level or kind: `l456-ug` (levels 4000 to 6000,
  undergraduates), `grad-approval`, `quota`, `table` (an unheaded table), `closed-1`, `closed-2` for
  repeats.

Reuse last year's id for the same sentence: `node scripts/transcription-diff.mjs <yours.json>
--map-to <last year's transcription>` lists where your id differs from last year's for a matching
quote. Rename yours to last year's, unless the rule's meaning changed (then it is a new rule, with a
new id, and the overlay and register must handle it).
