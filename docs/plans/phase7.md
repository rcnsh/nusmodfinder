# Phase 7 plan: ops and architecture (r4, after critic round 3, the last)

Goal (exit): **SC9** is met, and stays met through the next academic year's refresh.
- **SC9:** everything in git with CI (tests, lint, eval gate), migrations rebuild the database
  from scratch, and the deployed version is traceable to a commit.
- Phase 0 built most of SC9. This plan measures what stands today (§1) and plans only the gaps.
- Out of scope:
  - launch, the name and domain, and SC10's README pass (Phase 8);
  - search quality (S2, S3, S4, S6; G4);
  - new product features, except the unpublished-semester state if G2 asks for it;
  - running the 2027/28 refresh itself, whose data does not exist yet.

This plan changes no code. Every number marked *est.* is an estimate; every other number comes
from the repo at `a64a024` or from a cited evidence file. Nothing here was measured against
Cloudflare, the live site or GitHub; what needs a remote read is listed in 7-0.

The critic rounds shaped the design (§6). The main choices, with the round that forced each:
- **Ranking lock.** The eval gate is a committed lock of the open-set result lists, statuses
  included, computed by the eval runner.
  - It is checked whenever the eval's inputs (the runner's import closure included) differ from
    those of a commit whose gate passed, or whenever the lock itself changed.
  - A change to the lists needs evidence written after the base lock (r1–r3).
- **CI layout.** Every CI job always starts and skips by steps. `main` diffs against its last
  green run (r1).
- **Corpus manifest.** The production corpus is a sha-checked release asset in a manifest. Ingest,
  the bundle and every per-corpus file read only that asset, never the Mac's cache (r2).
- **Pinned NG files for the eval.** The eval reads pinned copies of the 2026/27 NG list and
  restrictions, so the live files can be revised (r2, r3).
- **Year switch.** It has a D1 restore, a write budget, and a state for a semester NUS hasn't
  published yet (G2) (r3).
- **Per-year source gate.** The source gate becomes a per-year procedure: a manifest, a stable
  rule-id scheme, overlay roles instead of hard-coded ids, an oracle selector, briefs, and an
  encrypted archive of NUS's source documents (G5) (r1, r2).
- **Rollback.** Rollback checks D1's data version and `catalogueKey` itself, with direct reads
  rather than a flag (r1–r3).

r4 applies round 3's objections and has not itself been critiqued; the lead stops at three rounds
(§6).

## 1. Facts gathered

### SC9 today, item by item
| SC9 item | Today | Gap |
|---|---|---|
| Everything in git | Code, migrations, data files, evidence and the eval sets are in git, with the holdout as ciphertext. Large inputs are GitHub release assets with their sha256 in git: the pinned corpus (`data-2026-2027-20260904`, `.github/workflows/ci.yml`), the vectors bundles (`data/vectors.json`) and the corpus embeddings (`eval/embeddings.json`). | The production corpus D1 holds (`.data/cache/2026-2027-moduleInfo.json`, fetched 2026-11-04 06:29 UTC, 6,778 offered) is only on the Mac. T3 worktrees have no `.data/`. The Registrar PDFs, YST pages and the Law image live in `~/.config/vnm/sources/<date>/`, with their sha256 in `docs/evidence/phase4/sources.md`. `build-ng-restrictions.mjs` hashes each one and refuses a missing file (`:25,270-281`). Turning YST's HTML into text has no script, only a description (`sources.md:26`), yet the YST parser depends on that exact line format (`:298-310`). So the JSON in git serves the site, but rebuilding the rules or seeing what a revised PDF changed needs the Mac. The holdout key stays out of git by design (ADR 0003). |
| CI: tests | `ci.yml` runs four jobs. `check` covers lint, typecheck, types drift, `npm test`, the eval self-test, the ciphertext check and the rebuild check. The others are `full-corpus`, `sc1` and `ui` (Chromium and WebKit). `findings.yml` runs on every change. | `ci.yml` ignores `docs/*.md`, `docs/decisions/**` and root `*.md` (`ci.yml:6,10`). Yet `npm test` reads `docs/REFERENCE.md` (`test/findings/source.node.test.js:15`), `EVAL.md` (`:92`), ADR 0001 (`test/migrations.node.test.js:36`) and ADR 0003 (`test/eval/lock.node.test.js:14`, `test/eval/gate.node.test.js:439`, `test/eval/baseline.node.test.js:20`). So a PR that edits only one of those files merges with no test run, and `main` can go red without anyone seeing it. |
| CI: lint | `eslint .` in `check`. | none |
| CI: eval gate | `check` runs `npm run test:eval` (the harness on a synthetic fixture set) and `eval:verify` (ciphertext hashes). | **Not enforced.** Nothing in CI compares HEAD's ranking with the shipped ranker. Every ship ran the open-set comparison by hand: dev lists filtered, `ng`-stripped and unfiltered, plus the eval fixture (ADR 0003's pin lines). The custodian then ran the holdout count. A ranking change that skipped all this would merge green. FINDINGS O2 still says "An eval gate in CI (SC9) is still open". |
| Migrations rebuild from scratch | `npm run db:rebuild-check` (`scripts/schema-snapshot.mjs`) builds three local databases, all in `check`:<br>• 0001–0005, against the Phase 0 capture of the old WEUR database;<br>• the old recipe, from `3b18041`;<br>• every file in `migrations/`, against `test/fixtures/schema-0006.json` (pragma rows, `sqlite_master`, `index_xinfo`).<br>The data side (migrations, then a cold ingest, then verify) is covered locally by `test/full/ingest.test.js:109`. | The full-chain snapshot is written by the script itself (`-- --update`), and nobody has compared it with production. `nusmods-apac` got 0001–0006 from `wrangler d1 migrations apply --remote` (ADR 0005). It got 0007–0010 as hand-run files, each with its `d1_migrations` row (`scripts/remote-migration.mjs`, e.g. `docs/evidence/phase5/remote-ops.md:19`), and 0008 went in before 0007 (`docs/evidence/phase3/remote-ops.md:55,138`). The snapshot's file name still says 0006. |
| Deployed version traceable | `npm run deploy` refuses a dirty tree or a HEAD that isn't on `origin/main`. It uploads with `--tag <short sha>`. `/health` returns `versionTag`, `versionId`, `dataVersion` and the bundle's corpus. `p5-live` checks that the tag is a prefix of HEAD. | Deploy never checks that the commit passed CI. A HEAD behind `origin/main` gets only a note (`scripts/deploy.mjs:216-218`). Version ids and rollback targets are typed by hand into each phase's `remote-ops.md`. Nothing on the git side records which commits were deployed. |
| Rollback | `wrangler rollback <id>` is run by hand, with the id taken from `remote-ops.md` (`docs/REFERENCE.md:504-505`). It rolls back code only. Wrangler leaves bound resources alone, so D1 comes back separately, from a Time Travel bookmark that is noted by hand. | There is no script, and rollback has never been drilled. The rename created a new Worker, so nothing before `59986aa3` can be a rollback target (`docs/evidence/phase5/remote-ops.md`, "the Worker renamed"). A rollback across a data change would run an old bundle against new D1 rows. That is the mismatch the deploy guard exists to stop (`deploy.mjs:250-263`). |

### State of production and `main`
- Live: version `b0834844` (tag `a23601d`), the Phase 6 red-team follow-up. The previous version
  was `f8aefeab`. The shipped-ranker pin is `a23601d` (`eval/lib/baseline.mjs:37`). Phase 6 is
  closed (`docs/evidence/phase6/exit.md`).
- `main` (`a64a024`) differs from the live code only in docs and eval records.

### Manual and fragile ops steps, from the evidence
- **The `.dev.vars` swap.** Runbook step 3 writes the one-off secret over `.dev.vars`
  (`docs/REFERENCE.md:625`) and starts `wrangler dev --remote --port 8791` by hand. For the
  Phase 6 ship, Jacob's `.dev.vars` had to be backed up and restored around that step
  (`docs/evidence/phase6/remote-ops.md`, 18:38). `deploy.mjs`'s guard already does this
  properly: it uses a 0600 env file in a temp dir and a free port (`:132-162`).
- **The localhost:8787 defaults.** `scripts/ingest.mjs:227`, `scripts/verify.mjs:107` and
  `scripts/vectors.mjs:244` default to `http://localhost:8787`. Another project owns that port on
  the dev Mac (`scripts/ui-server.mjs:36` refuses it). Run without `--url`, these scripts send the
  `INGEST_SECRET` bearer to whatever is listening there.
- **Remote-ops logs and `requests.tsv` are typed by hand, and they drift.**
  - Rows 124, 125 and 127 of `docs/evidence/requests.tsv` and two Phase 6 log headings say
    2026-11-12 with UTC times, but those events took place on 2026-11-11 UTC. `0b5f360` was
    committed at 18:37 UTC and `a23601d` at 23:58 UTC, both on 11-11.
  - Two deploys have no rows: the ADR 0009 ship (`a6103634`, tag `a7b90f4`, with two `p5-live`
    runs of about 100 calls each) and the rename (`59986aa3`, 3 smoke calls and a 99-call
    `p5-live`). Both appear in `docs/evidence/phase5/remote-ops.md`, but in `requests.tsv`
    row 123 (09:46 UTC) runs straight into the Phase 6 rows.
  - Rows 1 to about 100 are in an older format, with `b1`-style ids and no date column.
- **`wrangler dev --remote` is flaky to start.** For the ADR 0009 deploy, the guard failed with
  Cloudflare `code 10021` and took 8 manual retries over 25 minutes.
- **Smoke checks are curl by hand**, with a different set each time (rows 114, 116, 120–122, 124).
  A repeated `/search` is a cache hit for an hour (`src/search.js:59,262`), so it touches neither
  D1 nor the bundle.
- **No D1 bookmark is recorded by a script.** Restoring one is a D1 write.

### The yearly data refresh
A new academic year today needs the following (`docs/REFERENCE.md` "Re-ingesting" and "When a
source changes"):
1. **NUSMods' new year.** `npm run ingest` fetches it. NUSMods is unofficial and community-run.
2. **The Registrar's NG list and restrictions PDFs**, downloaded by hand (NUS blocks automated
   fetching) into `~/.config/vnm/sources/<date>/`. Then comes Phase 4's 4F gate, which is tied to
   2026/27 in code:
   - `scripts/extract-ng.py` files rows under the last semester heading it matched. A heading
     its `SECTION_RE` misses (`:26`) puts the next semester's codes under the previous one, and the
     script fails only on zero sections (`:63`).
   - `scripts/build-ng-restrictions.mjs` reads one fixed transcription
     (`docs/evidence/phase4/transcription-b.json`, `:314`). That transcription must match a
     hand-written `OVERLAY` of 2026/27 rule ids exactly (`:78-257`, check at `:317`). The script
     also hard-codes `ACAD_YEAR` (`:22`), its sources folder (`:25`) and the PDF-to-NUSMods
     department names (`DEPT`, `:33`).
   - The SC1 oracle (`test/sc1/oracle.node.mjs`, 758 lines) is written by hand for "AY2026/27",
     from the PDFs and the interpretation register. Jacob ruled on the register's open readings
     (`docs/evidence/phase4/interpretations.md`).
   - No brief for the transcribers or the oracle author is in the repo. The only brief is the red
     team's.
   - Rule ids are not stable between transcribers: 43 of 132 differ between transcriptions A and
     B (e.g. `C-urops-fass` and `C-urop-fass`). The builder hard-codes `'A-self-funded'` (`:365`),
     and the page hard-codes `'E-offerings-list'` (`public/shortlist.js:178`).
   - `extract-ng.py` takes the academic year from the last section heading (`:51`). The 2026 PDF
     lists Sem 2 first (`docs/evidence/phase6/facts.md:103`).
   - The oracle's 24 calls on points the register leaves open (its D1–D24) sit only in its header.
     Several register rows name 2026 codes (C1, C3, C4, C5, I14). `TWINS`, `DECIDED` and
     `LAW_COMPULSORY` live in the builder (`:56,60,261`), and the oracle repeats the twins
     (`oracle.node.mjs:218`).
   - Six files outside `test/sc1` import the oracle directly: `scripts/p5-live-plan.mjs:11`,
     `scripts/p6-live-plan.mjs:10`, `docs/evidence/phase4/ship-oracle.mjs:13`,
     `test/exchange.test.js:14`, `test/search-fields.test.js:17` and `test/shortlist-sc1.js:15`.
   - NUS's own sentences are hand-copied into code, outside any source file: GRO's level-4000
     sentence and the Law exception (`src/level-note.js:34,42`), rule E's quote, GRO's
     popular-courses and Economics/Law lines, and the 13 CourseReg-box quotes
     (`public/shortlist.js:63,67,152-166,347`). No check ties them to a saved source.
   - The eval reads `data/ng-courses-2026-2027.json` from the ranker tree and records its raw
     sha256 (`eval/lib/corpus.mjs:42-45`). The dev qrels carry that sha256, and `metrics.mjs:242`
     refuses a mismatch. Any edit to that file, a header or a Registrar revision alike, breaks every
     eval report and the custodian's looks.
   - The "updated as at" dates are revision dates, not publication dates. The restrictions PDF
     also carries a 19 March 2025 footer (`docs/evidence/phase4/transcription.md:38`).
     `ng-courses-<year>.json` records no source sha256.
3. **Year literals, edited by hand:**
   - `scripts/lib.mjs:23` (`DEFAULT_ACAD_YEAR`);
   - `scripts/build-ng-restrictions.mjs:22,25`;
   - `public/year.js:9` and `public/index.html:44`;
   - the semester months in `public/app.js:166` ("Aug–Dec 2026", "Jan–May 2027") and their aria
     snapshots (`test/ui/aria.spec.js-snapshots/first-screen-*.aria.yml`);
   - the source dates in `scripts/build-ng-reasons.mjs:53-54`;
   - the runbook's `--year 2026-2027` (`docs/REFERENCE.md:628`);
   - the year-named data files.

   A test checks `public/year.js` and the header against `data/ng-reasons.json`. Nothing checks the
   rest.
4. **Files built from the pinned 2026-09-04 corpus, which never follow production.**
   `data/catalogue-codes.json` and `data/prefixes.json` (`scripts/build-3b-data.mjs`) are bundled
   into the Worker (`src/intent-data.js:15`). This is B12-open: 162 catalogue-only codes added since
   the pin get search's unknown-code answer, while `/module` calls them catalogue-only. In a new
   year, every new prefix and every catalogue change would be missing too. Neither the guard nor
   `verify --pre-deploy` compares the catalogue with D1.
5. **CI tests the pinned year, not the live one.** `full-corpus` and `sc1` run over the pinned
   2026-2027 corpus and bundle. `test/sc1/identity.test.js:63` and `paths.test.js:76` skip unless
   the bundle is the pinned one, and the `sc1` project shares the pinned aliases
   (`vitest.config.mjs:140-147`). The SC1 oracle test sits in `full-corpus`, not `sc1`.
   `test/full/sc1-oracle.node.test.js:18` and
   `test/eligibility.node.test.js:14` name `ng-restrictions-2026-2027.json`. Only the pinned
   snapshot is checked to see whether the rules' department and faculty names still exist in
   NUSMods (`sc1-oracle.node.test.js:68-78`). If NUSMods renamed a department, the closed rule would
   match nothing. The oracle matches on the same strings (its D3), so CI would stay green while those
   courses showed as open.
6. **The runbook's eight steps**, in order:
   - the bundle build, embedding missing texts (neurons logged), the release asset;
   - rebuilding the vocabulary, groups and `ng-unscheduled`;
   - the PR, the D1 bookmark, the `.dev.vars` swap;
   - `ingest --d1-only --allow-year-change`, probably with `--allow-mass-delete` too;
   - `verify --pre-deploy`, the deploy, the smoke check, the Vectorize standby, verify.

   `vectors.mjs build --year Y` writes `ng-unscheduled` for `DEFAULT_ACAD_YEAR`, whatever Y is
   (`scripts/build-ng-unscheduled.mjs:158`).
7. **A missing NG file closes every course, and nothing stops it.** Ingest only warns
   (`scripts/lib.mjs:277`, `docs/REFERENCE.md:175-176`): `ingest`, `verify --pre-deploy` and the
   deploy would all pass with exchange mode showing everything closed.
8. **The refresh is several events a year, not one, and NUS publishes in stages.**
   - Sem 1 and full-year applicants apply from 21 March to 10 April and get results in late May
     (`docs/evidence/phase6/facts.md:120-121`).
   - NUS publishes Sem 1's exchange list in March or April and Sem 2's later. The timetable comes
     in July or August; the Registrar says mid-July (`public/shortlist.js:142`).
   - The restrictions PDF names no academic year, so no "2027/28 restrictions" document will ever
     appear; only revisions of the one in force.
   - YST's Sem 2 page had not appeared by 10 November 2026 (`sources.md:17`).
   - Each revision repeats the 4F gate for the changed sections, plus a row-only re-ingest.
   - Today, a semester with no NG list reads "Offered to exchange students only in the other
     semester" (`build-ng-reasons.mjs:21`), which would be false for a list NUS hasn't published
     yet.
9. **Ingest and the bundle build read only the Mac's cache.** `npm run ingest` reads
   `.data/cache` (`scripts/ingest.mjs:24,322`, `scripts/lib.mjs:95-96`), and so does
   `vectors.mjs build` (`:16-25`). Ingest's D1-only check covers the offered modules' data version
   only (`ingest-core.mjs:342-346`); it writes `catalogue_only` from the cache with no check
   (`:533-569`). A fresh worktree has no cache, so ingest refuses.
10. **Nothing detects new data** (FINDINGS O4, `reproduced`).

The eval stays on the pinned 2026-2027 corpus by design, because its qrels were judged on it
(ADR 0003).

### Observability today
- `observability.enabled: true` (`wrangler.jsonc`) is set with no `head_sampling_rate`. `/search`
  writes one `"event":"search"` JSON line. An unhandled error writes `"event":"unhandled"` with
  the `cf-ray`.
- CPU per request was measured once, at the 3-0 cutover (`343ea371`: p50 9.1 ms, p75 15.5 ms).
  The measurement went through GraphQL `workersInvocationsAdaptive`, because Workers Logs return
  403 to the wrangler OAuth token (`docs/evidence/phase3/3-0-cutover.md:53`). Account-wide D1 rows
  and neurons came through GraphQL in Phase 1 (`docs/evidence/phase1/remote-ops.md:11,36`).
- There is no alert, no uptime check and no periodic usage report.

### Cost against Workers Paid
Sources: `docs/REFERENCE.md` "Cost" and ADR 0004. The allowances are account-wide, and the account
has other Workers and 9–10 D1 databases (`docs/evidence/phase3/remote-ops.md:13`). Nobody has
measured this site's traffic since it went public on 2026-11-11.

| | Included (account) | Per unit here | Note |
|---|---|---|---|
| Workers CPU | 30M CPU-ms a month | about 12 ms a request | about 2.5M requests a month; the binding allowance |
| Workers requests | 10M a month (`docs/plans/phase6.md` §4) | 1 per API call; static assets free | |
| D1 rows read | 25 billion a month | 239–497 per search (medians); 1 per `/module` | about 6.8k per deploy (the guard) |
| D1 rows written | 50M a month | 34,383 per forced re-ingest | a year switch also rewrites every catalogue-only row, about 66k charged in all (*est.*, 7E) |
| Workers AI | 10,000 neurons a day | about 0.03 per search; about 2,400 per forced re-embed | a new year re-embeds most texts: 2.2–2.6k (*est.*), in one day |
| Vectorize stored dims | 10M | 2,602,752 (26%) | the standby |
| Workers Logs | not in ADR 0004; checked in 7-0 | 1–2 events a request | |
| GitHub Actions | free on public repos; 2,000 min a month on Free for private ones | per push: `check`, `full-corpus`, `sc1` and 2 × `ui` | repo visibility checked in 7-0 |

### Open findings
- `reproduced`:
  - S1, the v1 eval. Phase 2's v2 eval replaced it, but the row was never re-triaged.
  - S2, S3, S4 and S6, search quality, carried since Phase 4.
  - O4, no scheduled refresh.
- B12-open (above). Phase 6's other left-open items are print paths and NUS sources, not ops
  (`exit.md`).

## 2. Workstreams
| WS | Scope | Branch | Depends on |
|---|---|---|---|
| 7-0 | measure (remote reads, by the lead) | — | G1–G5 |
| 7A | CI: no blind spots; the ranking lock | `phase7/ci` | — |
| 7B | deploy trace, preflight, smoke, rollback, D1 bookmark and restore | `phase7/deploy` | 7A merged, 7C's session |
| 7C | the remote session and the ops log | `phase7/ops-log` | — |
| 7D | the corpus manifest; one year source; files that follow production; CI on the live year | `phase7/year-data` | 7A, 7C |
| 7E | the source gate per year; the refresh tooling, rehearsal and runbook | `phase7/year-refresh` | 7D, G2, G5 |
| 7F | usage report; drift and reminder issues (G3) | `phase7/ops-report` | 7C |
| 7G | ship, drills, exit | — | 7A–7F |

Every workstream writes its tests first, in the first commit of its PR, and they fail before the
change. Pure docs are the exception.

### 7-0 Measure (by the lead; remote reads only, each logged)
- **GitHub:**
  - repo visibility;
  - the last 20 `main` runs' times per job;
  - whether a branch protection rule or ruleset requires checks;
  - whether `GITHUB_TOKEN` with `actions: read` can list runs.
- **The lock's cost, timed on the Mac:** the eval runner over the dev set in all three modes
  (filtered, `--strip`, `--unfiltered`) on the pinned corpus, plus the eval fixture set on its own
  corpus, exactly as `eval:lock` will run them. A runner takes about three times as long (the
  lexical grid: about 4 min locally, about 12 min on CI, per `vitest.config.mjs`).
- **Whether a D1 Time Travel restore is billed as row writes** (Cloudflare's docs).
- These reads come before 7C's tooling exists, so they are logged by hand in
  `docs/evidence/phase7/remote-ops.md`.
- **One read-only production schema capture.** Each query goes through `wrangler d1 execute
  nusmods-apac --remote --command … --json`, never `--file`. The queries:
  - the Phase 0 pragma query;
  - `sqlite_master`;
  - `index_xinfo` over every index;
  - the `d1_migrations` names.

  The diff runs offline with `schema-snapshot.mjs --compare-remote <file>` (added in 7A) against
  every section of the full-chain snapshot. The migrations are compared as a set: production
  applied 0008 before 0007. Cost: about 400 rows read (*est.*).
- **Account-wide month-to-date usage through GraphQL**, and which fields exist (CPU totals, errors
  by HTTP status); whether Workers Logs have an included volume on Paid (Cloudflare's docs).

### 7A CI
- **Every job always starts.**
  - `ci.yml` drops `paths-ignore` and keeps the draft guard (`draft != true`) on every job.
  - It adds `actions: read` to `permissions`.
  - A first job, `changes` (`scripts/ci-changes.mjs`), sets outputs `code`, `ui`, `grid` and
    `rollover` from a diff:
    - **PR:** the base is the PR's base sha.
    - **Push to `main`:** the base is the newest `main` commit whose `CI` run succeeded (`gh run
      list … --status success --json headSha`).
    - **Full run:** an API error, a missing green run, an unreachable base or `workflow_dispatch`
      runs everything.
  - Heavy jobs (`full-corpus`, `sc1`, `ui`, `rollover`) use `if: ${{ !cancelled() && <draft
    guard> }}`. They skip by steps when their output is `false`, and they treat a missing output
    (a failed `changes`) as `true`. Their check names always report.
  - Runs on `main` are grouped per sha, so none cancels another. PRs still cancel superseded runs.
- **The ranking lock** (`eval/ranking-lock.json`): `npm run eval:lock` writes it, and `npm run
  eval:lock -- --check` checks it.
  - **The harness.** The eval runner (`eval/runner/run.mjs`), unchanged, runs in two seeds: the
    pinned corpus for the dev set in three modes (filtered, `--strip`, `--unfiltered`), and the
    eval fixture corpus for the fixture set. It never runs in the `sc1` Vitest project, so 7D's
    production aliases can't reach it.
  - **Per query:** the sha256 of the HTTP status plus the ordered result codes. A 500 never hashes
    like an empty 200.
  - **Overall:**
    - `inputsHash`: a hash of the git objects (as `pinnedTreeHash` does, so ignored files never
      count) of `LOCK_INPUTS`;
    - the embedding version and the corpus release;
    - `evidence` for the current lists.
  - **`LOCK_INPUTS`:**
    - `HASHED`;
    - the static import closure of `eval/runner/run.mjs` and `retrieval.eval.js`, computed with
      acorn (already a dev dependency); today this includes `eval/lib/sets.mjs`, `corpus.mjs`,
      `embeddings.mjs`, `query-forms.mjs`, `workspace.mjs` and `scripts/pinned-corpus.mjs`;
    - `test/fakes.js` and `vitest.eval.config.mjs`;
    - `eval/study-map.json`, `eval/dev/`, `eval/fixtures/` and `eval/embeddings.json`;
    - the pinned NG files (7D);
    - `package-lock.json`, which fixes workerd and its SQLite.

    The completeness test recomputes the closure and fails if any file in it is outside
    `LOCK_INPUTS`. A dynamic `import()` it cannot resolve to a listed path fails it too.
- **Job `eval-gate`** always starts (draft guard only):
  1. **Fast path.** HEAD's lock lists equal the base commit's lock lists, *and* HEAD's
     `inputsHash` equals either the lock's or the one recorded by a commit whose `eval-gate`
     passed (the PR base, or `main`'s last green). Then it passes in seconds. A PR that touches
     only the lock file never takes this path.
  2. **Recompute.** It recomputes the lists at HEAD. If they equal HEAD's lock lists, it passes. If
     the lock lists differ from the base's, the evidence check below must also pass. The lock is
     never rewritten for a neutral change, so two PRs never conflict on it.
  3. **Otherwise** it fails and names the changed queries with their statuses.
- **Evidence for a ranking change** (`npm run eval:lock -- --evidence <kind> <ref>`), checked
  against the base commit's lock:
  - **`holdout-pass`:** a ledger row with verdict `pass`, appended after the base lock's commit
    (by `git log`), whose baseline ranker is the base commit's pin. A row can be cited only once.
  - **`no-look`:** a `count-log.md` row appended after the base lock's commit whose new `route`
    column names one of ADR 0003's no-look routes: representative-only, answerable-floor,
    group-first, or Phase 4's gated-without-a-look (ADR 0003:526-533).
    - `eval:count` and `eval:representatives` gain `--route <name>` and write it into the column.
    - ADR 0003 is amended in the same PR, and its lock test is updated.
  - **`revert`:** the new lists equal those of an earlier lock in `git log -p
    eval/ranking-lock.json`.
  - **Refused:** `eval:lock` that changes the lists without `--evidence`, an unchanged `evidence`,
    and an ADR pin line (pin lines are written after the merge).

  This guards against accidents, not against a maintainer who writes false evidence. A lock change
  shows in every diff. The holdout half stays with the custodian, because the key never enters CI.
- **The initial lock** is written at `a23601d`'s ranker. Its evidence is `bootstrap`, allowed only
  when the base commit has no lock.
- **`schema-snapshot.mjs --compare-remote <file>`** diffs a remote capture offline (for 7-0). It
  compares every section of the full-chain snapshot, and compares the migrations as a set.
- **Tests first:**
  - **`test/eval/ranking-lock.node.test.js`**, over fake list files and temp git repos:
    - **inputs:** unchanged since the lock; unchanged since a green base with a stale lock;
    - **lock edits:** a lock-only edit (no fast path; it fails without evidence); a lock whose
      `inputsHash` was hand-set to HEAD's;
    - **lists:** neutral lists; a changed list with no lock change;
    - **changes the old gate missed:** a status-only change, a fixture-only change, an
      unfiltered-only change;
    - **evidence:** a new pass row, a reused row, a `fail` row, a row against an older pin, a new
      count-log row with a route, one without, a stale one, a revert, an unchanged `evidence`;
    - **bootstrap:** a second `bootstrap` is refused.
  - **The completeness test:**
    - it fails before 7A, because nothing defines `LOCK_INPUTS`;
    - adding an import to `sets.mjs` from an unlisted file fails it;
    - `package-lock.json` is covered.
  - **`--compare-remote`:** a capture with 0008 before 0007 matches; a missing index, a changed
    trigger body and a missing migration row each differ.
  - **`scripts/ci-changes.mjs`**, as a table: a docs-only diff, a REFERENCE.md diff, a `public/`
    diff, a `data/` diff, no green base, an unreachable base, an API error.
  - **`test/ci-workflow.node.test.js`:**
    - there is no `paths-ignore`;
    - `check` and `eval-gate` have no path-based `if`;
    - heavy jobs skip only by steps, use `!cancelled()`, and survive a failed `changes`;
    - the workflow has `actions: read`;
    - `main`'s concurrency group includes the sha.
  - **`[S1 fixed]`:** the lock's lists come from `eval/dev` (v2, judged qrels), never from
    `eval/v1/`. It fails before 7A. The known-bug test becomes a history note on `eval/v1/`.
- **O2's note** drops "eval gate still open".
- **Exit checks:**
  - a throwaway PR (closed unmerged) that edits only `docs/REFERENCE.md` runs `check`, and
    `eval-gate` takes its fast path;
  - a throwaway PR that changes `RRF_K` (`src/search.js:98`) fails `eval-gate`;
  - `main` is green;
  - the slow path (two seeds) is timed against a 15-minute budget.

### 7B Deploy trace, preflight, smoke, rollback, D1 bookmark and restore
- **`npm run deploy -- --preflight`** runs every check except D1's, for HEAD, and writes a run
  record:
  - the git checks;
  - CI and Findings green on HEAD's sha, from its `push` runs;
  - the vars;
  - the bundle and the corpus manifest;
  - `year check` in its CI mode (no archive);
  - `wrangler check startup`.

  When HEAD changes a source-derived input (`data/ng-*`, `data/ng-sources-*`, `scripts/ng-overlay/`,
  or a quoted NUS sentence), preflight also needs a committed `year check --full` record (7E) for
  those inputs' hash. A hotfix that touches none of them needs no archive key. The runbook requires
  a preflight before any D1 write, and `ingest` warns when no preflight record exists for HEAD.
- **`npm run deploy`** runs the preflight, then the guard, the upload, the startup gate and the
  promote.
  - **On `main`:** HEAD must be on `origin/main`, and its own `CI` and `Findings` push runs must
    have succeeded. For a run in progress, deploy names `gh run watch <id>`; for a failed or
    cancelled run, `gh run rerun <id>`.
  - **Behind the tip:** deploy refuses unless `--behind-ok` is given, and logs that flag. It covers
    the case where D1 was already written for HEAD and an unrelated PR merged meanwhile.
- **A git tag on every deploy:**
  - **Intent record:** before promoting, deploy records the version id, the previous version id
    (from `wrangler deployments status --json`), the data version, the `catalogueKey` and the
    startup ms.
  - **Tag:** right after `versions deploy`, an annotated tag `deploy/<UTC
    yyyymmddThhmmssZ>-<version id, first 8>` on HEAD carries the same fields. Deploy pushes it, then
    runs `triggers deploy`.
  - **Interrupts:** a SIGINT or SIGTERM after the promote finishes the tag and the record before
    exiting.
  - **A failed push** prints the command to retry. The version is already live.
  - **Back-filled tags:** `b0834844` on `a23601d` and `f8aefeab` on `0b5f360`, both marked as
    back-filled, both at data version `d820d578cf81` (`git show <sha>:src/data-version.json`).
- **`npm run d1:bookmark`:** runs `wrangler d1 time-travel info nusmods-apac --json`, a read.
  Records the bookmark and prints it for the runbook's notes. The ingest that follows copies it
  into its own record.
- **`npm run d1:restore -- [--bookmark <id>]`:** without `--bookmark`, takes the newest bookmark
  record under `docs/evidence/ops/runs/`. It prints the bookmark, its age and the ingest it came
  before. It runs `wrangler d1 time-travel restore nusmods-apac --bookmark <id> --json`, a D1 write
  (Time Travel restores aren't billed as row writes; 7-0 confirms this). Then it records the
  restore and re-reads D1's data version. The code stays where it is. This undoes "ingest done,
  deploy refused". Bookmarks reach back 30 days, and the runbook says so.
- **`npm run smoke -- [--expect <sha>]`** sends five requests, each at least 4 s after the last.
  Codes, groups and the data version come from the expected commit's files (`git show
  <sha>:…`), so after a rollback it checks the rolled-back data.
  - `/health`: the tag, the data version and the `production` bundle.
  - `/`: 200, with the CSP header.
  - `/module/<code>`: 200, for a code in no group whose title is unique in that commit's corpus.
  - `/search` for that title: `cache;desc=miss`, not degraded, and the code in the top 5.
  - `/facets`: 200.
- **`npm run rollback`:**
  - **Target:** `--to <id>`, or else the deployment before the live one (`wrangler deployments list
    --json`). The target's commit, data version and `catalogueKey` come from its `deploy/*` tag.
  - **Data check:** no Worker session and no working-tree code. The script runs `wrangler d1
    execute --remote --command` reads of `modules.row_hash` and `catalogue_only` codes (about 21k
    rows), and computes the data version and `catalogueKey` with `src/rowhash.js`. It refuses
    unless both equal the target's. For a deliberate mismatch it needs `--accept-data-mismatch`,
    and prints the risk. The usual cross-data path is `d1:restore` first, then rollback.
  - **Run:** `wrangler rollback <id> --message "rollback to <tag>" -y`. Then it tags
    `rollback/<time>-<id8>` on the target's commit and prints `npm run smoke -- --expect <target
    sha>`.
  - **Vectorize:** the standby is not rolled back. If the standby matters (a `DENSE_BACKEND` flip),
    the runbook says to rerun `vectors standby` from the target commit.
  - **Requirements:** no clean tree and no CI. GitHub is needed only for the tag, and a failed tag
    is reported, not fatal.
- **Tests first** (with injected `exec`, `fetch` and signals, as in today's deploy tests):
  - **Preflight:**
    - refuses on each failing check;
    - needs a `--full` record only when source-derived inputs change;
    - writes nothing remote.
  - **Deploy:**
    - refuses a HEAD behind the tip without `--behind-ok`;
    - refuses no run, a running run, a failed or cancelled run, and a Findings failure;
    - tags before `triggers deploy`, with the previous id;
    - finishes on SIGINT after the promote;
    - a failed push doesn't fail the deploy;
    - every exit path after the upload leaves a record.
  - **Rollback:**
    - refuses a data-version or `catalogueKey` mismatch;
    - takes `--to`;
    - tags the target's commit;
    - works from a dirty tree;
    - never starts a Worker session.
  - **Restore:** picks the newest bookmark; passes `--json`; records the restore and the re-read.
  - **Smoke:**
    - fails on a tag mismatch, a cache hit, a degraded answer, a missing CSP, or a code missing
      from the top 5;
    - `--expect` reads that commit's files;
    - draws only ungrouped, uniquely titled codes;
    - spaces its requests.

### 7C The remote session and the ops log
- **`npm run remote -- <command…>`:**
  - starts `wrangler dev --remote --ip 127.0.0.1` on a free port (never 8787 or 8799), with a
    one-off `INGEST_SECRET` in a 0600 env file in a temp dir;
  - waits for `/health`, retrying `code 10021` for up to 30 minutes and logging each try;
  - runs the command with `WORKER_URL` and `INGEST_SECRET` set;
  - stops the session and deletes the dir.

  The deploy guard uses the same module.
- **No default URL.** `ingest`, `verify` and `vectors standby` refuse to run without `--url` or
  `WORKER_URL`, and refuse ports 8787 and 8799.
- **The ops log is one file per run.** Every script that touches a remote writes
  `docs/evidence/ops/runs/<UTC yyyymmddThhmmssZ>-<script>-<4 hex>.json` on every exit path.
  Unique names mean no two worktrees conflict, and nothing is numbered at write time.
  - **A record holds:**
    - the UTC time and the script;
    - the commit, with a `dirty` flag and, when dirty, the sha256 of `git diff HEAD`;
    - the target;
    - what was read and written, estimate and actual;
    - the live requests sent, by path;
    - version ids and the bookmark;
    - the outcome.
  - **Writers:**
    - deploy (preflight included), the remote session, ingest, verify, standby;
    - smoke, rollback, `d1:bookmark`, `d1:restore`;
    - `corpus publish`, `sources publish`, `eval:embed` (which also keeps `neurons.tsv`);
    - `p5-live`, `p6-live`, the usage report, the schema capture.
  - **`requests.tsv`** stays as it is for rows 1–127 plus the back-fill. `npm run ops:requests`
    prints live-call totals from both.
  - **Phase 7's own early reads** (7-0) come before this tooling. They are logged by hand in
    `docs/evidence/phase7/remote-ops.md`, as before.
- **Clean-tree exemption:** deploy exempts only new, untracked files under
  `docs/evidence/ops/runs/`. A modified tracked file still refuses. `docs/` is neither bundled nor
  an asset.
- **Back-fill and corrections,** by hand, once, marked as such:
  - `requests.tsv` rows for the live calls of the ADR 0009 and rename deploys;
  - a correction note for rows 124, 125 and 127, and for the two Phase 6 log headings that say
    2026-11-12 for events of 2026-11-11 UTC.
- **`check:findings` validates run records:** the schema, an ISO time not in the future, and an
  outcome present.
- **The runbook:** steps 3–8 become `npm run remote -- …`. No step writes `.dev.vars`.
- **Tests first:**
  - **The session:** never reads `.dev.vars`; refuses reserved ports; retries 10021 and stops at the
    limit; always kills the child.
  - **No default URL:** ingest, verify and standby refuse a missing URL and a reserved port.
  - **Records:**
    - each writer leaves one record on success and one on failure;
    - two writers in the same second get different names;
    - a dirty tree is recorded.
  - **The exemption:** admits a new run file and refuses a modified tracked file.
  - **`test/runbook.test.js`:** REFERENCE.md has no `> .dev.vars`.

### 7D The corpus manifest; one year source; files that follow production; CI on the live year
- **The corpus manifest** (`data/corpus.json`). For each production corpus it records the release
  asset (`prod-<year>-<yyyymmdd>`, gz), its raw sha256 and its fetch time. A `current` field names
  the entry ingest uses. The manifest stores no data version: that depends on the NG files too
  (`src/rowhash.js:44-47`), so it is always recomputed.
  - **Commands:**
    - `npm run corpus -- fetch <year>` downloads NUSMods into `.data/staging/`;
    - `npm run corpus -- publish` uploads the asset, writes its entry and sets `current`;
    - `npm run corpus -- restore` downloads and sha-checks `current` into `.data/prod/<sha>.json`,
      in any worktree.
  - **Readers.** Ingest, `vectors.mjs build --corpus production`, the vocabulary, groups,
    `ng-unscheduled`, catalogue and prefix builders, `p5-live` and `p6-live` read only `current`,
    never `.data/cache`. Ingest refuses a corpus whose sha256 isn't `current`'s.
  - **CI.** CI computes the data version from the asset and HEAD's NG files, and the
    `catalogueKey` from the asset. It checks them against `src/data-version.json` and the bundled
    catalogue file. A mid-year NG revision on the same asset therefore stays consistent.
  - **Licence basis.** The pinned corpus is already a release asset. ADR 0011 records the basis.
  - **First entry.** The 2026-11-04 corpus D1 was loaded from (`--offline` on 11-07 and 11-10). It
    is published once its recomputed data version matches the committed one.
- **One year source.** `DEFAULT_ACAD_YEAR` (`scripts/lib.mjs`) is the only year.
  - `build-ng-restrictions.mjs` and `vectors.mjs` drop their own year and their `--year` flag.
  - `public/app.js` computes the semester months from the year.
  - Source dates and sha256s live in the per-year source manifest (7E). The existing NG files are
    not edited.
  - **The scan test** runs over `src/`, `public/`, `scripts/`, and `test/` outside fixture-year
    tests. It flags any `\b20\d\d\b` that isn't on an allow list:
    - `DEFAULT_ACAD_YEAR`, `public/year.js`, the header and the pinned constants, each checked
      equal to what it must match;
    - an explicit list of cited past years, each with its reason.
  - Tests over production or pinned data load their NG files by the corpus's year.
- **The eval reads pinned NG files.** `eval/lib/corpus.mjs` passes byte-identical copies of
  `ng-courses-2026-2027.json` and `ng-restrictions-2026-2027.json` from `eval/pinned/` into
  `offeredModules`. It no longer reaches the live files through the ranker's `loadNgCourses`
  (`corpus.mjs:44-46`, `scripts/lib.mjs:264,276,293`). The run records both sha256s, and the
  report checks both. A Registrar revision before the switch then moves neither the eval nor the
  lock. This is an ADR 0003 amendment, made in the same PR.
- **Catalogue codes and prefixes follow the corpus**, as the vocabulary and groups do:
  - They become bare module names, `catalogue-codes-data` and `prefixes-data`.
  - `wrangler.jsonc` aliases them to the production builds. The Vitest configs alias them to the
    fixture's or the pinned builds. Each eval run aliases them to its run corpus's, so the lock is
    unchanged.
  - `catalogue-only.json` follows the same rule.
  - `/admin/hashes` adds a `catalogueKey` over `catalogue_only`: about 14.4k more rows per call,
    and `GET /admin/catalogue` already reads them.
  - The guard and `verify --pre-deploy` refuse a mismatch with the bundled file.

  This closes B12-open.
- **CI on the live year:**
  - **The `sc1` job:**
    - restores `current` and seeds the production corpus;
    - gets production aliases (the production bundle, `data/vocabulary.json`, `data/groups.json`);
    - drops the pinned-only skips (`identity.test.js:61-63`, `paths.test.js:76`).
  - **A new `sc1-node` Vitest project**, run by the same job, holds the SC1 oracle test and a check
    that every department and faculty a rule names exists in the production corpus. `.node` tests
    can't join `sc1` (`vitest.config.mjs:143`), and the job's "no test ran" guard counts both
    projects.
  - **Corpus-specific assertions** stay in `full-corpus`, over the pinned corpus:
    `STANDBY_RECALL_FLOOR` (`paths.test.js:67`) and identity's 3G no-signal ruling. `sc1` asserts
    invariants only.
  - **`full-corpus`** keeps the pinned corpus (the eval's).
- **Tests first:**
  - the scan, including that a hex string doesn't match;
  - **the manifest:** a wrong sha is refused, `restore` checks it, ingest refuses the cache, and
    CI recomputes the data version after an NG edit;
  - a code in the production catalogue file but not the pinned one answers `not-offered`;
  - `build --check` fails on a stale file;
  - the guard and `verify --pre-deploy` refuse a `catalogueKey` mismatch;
  - **the eval:** an edit to either live NG file leaves the eval's modules identical (compared
    module by module, not only by sha);
  - `sc1` and `sc1-node` report zero skipped over production;
  - the department check fails on a renamed department.
- **Exit checks:**
  - the 162 codes answer `not-offered` locally, with the count recorded;
  - `sc1` is green over production;
  - the lock passes as ranking-neutral;
  - one `catalogueKey` read of D1, from merged `main` after a preflight, equals the file's. If it
    doesn't, the catalogue rows are re-ingested from `main` through the runbook (bookmark first):
    at most about 14.4k rows, charged about 28.7k by the budget, and counted in §3 as contingent.

### 7E The source gate per year; the refresh tooling, rehearsal and runbook
- **NUS's source documents, archived (G5).**
  - **One archive per revision.** Each set of documents goes into an AES-256-GCM archive, uploaded
    as a release asset (`sources-<year>-<yyyymmdd>`). Its sha256 and each file's sha256 are listed
    under that revision in `data/ng-sources-<year>.json`.
  - **What goes in:**
    - the NG list and the restrictions PDFs;
    - the self-funded list, YST's pages and the Law image;
    - every page the site quotes: GRO's pages, CourseReg's FAQ and guide, NUS's brochure, the
      application guide, and the 2018/19 info sheets.
  - **Quotes that can't be archived.** A quoted source that can't be archived is listed as
    `unarchived`, with the reason. `year check` reports these quotes rather than dropping them.
  - **The key** sits beside the holdout key, and the runbook says to back it up. Losing it blocks
    the next source change, but not deploys (7B).
  - **Restore:** `npm run sources -- restore <year> [--revision <date>]` unpacks into a temp dir,
    and the builder reads that dir instead of `~/.config/vnm/`.
  - **YST text:** `scripts/yst-text.mjs` replaces the hand step that turns YST's HTML into text.
- **The source manifest per year** (`data/ng-sources-<year>.json`) holds:
  - the revisions, each with its documents (name, URL, file, sha256, "updated as at");
  - which semesters each list has published (the NG list and YST's pages per semester);
  - the transcription, overlay module and register paths;
  - the quote index: each hand-copied NUS sentence in `src/` and `public/`, with its document.
- **Stable rule ids.**
  - The transcription brief fixes the id scheme: section, department, rule.
  - `transcription-diff.mjs --map-to <last year>` proposes last year's id wherever the normalised
    quote matches, and lists renamed, new and dropped rules for review.
  - **Overlay roles.** `self-funded-list` and `off-list-rule` (rule E) are roles that
    `build-ng-restrictions.mjs:365` and `public/shortlist.js:178` read instead of literal ids. The
    builder fails if a role is missing or appears twice.
- **Per-year code, shared logic.**
  - The 2026/27 overlay, `DEPT`/`FAC`, `TWINS`, `DECIDED` and `LAW_COMPULSORY` move to
    `scripts/ng-overlay/2026-2027.mjs`.
  - The parts that don't change by year move to a shared module: the R3 year-note parser
    (`:269-347`) and R6-2's level note.
  - The oracle moves to `test/sc1/oracle-2026-2027.node.mjs`, behind one selector,
    `test/sc1/oracle.mjs`, which picks by the corpus's year. Every importer goes through it (the six
    files in §1, and `test/sc1`). A test fails on any direct import of a dated oracle.
- **The register carries the rulings.**
  - The oracle's D1–D24 become register rows, marked as the lead's rulings.
  - Each year's register starts as last year's rulings, with rows that name codes flagged
    "re-verify".
  - The `DEPT`/`FAC` heading map is a transcription fact that both sides may read.
- **Extraction.**
  - `extract-ng.py --year <yyyy-yyyy>` keeps only the sections whose heading names the target
    year: August of its first year for Sem 1, January of its second for Sem 2. It drops sections
    for other years and lists them. NUS prepends new sections, so an April PDF can hold Sem 1
    2027/28 above Sem 2 2026/27.
  - It fails when a semester the manifest marks published has no section, or a section has zero
    rows.
  - It writes the count for each semester.
  - A `--from-text` mode, which needs no `pypdf`, lets CI test the heading logic.
  - `year check`'s 25% rule compares only semesters published in both years.
- **`year check`** has two modes.
  - **The CI mode** checks:
    - every year source agrees;
    - no stub remains;
    - the manifest's documents and dates;
    - the per-corpus files come from that year's corpus;
    - the counts;
    - an oracle exists for the year.

    Preflight runs this mode.
  - **`--full`** (on the Mac, with the key) restores the archive and adds two checks: every quote
    appears verbatim in its document, and the manifest-driven builder reproduces the committed
    `ng-restrictions-<year>.json` byte for byte. It writes a run record carrying the hash of the
    source-derived inputs. Preflight requires that record when those inputs change (7B), so a
    hand-edited rules file can't pass on its hash alone.
- **`year next <yyyy-yyyy>`** runs first. It creates the year's manifest, overlay module, oracle
  file, register and NG files as stubs (`"stub": true`), never overwriting an existing file, and
  prints the checklist. Ingest refuses a missing or stub NG file for the year.
- **`docs/year-refresh/`:**
  - `README.md`: the checklist;
  - `brief-transcription.md`;
  - `brief-oracle.md`: the oracle author reads the PDFs, the register and the `DEPT`/`FAC` map,
    never `src/eligibility.js`, the overlay or its module. For a new year, a fresh author rewrites
    only the sections whose rules changed, starting from last year's oracle;
  - `overlay.md`: new ids, roles, department renames;
  - `register.md`: the maintainer rules on open readings, and each ruling is logged before the
    oracle author starts;
  - **agreement:** the oracle and `eligibility()` agree on every code. Each disagreement is
    classified and fixed at its source. Oracle-class fixes go to a fresh subagent.
- **Rehearsal in CI** (job `rollover`).
  - **Setup:** the job works in a temp copy of the repo. It needs no PDF and no archive. It
    relabels the pinned corpus 2027-2028, and copies the committed NG JSON files, the manifest, the
    overlay module, the register, the transcription and the oracle, all marked as that year. It
    also writes a variant of the manifest with Sem 2 unpublished.
  - **The run:**
    - `year next`, which refuses to overwrite the copies;
    - the builders other than the restrictions builder;
    - a local D1 ingest with `--allow-year-change` through the local Worker;
    - `verify --pre-deploy`;
    - the SC1 path tests against the selected oracle;
    - `year check` in CI mode.
  - **What each copy must fail on:** a stale `public/year.js`, and a stub.
  - **Elsewhere:** the wrong-year heading and the missing role are tested by unit tests
    (`--from-text`, a fixture overlay), not by the rehearsal.
  - **The limit:** it proves the code has no year built in. It cannot show what a new PDF layout
    will break.
- **The unpublished semester (if G2 says so).**
  - **Which courses:** a semester the manifest marks unpublished shows the courses that were on
    last year's list for that semester. Each is marked "On NUS's 2026/27 list; NUS hasn't published
    2027/28's yet". It counts as "to confirm with NUS", never as open. Courses that weren't on last
    year's list stay hidden, as off-list courses are today.
  - **What must change:** `src/eligibility.js:85,138` (a new reason id `ng:unpublished-sem`, kind
    `ask`), `src/ng-reasons.js:72`, `public/shortlist.js:343,389-391`, the oracle and the SC1 tests.
    YST's Sem 2 page follows the same flag.
- **Write budget for a year switch.** Every module row is rewritten (charged about 37.3k,
  `docs/evidence/phase5/remote-ops.md:21`). So is every `catalogue_only` row, because its hash
  includes the year (`src/rowhash.js:124`): about 28.7k charged. That is about 66k against the 40k
  default. The runbook passes `--write-budget 80000`. If a run stops at the budget, rerun it with the
  same flag; `deploy`'s `catalogueKey` check refuses until it completes.
- **The runbook** (`docs/year-refresh/README.md`), for a year switch:
  1. **When:** G2's trigger. The monthly reminder issue (G3) prompts the check.
  2. **Scaffold:** `year next`.
  3. **Sources:** save the documents by hand, then `sources publish`.
  4. **Transcription:** two independent transcriptions, the diff and the id map, then the register
     with the maintainer's rulings.
  5. **Corpus and rules:**
     - `corpus fetch` and `corpus publish`;
     - the overlay;
     - the builders over `current`.
  6. **Oracle:** the oracle sections, then agreement.
  7. **Checks:** `year check --full`, then the bundle (`vectors.mjs build --corpus production`).
  8. **PR:** CI runs `sc1` on the new year. Merge only when complete.
  9. **Before any D1 write:** on merged `main`, `deploy --preflight`, then `d1:bookmark`.
  10. **Ingest and verify:** `remote -- ingest --d1-only --allow-year-change --write-budget 80000`,
      then `remote -- verify --pre-deploy`.
  11. **Deploy and smoke:** `deploy`, then `smoke`.
  12. **Standby:** `remote -- vectors standby`, then `remote -- verify`.
  13. **Live checks:** run them with the year's oracle.

  **Failures:**
  - **Ingest done, deploy refused:** `d1:restore` (the code stays as it was), fix the cause, then
    resume from 9.
  - **Deploy done, smoke failing:** `d1:restore`, then `rollback`, then `smoke -- --expect
    <target>`.
- **A mid-year revision** is the same list with these changes. A new Sem 2 list or YST page is a
  revision that sets that semester to published.
  - **3:** publish a new archive revision, and `sources restore` the previous one to diff against.
  - **4:** both transcribers redo only the changed sections, in a copy of the last transcription;
    the diff shows exactly those sections.
  - **5:** the overlay for the changed rules, and the builders.
  - **6:** the oracle sections for the changed rules, then agreement.
  - **7:** `year check --full`, then the bundle. The data version changes, because the row hash
    covers `ng_allow` and `ng_rules`.
  - **10:** a row-only `ingest --d1-only`.
  - **8, 9, 11–13:** as listed.
- **Time (*est.*):**
  - a year switch: the gate takes about a day (Phase 4's ran in one day), builds about 1 h, CI
    about 45 min, and steps 9–13 about 2 h. Two working days in all;
  - the re-embed's ~2.4k neurons go on a day with nothing else;
  - a revision: half a day.
- **Tests first:**
  - **`year check`, CI mode:** a consistent tree, a stale constant, a stub, a date that disagrees,
    a 40% drop in a semester published both years, a missing oracle, and an unpublished semester
    (which passes);
  - **`--full`:** a missing quote, and a rules file edited by hand. Both run on the Mac. CI checks
    that the record exists, not what is in it;
  - **`extract-ng.py --from-text`:** a section for another year dropped, a published semester
    missing, a section with zero rows;
  - **`year next`:** writes stubs and never overwrites;
  - **ingest:** refuses a stub;
  - **the selector:** picks by year, and direct imports are banned;
  - **roles:** missing or doubled;
  - **the id map** over transcriptions A and B;
  - **`yst-text.mjs`:** reproduces the committed `.txt` (on the Mac);
  - **the unpublished-semester state:** in eligibility, the shortlist and SC1 (if G2 says so).

### 7F Usage report; drift and reminder issues
- **`npm run ops:report -- --month <yyyy-mm>`** uses GraphQL.
  - **Account-wide, each against its allowance:** Worker requests and CPU, D1 rows read and written,
    neurons per day.
  - **This Worker's share:** requests, CPU p50 and p99, errors by status (if 7-0 finds the field).
  - **Flags:** anything above 25%, and anything that grows month on month.
  - **Output:** `docs/evidence/ops/<month>.md`, plus a run record.
  - **When:** monthly, and after a ship that changes the search path.
- **Drift and reminders (G3).** `.github/workflows/drift.yml` makes no Cloudflare call and no
  live-site call.
  - **Weekly:**
    - fetch NUSMods' `moduleInfo.json` for `DEFAULT_ACAD_YEAR` (with the cached ETag) and next
      year's `moduleList.json`;
    - compute the data version offline;
    - keep one "pending refresh" issue updated with field counts;
    - open a separate issue, never auto-closed, when next year appears;
    - open an issue on its own failure (a NUSMods shape change, an HTTP error).
  - **Monthly, all year:**
    - open a reminder issue to check the Registrar's NG pages and YST's pages;
    - when the last commit is more than 45 days old, add to it that GitHub stops a public repo's
      schedules after 60 quiet days.
  - **O4** stays `reproduced`, since ingest stays manual by design; its note says detection is
    scheduled.
- **Tests first:**
  - **The report:** fixture GraphQL answers give the expected report; a missing dataset is reported
    as missing, not zero; the 25% flag works.
  - **Drift:** the comparison over a fixture pair; the issue text for each case; the 45-day note.
- `head_sampling_rate` stays unset unless 7-0 finds the log volume billed.

### 7G Ship, drills, exit
- **Ship `main`:** `deploy --preflight`, then `deploy`, then `smoke`. The scripts record every step.
- **Rollback drill.** Code only, at most 15 requests, and about 42k rows read for two data checks:
  - `npm run rollback` to `b0834844`. Its back-filled tag carries the same data version and
    `catalogueKey`;
  - `npm run smoke -- --expect a23601d`;
  - `npm run rollback -- --to <the version just left>`;
  - smoke again.
- **Schema:** 7-0's capture diff is 0, with all 10 migrations present. `schema-0006.json` is
  renamed `schema-full.json`.
- **Fresh clone:** in a new worktree with no `.data/`, `npm ci && npm test && npm run
  db:rebuild-check && npm run test:eval` all pass, and `npm run corpus -- restore` gives ingest its
  input.
- **Docs:**
  - REFERENCE.md: Deploying, Rollback, Operations, A new academic year, Cost, Known limitations;
  - `docs/year-refresh/`;
  - FINDINGS: S1, O2, O4;
  - ADR 0003's amendments: the pinned NG files and the `route` column;
  - PLAN.md and PROGRESS.md;
  - the vault page (the lead).

## 3. Cost, ops and risks
- **Remote, all of Phase 7 (*est.*):**
  - **Deploys:** two or three, each with the guard reading about 21k D1 rows.
  - **Rollback drill:** two data checks, about 42k rows.
  - **One-off reads:** a schema capture (about 400 rows), a `catalogueKey` read (about 14.4k), a
    bookmark read.
  - **Live requests:** 5 smoke requests per deploy, plus the drill's (at most 15).
  - **Other:** GraphQL reads.
  - **Contingent:** a catalogue-only re-ingest if D1's `catalogueKey` differs: at most about 14.4k
    rows written, charged about 28.7k.

  Phase 7 runs no migration and no Workers AI. ADR 0004's headroom rule holds by orders of
  magnitude.
- **A future year switch (*est.*):**
  - about 66k rows charged (see 7E);
  - about 2.4k neurons;
  - 21k rows read per deploy.

  All inside the allowances.
- **GitHub writes:**
  - release assets: the 2026-11-04 corpus (about 4–5 MB gz) and the 2026/27 sources archive;
  - tag pushes for each deploy and rollback, plus two back-filled tags;
  - throwaway PRs for the exit checks.
- **GitHub minutes:**
  - the lock's slow path, two seeds, on changes to `LOCK_INPUTS`. The budget is 15 min; 11 of the
    last 60 `main` commits touch `HASHED`;
  - `rollover` on code changes;
  - `check` on every push;
  - no cancellation on `main`.

  If the repo is private, 7-0's minutes per push decide whether `rollover` runs only on `main`.
- **NUSMods** (G3): one conditional fetch a week.
- **Holdout:** no look. The pin stays `a23601d` unless a ship changes the ranker.
- **Risks:**
  - **GitHub outage:** nothing deploys, but rollback and restore still work, and only their tags
    wait.
  - **The lock:**
    - it compares open sets only, so the custodian's holdout count at ship stays;
    - it stops accidents, not false evidence;
    - an import its acorn scan can't resolve fails the completeness test, so it can't pass
      silently.
  - **A tag push can fail after a promote.** The version is then live and untagged until the push
    is retried.
  - **The rehearsal** relabels last year's data. A new PDF layout or new rules still need the 4F
    gate and a person's rulings.
  - **Time Travel** reaches back 30 days.
  - **GitHub may disable schedules** in a quiet public repo.
  - **The G5 key:** losing it blocks the next source change, not deploys.

## 4. Exit criteria
- **SC9, measured:**
  - **CI:**
    - every push to `main` and every ready PR runs `check` and `eval-gate`;
    - heavy jobs skip only by the tested rule;
    - the throwaway `RRF_K` PR fails, and `main` passes.
  - **Migrations:** `db:rebuild-check` passes, and production's schema equals the full-chain
    snapshot, with the same set of migrations.
  - **Trace:**
    - `/health`'s tag is the commit of the newest `deploy/*` or `rollback/*` tag;
    - deploy refuses a commit without green CI (tests);
    - the rollback drill ran and has its records.
- **Ops:**
  - no runbook step writes `.dev.vars`;
  - no script has a default URL;
  - every remote operation after 7C merges has a run record, and 7-0's are in
    `docs/evidence/phase7/remote-ops.md`;
  - ingest and the bundle read only the manifest's `current` corpus.
- **Year:**
  - `year check` passes in CI mode, and `--full` passes on the Mac with its record committed;
  - the rehearsal passes in CI;
  - `docs/year-refresh/` holds the checklist and the briefs;
  - the 2026/27 sources archive is published;
  - B12-open is closed.
- **Observability:** this month's report is committed, and the account is inside every allowance.
- **Docs:** as 7G lists.

## 5. Gate questions for Jacob
- **G1. Deploys stay on your Mac.** Should `npm run deploy` stay a local command, which from now
  on refuses any commit whose CI isn't green? The alternative is deploying from GitHub Actions with
  a Cloudflare API token stored in GitHub. *Recommended: keep it local.* The deploy guard reads
  production D1 through a `wrangler dev --remote` session. From Actions, that would need a token
  with Workers, D1 and Vectorize edit rights stored as a GitHub secret, for a site one person
  deploys a few times a month.
- **G2. When the site moves to 2027/28, and what Sem 2 shows until NUS publishes it.** NUS
  publishes the Sem 1 exchange list in March or April, the Sem 2 list months later, and the
  timetable around mid-July. Applicants apply from 21 March to 10 April. Until NUSMods has
  2027/28's courses, the site can only show 2026/27, labelled as such, as it does now. Should the
  site switch to 2027/28 once NUSMods has the new year and the Sem 1 list is out (about July)? Until
  the Sem 2 list appears, Sem 2 would show the courses that were on last year's Sem 2 list, marked
  "On NUS's 2026/27 list; NUS hasn't published 2027/28's yet" and counted as "to confirm", never as
  open. The alternative is to wait until both lists are out, around September. *Recommended: switch
  in July, as described.* Sem 1 students register for courses in July and August, so a September
  switch would leave them on last year's data. Last year's Sem 2 list is the best guide there is,
  and labelled that way it is honest. It adds one state to exchange mode, the shortlist and their
  tests.
- **G3. Automatic GitHub issues.**
  - (a) Once a week, check whether NUSMods' data for this year has changed or next year's has
    appeared, and keep an issue saying what changed. Once a month, also remind you to check the
    Registrar's and YST's pages.
  - (b) Once a day, load `/health` and one search on the live site, and open an issue if either
    fails.

  *Recommended: (a) yes, (b) no.* (a) costs nothing on Cloudflare, tells you when a refresh is due,
  and leaves refreshing as a command you run. (b) adds daily traffic to a site you can check
  yourself, and the monthly report shows error counts.
- **G4. Search findings left open.** Should S2, S3, S4 and S6 (ranking issues found in Phase 0)
  stay open as known limits, with no ranking work in Phase 7? *Recommended: yes.* SC5 passed, 8 of
  the 12 holdout looks are spent, each further ranking change costs a look, and Phase 7 is ops.
- **G5. Where NUS's source documents live.** Rebuilding exchange mode's rules, or seeing what a
  revised PDF changed, needs last year's PDFs and pages. Today they exist only on your Mac. Should
  they be stored in the repo's releases, encrypted, with the key kept next to the holdout key?
  *Recommended: yes, encrypted.* Every year's sources then live with the code that read them, and
  encryption avoids republishing NUS's documents in public. Back up the key: without it, the next
  change to the sources can't be checked, though deploys still work.

## 6. Critic log

### Round 1 (critics A CI and testing, B ops, deploy and data, C the maintainer a year on)
Found sound by round 1:
- **A:**
  - the `paths-ignore` lines and the tests that read docs;
  - the PR/push diff base;
  - skipped jobs leaving `success`;
  - the holdout key staying out of CI.
- **B:**
  - `wrangler deployments status --json` and `rollback --message -y` exist in 4.157.0;
  - the GraphQL token worked before;
  - the default URLs and the guard's env file;
  - the Phase 5 and 6 log gaps;
  - the 2,602,752 stored dims;
  - `remote-migration.mjs` records `d1_migrations` rows.
- **C:**
  - ingest's year-change and mass-delete refusals;
  - `verify --pre-deploy`'s year check;
  - the eval's aliasing staying ranking-neutral;
  - G1;
  - 7C.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A1-1 | A (blocking) | the ledger's candidate commits are squashed away (`ff54fdc` is on no branch), so re-running them fails | the gate never re-runs a ledger commit; a committed ranking lock holds the lists, and the ledger is evidence only |
| A1-2 | A (blocking) | the no-look ship routes (representative-only, 3G, 3F) have no `pass` row; the gate would force a look | evidence may be a ledger row, a count-log row or an ADR 0003 pin line |
| A1-3 | A (blocking) | the diff base `event.before` lets a docs push after a red ranking commit skip the gate, and deploy ships it | `eval-gate` always runs (a content check, not a diff); `main` diffs against its last green CI run |
| A1-4 | A | the pin, the ledger and `HASHED` can be edited in the PR they gate | the lock's evidence is checked against the base commit's lock and pin; a lock change shows in the diff; stated as an accident guard, not a security boundary |
| A1-5 | A | branch 2 ran only filtered dev lists; past ships compared `ng`-stripped and unfiltered too | the lock covers filtered, `ng`-stripped and unfiltered dev plus the fixture; a test for an unfiltered-only change |
| A1-6 | A | the static doc-path scan clashes with the skip lists (comments, output paths) and misses `join(...)` | scan dropped; `check` never skips, so every test that reads docs runs |
| A1-7 | A | a job-level `if` on a matrix job reports no check, which would wedge a required check | every heavy job always starts and skips by steps; 7-0 reads branch protection |
| A1-8 | A (minor) | the `workflow_dispatch` exit check passes today | exit check uses a throwaway PR |
| A1-9 | A (minor) | facts: `corpus.test.js` only mentions REFERENCE in comments; `baseline.node.test.js:20` reads ADR 0003; `main` moved | fixed; rebased on `a64a024` |
| A1-10 | A (minor) | `[S1 fixed]` would pass before 7A | the test asserts the eval gate's lists come from `eval/dev`, which fails before 7A |
| A1-11 | A (minor) | one embedding version for both refs refuses an embedding-text change | HEAD's lists use HEAD's `eval/embeddings.json` default; the lock records its version |
| A1-12 | A (minor) | CI time assumed; `rollover` in the near-full `full-corpus` job | 7-0 times a dev run; `rollover` is its own job; recounted: 11 of the last 60 `main` commits touch the hashed paths, not 33 |
| B1-1 | B | live is `b0834844` (tag `a23601d`), the pin is `a23601d`, `exit.md` exists | facts updated |
| B1-2 | B | "previous `deploy/*` tag" has no target on the first ship, rolls forward to the same version, skips a tagless deploy; the rollback tag lands on the Mac's HEAD | target from `wrangler deployments list`, or `--to`; the tag is made before `triggers deploy`; the rollback tag goes on the target's commit |
| B1-3 | B | a rollback across a data change runs an old bundle on new D1; no script records a bookmark | refuses without `--d1-restored` or `--accept-data-mismatch`; `npm run d1:bookmark` logs it |
| B1-4 | B | the per-corpus files built in a worktree come from a refetched cache; nothing ties the catalogue to D1 | built only from the sha-checked production asset; the guard and `verify --pre-deploy` compare a `catalogueKey` |
| B1-5 | B | the usage report compares one Worker with account-wide allowances | the report is account-wide, with this Worker's share |
| B1-6 | B | the pragma query misses `sqlite_master`, `index_xinfo`, `d1_migrations`; `--file` pauses D1 | all four queries, each with `--command`; offline `--compare-remote` diff |
| B1-7 | B | the exemption plus the behind-origin note can deploy a stale commit | deploy refuses a HEAD that is not `origin/main`'s tip |
| B1-8 | B (minor) | `main`'s concurrency cancels pending runs | `main` runs grouped per sha; deploy names `gh run rerun` |
| B1-9 | B (minor) | a tag named to the minute collides on a retry | seconds plus the version id |
| B1-10 | B (minor) | the log must cover failure paths | every exit path after upload writes a line; tested |
| B1-11 | B (minor) | `check-requests` fails on legacy rows | applies to rows after 127, with the exemption in the script |
| B1-12 | B (minor) | row 127 and a second heading also have the wrong date | added to the correction |
| B1-13 | B (minor) | a fixed smoke query is a cache hit | a random bundle title; requires `cache;desc=miss` |
| B1-14 | B (minor) | the GraphQL status dimension is unverified | 7-0 checks the fields before tests lock a schema |
| B (note) | B | no licence basis recorded for republishing NUSMods data | ADR 0011 records it, following the pinned asset |
| C1-1 | C (blocking) | the 4F gate needs code edits (fixed transcription path, `OVERLAY`) and a new oracle; no briefs | per-year source manifest, overlay and oracle; `docs/year-refresh/` with the briefs, the overlay guide and the rulings rule; disagreement fixed at its source |
| C1-2 | C (blocking) | SC1 tests name 2026-2027; the department-exists check reads the pinned snapshot | tests load by the corpus's year; the department check runs over production in `sc1`; the scan covers `test/` |
| C1-3 | C | `extract-ng.py` can file Sem 2 under Sem 1 | counts per semester, and `year check` flags a move above 25%; "both sections required" became "every published semester's section, of the target year" in r3–r4 (C2-4, B3-5) |
| C1-4 | C | dates are revisions; no NG file closes everything; refreshes repeat in a year | facts corrected; G2 reworded; monthly Registrar reminder; mid-year revision path in the runbook |
| C1-5 | C | `year check` gates nothing; ingest only warns | deploy and the bundle build run it; ingest refuses a missing or stub NG file |
| C1-6 | C | missed literals (`app.js:166` months, aria snapshots, the sources folder, the runbook) | listed; months computed from the year; the scan matches any `20\d\d` with an allow list |
| C1-7 | C | the drift check fails silently (60-day disable, shape change, an always-open issue) | its failure opens an issue; next year has its own issue; the monthly report commit keeps the repo active |
| C1-8 | C (minor) | `ng-courses` has no sha; the date would sit in two files | `extract-ng.py` writes sha and date into its own file; each document's date lives in one place |
| C1-9 | C (minor) | the rehearsal can't catch year-specific test data; `--year` mixes years | production tests assert invariants only; `--year` flags removed |
| C1-10 | C (minor) | no time estimate or order | the runbook gives the order (asset before the PR, merge only when complete) and times |


### Round 2 (fresh critics on r2)
Found sound by round 2:
- **A:**
  - the eval runs in CI with no Cloudflare call (sha-checked release assets, committed dev query
    vectors);
  - `--strip` and `--unfiltered` exist;
  - the fusion tiebreak is deterministic;
  - the last-green base handles squash merges and reruns;
  - A1-3's always-running content check;
  - the 11-of-60 count.
- **B:**
  - wrangler 4.157.0's `d1 time-travel info --json`, `deployments list/status --json` and
    `rollback`;
  - `/admin/hashes` can carry a `catalogueKey`;
  - the 11-04 cache is what D1 was loaded from;
  - every §1 citation it checked.
- **C:**
  - ingest refusing stubs;
  - the row hash covering `ng_allow`;
  - generic texts for unknown rule ids;
  - the department check over production;
  - the eval on the pinned corpus;
  - the gate's one-day estimate;
  - no year literals in the vector, group and vocabulary builders.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A2-1 | A (blocking) | after one neutral ranker change the lock's tree hash is stale, so every later push pays the slow path | the fast path also passes when the inputs equal those of a commit whose `eval-gate` passed (PR base or `main`'s last green); the lock is never rewritten for a neutral change, so PRs don't conflict on it |
| A2-2 | A (blocking) | rerunning `eval:lock` passes by accident; a ledger row isn't tied to HEAD; ADR pin lines are written after the merge, so no-look changes and reverts can't pass | evidence must be new since the base lock (a ledger `pass` row against the base pin, or a count-log row naming an allowed route), cited once; `revert` matches an earlier lock in history; `eval:lock` refuses to change lists without `--evidence`; pin lines are not evidence |
| A2-3 | A | the lists depend on more than `HASHED` (runner, fakes, eval config, study map, dev embeddings, fixtures) | `inputsHash` covers `LOCK_INPUTS`, which adds those paths; a completeness test |
| A2-4 | A | codes-only hashes make a 500 look like an empty 200 | each query's hash covers its status |
| A2-5 | A | 7-0 timed one run; the slow path is three modes plus the fixture, about 3× slower on a runner | one seeded run with three modes (as `identity.test.js`); 7-0 times exactly that and scales by the measured runner factor |
| A2-6 | A | `sc1` on production: pinned-only skips turn the job red; the oracle test is in `full-corpus`; aliases are pinned | the `sc1` project gets production aliases, drops the skips, and runs the oracle and department tests; "zero skipped" in tests-first |
| A2-7 | A | the eval checks the raw sha of `data/ng-courses-2026-2027.json`; a header edit or a revision breaks every report | the existing NG files are not edited; the eval reads a byte-identical pinned copy (ADR 0003 amendment) |
| A2-8 | A | `contents: read` can't list runs; a failed `changes` would skip dependents | `actions: read`; an API error runs everything; heavy jobs use `always()` and treat a missing output as `true` |
| A2-9 | A (minor) | "`check` has no `if`" would drop the draft guard | the draft guard stays; the test bans only path-based skips |
| A2-10 | A (minor) | there are no RRF weights; `fuse` has one `RRF_K` | the throwaway PR changes `RRF_K` |
| A2-11 | A (minor) | the rehearsal writes into the tree | it runs in a temp copy |
| B2-1 | B (blocking) | ingest, the bundle and `catalogue_only` still read `.data/cache`; a refetch splits D1 from the asset | `data/corpus.json` manifest; ingest, the bundle and every builder read only the sha-checked asset; CI checks its data version and `catalogueKey`; `corpus restore` for fresh worktrees |
| B2-2 | B | deploy can refuse (not the tip, CI pending) after D1 is written | `deploy --preflight` before any D1 write; `--behind-ok` (logged) for a tip that moved after the ingest |
| B2-3 | B | the drill's target `b0834844` has no tag, so rollback refuses | marked back-filled tags for `b0834844` and `f8aefeab` |
| B2-4 | B | per-worktree appends to one log conflict, block `git pull`, and numbering errors block deploys | one file per run with a unique name; nothing numbered at write time; the exemption admits only new run files |
| B2-5 | B | the smoke's "in the top 5" fails for grouped codes and shared titles; the bundle has no titles | draws ungrouped, uniquely titled codes; takes the title from `/module` first |
| B2-6 | B (minor) | production applied 0008 before 0007 | migrations compared as a set |
| B2-7 | B (minor) | `--d1-restored` is an unchecked claim; Time Travel reaches back 30 days | rollback reads D1's data version itself; the 30-day limit is in the runbook and risks |
| B2-8 | B (minor) | Ctrl-C between the promote and the tag leaves no record | an intent record before the promote; signals finish the tag and the record |
| B2-9 | B (minor) | a record names HEAD even when the tree is dirty | `dirty` flag and diff hash |
| B2-10 | B (minor) | GitHub writes and the contingent re-ingest are uncounted | counted in §3 |
| C2-1 | C (blocking) | NUS's documents are only on the Mac; the YST text step has no script | encrypted per-year sources archive as a release asset (G5); `sources restore`; `yst-text.mjs` |
| C2-2 | C | 43 of 132 ids differ between transcribers; ids are hard-coded in the builder and the page | fixed id scheme; `--map-to` last year's ids by quote; overlay roles replace literal ids |
| C2-3 | C | waiting for both lists means a September switch; the restrictions name no year; "the other semester" would be false | G2 reframed (switch at the Sem 1 list and the NUSMods year, with an "unpublished Sem 2" reason); facts added |
| C2-4 | C | a PDF with last year's Sem 2 passes every check | every heading must name the target year |
| C2-5 | C | the oracle's D1–D24 and the register's code-named rows leak or go stale; `TWINS` and the rest stay in the builder; no rule on who fixes the oracle | D1–D24 become register rulings; code-named rows flagged for re-verification; the per-year overlay module takes `TWINS`, `DECIDED` and `LAW_COMPULSORY`; year-invariant logic shared; oracle fixes go to a fresh subagent |
| C2-6 | C | NUS quotes are hand-copied outside any source file | each quote names its document in the manifest; `year check` finds it verbatim in the restored text |
| C2-7 | C (minor) | six files import the oracle directly | one selector; a test bans direct imports |
| C2-8 | C (minor) | "4F, then `year next`" is circular | `year next` runs first and never overwrites |
| C2-9 | C (minor) | reminders stop in September; the keepalive is manual | reminders monthly all year; a 45-day note in the reminder; GitHub's own warning |
| C2-10 | C (minor) | ingest reads only `.data/cache`, so a fresh worktree can't ingest | `corpus restore` from the manifest |

### Round 3 (fresh critics on r3; the last round)
Found sound by round 3:
- **A:**
  - `ci.yml` has no `needs` today;
  - the last-green base;
  - `RRF_K` at `search.js:98`;
  - the pinned-only skips;
  - the grid timings;
  - `schema-snapshot.mjs` filtering `d1_` tables, so the migrations need their own set query;
  - `findings.yml` unfiltered;
  - the production bundle entry.
- **B:**
  - the drill's targets both at `d820d578cf81`;
  - about 21k rows per data check;
  - `GET /admin/catalogue` exists;
  - wrangler's `time-travel info/restore --json` and the 30-day limit;
  - the CSP surviving a rollback;
  - tag pushes triggering no workflow;
  - the standby deleting orphans by listing;
  - the guard's env-file pattern.
- **C:**
  - a skipped bundle failing loudly at ingest;
  - `yearLine` across the switch;
  - `ng-unscheduled` not moving the lock;
  - the oracle selector, overlay roles and stub refusal;
  - G1, G3 and G4.

r4 applies the resolutions below and has not been critiqued. Nothing above minor is left
unaddressed, but r4's changes are untested by a critic. One item is open for the lead, because it
needs Jacob's G2 answer.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A3-1 | A (blocking) | the runner reads files outside `LOCK_INPUTS` (`sets.mjs`, `corpus.mjs`, `embeddings.mjs`, `query-forms.mjs`, `workspace.mjs`, `pinned-corpus.mjs`, the lockfile), so the fast path passes a real change and wedges the next PR | `LOCK_INPUTS` adds the runner's static import closure (acorn) and `package-lock.json`; the completeness test recomputes the closure and fails on an unresolvable dynamic import |
| A3-2 | A (blocking) | the fast path ignores the lock file, so a botched lock merges green | the fast path also requires HEAD's lock lists to equal the base's; a lock-only edit takes the slow path and the evidence check; tested, with a hand-set `inputsHash` |
| A3-3 | A | the pinned NG copy pins nothing: `loadNgCourses` still reads the live courses and restrictions files | both files are pinned and passed into `offeredModules`; the test compares modules, not a sha |
| A3-4 | A | `count-log.md` has no route column; Phase 4's no-look route is missing | `--route` on `eval:count`/`eval:representatives`, a `route` column, Phase 4's route listed, ADR 0003 amended |
| A3-5 | A | "one seeded run as `identity.test.js`" confuses the `sc1` harness with the eval runner; the fixture needs a second seed | the lock uses the eval runner, two seeds; 7-0 times exactly that; never in the `sc1` project |
| A3-6 | A | the oracle test can't join `sc1` (`.node` excluded); `sc1` seeds the pinned corpus; two `sc1` checks aren't invariants | an `sc1-node` project in the same job; `sc1` restores and seeds the production corpus; `STANDBY_RECALL_FLOOR` and the 3G ruling stay pinned in `full-corpus` |
| A3-7 | A | `rollover` can't run the restrictions builder or `extract-ng.py` in CI; the copy list misses the overlay, register, transcription | the rehearsal copies built JSON and every per-year file; heading and role cases are unit tests (`--from-text`, a fixture overlay) |
| A3-8 | A (minor) | CI checking the committed rules file's hash is circular | preflight requires a committed `year check --full` record for the source-derived inputs' hash |
| A3-9 | A (minor) | `always()` runs on cancel | `!cancelled()` |
| A3-10 | A (minor) | the manifest's stored data version goes stale after an NG revision | the manifest stores none; CI recomputes from the asset and HEAD's NG files |
| A3-11 | A (minor) | `treeHash` walks ignored files | `inputsHash` hashes git objects |
| A3-12 | A (minor) | no `--compare-remote` test; `20\d\d` matches hex | test added; `\b20\d\d\b` with a hex case |
| B3-1 | B | no tool restores D1; nothing finds the bookmark; restore prompts without `--json` | `npm run d1:restore` (newest bookmark record, `--json`, recorded, re-reads the data version); failure paths in the runbook |
| B3-2 | B | the year switch charges about 66k against the 40k default; a stop leaves `catalogue_only` half-written | the runbook passes `--write-budget 80000`; §1 and §3 corrected; rerun guidance |
| B3-3 | B | preflight's `year check` needs the archive key for every deploy | preflight runs the CI mode; `--full` is required only when source-derived inputs change |
| B3-4 | B | the manifest's data version depends on the NG files; no `current` pointer | no stored data version; `current` field |
| B3-5 | B | the July switch can't pass the count rule or "both sections" | extraction and the count rule read the manifest's published semesters |
| B3-6 | B | smoke after a cross-year rollback checks HEAD's data | `--expect` reads that commit's files |
| B3-7 | B (minor) | rollback checks no `catalogueKey` | the tag carries it and rollback checks it |
| B3-8 | B (minor) | the standby isn't rolled back | stated; rerun `vectors standby` from the target if it matters |
| B3-9 | B (minor) | "every remote op has a record" can't hold for 7-0; some writers missing | criterion limited to after 7C; 7-0 logged by hand; writers added (`corpus`/`sources publish`, `eval:embed`, `d1:restore`) |
| B3-10 | B (minor) | after a rollback the newest `deploy/*` tag isn't live | the criterion counts `rollback/*` tags |
| B3-11 | B (minor) | 7D's contingent re-ingest from an unmerged branch contradicts the preflight rule | it runs from merged `main` after a preflight |
| B3-12 | B (minor) | rollback's data check depends on the working tree's Worker | direct `d1 execute` reads; no Worker session |
| C3-1 | C (blocking) | the eval also reads the live restrictions file; a revision fails `eval-gate` with no evidence route | as A3-3: both NG files pinned for the eval |
| C3-2 | C | the unpublished Sem 2 state's behaviour is undecided and touches more code than named | **design given, and open for the lead:** last year's Sem 2 list, labelled, counted "to confirm", never open; the touchpoints are listed (`eligibility.js:85,138`, `ng-reasons.js:72`, `shortlist.js:343,389-391`, the oracle, SC1, YST); G2 asks Jacob to confirm it. The detailed spec waits for his answer |
| C3-3 | C | the checks block G2's own switch; NUS prepends sections; YST Sem 2 missing in July | `extract-ng.py --year` keeps target-year sections; checks read the published semesters; YST follows the same flag |
| C3-4 | C | the mid-year revision path can't be carried out from the docs | written out step by step: archive revision, partial re-transcription in a copy, overlay, oracle, agreement, `--full`, bundle, PR, preflight, bookmark, row-only ingest, deploy |
| C3-5 | C (minor) | G5 didn't say the key could block deploys | it can't now (B3-3); G5 says what the key blocks |
| C3-6 | C (minor) | the archive missed the brochure, the application guide and the info sheets | added; unarchivable sources listed as `unarchived` and reported |
| C3-7 | C (minor) | G2's wording hid that applicants see 2026/27 from April to July | G2 says so |
