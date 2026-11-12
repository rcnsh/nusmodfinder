# Phase 8 plan: launch readiness (r4, after critic round 3, the last)

Goal (exit): **SC10** is met, the name and domain gate is confirmed, and the site is ready for an
announcement. Jacob decides whether to announce it and posts it himself.
- **SC10:** README, EVAL.md and the vault page describe the system as it is.
- **The name and domain gate:** ADR 0009 is accepted ("NUS Mod Finder (unofficial)" at
  nusmodfinder.rcn.sh). Phase 8 asks Jacob to re-confirm it (G1) and doesn't reopen it.
- **Conclusion of §1:**
  - **Cost is small, but the project's rule is zero overage.** A launch spike of 10,000 uncached
    searches in a day costs about 330 to 660 Workers AI neurons.
    - The search cache and the keyword-only fallback already cover a spike.
    - Paid bills overage rather than refusing it. ADR 0004 says "Nothing in this project may run
      up an overage".
    - The month's busiest day used 68% of the shared daily neurons, about 4,300 of them this
      project's own corpus embeds. With no embed or re-ingest on a launch day, about 110,000
      uncached searches fit; past that the overage is cents, but it breaks the rule. G5 asks Jacob
      what he wants.
  - **The docs are the risk.**
    - EVAL.md still opens on the Phase 2 baseline, its reproduce commands no longer run as
      written, and it says no holdout look was taken (8 have been).
    - REFERENCE.md's older sections keep the old working title, the reversed v1 conclusion,
      free-tier and pre-3-0 cost text, and stale counts.
  - **Gaps a visitor would hit:**
    - a mistyped URL shows raw JSON;
    - the page says nothing without JavaScript;
    - on a phone, nothing says which academic year the site covers;
    - there is no privacy note, although Cloudflare keeps request URLs, search text included;
    - a keyword-only answer can stay in a browser for 4 hours;
    - a student who finds a wrong status has no way to report it.
  - **Operations gaps:**
    - deploys from Actions run no smoke check;
    - a rollback is undone by the next push to `main`.
- **Out of scope:**
  - search quality: S2, S3, S4 and S6 stay known limits (ADR 0011 G4);
  - new features;
  - the 2027/28 refresh (July, `docs/year-refresh/`);
  - posting or announcing anything. That's Jacob's action, after this phase.

This plan changes no product code. Numbers come from the repo at `2fa2558` (= `origin/main`), from
a fresh clone of it, from cited evidence files, or from the live calls listed at the end of §1.
Every number marked *est.* is an estimate. r2 to r4 apply critic rounds 1 to 3 (§6). r4 has not
been critiqued; the rounds stop at three.

## 1. Measure today

### Production and `main`
- Live: version `d0cb8211` (tag `2fa2558`), data version `7eb77cf0828b`, production bundle
  6,818 vectors (`/health`, 12:51:44 UTC).
  - Every push to `main` deploys from Actions once CI is green, docs-only pushes included
    (`docs/REFERENCE.md:654-657`).
  - The latest guard read 21,353 D1 rows (`docs/evidence/ops/runs/20261112T120742Z-deploy-e9bb.json`).
  - **An Actions deploy runs no smoke.**
    - `grep -n smoke .github/workflows/*.yml scripts/deploy.mjs` finds nothing.
    - The deploy's record is a workflow artifact, and nothing is committed from CI
      (`docs/REFERENCE.md:648-650`).
    - Smoke is a manual Mac step (`:706-711`). Committing its record is itself a push that
      deploys again.
- Repo `rcnsh/nusmodfinder` is **public** (`gh repo view`). The README is the first page many
  visitors will read.
- Phase 7 closed at `phase7-final`. Holdout looks: 8 of 12. Test-set looks: 1 of 1
  (`eval/holdout-ledger.md`).

### The fresh clone (the README's "Run it locally")
Fresh `git clone` of `origin/main` into a temp dir on the Mac, 2026-11-12. This plan's branch is
re-tested before the PR opens (§6):

| Command | Result |
|---|---|
| `nvm use` | `.nvmrc` says `22`; README says "Node 22.12+"; `package.json` `engines` `>=22.12.0`. Not run (the Mac's Node is 26.13.0). |
| `npm ci` | ok, 2.1 s with a warm npm cache. npm 11.20.0 skips install scripts (esbuild, fsevents, workerd: "Run `npm install-scripts approve`"); nothing below needed them. |
| `npm run dev` | prints `http://127.0.0.1:60943` (a free port; 8787 and 8799 are refused, `scripts/ui-server.mjs`); `/` 200, `/health` the fixture bundle (434), a search 20 results; stopped cleanly. It runs a fake embedder over 434 fixture courses, so its ranking is not production's (a critic's "machine learning for beginners" put LAK1201 Korean 1 first). |
| `npm test` | 144 files passed, 5 skipped; **1,954 tests passed, 22 skipped**, 17 s. The "Authentication error [code: 10000]" lines come from the fake wrangler in `test/remote-session.node.test.js:41`, not from Cloudflare. |
| `npm run test:ui` | **796 passed, 74 skipped**, 2.2 min. It needs Playwright's browsers, which this Mac has cached. Without them it fails until `npx playwright install chromium webkit` runs. README omits that line; REFERENCE.md has it (`:483`). |

### SC10 audit: README.md (60 lines)
| Line | Claim | Today | Verdict |
|---|---|---|---|
| 3, 5 | what it is; "unofficial, not run by NUS or NUSMods" | matches the page and its footer (`public/index.html:176`) | true |
| 7-10 | queries, filters, phrase chips | match `public/`, `src/query-intent.js` | true |
| 12 | exchange mode asks "your year of study at home" | the page asks "Your year of study during your exchange" (`public/index.html:69,110`); NUS's rules turn on that year | **wrong** |
| 9-19 | (missing) | **the shortlist and its CSV and PDF exports** (Phase 6, SC3), the planning half of the site | **gap** |
| 9-19 | (missing) | **which academic year**: the site serves NUS's 2026/27 lists until the July switch (ADR 0011 G2) | **gap** |
| 9-19 | (missing) | **how to report a wrong status or reach whoever runs the site**: `grep -rniE "github\|mailto\|feedback\|contact" public/` finds nothing | **gap** (G6) |
| 21-23 | FTS5 and an exact dense search over `bge-small-en-v1.5`, fused by RRF; "~10.7 MB bundle" | production bundle 10,758,136 bytes (`data/vectors.json`); grows with each refresh | stale (10.8 MB); a corpus-following count, so say "about 11 MB" or point to the file |
| 24-27 | query understanding; `public/`, Plex, Playwright and axe in Chromium and WebKit | `src/typo.js`, `playwright.config.mjs`, CI `ui` | true |
| 31-34 | the ranker "is scored offline against the first hybrid version (`eval-v0`)"; "Later changes are gated on a separate holdout" | SC5 was against `eval-v0`, but each later change is compared with the shipped pin `a23601d` (`eval/lib/baseline.mjs:37`). Several shipped with no look, by ADR 0003's no-look routes (3F, 3G, 4A–4D, the representative; ADR 0003 :563 on). CI's ranking lock gates every ranking change (`docs/REFERENCE.md:1202`). | **wrong** |
| 35-36 | "EVAL.md has the method, the Phase 2 baseline and what the numbers do not show" | follows EVAL.md | follows EVAL.md |
| 40-44 | the four commands | all run (above); `dev`'s ranking isn't production's | true; add the browser install line and say what `dev` runs on |
| 46-59 | REFERENCE.md pointers, data sources, MIT, IBM Plex under the OFL | the files exist; the links answer 200 (critic C) | true |

### SC10 audit: EVAL.md (342 lines)
EVAL.md describes the Phase 2 eval and the v1 eval. It doesn't describe the eval as it stands
after Phases 3 to 7.

| Line | Claim | Today | Verdict |
|---|---|---|---|
| 3 | "Phase 2 baseline (**current**)" | the shipped ranker is `a23601d` (`eval/lib/baseline.mjs:37`); SC5 passed at `phase3-final` (`sc5.md`) | **stale** |
| 14-15 | "Vectorize search is approximate, while the replica's is exact"; "both live fidelity checks failed on the dense half" | since 3-0, production's dense search is the exact in-Worker bundle, so replica and production differ only in the corpus (`sc5.md:12-13`) | **stale** |
| 16-17 | production serves the 2026-11-04 catalogue (6,778 modules) | `current` is `prod-2026-2027-20261112` (`data/corpus.json`) | **stale** |
| 33 | qrels "`qrels-dev-v2`, 1,666 pairs", and the table's 0.712 over n = 83 | `eval/dev/qrels.json` is `qrels-dev-v11`, 2,476 pairs. Against `846fac2`'s copy, the grade ≥ 1 sets differ on 60 of 98 queries, and 90 queries have a relevant document, not 88 (critic A, round 2). `docs/evidence/phase2/baseline-table.mjs` reads the set's `qrels.json`, so HEAD can't reproduce 0.712. | **stale; not reproducible** |
| 20 | query embeddings `emb-bge-small-v0` | the eval's default is `emb-bge-small-v1` (`eval/embeddings.json:2`) | stale for the default, true for the baseline |
| 97-100 | "No look has been taken"; "Looks are spent only on Phase 3 candidates, at most 12" | 8 holdout looks and the one test look are spent (`eval/holdout-ledger.md`); L8 (5F) was a look outside Phase 3 | **wrong** |
| 104-106 | `npm run eval -- run --set dev --variant v0 --ref eval-v0` (and the lexical and vector runs) | with no `--embedding`, the run takes the default `emb-bge-small-v1`, and the runner refuses a v0 ranker on v1 vectors (`eval/README.md:405-407`, `test/eval/corpus-embeddings.node.test.js:45-46`). The commands need `--embedding emb-bge-small-v0`. | **broken command** |
| — | (missing) | the SC5 result; the ranking lock in CI (ADR 0011, `eval/ranking-lock.json`); ADR 0003's amendments 2026-11-06 to 2026-11-12 (the no-look routes, the count log's `route` column, the eval's pinned NG files); the shipped-ranker pin | **gap** |
| 115-342 | the v1 eval, "historical" | its "uncomfortable conclusion" (`:329-333`) is reversed by Phase 2 (`:70`) and by SC5, yet REFERENCE.md still quotes it as current (next table) | **misleading in place**; belongs in `eval/v1/` |
| 158-160 | "the D1 free-tier daily row-read limit" | history; the account is on Workers Paid (ADR 0004) | moves with v1 |

### SC10 audit: docs/REFERENCE.md (1,345 lines)
The sections written in Phase 7 hold up against the code: Deploying, Deploying from Actions,
Rollback, Operations, the ranking lock, drift. Critic A found two wrong lines in its CI section.
The other stale claims sit in the older sections.

| Line | Claim | Today | Verdict |
|---|---|---|---|
| 13-17, 91-93, 1345 | "the lexical half … accounts for essentially all of the measured improvement; the vector half does not currently earn its keep"; `mode` "is the only reason we know the vector half is not pulling its weight"; "The vector half is unproven" | v1's conclusion; Phase 2 reversed it (EVAL.md:47-49, 65-71: hybrid 0.712 nDCG@10, vector alone 0.672, lexical alone 0.609) | **wrong** |
| 24 | the `/search` route's parameters | omits `exam`, `su`, `hoursBelow`, `prereq` and `ignore` (`src/search.js:164-241`); `/health` (`src/index.js:52`) isn't in the route table | **incomplete** |
| 50, 145 | "40 codes in 2026/27" NG-listed with no classes | `data/ng-unscheduled.json` `count` 43 (after the 2026-11-12 refresh) | **stale** |
| 98-107 | "How a search is answered" | omits 3B's pins and masks, 3C's correction (a second embedding, `src/typo.js:32`), 3F's groups, 3G's no-signal answer, the intents and the representative | **incomplete** |
| 122 | fixture bundle "the ~400 test modules … (632 KB)" | 434 modules, 685,600 bytes (`data/vectors.json`) | stale |
| 124 | production "6,778 at the 3-0 cutover" | labelled as a past count | true as history |
| 207-210 | 1,175 of 1,207 NG codes in the corpus; 1,411 of 1,447 semesters agree | pinned-corpus figures (the same facts `test/full/corpus.test.js:15,30` asserts against the pinned corpus; that test doesn't read REFERENCE.md); not labelled as pinned | label them pinned; keep the numbers |
| 306-307 | "The page is **Exchange Course Finder (unofficial, for NUS)**, the working name until Phase 8" | the page is "NUS Mod Finder (unofficial)" (`public/index.html:7`, ADR 0009) | **wrong** |
| 530-531 | "`npm test` (which reads REFERENCE.md, EVAL.md and ADRs 0001 and 0003)" | no test reads EVAL.md since `51851b6` (`grep -rln EVAL.md test`: only `test/ci-changes.node.test.js`, as a path name) | **wrong** |
| 1186-1189 | the eval runs "a fake Vectorize holding real … embeddings" | since 3-0 the runner builds a bundle; only `eval-v0` keeps the fake Vectorize (`eval/runner/run.mjs:150-157`) | **stale** |
| 1192 | `npm run eval -- --variant v0 --ref eval-v0` | same refusal as EVAL.md:104 | **broken command** |
| 1198-1200 | "`EVAL.md` still describes [the v1 eval]" | follows EVAL.md | follows EVAL.md |
| 1239-1260 | Cost: "CPU is the smaller limit"; "~0.03 per search" | at 0.033–0.066 neurons a search, 10,000 a day covers 4.5M–9M searches a month alone, more than CPU's 2.5M. But the allowance is shared: on 2026-11-06 the account used 6,805, about 4,300 of them this project's corpus embeds (`docs/evidence/neurons.tsv`). Pinned by `test/findings/source.node.test.js:55-77`: lines 71-72 pin "**CPU is the smaller limit.**" and line 76 the Phase 1 D1 medians. Both are billed past the allowance, not refused. (FINDINGS B9, `docs/FINDINGS.md:312` names that test.) | **incomplete**: name the shared neurons |
| 1248 | "~6.8k per deploy (the guard)" | 21,353 at the latest deploy; REFERENCE's own :595 and :657 say ~21k | **stale** |
| 1250 | 6,778 × 384 = 2,602,752 stored dims | the standby holds what D1 holds (6,818 today) | stale; point to the file |
| 1291-1294 | "If you blow the limit anyway, every D1 query fails until midnight UTC … or move to the Workers Paid plan" | the account is on Paid; overage is billed, not refused (D1 pricing FAQ) | **wrong** |
| 1296-1299 | the caveat names Vectorize and D1 allowances | the shared allowance that matters is Workers AI's (the busiest day 68%, `docs/evidence/ops/2026-11.md`, mostly this project's own embeds) | **stale** |
| 1308-1309 | "6,771 of the 21,130 records" | pinned figures, asserted by `test/full/corpus.test.js:15` | label them pinned |
| 1324-1325 | one acad year "would … halve the uncached searches the queried-dimension allowance covers" | Vectorize is off the search path since 3-0 | **wrong** |
| 1336-1337 | "No natural-language constraint parsing" | 3H and 5F parse *no final exam*, *S/U*, *light workload* and level phrases (README:12-13); "no Friday classes" is still unparsed | **half wrong** |
| 30 | "the student's year of study at home" | the page asks for the year during the exchange (`public/index.html:69,110`) | **wrong** |
| 1248, 1259 | per search D1 rows: "unfiltered 137–239 (median 239), filtered 249–1,784 (median 497)" (Phase 1) | Phase 3's counted run: p50 255, max 1,403, filtered p50 613.5 (`docs/evidence/phase3/sc7.md:104-105`) | **stale** |
| 806 | "Headers and IPs are never logged" | true of the Worker's own line; Workers Logs' invocation logs carry request metadata and headers on their own (`wrangler.jsonc:6`, see privacy below) | **misleading** |
| 1149-1150 | Workers Logs: "Paid includes their volume" | true until 2026-12-01, then Cloudflare Observability pricing (`docs/evidence/phase7/measure.md:46-49`) | add the date |

### SC10: the vault page
The vault page belongs to the lead. This plan doesn't audit or write it.

**Deliverable for the lead:** audit the project page claim by claim against the code, as §1 does
for the other docs, and update it after 8A and 8B merge. It should cover:
- the state: launched or not, per G2;
- the URL, the stack, the deploy (Actions after green CI);
- the privacy stance (G3), the outage check (G4), the spending rule (G5) and the contact route
  (G6);
- where the launch checklist lives.

A round 2 critic read the page and found four stale statements for that audit:
- the ranker as Phase 3's frozen tag, though the live pin is `a23601d`;
- a human-graded calibration sample, though EVAL.md:95 and ADR 0004 say no human graded a pair;
- a pointer to a README section that lives in REFERENCE.md (:1311);
- "home year" for the year of study during the exchange.

### Launch risk: what a spike costs
**Per uncached `/search`.** One embedding of the query (`src/search.js:394-412`), a second when 3C
corrects a word (`EMBED_CORRECTED`, `src/typo.js:35`), and for a whole-query catalogue-only code an
embedding of its text for `related` (`src/search.js:894-905`). Pricing: `bge-small-en-v1.5` is
1,841 neurons per million input tokens (Cloudflare pricing). Student queries average 15.6 to
18.3 tokens: dev 2,462 / 136, holdout 1,853 / 119, test 4,434 / 242 (`docs/evidence/neurons.tsv`).

| Search | Neurons |
|---|---|
| typical (18 tokens) | 0.033 |
| a corrected typo | 0.066 |
| 200 characters, corrected (*est.* 60 tokens each) | 0.22 |
| whole-query catalogue-only code (`related`, up to 2,000 characters, *est.* ≤ 460 tokens) | ≤ 0.88 |
| cache hit (same canonical query, same colo, within 1 hour) | 0 |

**Other costs per search:**
- **D1:** 255 rows read at the SC7 p50, 1,403 at its max (`docs/evidence/phase3/sc7.md:104`), and
  7,772 at the local grid's worst.
- **CPU:** p50 9.1 ms, p75 15.5 ms, 33-34 ms on a fresh isolate (`docs/REFERENCE.md:1252`). This
  month the Worker's p99 over all requests is 136.7 ms (`ops/2026-11.md`).
- **Logs:** one invocation log and one `search` line per Worker request (`src/search.js:1184`).
- **A visit:**
  - `/` and its files are static assets: no Worker run, no request charge (`wrangler.jsonc`
    `assets`);
  - `/facets` is 1 Worker request and 1 D1 row;
  - `/module/:code` is 1 row, or 2 on a 404.

**A spike, against the account-wide allowances** (Workers Paid). Month to date, 11.4 days
(`ops/2026-11.md`):
- CPU 4,526,846 ms (15.1%);
- requests 386,162;
- the busiest Workers AI day 6,805 neurons (68%, 2026-11-06), of which about 4,300 were this
  project's two corpus embeds (`docs/evidence/neurons.tsv`). Other projects' share that day was about
  2,500.

| Uncached searches | Neurons | CPU (*est.* 12 ms each) | D1 rows (*est.* 500 each) | What happens |
|---|---|---|---|---|
| 1,000 a day | 33–66 | 12k ms | 0.5M | nothing |
| 10,000 a day | 330–660 | 120k ms (0.4% of a month) | 5M (0.02%) | nothing |
| 50,000 a day | 1.7k–3.3k | 600k ms (2%) | 25M | nothing, unless this project embeds its corpus that day too (~2–4k neurons) |
| 100,000 a day | 3.3k–6.6k | 1.2M ms (4%) | 50M | with other projects at ~2,500: 5.8k–9.1k, inside. With a corpus embed the same day, up to ~3.4k over, billed at $0.011 per 1,000: **about $0.04** |
| 1,500–3,000 in one **minute** | — | — | — | Workers AI's limit for text-embedding models is 3,000 requests a minute (Workers AI limits page). A corrected search makes two calls. Past it, embeddings fail and searches go keyword-only. If the limit is per account, other projects' embeddings fail too. |

- **Billing, not refusal.** On Workers Paid, neurons over 10,000 a day are billed, not refused.
  Error 3036 ("daily free allocation") applies to the Free plan (Workers AI errors page).
  - Nothing in the Worker caps its own use.
  - ADR 0004 (:30-32) rules that "Nothing in this project may run up an overage". It was written
    when the only traffic was the project's own operations.
  - With no corpus embed or re-ingest that day, about 110,000 uncached searches (at 0.066) fit
    beside other projects' ~2,500. Past that, or on a day with an embed, the rule breaks. G5 asks
    Jacob what he wants.
  - Cloudflare's budget alerts email when the account's usage-based spend crosses a threshold. They
    fire the day after, cap nothing, and are on by default at $10 for eligible accounts (Cloudflare
    changelog, 2026-07-20).
- **Worst-case abuse.** Unique uncached searches past the allowances cost about **$2 to $12 per
  million** (*est.*):
  - neurons: $0.36–0.73 at 0.033–0.066 each, up to $9.70 at the 0.88 worst case;
  - Workers Logs: $1.20 at two events a search and $0.60 a million, until 2026-12-01;
  - requests: $0.30 a million;
  - CPU: $0.24 at 12 ms and $0.02 a million ms.

  Cache hits skip the limiter but still cost a request and log events.
- **The burst guard.** `SEARCH_LIMIT` allows 20 per 10 s per IP and colo (`wrangler.jsonc`,
  `src/search.js:1211`). It stops one runaway script, not a spread-out one.
- **Other sites can spend this account's neurons.**
  - Any third-party page can make its visitors' browsers send `/search` requests, each from its
    own IP. A plain cross-origin GET is a CORS "simple request": the browser sends it and the
    Worker runs the search. CORS only decides whether the calling page may read the answer (MDN).
  - Every JSON answer also carries `access-control-allow-origin: *` (`src/http.js:11`,
    `src/modules.js:131`, `src/search.js:1224`). It has been there since the initial commit
    `3b18041`, with no recorded reason. So such a page can read the answers too.
  - `searchRoute` checks no `Origin` or `Sec-Fetch-Site`.
  - The page itself is same-origin (`connect-src 'self'`, `public/_headers`). Smoke, the eval and
    `curl` send no `Sec-Fetch-Site`.
- **The cache.**
  - It is checked before the limiter (`src/search.js:1204-1207`), and is per data centre.
  - Live, the repeat of a miss was a hit in 24 ms. The miss carried `max-age=3600`, as stored; the
    hit carried `max-age=14400`.
  - The Worker's own response isn't rewritten: the miss left with 3600. The 14400 is on the
    stored copy `cache.match` returns, which matches the zone's Browser Cache TTL default (4 hours,
    Cloudflare cache docs). Setting `cache-control` on the hit fixes it, since the Worker's response
    header is what the browser gets.
  - Live calls 11 and 17 both show it.
  - So a keyword-only answer, stored for 60 s (`src/search.js:60,1238`), can come back from the
    edge within its minute with 4 hours on it. The page's fetches set no `cache` option
    (`public/api.js:101,125`), so that visitor keeps the keyword-only answer after Workers AI
    recovers.
  - Miniflare's cache returns stored headers unchanged, so no local test shows the 4 hours.
  - Every deploy changes the version id, which is in the key (`src/search.js:1201`). So each
    merged PR, docs included, empties the search cache.
- **Shared NAT.** The limiter's key is the client IP (`src/search.js:1212`). A room of students
  behind one address shares 20 searches per 10 s. The page searches on submit and on a filter
  change, not per keystroke (`public/keys.js`, `public/nav.js`). Over the limit, a visitor reads
  "Too many searches from your connection. Try again in a minute." (`public/messages.js:20`).

**If Workers AI or D1 fails** (SC7's fallback, `src/upstream.js`):

| Failure | What the Worker does | What a visitor reads |
|---|---|---|
| Workers AI error, timeout (1.5 s), capacity (3040) or rate limit (429) | keyword-only answer (`degraded`), stored 60 s, but see the cache note above; the dense circuit opens after 3 failures for 30 s per isolate | "Search is in a simpler mode right now: it finds only courses that contain the words you typed…" (`public/messages.js:95`) |
| Vectorize | nothing: it is off the search path (`DENSE_BACKEND=bundle`) | nothing |
| D1 error or timeout (3 s) | 502 `upstream_failure`, not cached | "The search service could not reach its course data. Try again in a moment." (`:21`) |
| an unhandled throw | JSON 500 with the `cf-ray` (`src/index.js:93-105`) | "Something went wrong in the search service. Try again in a moment." (`:22`) |
| rate limit | 429, `retry-after: 60` | the sentence above |

### Launch risk: what a visitor sees
From the live calls (end of §1), critic C's local run (`npm run dev`, 390 px) and the code:
- **The academic year.**
  - The site serves NUS's 2026/27 lists. The header's "Academic year 2026/27" is hidden at
    1040 px and below (`public/styles.css:353,360`, `.hdr-r { display: none; }`): a critic found no
    "2026/27" in the results view at 390, 640, 768, 820, 1024 or 1040 px.
  - The phone's first screen offers "Sem 1 Aug–Dec 2026" and "Both semesters Aug 2026–May 2027".
  - The results view at 390 px shows no year at all (critic C, round 2: a page-text scan).
  - **2027/28 applicants are told.** The shortlist says "This order uses NUS's 2026/27 exchange
    list and exams. Applying for 2027/28? NUS publishes Sem 1's list in March or April…"
    (`public/shortlist.js:143`). Phase 6 designed it so applicants plan on 2026/27's lists and
    exams (`docs/evidence/phase6/facts.md:157`).
  - Outside the shortlist and the export, nothing mentions 2027/28. In March the first screen
    still offers "Sem 1 Aug–Dec 2026" (`public/app.js:167-168`).
  - Applicants apply for 2027/28 in March and April. NUS's pages give two windows: 25 March to
    12 April, and 21 March to 10 April, both from an earlier cycle. Nomination comes first, in
    February and March (`docs/evidence/phase6/facts.md:119-121`). The site moves to 2027/28 in July
    (`docs/year-refresh/README.md:136`).
- **Reporting a problem:** the page names no contact and no issue tracker. The footer links only
  NUSMods and NUS (`public/index.html:177-182`).
- **Cookies:** the site sets none. Live calls 16 and 17 (`/` and a `/search`) carry no
  `Set-Cookie`. Cloudflare's bot features may set a security cookie when they challenge a visitor;
  none was seen.
- **A mistyped path** (`/no-such-page`): HTTP 404 `{"error":"not_found","message":"No route for
  /no-such-page."}` as raw JSON in the browser (`src/index.js:63`). It is JSON even with
  `Accept: text/html` (critic C). `wrangler.jsonc` `assets` has no `not_found_handling`.
- **`/favicon.ico`:** a JSON 404. The page links `/favicon.svg`, `/favicon-32.png` and
  `/apple-touch-icon.png`, which all exist, but each request for `/favicon.ico` spends a Worker
  request. This month 144 of the Worker's 303 requests were 404s (`ops/2026-11.md`); what they
  were is not recorded.
- **An unknown course** (`/module/ZZ9999`): 404 `kind: "unknown"`, cached 60 s. The page says
  "There is no course ZZ9999 in the NUS catalogue. Check the code." (`public/messages.js:74`).
- **No JavaScript:** the first screen renders without its semester options and does nothing. No
  `<noscript>` (`grep -n noscript public/index.html`: none).
- **Footer links:**
  - "Courses offered to exchange (NG) students" and "Course restrictions for exchange (NG)
    students" both point to the same Registrar page (`public/index.html:179-180`).
  - The restrictions document has its own address (`data/ng-sources-2026-2027.json:42`).
- **Mobile:**
  - SC8's 390×664 fold specs pass in both browsers (`test/ui/fold.spec.js`, the fresh-clone run).
  - Critic C ran set-up, search, shortlist and CSV export at 390 px with no console error.
- **Share preview:**
  - `og:title`, `og:description`, `og:image` (1200×630) and `twitter:card` are present
    (`public/index.html:13-23`).
  - The image says "NUS Mod Finder", "unofficial" and the URL.
  - `og:site_name` is "NUS Mod Finder" alone (`:15`).
  - Live `/og.png` is 200, 46,659 bytes.
  - No preview was rendered in a real messaging app.
- **robots and SEO:**
  - Live `/robots.txt` is 200, Cloudflare's managed robots.txt with content signals. The Worker
    sends no such file, and `public/` has none.
  - Title, description and canonical link are present.
  - No sitemap: one page with its state in the query string.

### Launch risk: privacy and legal
- **Workers Logs.**
  - `observability.enabled: true` with no `logs` block (`wrangler.jsonc:6`). So every Worker
    request (`/search`, `/module`, `/facets`, `/health`, 404s) gets an invocation log. Cloudflare
    documents it as carrying "the Request, Response, and related metadata" and "request metadata,
    and headers".
  - Logs are kept for **7 days** on Paid (Workers Logs docs). From 2026-12-01, under
    Observability pricing, 7 days is the default, and Cloudflare plans 30, 90 and 365-day options.
    So the note states the account's setting, and the checklist re-checks it.
  - The URL carries `q` (the full search text), `sem`, `study` and the filters.
  - Whether IP-bearing headers appear is **not measured**. 8-0 reads one.
- **The Worker's own `search` line** (`src/search.js:201,1184-1187`) carries the query cut to 100
  characters, the filters, counts, spans, colo and version. It has no IP and no header.
  - Whether Workers Logs attach request metadata to custom lines too is **not measured**. 8-0
    reads one.
- **Zone-level request analytics**, which `observability` doesn't control.
  - Cloudflare's HTTP request analytics (`httpRequestsAdaptive`) and Security Analytics keep
    sampled per-request records on every plan, for at least 31 days (Cloudflare's datasets page,
    per critic B).
  - These cover the page itself too, whose URL carries the search text after a search
    (`/?q=…`, live call 9).
  - Whether the IP and the query string appear there is **not measured**. 8-0 reads one sampled
    entry.
- **On the device:**
  - `localStorage` holds the year of study (`vnm.study`, `public/app.js:186-188`, written at
    `:761,804,1134`) and the last edited shortlist (`public/saved.js`).
  - "Forget this list on this device" clears the list (`public/shortlist-view.js:221`). Nothing on
    the page clears the year.
  - "Copy link" shares a URL that carries the year of study and the picks (`…&study=ug2&pick=…`).
  - No cookies (live calls 16-17). No third-party request (self-hosted fonts; CSP
    `default-src 'none'`, `'self'` only, `public/_headers`).
  - No `Referrer-Policy` is set. The browser's default sends only the site's origin, not the
    search text, when a student follows a link to NUSMods or NUS (critic C, round 2).
- **A privacy note: none.** `grep -rni privacy public/` finds nothing.
- **"Unofficial" wherever the name appears:**
  - covered:
    - `<title>`, `og:title` and the `<h1>` at every width (`public/index.html:7,16,43`);
    - `og.png` and the footer (`:176`);
    - the README (`:5`) and the GitHub description;
    - the export's foot (`docs/REFERENCE.md:406`);
  - gaps: `og:site_name` (`:15`) and the JSON 404s.
- **NUSMods:**
  - The README and the footer credit it and link it.
  - NUSMods publishes no API terms beyond "Please be considerate and use these services
    responsibly" (its GitHub README); the old API repo is MIT.
  - Visitors never call NUSMods: the site reads D1. NUSMods sees one conditional GET a week (drift)
    and the manual refreshes. Launch traffic adds nothing there.
- **NUS's text:**
  - Course titles, descriptions, prerequisites and preclusions are NUS's text, as NUSMods
    republishes them. The page shows them in full, and the export labels the description "Course
    description (NUS, via NUSMods)" (`docs/REFERENCE.md:410`).
  - NUS's rules are quoted in 19 short, attributed sentences, each checked against the archived
    sources (`docs/evidence/phase7/exit.md:22`).
  - ADR 0011 G5 settled the sources (archived encrypted) and the quotes (they stay). Showing
    descriptions is what NUSMods has done for years. It is a residual risk, answered by taking
    text down if NUS asks (8C).
  - nus.edu.sg was not fetched for this plan.
- **Fonts:** IBM Plex under the SIL OFL 1.1 (`public/fonts/OFL.txt`), named in the README.

### Launch risk: operability after launch
- **Who notices an outage:** nobody, automatically.
  - ADR 0011 G3 declined a daily live check, as adding traffic to a site Jacob can check himself.
  - Smoke runs only on a deploy. The monthly report counts errors after the fact. Drift makes no
    live-site call (`docs/REFERENCE.md:1152-1155`).
  - **Launch changes the calculus.** This month the Worker served 303 requests, 159 of them 200s,
    mostly Jacob and the checks. After a post, strangers rely on the site in a registration
    window, and an outage could last until Jacob next looks. Hence G4.
- **The monthly report:** `npm run ops:report` (7F); 2026-11 committed.
- **Drift:** weekly; one issue so far (#110, closed by the refresh).
- **Runbooks:** deploy, rollback, `d1:restore`, smoke and the year refresh exist. None covers "the
  site is down": what to look at first, and when to roll back.
- **A rollback doesn't stick.** The Actions deploy runs on every green push to `main` whose tip
  has no `deploy/*` tag (`docs/REFERENCE.md:641-646`). After `npm run rollback`, the next push (a
  note about the incident, a docs fix) redeploys the code that was rolled back. The kill switch is
  the repo variable `DEPLOY_FROM_ACTIONS` (`:654`).
- **Errors outside `/search` leave no line of their own.** D1 failures on `/module` and `/facets`
  answer 502 with no console line (`src/modules.js:257,290`). Only the invocation logs and
  GraphQL's status counts record them (`scripts/ops-report.mjs:65-74`).
- **The NG sources' freshness** is checked by hand: the monthly `drift:reminder`
  (`scripts/drift.mjs:370-371`). The last revision recorded is 2026-11-10
  (`data/ng-sources-2026-2027.json`).
- **Workers Logs pricing changes on 2026-12-01** (`measure.md:46-49`). Today's volume is far
  inside the new inclusion.

### Accessibility and performance (cited, not re-measured)
- **SC8** passed at Phase 5 and held over the shortlist at Phase 6 (`docs/evidence/phase6/exit.md:12`).
  - CI's `ui` job runs the same specs on every page change, and they passed in the fresh clone.
  - `public/` changed in Phase 7: 12 files, +85 −40 (`git diff --stat phase6-final origin/main --
    public/`), all under those specs.
  - No live axe run since Phase 6.
- **SC2** passes (`test/ui/sc2.spec.js`).
- **SC7:** pooled cache-miss p50 186.0 ms at the Phase 3 freeze (`docs/evidence/phase3/sc7.md:81`).
  - Today's 5 misses: `total` 453, 243, 226, 298 and 225 ms. Five calls on one connection is not a
    measurement.
  - Phase 8 doesn't touch the search path, except the hit's `cache-control` and the cross-site refusal,
    so SC7 is not re-measured.
- **Re-measure plan:** only what Phase 8 changes. 8B changes:
  - the 404 page;
  - `/favicon.ico`;
  - `<noscript>`;
  - the privacy note;
  - the year line;
  - the hit's `cache-control`;
  - the cross-site refusal on `/search`;
  - the contact link (G6).

  CI's `ui` job covers them, and 8D checks them once live (≤ 10 GETs, ≤ 1 `/search`).

### What "launch" could mean
The site has been public since 2026-11-11 (ADR 0009). Nobody has announced it.
- **The choices:**
  - (a) no post;
  - (b) Jacob posts in a few channels he chooses;
  - (c) a broad public post.
- **Incoming Sem 2 2026/27 students** (January 2027) are mostly **admitted** by now: NUS makes
  first offers in "first week of June or November" (`docs/evidence/phase6/facts.md:104`).
  - What they have left is CourseReg's "Submit Course Requests" rounds and appeals (`:112`). The
    Sem 2 NG appeal timeline is out ("Updated: 11am, 7 Oct 2026").
  - The shortlist serves them through its "Already admitted?" box and the CourseReg lines.
  - The CourseReg round dates weren't fetched: nus.edu.sg sits behind bot protection, and a
    critic's fetch of the appeal schedule returned a bot check. Business's FAQ puts registration
    "at the beginning of the semester" (`facts.md:107`). Jacob reads the dates by hand (G2).
- **2027/28 applicants** (21 March to 10 April) plan on 2026/27's lists and exams, labelled as
  such (above). NUS may publish 2027/28's Sem 1 list during their window. The site switches in
  July.
- **Before any post (8C's checklist), only what a visitor meets:**
  - 8B live, the privacy note included;
  - the README's rows fixed (8A's README part);
  - G4's choice in place;
  - the latest deploy's smoke green;
  - this month's NG-source check done, with NUS's "updated as at" dates matching
    `data/ng-sources-<year>.json`.

  EVAL.md, REFERENCE.md and the vault page can follow: no student reads them, and a post shouldn't
  miss course registration waiting for them.

### Live calls (all GET, ≥ 4 s apart; 17 of the 25 allowed, 7 of the 10 `/search`, 2 of them cache hits)
The raw log is `docs/evidence/phase8/live-calls.jsonl`. `docs/evidence/requests.tsv` takes no new
rows since 7C (`test/ops-requests.node.test.js:55-64`). Run records need a script, and these calls
had none, so they are listed here, as Phase 7's 7-0 reads were in its `remote-ops.md`.

| # | UTC | URL (on https://nusmodfinder.rcn.sh) | Status | Note |
|---|---|---|---|---|
| 1 | 12:51:39 | `/` | 200 | CSP present; 11,575 bytes |
| 2 | 12:51:44 | `/health` | 200 | tag `2fa2558`, data `7eb77cf0828b` |
| 3 | 12:51:49 | `/robots.txt` | 200 | Cloudflare's managed file |
| 4 | 12:51:55 | `/favicon.ico` | 404 | JSON |
| 5 | 12:52:00 | `/og.png` | 200 | 46,659 bytes |
| 6 | 12:52:05 | `/no-such-page` | 404 | JSON |
| 7 | 12:52:10 | `/module/CS3244` | 200 | `d1;dur=115` |
| 8 | 12:52:16 | `/module/ZZ9999` | 404 | `kind: unknown`, max-age 60 |
| 9 | 12:52:22 | `/?q=cs3244&open=CS3244` | 200 | same page bytes |
| 10 | 12:52:27 | `/search?q=machine+learning+for+beginners` | 200 | miss, 20 results, `total;dur=453`, max-age 3600 |
| 11 | 12:52:33 | same | 200 | hit, `total;dur=24`, **max-age 14400** |
| 12 | 12:52:38 | `/search?q=machne+lerning` | 200 | miss, 0 results, `no-signal` |
| 13 | 12:52:43 | `/search?q=intro+to+psychology&ng=1&study=ug2&sem=1` | 200 | miss, 20 results, `total;dur=226` |
| 14 | 12:52:49 | `/search?q=xqzvbnm+plorft` | 200 | miss, `no-signal` (SC4's gibberish case) |
| 15 | 12:53:04 | `/search?q=machne+learning` | 200 | miss, 20 results (EE2211 first), `total;dur=225` |
| 16 | 13:18:25 | `/` | 200 | no `Set-Cookie`, no `Referrer-Policy` (round 2) |
| 17 | 13:18:31 | `/search?q=machine+learning+for+beginners` | 200 | hit, no `Set-Cookie`, **max-age 14400** again (round 2) |

Call 12 is SC4's example with a second misspelt word. It answers "Nothing in the catalogue
matches". That's a search-quality limit (ADR 0011 G4), recorded here and not planned.

## 2. Workstreams
| WS | Scope | Owner | Branch | Depends on |
|---|---|---|---|---|
| 8-0 | three dashboard reads, then G3; Jacob answers G1, G2, G4, G5, G6 | lead (reads), Jacob (answers) | — | — |
| 8A | the docs describe the system as it is (SC10) | implementer agent | `phase8/docs` | — |
| 8B | what a visitor sees: 404 page, favicon, no-JS, year line, footer links, contact (G6), privacy note, logs per G3, hit TTL, cross-site refusal; their docs | implementer agent | `phase8/visitor` | 8-0, G3, G6 |
| 8C | smoke in the Actions deploy; the launch checklist, post text, outage runbook; the outage check per G4; the budget alert and ADR wording per G5; their docs | implementer agent | `phase8/launch` | G2, G4, G5 |
| 8D | ship, live re-check, a fresh review of the docs, exit; the vault page | lead | — | 8A–8C |

Code workstreams write their tests first, in the first commit of the PR, and those tests fail
before the change. Pure docs are the exception. Every change is ranking-neutral: the ranking lock
takes its fast path or recomputes equal. No holdout look. Each PR that changes behaviour updates
README.md and REFERENCE.md in the same PR, so 8A's work stays true after 8B and 8C.

### 8-0 Three reads, then G3
The lead reads, in the Cloudflare dashboard, and records field names and redacted examples (never a
visitor's values) in `docs/evidence/phase8/measure.md`:
1. **One Workers Logs invocation log for a `/search`, and its `search` line:** which request
   fields, headers and IP-bearing headers each carries, and the account's retention setting.
2. **One sampled HTTP request in the zone's analytics** for a `/search?q=` and a `/?q=`: whether
   the client IP and the query string appear, and the retention Cloudflare states.
3. **The zone's Browser Cache TTL setting.** It is read only. Changing it is a zone-wide change and
   Jacob's call; 8B fixes the hit path in code either way.

Then Jacob answers G3 with those facts in its brackets. The other gates don't wait.

### 8A Docs as they are (SC10)
**Tests first:** `test/docs-facts.node.test.js`.

Text is compared after collapsing whitespace and stripping Markdown quote markers (`> `), so a
phrase split across lines (REFERENCE.md:16-17) still matches. No bare-number search: each number is
matched in its sentence.
- **Facts that change only by a deliberate act**, checked against their source:
  - holdout and test looks spent (rows of `eval/holdout-ledger.md` by set). A look's PR updates
    EVAL.md;
  - SC5's Δ and CI (`docs/evidence/phase3/sc5.md`);
  - EVAL.md's qrels label equals `eval/dev/qrels.json`'s `version`, so a new qrels version fails
    until EVAL.md is re-derived;
  - **the year.**
    - The sentences that state the live year carry a marker (`<!-- year:live -->`), and only those
      are checked against `DEFAULT_ACAD_YEAR` (`scripts/lib.mjs`).
    - Sentences marked `<!-- year:pinned -->` are checked against `PINNED_ACAD_YEAR`
      (`scripts/pinned-corpus.mjs:11`).
    - Identifiers such as `prod-2026-2027-20261104` are never checked.
    - The test proves it fails first by running its check with the year stubbed to `2027-2028`;
  - the NG list's codes per semester, in marked live sentences, against
    `data/ng-courses-<year>.json`. Pinned sentences are checked against `eval/pinned/`.
- **No volatile values in prose.** Since `46c8d56`, a NUSMods refresh needs no test edits, and
  ADR 0003's pin procedure (:565-566) doesn't edit docs. So these are written as pointers to their
  files and never stated:
  - the production bundle's count and size;
  - `ng-unscheduled`'s count;
  - the standby's dims;
  - the shipped pin's sha.

  The test asserts that those pointer sentences (marked `<!-- pointer -->`) contain no number at
  all. A stale 40, 6,778 or 10.7 then fails today, as it should.
- **Retired claims:** no match, outside a section headed "History", for:
  - "Exchange Course Finder";
  - "vector half is unproven", "does not currently earn its keep", "not pulling its weight";
  - "until midnight UTC";
  - "No look has been taken";
  - "Vectorize search is approximate";
  - "year of study at home";
  - "Headers and IPs are never logged";
  - "Exchange Course Finder" and "year of study at home" also cover REFERENCE.md:30 and :306.
- **Commands:**
  - every `npm run <x>` in the README exists in `package.json` (passes today);
  - the README names `npx playwright install` before `test:ui` (fails today);
  - every `--ref eval-v0` in EVAL.md, REFERENCE.md and `eval/README.md` (:38, :45, :296-298,
    :423) also passes `--embedding emb-bge-small-v0` (fails today).
- **Existing tests and references 8A must change in the same PR:**
  - **`test/findings/source.node.test.js:55-77`** (FINDINGS B9) pins the Cost section's text:
    - the B9 arithmetic, which stays as history;
    - "**CPU is the smaller limit.**" (:71-72), which becomes "CPU or the shared neurons" with §1's
      numbers;
    - Phase 1's D1 medians (:76), which become Phase 3's counted run (`phase3/sc7.md:104-105`).

    The test asserts the new text. If its title changes, `docs/FINDINGS.md:312` must name it
    exactly: `check-findings` requires backticked test names to exist, and the Findings workflow
    gates the deploy.
  - `eval/v1/README.md` already exists, kept "so EVAL.md … stay checkable" (:4). It quotes
    EVAL.md's v1 MRR row (:16), and `docs/FINDINGS.md:344,346` cite that row and `EVAL.md:94`. The
    v1 text moves into that file.
  - **The FINDINGS citations are already wrong.** `docs/FINDINGS.md:346` cites `EVAL.md:94` and
    `:41`. The v1 MRR row is at :211 and the `ORDER BY rank` sentence at :158; `check-findings`
    ignores line suffixes. They are re-derived, not moved.
  - The v1 text's `eval/results-main.txt` and `eval/results-holdout.txt` paths become
    `eval/v1/…`.
  - `docs/evidence/phase2/baseline-table.mjs`'s header (:1-4) hard-codes "qrels-dev-v2" and "83".
    It follows the re-score.
- **`scripts/year.mjs` `CHECKLIST`** and `docs/year-refresh/README.md` gain a step: update the
  year labels in the three docs; `docs-facts` must pass.

**The changes** (each row of §1's three tables not marked true):
- **README:**
  - the shortlist and exports;
  - "during your exchange";
  - the academic year it serves and when it moves;
  - how ranking changes ship (SC5 against `eval-v0`; later changes against the shipped pin, by a
    holdout look or an ADR 0003 no-look route, and always CI's ranking lock);
  - the browser install line;
  - `dev`'s fake embedder and fixture;
  - the bundle size as a pointer.
- **EVAL.md, current state first:**
  1. the shipped ranker and how a change ships (the ranking lock, holdout looks 8 of 12, the no-look
     routes, the pin in `eval/lib/baseline.mjs` and ADR 0003);
  2. SC5;
  3. the Phase 2 baseline re-scored on today's `qrels-dev-v11` (an open set, no look, by
     `baseline-table.mjs`), with the v2 numbers kept as history, labelled with their qrels.
     - The re-score moves more than the tables. On v11, 85 queries are primary and 6 unscored
       (d-061 and d-093 now have grade ≥ 1), against 83 on v2 (critic A, round 3).
     - So every qrels-dependent sentence is re-derived: :21-22, :29-31, :43, :74-83 (feature-gap,
       shapes, violations) and :79;
  4. replica and production, which differ in three ways:
     - the corpus (pinned 2026-09-04 against production's `current`);
     - the NG files: `eval/pinned/` never moves, `data/` follows NUS's revisions. They are
       identical today (same sha256);
     - query vectors (Workers AI isn't bit-deterministic, so ties near the cut can differ,
       `eval/README.md:409-413`).

     Since 3-0 both are exact.
  5. what the numbers don't show.

  The v1 eval moves to `eval/v1/README.md`.
- **REFERENCE.md:**
  - every row of §1's table;
  - "How a search is answered" rewritten as the current pipeline, briefly, linking each stage's
    module;
  - the route table completed;
  - Cost leads with today's limits, §1's spike table and G5's rule; the B9 history stays;
  - the Workers Logs date.

**Exit checks:**
- `docs-facts` and `npm test` pass.
- In a fresh clone, the README's commands run as written.
- On the Mac, EVAL.md's dev reproduce commands (open set only, no `--holdout`) print the numbers in
  its tables and its qrels-dependent sentences.
- **A fresh reviewer's pass in 8D** over README.md, EVAL.md and REFERENCE.md against the code.
  §1's tables only bound what was found. Every finding is fixed or rebutted before the exit.

### 8B What a visitor sees
**Tests first:**
- **Worker tests:**
  - **The 404.** An unknown path with `Accept: text/html` gets an HTML 404 with the name,
    "unofficial" and a link home. Its CSP, `X-Frame-Options` and `X-Content-Type-Options` equal
    `public/_headers`' rule, parsed from that file so the two can't drift: Cloudflare doesn't
    apply `_headers` to responses the Worker makes. Any other `Accept` keeps today's JSON 404.
  - **`/favicon.ico`** is a static file (no Worker run).
  - **The hit's TTL.** With `caches.default.match` stubbed to return a stored copy carrying
    `max-age=14400` (as production's does), the hit is sent with 3600, or 60 for a degraded entry.
    Miniflare's own cache returns stored headers unchanged, so only a stub can fail first.
  - **The cross-site refusal.**
    - `/search` with `Sec-Fetch-Site: cross-site` answers 403 before the cache, the limiter and any
      binding, unless `Sec-Fetch-Dest` is `document`.
    - A link a student follows to `/search` is `navigate` + `document`. A hidden iframe is
      `navigate` + `iframe`, and is refused.
    - Served as today: `same-origin`, `none` (a bookmark), and Node's `fetch` as smoke and uptime
      send it (`Sec-Fetch-Mode: cors` with no `Sec-Fetch-Site`, captured by a round 3 critic), the
      eval and `curl`.
    - The tests use exactly those header sets, the iframe case included. The 429 and 403 bodies stay
      JSON.
    - `public/messages.js` gains a sentence for the 403, since today an unknown code shows "The
      search service had a problem. Try again in a moment." and invites retries.
  - **Errors outside `/search`.** A D1 failure on `/module` or `/facets` writes one log line with
    the route and the error, and no URL, query or IP.
- **UI specs:**
  - with JavaScript off (Playwright `javaScriptEnabled: false`), one sentence saying the site needs
    JavaScript is visible on the first screen at 390×664, on `/` and on a shared `/?q=…&pick=…`
    link;
  - **the year line** shows at 390, 768 and 1024 px (the header's year is hidden at 1040 px and
    below) in the set-up, results and shortlist views, with its applicant clause, and the fold spec
    still passes;
  - the restrictions footer link is the restrictions document's address;
  - the contact link (G6) is present and, for (a), carries the course code, semester, year of
    study and data version into the new issue;
  - the 404 page and the privacy note pass axe in both themes.
- **If G3 is (b) or (c):** a config test asserts `wrangler.jsonc`'s `observability.logs`. For (c),
  a Worker test asserts the `search` line has no `q`.

**The changes:**
- **The 404:** `src/404.html`, imported by the Worker. Wrangler imports `.html` as a Text module by
  default, so `Env` gains no binding. It lives in `src/`, not `public/`, so it isn't also served as
  `/404.html` with a 200. It's sent when `Accept` prefers `text/html`, with `_headers`' headers.
- **Small page changes:**
  - `public/favicon.ico`;
  - `<noscript>`;
  - **the year line at every width:** "NUS's 2026/27 lists", from the wording `public/year.js`
    drives. It adds a clause for applicants, e.g. "Applying for 2027/28? NUS's lists come out in
    March–April; until July this site shows 2026/27's.", reusing `public/shortlist.js:143`'s
    wording;
  - the restrictions link;
  - the contact link per G6. For (a), a "Report a problem" link in the course detail opens a
    pre-filled `issues/new` (code, semester, year of study, data version) with an issue template in
    `.github/ISSUE_TEMPLATE/`;
  - `og:site_name` "NUS Mod Finder (unofficial)".
- **The search hit path** re-sends its stored TTL. The degraded flag is stored with the entry, so
  the hit knows which.
- **The cross-site refusal** on `/search` only. It stops other sites spending this account's
  neurons through their visitors' browsers. `Sec-Fetch-Site` is set by browsers and can't be
  forged by page scripts (MDN; in all major browsers since March 2023). `access-control-allow-origin`
  stays where it is, so no other caller changes.
- **The privacy note:** a short page linked from the footer, written from 8-0's reads and G3's
  choice. It says:
  - who runs the site and how to reach them (G6);
  - what Cloudflare keeps: Workers Logs at the account's retention, and the zone's request
    analytics, which the site can't turn off, with their stated retention;
  - what the site's own log keeps;
  - what stays on the device, and how to clear it: "Forget this list" for the shortlist, the
    browser's site data for the year;
  - that a copied shortlist link contains the year of study and the list;
  - that the site sets no cookies (measured, live calls 16-17), though Cloudflare may set a
    security cookie if it challenges a visitor; no trackers; Cloudflare is the only service that
    sees the requests.
- **G3's logging choice** in `wrangler.jsonc`, and for (c) in `src/search.js`.
- **Docs in the same PR:**
  - REFERENCE.md's routes (the 404, the 403), "Logging" and :806 per G3, Operations;
  - the README's data and privacy line, and its contact gap (§1's row) per G6.

**Exit checks:**
- CI green, ranking lock unchanged;
- after the Actions deploy, its smoke step green (8C);
- 8D's live checks.

### 8C Smoke in the deploy; launch checklist; outage runbook and check; spending (G5)
- **Smoke in the Actions deploy.** `.github/workflows/deploy.yml` runs `npm run smoke -- --expect
  <sha>` after the deploy step and before "Keep the run record" (`deploy.yml:71-78`), so its record
  joins the artifact. Nothing is committed from CI. A failed smoke fails the job, which GitHub
  reports to Jacob.
  - **It needs no token,** because the deploy step has already put the bundle in `.data/vectors`
    and restored `current` to `.data/prod` in the same job. Smoke's own restore is then a no-op
    (`scripts/corpus-manifest.mjs:171-175`). The step says so in a comment; if the order ever
    changes, it gets `GH_TOKEN`.
  - **Tests first:** `test/deploy-workflow.node.test.js` asserts the step, its place (after the
    deploy, before the artifact) and that it sees no Cloudflare secret.
  - Smoke sends 5 GETs, 1 of them an uncached `/search`: about 0.033 neurons a deploy.
- **`docs/launch.md`**, short, for Jacob:
  - **Before any post:** §1's preconditions (only what a visitor meets), each with how to check
    it.
    - `/health`'s tag is `main`'s.
    - The latest Deploy run's smoke step is green: `gh run view <id>`, no commit needed.
    - The privacy note is live, with the retention it states matching the account's.
    - This month's NG-source check is done, NUS's "updated as at" dates matching
      `data/ng-sources-<year>.json`.
  - **The post text**, per G2's audience; nothing here posts.
    - For admitted Sem 2 students: what the site does, that it covers NUS's 2026/27 courses, that
      the shortlist lays out CourseReg's requests, that it is unofficial, and to check with NUS.
    - For 2027/28 applicants (if G2 includes them): that it uses 2026/27's lists and exams,
      labelled, and that NUS publishes 2027/28's Sem 1 list in March or April.
    - Jacob edits and posts it.
  - **Timing:**
    - before the Sem 2 CourseReg rounds (G2 asks Jacob for the date; nus.edu.sg isn't fetched by the
      project);
    - for applicants, before or during nomination and the application window, whose 2027 dates
      Jacob confirms.
  - **No corpus embed or forced re-ingest in launch week.** On 2026-11-06 those were about 4,300 of
    the day's 6,805 neurons (§1).
  - **Launch week:**
    - Workers AI's daily neurons;
    - the Worker's 4xx and 5xx counts;
    - reports arriving through G6's route, each answered;
    - `npm run ops:report` a week after the post, committed.
  - **"The site is down":**
    1. Check, in order: `/health`, a search, `wrangler deployments status`, the last deploy tag.
    2. **First** set `DEPLOY_FROM_ACTIONS` to anything but `true`, or revert the cause on `main`,
       so the next push doesn't redeploy it.
    3. `gh run list --workflow Deploy`: wait for or cancel any queued or running Deploy job. The
       concurrency group never cancels one, so it could overwrite the rollback (`deploy.yml:29-31`).
    4. Then `npm run rollback` and `npm run smoke -- --expect <sha>`.
    5. **Turn the switch back on before merging the fix.** A merge while it's off is skipped by the
       job's `if` (`deploy.yml:38`), and turning it on fires no event. Or deploy the fix from the
       Mac with `npm run deploy`.
  - **If NUS or NUSMods asks for a change or removal:** reply, take the text or feature down within
    a day, record it in an ADR.
- **If G4 is (b) or (c):** `.github/workflows/uptime.yml` and `scripts/uptime.mjs`.
  - **Schedule:** hourly at an odd minute (as `drift.yml` uses `17 1 * * 1`). GitHub may delay or
    drop scheduled runs under load.
  - **Each run:**
    1. GET `/health` (no D1, no neurons) and one `/module/<code>` (1 D1 row, not edge-cached,
       `src/modules.js:47-48`).
    2. One `/search` whose query rotates by the hour. Its answer must be a miss
       (`cache;desc=miss`, as smoke requires, `scripts/smoke.mjs:218`) and must not be `degraded`.
       That catches the Workers AI failure, which still answers 200. If a late run lands on a
       cached query, it takes the next query in the list. About 0.8 neurons a day.
    3. On a failure, check again after 90 s in the same run. No state is kept between runs.
    4. Two failures open one `uptime:down` issue, found by a hidden marker as drift does. GitHub
       emails it to Jacob.
    5. A later good run comments and closes it.
  - **Permissions:** `contents: read`, `issues: write`, no secret but `GITHUB_TOKEN`.
  - **(c)** adds an end date the script checks, after which it exits 0.
  - **Tests first:** fixture responses give open, comment and close; one failure then a pass opens
    nothing; a degraded answer counts as a failure; the cron matches the script's schedule.
- **Spending, per G5.** No code; a switch to keyword-only was considered and dropped (§6, B3-1).
  - **(a):** ADR 0004 is amended in ADR 0012: visitor-driven overage is allowed up to Jacob's
    monthly amount. Jacob sets a Cloudflare budget alert at that amount, which emails and caps
    nothing. The monthly report flags any billed day.
  - **(b):** ADR 0004 stands. Its rule is kept by the launch-week rule above (no corpus embed), and
    a budget alert at the lowest amount tells Jacob the day after it is broken.
  - Either way, `launch.md` and REFERENCE.md's Cost say what the alert does and doesn't do.
- **Docs in the same PR:** REFERENCE.md's Deploying (the smoke step), Operations (uptime, the
  rollback order), Cost (G5).

**Exit checks:**
- the next Actions deploy's smoke step green;
- `launch.md` committed, every precondition checked once;
- if G4 is (b) or (c): one green `workflow_dispatch` run, and a dry run against a refused URL
  shows the issue text without creating an issue;
- G5's choice in place.

### 8D Ship, live re-check, review, exit
- **Ship:** 8A, 8B and 8C each merge after green CI, and Actions deploys each one. After 8C, each
  deploy smokes itself.
- **Live re-check after 8B's deploy:** ≤ 10 GETs, ≤ 1 `/search`, each ≥ 4 s apart, listed in
  `docs/evidence/phase8/remote-ops.md`:
  - `/no-such-page` with and without `Accept: text/html`;
  - `/favicon.ico`;
  - the privacy note;
  - `/`'s `<noscript>`;
  - `/health`;
  - one `/search` repeated once, to see the hit's `cache-control`;
  - one `/search` with `Sec-Fetch-Site: cross-site` and `Sec-Fetch-Dest: iframe`, expecting 403
    before any binding (no neuron).

  axe and the fold run in CI, not live.
- **A fresh reviewer pass** over README.md, EVAL.md and REFERENCE.md against the code, given only
  the files and the repo (8A's exit check).
- **Fresh clone again** at the exit commit.
- **Docs:**
  - PLAN.md row 8 and PROGRESS.md;
  - `docs/evidence/phase8/exit.md`;
  - ADR 0012 accepted;
  - the vault page (the lead's audit and update).

## 3. Cost, ops and risks
- **Remote, all of Phase 8 (*est.*):**
  - three or four Actions deploys, each with the guard (~21k D1 rows read) and, after 8C, a smoke
    (5 GETs, 1 search, ≤ 0.07 neurons);
  - 8-0's three dashboard reads;
  - 8D's ≤ 10 GETs, ≤ 1 search.

  No D1 write, no migration, no Vectorize call. Workers AI only in smokes and 8D's search, well
  under 1 neuron in all.
- **G4 (b):** about 72 requests, about 6k D1 rows (24 searches at SC7's p50 of 255, plus 24
  `/module` reads) and about 0.8 neurons a day.
- **The spike:** §1's table. With no corpus embed that day, about 110,000 uncached searches fit
  inside the allowance. Past that, cents, which ADR 0004 allows none of until G5 says otherwise.
- **Holdout:** no look. Every Phase 8 change is ranking-neutral, and the lock proves it.
- **Risks:**
  - **Deploy on every push** empties the search cache on each merge. In a launch week, batch docs.
  - **The shared Workers AI allowance and per-minute limit.** A spike on a day this project also
    embeds its corpus is billed (G5). A burst past 3,000 embeddings a minute degrades search to
    keyword-only, perhaps for other projects too.
  - **Shared NAT and the burst limit.** A class searching together from one address can hit 429s.
    If launch-week reports show it, the limit is one number in `wrangler.jsonc`.
  - **NUS's text** shown in full, as NUSMods shows it. Answered by `launch.md`'s takedown line.
  - **Zone-level analytics** keep sampled request records the site can't turn off. The privacy
    note says so.
  - **Workers Logs retention and pricing change on 2026-12-01.** The checklist re-checks the
    retention the note states.
  - **GitHub schedules** pause after 60 quiet days on a public repo. Drift's reminder already
    warns, and an uptime workflow would pause too.

## 4. Exit criteria
- **SC10:**
  - every row of §1's three tables not marked true is fixed, or rebutted with evidence;
  - the 8D reviewer's findings are fixed or rebutted;
  - `docs-facts` runs in `npm test` and passes;
  - a fresh clone runs the README's commands;
  - EVAL.md's dev reproduce commands print its table's numbers;
  - the vault page is audited and updated (the lead).
- **Name and domain:** G1 answered and recorded in ADR 0012.
- **Visitor-facing:**
  - 8B live and checked;
  - G3's and G6's choices deployed;
  - the privacy note matches 8-0's reads.
- **Launch:**
  - the preconditions for a post (§1) can hold before SC10's EVAL, REFERENCE and vault parts are
    done;
  - every Actions deploy smokes itself;
  - `docs/launch.md` committed, each precondition checked once;
  - G4's and G5's choices in place (G5: the ADR wording and the budget alert), and G4's run green
    once if (b) or (c);
  - the announcement itself is Jacob's, after the exit. It is not an exit criterion.
- **Ops:** every remote step has a run record or a line in `docs/evidence/phase8/remote-ops.md`.
  No holdout look. Ranking lock unchanged.

## 5. Gate questions for Jacob
- **G1. The name and address.** The site is "NUS Mod Finder (unofficial)" at
  nusmodfinder.rcn.sh, as you chose in Phase 5 (ADR 0009). Keep both for the launch?
  - Options: keep both; or change one before any post.
  - *Recommended: keep both.* The name, the address, the share image and the GitHub repo all
    match. A change after a post would break shared links.
- **G2. What launch means to you, and for whom.** The site covers NUS's 2026/27 courses until
  July. It helps two groups now:
  - students coming for Sem 2 (January 2027), who are mostly admitted and next face course
    registration;
  - students applying in March and April for 2027/28, who can plan on 2026/27's courses and
    exams. The site labels them as last year's.

  The options:
  - (a) No post. The site stays public and findable.
  - (b) You post in a few places you choose, using short texts Phase 8 drafts for you to edit:
    - for Sem 2 students, before course registration;
    - and, if you like, for applicants, around nomination and the application window.
  - (c) A broad public post, such as an NUS forum.

  If (b) or (c): which places, which group or groups, and roughly when? Please also give the Sem 2
  course registration dates, and 2027's application dates, from NUS's pages. The project can't
  fetch them (bot protection), and the posts should land before them.

  *Recommended: (b), both groups at their own times.* Few targeted posts reach the people the site
  is for, and a problem reaches a small group first. Waiting until July would miss this year's
  applicants entirely.
- **G3. What the site keeps about visitors.** Asked after 8-0's reads, which fill in the brackets.
  - Cloudflare keeps a log of each search and course request for [N] days: the address, including
    what was searched, and request details [IP address: yes or no].
  - The site's own log line keeps the search text cut to 100 characters, and [no IP, or: Cloudflare
    attaches the request details to it too].
  - Separately, Cloudflare's traffic statistics keep a sample of requests for [N] days, [with or
    without the address and IP]. The site can't turn those off.

  The options:
  - (a) Keep it all, and say so in a privacy note.
  - (b) Turn off Cloudflare's per-request log, keep only the site's own line, and say so in a
    privacy note.
  - (c) Keep no search text in any log the site controls, only counts and timings.

  *Recommended: (b), if the reads show the site's own line carries no IP. Otherwise (c).* The
  monthly report doesn't use Cloudflare's per-request log. A search kept briefly without who sent
  it is easy to explain. Errors outside search get their own short line (8B), so none is lost.
- **G4. Who notices if the site goes down.** In Phase 7 you chose no daily live check. Once
  strangers rely on the site, an outage could last until you next look.
  - (a) Stay as is: you check it, and the monthly report shows errors after the fact.
  - (b) Once an hour, GitHub checks the site, its course data and one search (about 1 Workers AI
    neuron a day). If a check fails twice a couple of minutes apart, it opens an issue, which
    GitHub emails you, and it closes the issue on recovery.
  - (c) The same as (b), but only for the first month after you post.

  *Recommended: (b).* About 70 requests a day, no secret, and it notices when search quietly falls
  back to keywords. You hear within about an hour, not whenever you next look. GitHub can delay
  scheduled runs, so it isn't to the minute.
- **G5. Spending.** ADR 0004 says the project never goes over the account's included allowances.
  - Search is very cheap: about 110,000 searches a day fit inside the daily AI allowance, as long
    as the project doesn't also rebuild its course embeddings that day. Phase 8 makes that a
    launch-week rule.
  - Past that, the overage is cents: about $0.04 for 100,000 more searches.
  - Nothing can cap it automatically. Cloudflare's budget alert only emails you, the day after.

  The options:
  - (a) Allow visitors' searches to go over, up to an amount a month you name, with a budget alert
    at that amount.
  - (b) Keep the rule as it is, with a budget alert at the lowest amount so you hear the day after
    if it's ever broken.

  *Recommended: (a), with a $5 alert.* A launch is the one time traffic can't be planned, the cost
  is cents, and (b)'s rule could be broken by visitors through no step of yours.
- **G6. How visitors reach you.** A student who finds a wrong status has no way to tell you today.
  - (a) A "Report a problem" link from each course to a pre-filled GitHub issue. It's public, and
    the student needs a GitHub account and posts under it.
  - (b) An email address on the page.
  - (c) Both: issues for wrong statuses, email for anything private (privacy questions).
  - (d) Neither. Then the privacy note names no contact, and launch week has no reports to read.

  *Recommended: (c).* Issues arrive with the course, semester and year filled in, and others can
  see known problems. An address covers students without GitHub and anything that shouldn't be
  public. If you'd rather not publish an address, (a).

## 6. Critic log

### Round 1 (fresh critics on r1: A the SC10 maintainer, B launch ops and cost, C a first-time visitor)
Found sound by round 1:
- **A:** holdout and test looks; the shipped pin; SC5's numbers; 6,818 and 10,758,136; 43
  unscheduled; 1,207 NG codes; the cited lines in EVAL.md (:3, :14, :16-17, :20, :97-100) and
  REFERENCE.md (:13-17, :50, :145, :123, :306, :483, :654-657, :1291-1294, :1324-1325, :1345);
  the spike arithmetic.
- **B:**
  - the neuron arithmetic and the pricing;
  - Paid's overage billing;
  - the cache before the limiter, and the version id in the key;
  - the circuit breaker;
  - D1's uncached 502 and the 500's `cf-ray`;
  - static assets run no Worker;
  - `invocation_logs: false` exists;
  - the `search` line has no IP;
  - `/module` isn't edge-cached;
  - the 2026-12-01 pricing.
- **C:**
  - `npm ci`, `npm run dev` (port 61759, stopped clean);
  - the README's links;
  - §1's 404, favicon, robots and no-JS findings, reproduced locally;
  - phone set-up, search, shortlist and CSV with no console error;
  - the share image;
  - the 404 design;
  - G1 and G4's wording.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A1-1, C1-1 | A (major), C (blocking) | the plan's `requests.tsv` row 145 turns `npm test` red (`test/ops-requests.node.test.js:55-64`: rows after 131 are back-fill or corrections); 8D planned the same | **Applied.** Row reverted. The calls are in `docs/evidence/phase8/live-calls.jsonl` and §1; 8D lists its calls in `docs/evidence/phase8/remote-ops.md`. The branch is re-tested before the PR. |
| A1-2 | A (major) | EVAL.md:104-106 and REFERENCE.md:1192 run `--ref eval-v0` without `--embedding`, which the runner refuses | **Applied.** Rows added; `docs-facts` checks it; 8A's exit runs EVAL.md's dev commands on the Mac. |
| A1-3 | A (major) | missed REFERENCE claims: :91-93, :1248, :530-531, :122, :1186-1189, :24 | **Applied.** All six rows added; :91-93's wording joins the retired list. |
| A1-4 | A (major) | README:31-34 also misstates the baseline (each change is against the shipped pin) and the holdout (no-look routes) | **Applied.** Row rewritten; 8A's README change names both. |
| A1-5 | A (major) | 8A's checks can pass with docs still wrong: the retired list misses rewordings, "every §1 row" bounds the audit by §1, one check already passes | **Applied.** Retired list extended; the README-commands check is marked as passing today; a fresh reviewer pass over the three files is an 8D step and an exit criterion. |
| A1-6 | A (major) | 8A's edits break existing tests: FINDINGS B9's pinned Cost text (`test/findings/source.node.test.js:55-75`), and the pinned figures `test/full/corpus.test.js` asserts | **Applied.** 8A names both. B9's test changes with the new binding-limit sentence. The pinned figures stay, labelled pinned; §1's rows for :207-210 and :1308 now say so. |
| A1-7 | A (minor) | "1,164" is inferred, not measured | **Applied.** The figure is gone: :207-210 keeps its pinned numbers, labelled. |
| A1-8 | A (minor) | checking prose against production counts re-couples the docs to every refresh (`46c8d56`) | **Applied.** Corpus counts stay out of prose; `docs-facts` asserts their absence and checks only facts that change by a deliberate act; the year-refresh runbook gains a line. |
| B1-1 | B (major) | a degraded answer can stay in browsers 4 hours (Browser Cache TTL overrides a lower `max-age`) | **Applied.** §1 and the failure table say so. 8B makes the hit re-send its stored TTL, with a test. 8-0 reads the zone setting. |
| B1-2 | B (major) | zone-level request analytics keep sampled records (≥ 31 days) outside `observability`, page URLs included | **Applied.** §1 lists them; 8-0 reads one; the note and G3 state them; G3 (c) says "any log the site controls". |
| B1-3 | B (major) | Workers AI's 3,000-a-minute limit for embeddings is missing | **Applied.** A per-minute row in the spike table and "rate limit (429)" in the failure table; §3 names the cross-project effect. |
| B1-4 | B (minor) | the abuse estimate leaves out log events and the worst-case query | **Applied.** $2–12 per million, by component. |
| B1-5 | B (major) | "twice in a row" needs state the uptime workflow doesn't have; schedules can be delayed | **Applied.** Re-check after 90 s in the same run, no state between runs; odd-minute cron; G4 says it isn't to the minute. |
| B1-6 | B (minor) | `access-control-allow-origin: *` on `/search` lets other sites spend neurons from their visitors' IPs | **Applied.** §1 names it; 8B drops it from `/search` only, with a test (no recorded reason for it: it dates from `3b18041`). |
| B1-7 | B (minor) | the 50,000 row overstates: only the upper bound crosses | **Applied.** "may cross (8.5k–10.1k)". |
| C1-2 | C (major) | G2 points at March 2027/28 applicants, whom the site doesn't serve until July; the year is hidden on phones | **Applied.** §1 lists the year; G2 is aimed at Sem 2 students; 8B shows the year at 390 px; `launch.md` holds March posts until the switch. |
| C1-3 | C (major) | G3 asks Jacob to choose on unmeasured facts | **Applied.** 8-0's reads come first and fill G3's brackets. |
| C1-4 | C (minor) | README says "year of study at home"; the page asks "during your exchange" | **Applied.** Row added; retired string. |
| C1-5 | C (minor) | `npm run dev`'s fake ranking will look broken to a newcomer | **Applied.** The README says what `dev` runs on. |
| C1-6 | C (minor) | the privacy note's "how to clear it" misses the year; a copied link carries the year and the list | **Applied.** Both in 8B's note. |
| C1-7 | C (minor) | the restrictions footer link points to the general NG page | **Applied.** 8B, with a UI spec. |

### Round 2 (fresh critics on r2: A the SC10 maintainer, B launch ops and cost, C a first-time visitor)
Found sound by round 2:
- **A:**
  - the ledger, the pin and SC5;
  - the `--ref eval-v0` refusal;
  - REFERENCE :530 (no test reads EVAL.md);
  - the counts (21,353, 6,818, 10,758,136, 434, 685,600, 43);
  - the omitted `/search` parameters;
  - the footer links, `og:site_name` and the hidden year;
  - B9's test named correctly;
  - the standby refreshed after the 2026-11-12 data change.
- **B:**
  - the 4-hour Browser Cache TTL rule;
  - the 3,000-a-minute embeddings limit;
  - `httpRequestsAdaptive`'s ≥ 31 days;
  - 7-day Workers Logs and `invocation_logs: false`;
  - `ops:report` reads GraphQL, not Workers Logs;
  - cache before limiter;
  - `/health` reads no D1;
  - `/module` isn't edge-cached;
  - drift's marker pattern;
  - the arithmetic.
- **C:**
  - the README beyond the flagged rows;
  - the set-up's "during your exchange";
  - the data dates on the first screen;
  - "NUS's 2026/27 courses" in the shortlist;
  - the CSV name and its Singapore-time column;
  - on-device storage is only `vnm.study` and `vnm.shortlist`;
  - Copy link's contents;
  - no `Referrer-Policy` (the default leaks no query);
  - the CSP;
  - the empty and error sentences;
  - G1 and G4's wording.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A2-1 | A (blocking) | EVAL.md's table is on `qrels-dev-v2` (1,666 pairs); HEAD has `qrels-dev-v11` (2,476), so its commands can't reproduce 0.712 even with `--embedding`, and "the commands run" would pass anyway | **Applied.** §1 row for EVAL.md:33. 8A re-scores the baseline on v11 (open set) and keeps v2's as labelled history. The exit check compares printed numbers with the table. |
| A2-2 | A (blocking) | SC10 covers the vault page, and the plan never audits it; four stale statements found | **Partly applied.** The brief makes the vault page the lead's. §1 now makes the lead's deliverable a claim-by-claim audit and lists the four statements. The plan itself still doesn't audit or write the vault. |
| A2-3 | A (major) | the cost story contradicts ADR 0004's "Nothing in this project may run up an overage" | **Applied.** §1 and the conclusion quote it. New gate G5. 8C carries each option's change. |
| A2-4 | A (major) | nothing keeps year statements true through the July switch; the year scan reads only code | **Applied.** `docs-facts` checks each current-year label against `DEFAULT_ACAD_YEAR`. `year.mjs`'s `CHECKLIST` and the runbook gain the step. |
| A2-5 | A (major) | 8B and 8C change documented behaviour with no docs step; REFERENCE :806 "Headers and IPs are never logged" is misleading | **Applied.** Each PR updates README and REFERENCE in the same PR. Row :806 added; the phrase is retired. |
| A2-6 | A (minor) | the v1 move must merge into the existing `eval/v1/README.md` and carry FINDINGS :344,346's citations | **Applied** in 8A. |
| A2-7 | A (minor) | the replica differs from production in three ways, not one | **Applied** in EVAL item 4. |
| A2-8 | A (minor) | the NG-list fact is ambiguous between `data/` and pinned | **Applied.** Live-list sentences are checked against `data/`; pinned ones are labelled and checked against `eval/pinned/`. |
| A2-9 | A (minor) | the test mechanics: a phrase split across `> ` lines; a bare "43" would match "43 requests"; "10.7 MB" moves; a pin sha in prose couples docs to each ship | **Applied.** Normalised matching, numbers only in their sentence. The bundle size, `ng-unscheduled` count, standby dims and pin sha go to pointers. |
| A2-10 | A (minor) | wrong cites: README rows, `typo.js:32`, `http.js:9`, `api.js:26`, and `test/full/corpus.test.js` doesn't read REFERENCE | **Applied.** All corrected. |
| B2-1 | B (blocking) | no smoke runs on an Actions deploy, and committing a Mac smoke record redeploys | **Applied.** §1 records it. 8C adds a smoke step to `deploy.yml` (artifact record). Preconditions read the Deploy run, not a commit. §3's budget is fixed. |
| B2-2 | B (blocking) | the "site is down" rollback is undone by the next push | **Applied.** `launch.md` turns off `DEPLOY_FROM_ACTIONS` or reverts first, then rolls back. §1 records it. |
| B2-3 | B (major) | dropping CORS doesn't stop cross-site requests being sent (simple requests) | **Applied.** 8B refuses `Sec-Fetch-Site: cross-site` (non-navigate) with 403 before the cache, the limiter and any binding. CORS headers stay. Tests cover the absent header (smoke, eval, uptime). |
| B2-4 | B (major) | the hit-TTL test passes today in Miniflare | **Applied.** The test stubs `caches.default.match` with a 14400 copy. 8D's live repeat is the real check. |
| B2-5 | B (major) | `_headers` doesn't apply to Worker responses, so the HTML 404 lacks the CSP; no ASSETS binding | **Applied.** The Worker sets `_headers`' headers, and a test parses the file. `404.html` is a text module, so `Env` is unchanged. |
| B2-6 | B (minor) | G3 (b) loses `/module` and `/facets` 502s, which log nothing of their own | **Applied.** 8B adds one line on those paths (no URL or IP). G3's text says so. |
| B2-7 | B (minor) | the uptime check can't see a keyword-only fallback (200) | **Applied.** One rotating uncached search per run that must not be `degraded` (~0.8 neurons a day). G4 says so. |
| B2-8 | B (minor) | after 2026-12-01, retention is configurable | **Applied.** 8-0 reads the account's retention; the note states it; the checklist re-checks it. |
| C2-1 | C (major) | the shortlist already serves 2027/28 applicants (`public/shortlist.js:143`); holding their posts to July misses their window | **Applied.** §1 corrected. G2 offers both groups at their own times. `launch.md` has both texts. |
| C2-2 | C (major) | Sem 2 students are mostly admitted, so what's left is CourseReg; no dates cited | **Applied.** §1 says so. The post text and timing target CourseReg. Its dates weren't fetched (bot protection), and Jacob reads them. |
| C2-3 | C (major) | G3 states the site's line has no IP while §1 says it's unmeasured | **Applied.** It's a bracket 8-0 fills, and the recommendation depends on it. |
| C2-4 | C (major) | no way to report a wrong status | **Applied.** New gate G6. 8B adds the link, the privacy note names the contact, and launch week reads the reports. |
| C2-5 | C (major) | the checklist never checks the NG sources are current | **Applied.** A precondition: this month's check, dates matching the source manifest. |
| C2-6 | C (minor) | "no cookies" checked only against the code | **Applied.** Measured live (calls 16-17): no `Set-Cookie`. |
| C2-7 | C (minor) | the year spec doesn't name the views | **Applied.** Set-up, results and shortlist at 390 px. |

### Round 3 (fresh critics on r3: A the SC10 maintainer, B launch ops and cost, C a first-time visitor; the last round)
Found sound by round 3:
- **A:**
  - `DEFAULT_ACAD_YEAR`;
  - the ledger and SC5;
  - the refusal path;
  - the re-score is feasible (v11's corpus hashes match the pinned run);
  - the CLI's `run` command;
  - `year-refresh-docs` accepts a command-less CHECKLIST line;
  - every cited REFERENCE line and the `src/`/`public/` cites it checked.
- **B:**
  - `deploy.yml`'s `fetch-depth: 0` resolves `--expect`, and smoke needs no Cloudflare secret;
  - the preflight's vars check reads names only;
  - cache before limiter;
  - same-origin page fetches and static `/?q=` links aren't touched by the refusal;
  - curl and Node `fetch` send no `Sec-Fetch-Site`;
  - ~0.8 neurons a day for uptime;
  - the unhandled-error line;
  - G3's options.
- **C:**
  - shared links and bookmarks are never refused;
  - the `Accept`-based 404 with `_headers`' headers;
  - the header year already in `test/year-scan.node.test.js:55`;
  - the privacy note's on-device section;
  - G1 and G4's wording;
  - G3 asked after the reads.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A3-1 | A (major) | "the current value is absent" can't catch a stale value (40, 6,778, 10.7 all pass) | **Applied.** Pointer sentences are marked and must contain no number, which fails today. |
| A3-2 | A (major) | the year rule passes today, misfires on identifiers after July, has no "History" sections to exempt, and pinned labels follow `PINNED_ACAD_YEAR` | **Applied.** Only marked live-year sentences are checked against `DEFAULT_ACAD_YEAR`, and marked pinned ones against `PINNED_ACAD_YEAR`. Identifiers are never checked. Fail-first is proved with a stubbed `2027-2028`. |
| A3-3 | A (major) | re-scoring on v11 moves more than the tables (85 primary, 6 unscored), and a v12 would go stale silently | **Applied.** Every qrels-dependent sentence is re-derived, `baseline-table.mjs`'s header too. `docs-facts` checks EVAL.md's qrels label against `qrels.json`'s `version`. |
| A3-4 | A (major) | `eval/README.md` carries the same refused commands | **Applied.** The `--embedding` rule covers it. |
| A3-5 | A (major) | the B9 test also pins "CPU is the smaller limit" (:71-72) and Phase 1's D1 medians (:76); its title is named in FINDINGS:312 | **Applied.** All named in 8A. The D1-medians row is added to §1. |
| A3-6 | A (minor) | `eval/pinned/` and `data/` NG files are identical today | **Applied.** "Can differ after a revision; identical today." |
| A3-7 | A (minor) | FINDINGS:346's EVAL.md line cites are already wrong; v1's results paths | **Applied.** Re-derived, not moved; paths fixed. |
| A3-8 | A (minor) | REFERENCE:30 "year of study at home" missing from §1 | **Applied.** Row added. |
| A3-9 | A (minor) | ADR 0012 says "two versions old" (it's v2 against v11) | **Applied** in ADR 0012. |
| B3-1 | B (blocking) | `DENSE_BACKEND=off` fails CI (two tests, the generated types), waits on the `ui` job, then breaks smoke and uptime | **Applied.** G5 (b)'s switch is dropped. G5's options are now ADR wording plus a budget alert. |
| B3-2 | B (major) | the 68% day was mostly this project's own corpus embeds (~4,300 of 6,805, `neurons.tsv`) | **Applied, and checked** (the sum is 4,299.9). §1, the spike table, G5 and the conclusion are corrected. Launch week has no corpus embed or re-ingest. |
| B3-3 | B (major) | G5's "cap" is enforced by nothing; Cloudflare's budget alerts email, the day after, and cap nothing | **Applied, checked** against Cloudflare's changelog. G5 offers an alert at Jacob's amount and says it doesn't cap. |
| B3-4, C3-6 | B, C (major) | allowing cross-site `navigate` lets hidden iframes through (C reproduced it locally) | **Applied.** Cross-site is allowed only with `Sec-Fetch-Dest: document`; the iframe case is tested. The 403 gets its own sentence on the page (C). |
| B3-5 | B (major) | the down runbook leaves the fix undeployed (the job's `if` skips merges while off) and a running deploy can overwrite the rollback | **Applied.** Wait for or cancel running deploys; turn the switch on before merging the fix, or deploy from the Mac. |
| B3-6 | B (minor) | Node's `fetch` sends `Sec-Fetch-Mode: cors` with no `Sec-Fetch-Site`; the tests should use that | **Applied.** |
| B3-7 | B (minor) | the smoke step's place (before the artifact step), its test file, and why it needs no token | **Applied.** |
| B3-8 | B (minor) | an hourly rotation can land on a cached query | **Applied.** It requires `cache;desc=miss`, and moves on otherwise. |
| B3-9 | B (minor) | G4 (b)'s D1 rows leave out the searches (~6k a day) | **Applied.** |
| B3-10 | B (minor) | `.html` is a Text module by default; a 404 in `public/` would also serve `/404.html` with 200 | **Applied.** `src/404.html`, no `rules` entry. |
| B3-11 | B (minor) | the 14400 is on the stored copy, not a rewrite of the Worker's response | **Applied.** §1 reworded; the fix stands. |
| C3-1 | C (major) | the year is hidden at 1040 px and below, not only on phones | **Applied.** §1 corrected; the spec runs at 390, 768 and 1024. |
| C3-2 | C (major) | applicants see 2026 dates and nothing about 2027/28 outside the shortlist | **Applied.** The year line carries an applicant clause from `shortlist.js:143`'s wording, in the spec. |
| C3-3 | C (major) | the pre-post gate includes SC10's back-office docs and could make the Sem 2 post miss CourseReg; no date | **Applied.** Preconditions are only what a visitor meets. G2 asks Jacob for the dates. |
| C3-4 | C (minor) | two different NUS application windows; nomination comes first | **Applied.** Both quoted; Jacob confirms 2027's. |
| C3-5 | C (major) | G5's "$1 cap" isn't a cap | **Applied** (with B3-3). |
| C3-7 | C (major) | G6's options don't line up: "neither" contradicts the note; no issue template; GitHub's account cost unstated; privacy questions in public | **Applied.** G6 has (c) both and (d) neither, with its consequences. (a) is pre-filled with a template. The recommendation is (c), with the account cost stated. |
| C3-8 | C (minor) | the README's contact gap is assigned to no workstream | **Applied.** 8B's README docs. |
| C3-9 | C (minor) | "no cookies" overstates; Cloudflare may set a security cookie | **Applied** in §1 and the note. |
| C3-10 | C (minor) | the no-JS spec should check visibility on the first screen and on shared links | **Applied.** |

**Stopped at round 3, by rule.** No objection was rebutted. Every one changed the plan, except
A2-2, which was applied in part.

**Open:**
- **r4 itself has had no critic.** Its new designs are untested by a fresh reader:
  - the marker-based `docs-facts` rules;
  - the `Sec-Fetch-Dest: document` exception;
  - the smoke step's reliance on the deploy step's restored files;
  - the uptime check's "next query" rule;
  - G5's and G6's new options.
- **A2-2 / the vault page:** the plan lists the lead's audit and four known stale statements, but
  doesn't audit the page (the brief makes it the lead's).
- **Facts left to Jacob or 8-0:**
  - the Sem 2 CourseReg dates and 2027's application dates (nus.edu.sg is bot-protected);
  - what Workers Logs and the zone's analytics hold per request;
  - the account's log retention;
  - the zone's Browser Cache TTL.
