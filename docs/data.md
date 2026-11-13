# Data: the corpus, ingest and the re-ingest runbook

Where course data comes from, how production's corpus is pinned, and how D1, the bundle and the
standby are rewritten when it changes. Exchange-mode data (the NG list and restrictions) is in
[exchange-mode.md](exchange-mode.md); the yearly switch is [year-refresh/](year-refresh/README.md).

## The source

[NUSMods API](https://api.nusmods.com/v2/): statically generated JSON, scraped daily from NUS's
own systems. It is **community-maintained and unofficial; NUS does not run it.** The ingest
script validates that the expected keys are present and aborts rather than writing malformed rows
if the shape changes.

Only modules with at least one `semesterData` entry are indexed; the rest are catalogue entries
not offered this year (D1's `catalogue_only`). <!-- year:pinned --> In the pinned 2026/27
snapshot that is 6,771 of the 21,130 records in `moduleInfo.json`. Production's counts follow
`current` in `data/corpus.json`.

## The corpus manifest

`data/corpus.json` lists every production corpus by its GitHub release asset
(`prod-<year>-<yyyymmdd>`, the gzipped `moduleInfo.json`; ADR 0014 for the licence) with its
sha256, size and the time NUSMods served it, and names `current`, the one production runs on.
Ingest, `vectors.mjs build --corpus production`, `vectors.mjs data-version`, every per-corpus
builder (`build-vocabulary`, `build-groups`, `build-ng-unscheduled`,
`build-catalogue-data --corpus production`) and the live checks read only `current`, from
`.data/prod/<sha256>.json`, sha-checked, with the NG files of its year; none fetches from NUSMods,
and a missing or mismatched file is refused with the command that fixes it.

```bash
npm run corpus -- restore            # current from its release asset into .data/prod/ (gh, sha-checked); any worktree
npm run corpus -- check              # CI: data version and catalogueKey follow current; the catalogue files are fresh
npm run corpus -- fetch [<year>]     # NUSMods' moduleInfo.json into .data/staging/ (the only fetch)
npm run corpus -- publish [--file <path>] [--fetched-at <iso>] [--new-data-version]
                                     # the staged (or --file) corpus as the next release asset and current
```

`publish` refuses a corpus whose data version (with HEAD's NG files) is not
`src/data-version.json` unless `--new-data-version`, and a release the manifest already lists; it
writes a run record. Commit `data/corpus.json` after it. The eval's pinned snapshot
(`.data/2026-2027-moduleInfo.json`, `scripts/pinned-corpus.mjs`) is separate and never moves.
`scripts/probe.mjs` (`npm run probe`) uses its own `.data/cache/` download.

### The catalogue files

`data/prefixes.json`, `data/catalogue-codes.json` (the `catalogue-codes-data` and
`prefixes-data` aliases) and `data/catalogue-only.json` are built from `current` by
`scripts/build-catalogue-data.mjs`; `data/pinned/` holds the pinned corpus's two files, which the
eval, the Worker tests and the full-corpus tests read. `catalogueKey` (`src/rowhash.js`) is the
sha256 of the sorted catalogue codes; `/admin/hashes` and `verify --pre-deploy` report D1's, from
its `catalogue_only` codes, and the deploy guard and `verify --pre-deploy` refuse one that is not
the bundled file's (`scripts/catalogue-check.mjs`).

### Course reviews

`data/reviews.json` holds each course's review scores from its NUSMods comments (ADR 0018), one
line per course: `n` reviews, the `latest` academic year one is about, and the age-weighted 1-5
`overall`, `workload`, `difficulty` and `teaching` (`null` where reviews don't say). The Worker
bundles it (`src/reviews.js`) and `/search` returns each result's entry as `reviews`. Rebuild it
on the Mac with `npm run reviews -- crawl`, then `score`, then `build`, and commit the file with
the run records:

- `crawl` pages NUSMods' Disqus forum (`nusmods-prod`) through Disqus's public API, 100 threads or
  comments per request, 2 s apart, into `.data/reviews/crawl/`; it resumes from its cursor files,
  so delete them to crawl afresh.
- `score` sends each course's comments to Claude Haiku 5.5 (an `ANTHROPIC_API_KEY` or an `ant
  auth` profile), six requests at a time, into `.data/reviews/scores/`. It sends no request whose
  estimate, with what is spent, in flight and failed, would pass `--max-usd` (default 10; a
  whole-forum pass cost $2.73), and leaves those for the next run. It skips chunks already scored
  in full, so run it again to re-send any that failed, came back short or were left at the cap;
  `--limit N` sends only N.
- `build` keeps reviews with an overall score and a year (questions, replies and hearsay
  dropped), counts a repeated review once, reads the year a review names in the forms students
  write ("AY22/23", "AY2022/23", "S2 AY19/20", "2020-2021", "AY1516") unless it is after the
  posting date, else uses the posting date, weights each by age and writes the file. It reads
  only `.data/`.

No comment text goes into the repo. The scores change only when someone reruns the three steps;
the page's aria snapshots hold some of them, so re-pin those after a rebuild
(`VNM_ARIA_UPDATE=1 npx playwright test aria --project chromium`).

## Re-ingesting

Ingest is a local Node script by design: `moduleInfo.json` is about 19 MB, and parsing it inside
a Worker would crowd the 128 MB memory ceiling. Embedding and upserting happen *in* the Worker,
over authenticated admin routes, so no Cloudflare API token has to exist on disk.

**The runbook.** The same order for every corpus change: a catalogue update, a re-embedding, a
row-only change (ADR 0006). Step by step for the two common cases:
[year-refresh/README.md](year-refresh/README.md), "A corpus-only refresh" (NUSMods changed; the
weekly drift issue links there) and "A year switch". The deploy guard refuses any commit whose
manifest D1 does not yet hold, so the manifest merges first and D1 is written before the deploy.
Vectorize, the standby, is written last.

```bash
# 0. A new corpus (a catalogue update, a new acad year): fetch it, then publish it as the next
#    entry of data/corpus.json. --new-data-version because its rows differ from what
#    src/data-version.json records; step 1 writes the new one.
npm run corpus -- fetch [<year>]
npm run corpus -- publish --new-data-version
#    Any other change starts from the corpus production already has:
npm run corpus -- restore
# 1. Offline, on a branch: the production bundle and the data version D1 will have.
node scripts/vectors.mjs data-version                              # what ingest would write
node scripts/vectors.mjs build --corpus production --expect-count <rows>
#    If texts are missing from the eval asset, it writes .data/vectors/missing-production.json
#    and stops; embed them (neurons recorded in the run record), then rebuild with --extra:
npm run eval:embed -- --texts .data/vectors/missing-production.json --out .data/vectors/extra-production.json
node scripts/vectors.mjs build --corpus production --expect-count <rows> --extra .data/vectors/extra-production.json
gh release create <release> .data/vectors/<asset> --title <asset> --notes "vectors bundle, sha256 <sha256>"
#    For a new acad year, rebuild the reason texts from that year's rules file first:
node scripts/build-ng-reasons.mjs
#    The build rewrites the NG-listed codes with no classes too; both checks must pass:
node scripts/build-groups.mjs --corpus production --check
node scripts/build-ng-unscheduled.mjs --corpus production --check
npm run corpus -- check   # the data version and catalogueKey follow current; the catalogue files are fresh
git add data/corpus.json data/vectors.json src/data-version.json data/vocabulary.json data/groups.json data/ng-unscheduled.json data/ng-reasons.json data/prefixes.json data/catalogue-codes.json data/catalogue-only.json   # plus any code the change needs; open a PR
#    A new acad year changes DEFAULT_ACAD_YEAR in scripts/lib.mjs, public/year.js and the header
#    in public/index.html, the only places in code a year is written (test/year-scan.node.test.js
#    fails on any other and checks those three agree; a year's own overlay and oracle files are
#    exempt). The docs' <!-- year:live --> sentences change too (test/docs-facts.node.test.js;
#    docs/year-refresh/README.md step 7). The whole year switch, sources to standby, is
#    docs/year-refresh/README.md; it passes --write-budget 80000 at step 4, since every module
#    and catalogue_only row is rewritten.
# 2. Merge it. Nothing deploys yet: the guard refuses until D1 matches.
# 3. On merged main, before any D1 write: the preflight (every check but D1's), then D1's
#    Time Travel bookmark, recorded (ingest copies it; d1:restore returns to it for 30 days).
npm run deploy -- --preflight
npm run d1:bookmark
#    Steps 4, 5 and 8 each start their own wrangler dev --remote session through npm run remote:
#    a free port, a one-off INGEST_SECRET in a temp env file, code 10021 retried for up to 30 min,
#    the session stopped when the command ends. Nothing reads or writes .dev.vars.
# 4. D1 only: no Workers AI, no Vectorize. Reads only current (restored, sha-checked); refuses
#    unless it hashes to the committed data version.
npm run remote -- ingest --d1-only
# 5. D1 against the manifest and the bundle, before the deploy. Reads no Vectorize. Also checks
#    data/ng-reasons.json's and data/ng-unscheduled.json's acadYear equal D1's acad_year, that the
#    latter holds exactly the NG codes with no D1 row, and that D1's catalogueKey (its
#    catalogue_only codes) equals data/catalogue-codes.json's; the deploy guard checks it too.
npm run remote -- verify --pre-deploy
# 6. Preflight, guard (over the D1 REST query; no session), startup gate, promote, tag, triggers.
npm run deploy
# 7. Smoke: five checks, >= 4 s apart. On failure: npm run d1:restore, then npm run rollback,
#    then npm run smoke -- --expect <target sha>. Deploy refused after step 4: npm run d1:restore,
#    fix the cause, resume from step 3.
npm run smoke
# 8. The standby: upsert every code (bundle values, D1 metadata, ≤ 1,000 a batch), delete
#    every index id D1 no longer holds, wait for the mutation, then verify, values included.
npm run remote -- vectors standby
```

Steps 4, 5, 6 and 8 leave run records in `ops/runs/` (`npm run remote` writes one for the
session, and the command its own); commit them with the change that follows. Steps 3, 6 and 7
leave theirs too (`deploy:preflight`, `d1:bookmark`, `deploy`, `smoke`); `ingest` warns when
`HEAD` has no preflight record. Between steps 4 and 6 the live Worker searches its old bundle
against the new D1, so `/search` re-checks every dense-only candidate's filters against its fresh
D1 row after hydrate and drops those that fail. Its old groups and `ng-unscheduled.json` sit
beside the new rows too: a code that gained a row answers from the row, and `otherCodes` is only
compared within one shortlist.

`npm run ingest` without `--d1-only` embeds and upserts as described below, for a database with no
bundle to match (a local one, or a cold load).

Before any remote write, estimate it and check the month's account-wide D1 usage (ADR 0004):
proceed only if the estimate × 1.5 fits in the remaining included writes.

A run for a different acad year than D1 holds is refused unless you pass `--allow-year-change`
(it rewrites every row to the new year). Pass `--allow-mass-delete` as well if more than 5% of
the codes D1 holds leave the corpus, in `modules` or in `catalogue_only`; without it the run is
refused before any write.

**What a run does.** It compares two hashes per module with what D1 holds
(`GET /admin/hashes`): `text_hash` (embedding model + embedded-text version + text) and
`row_hash` (normaliser version + every column D1 stores + the Vectorize metadata).
`/admin/hashes` and `GET /admin/catalogue` recompute each stored row's hash from its columns and
answer null where the stored `row_hash` differs, so a row changed behind its hash (a hand
`d1 execute`) is rewritten by the next run.

- Text changed: the module is re-embedded, then the vector and the row are upserted.
- Only the row changed: the row is rewritten, and the vector is re-upserted with its stored
  values under the new metadata. There is no new embedding, unless the stored vector's
  `metadata.textHash` is not the module's `text_hash` (a vector written before `textHash` was
  stored, or one Vectorize has not yet replaced with a newer embedding). Then the module is
  re-embedded, so old values never overwrite a pending new embedding.
- Unchanged: skipped. A rerun with nothing changed writes nothing but the facets row.
- Codes D1 holds that the corpus no longer offers are deleted through `/admin/delete`: their
  hashes are cleared in D1, then Vectorize deletes the vectors, then D1 deletes the rows. If the
  D1 delete fails and the module comes back, its cleared hash makes ingest re-embed it. Deletes
  run last, and only if every upsert batch succeeded.

The run then rebuilds the facets row and waits, by polling `describe()`, until Vectorize has
processed its last mutation. Only then does it write `src/data-version.json`, the `/search`
cache-key version (a hash of every code and row hash). Every mutation id is saved in
`.data/ingest-state.json` (git-ignored, per `--url`) as it is sent, with the Worker's `Date.now()`
when Vectorize accepted it (`sentAt`), and cleared only once a wait confirms it. The wait is
satisfied when `processedUpToMutation` is that id, or when `processedUpToDatetime` is later than
`sentAt`: Vectorize processes mutations in order, so a later one being processed covers it, even
when another client (another `--url` to the same index) mutated the index since and the id never
matches again. Both times come from Cloudflare's clock. The time check never counts one of the
run's own earlier mutations (nor those of a pending mutation it carried over; they are saved with
it as `earlier`): the docs do not say whether `processedUpToDatetime` is when a mutation was
accepted or when it was processed, and in the second reading an earlier batch would pass while
the last is still queued. If a mutating request was retried after a 5xx or a dropped connection,
its first attempt may have queued a mutation whose id never came back, so that run (and any rerun
carrying its entry over) waits by id only (`sentAt` saved as null). A rerun after exit 3 has
nothing to send but still waits for that mutation, and writes `src/data-version.json` only once
it is confirmed. If the state file cannot be written mid-run, the run carries on but ends with
exit 1, naming the mutation ids it could not record, and does not write `src/data-version.json`.

**If a rerun keeps exiting 3.** An entry saved without `sentAt` ends its wait only on the exact
id. Check `npx wrangler vectorize info nusmods-modules`. Once `processedUpToMutation` is the id in
`.data/ingest-state.json`, or `processedUpToDatetime` is later than the time that run ended (its
last mutation was sent before then), delete that URL's entry (or the whole file, if it holds no
other) and rerun the same command. It then has nothing to wait for and writes
`src/data-version.json`. Run `npm run verify` after.

**One run at a time.** A run holds `.data/ingest-state.json.lock` (created exclusively, holding
its pid and a nonce) until it exits. The first Ctrl-C (SIGINT) or SIGTERM stops the run after the
requests in flight, records their mutation ids, releases the lock and exits 130/143; the rerun
waits for those mutations. A second signal stops it at once (a mutation in flight may then go
unrecorded: run `npm run verify` after the rerun). A second `npm run ingest` from the same
checkout refuses with exit 1 and names the pid. If no ingest is running (a run that crashed or was
`kill -9`ed leaves the lock behind; the message says whether the pid is alive, but pids are
reused), delete the lock file and rerun. A run only removes a lock carrying its own nonce.

**Guards.** Each one stops the run before it writes anything:

- the database lacks migration 0006: the schema marker, the external-content FTS table, any of
  its four triggers (`modules_fts_insert`, `_delete`, `_update`, `modules_rowid_immutable`) or
  `row_hash`. Rewriting rows through the old FTS triggers reads about 46M rows, and a missing
  trigger lets the FTS index drift;
- the plan would delete more than 5% of the codes D1 holds, whatever the corpus size (pass
  `--allow-mass-delete` if the drop is real);
- the corpus is for another acad year than most of D1's rows (pass `--allow-year-change`). An
  empty database has no year;
- the corpus mixes acad years or repeats a code;
- the Worker embeds with a different model than `text_hash` assumes.

**Write budget.** `--write-budget` (default 40,000 D1 rows, ADR 0002) charges each admin call the
larger of the `meta.rows_written` it reports and an estimate per module. The estimate includes the
FTS5 shadow-table writes for inserted rows and rows whose code, title or description change, which
local D1 does not report and remote D1 may bill. Which rows those are is decided by `ftsHash`, a
hash of those three columns (the ones the 0006 FTS update trigger watches) that `/admin/hashes`
computes from what D1 stores. It is not decided by `text_hash`, which also changes with the model
or the embedded-text version. Before a batch would pass the budget, the run stops cleanly (exit 2)
and prints how to resume. Rerun the same command: the hash skip sends only what is still pending.
A stopped `--force` run resumes with `--from <code>`.

A forced re-ingest of every module (re-embed and rewrite, no FTS writes) reads about 35,100 rows
locally; D1 reports about 34,400 written, and the budget charges about 37,300, so it finishes in
one run. The `productionStart` step of `test/full/ingest.test.js` rebuilds that state in local D1
and measures it.

**Do not cold-load a remote database with the default budget.** Loading an empty database writes
about 48k table and index rows plus about 89k FTS5 shadow rows, about 137k in all. That fits the
monthly allowance (ADR 0004), but the budget charges about 149k and stops a run at the 40k
default, so pass `--write-budget` explicitly. The remote billing of FTS writes on inserts has not
been measured.

Other flags: `--force` (re-embed and rewrite everything), `--batch`, `--concurrency` and
`--wait-timeout` (default `10m`). Exit codes: 0 done, 1 refused or failed, 2 stopped by the
budget, 3 Vectorize did not confirm the last mutation in time (D1 is complete; rerun the same
command later, then verify).

### The admin routes

`/admin/*` returns 404 unless an `INGEST_SECRET` is bound, and the deployed Worker has none.
Ingest runs locally against `wrangler dev --remote` (`npm run remote`). Do not
`wrangler secret put INGEST_SECRET` unless you intend to expose a write endpoint on the public
URL.
