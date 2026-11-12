# Phase 8 plan: launch readiness (r1, draft before critics)

Goal (exit): **SC10** is met, the name and domain gate is confirmed, and the site is ready for an
announcement. Jacob decides whether to announce it and posts it himself.
- **SC10:** README, EVAL.md and the vault page describe the system as it is.
- **The name and domain gate:** ADR 0009 is accepted ("NUS Mod Finder (unofficial)" at
  nusmodfinder.rcn.sh). Phase 8 asks Jacob to re-confirm it (G1) and doesn't reopen it.
- **Conclusion of §1:**
  - **Cost is not the risk.** A launch spike of 10,000 uncached searches in a day costs about 330
    to 660 Workers AI neurons. The search cache, the keyword-only fallback and Workers Paid's
    billing (over the allowance is billed, not refused) already cover a spike.
  - **The docs are the risk.** EVAL.md still opens on the Phase 2 baseline and says no holdout look
    was taken (8 have been). REFERENCE.md still names the old working title, calls the vector half
    unproven, and keeps free-tier and pre-3-0 cost text.
  - **Small gaps a visitor would hit:**
    - a mistyped URL shows raw JSON;
    - `/favicon.ico` is a JSON 404;
    - the page says nothing without JavaScript;
    - there is no privacy note, although Cloudflare keeps each request's URL, search text
      included, for 7 days.
- **Out of scope:**
  - search quality: S2, S3, S4 and S6 stay known limits (ADR 0011 G4);
  - new features;
  - the 2027/28 refresh;
  - posting or announcing anything. That's Jacob's action, after this phase.

This plan changes no product code. Numbers come from the repo at `2fa2558` (= `origin/main`), from
a fresh clone of it, from cited evidence files, or from the live calls listed at the end of §1.
Every number marked *est.* is an estimate.

## 1. Measure today

### Production and `main`
- Live: version `d0cb8211` (tag `2fa2558`), data version `7eb77cf0828b`, production bundle
  6,818 vectors (`/health`, 12:51:44 UTC).
  - Every push to `main` deploys from Actions once CI is green, docs-only pushes included
    (`docs/REFERENCE.md:654-657`).
  - The last five Deploy runs, 12:30 to 12:40 UTC, are each docs-only redeploys of the same code.
- Repo `rcnsh/nusmodfinder` is **public** (`gh repo view`). The README is the first page many
  visitors will read.
- Phase 7 closed at `phase7-final`. Holdout looks: 8 of 12. Test-set looks: 1 of 1
  (`eval/holdout-ledger.md`).

### The fresh clone (the README's "Run it locally")
Fresh `git clone` of `origin/main` into a temp dir on the Mac, 2026-11-12:

| Command | Result |
|---|---|
| `nvm use` | `.nvmrc` says `22`; README says "Node 22.12+"; `package.json` `engines` `>=22.12.0`. Not run (the Mac's Node is 26.13.0). |
| `npm ci` | ok, 2.1 s with a warm npm cache. npm 11.20.0 skips `workerd`'s postinstall ("Run `npm install-scripts approve`"); nothing below needed it. |
| `npm run dev` | prints `http://127.0.0.1:60943` (a free port; 8787 and 8799 are refused, `scripts/ui-server.mjs`); `/` 200, `/health` the fixture bundle (434), a search 20 results; stopped cleanly. |
| `npm test` | 144 files passed, 5 skipped; **1,954 tests passed, 22 skipped**, 17 s. The "Authentication error [code: 10000]" lines in its output come from the fake wrangler in `test/remote-session.node.test.js:41`, not from Cloudflare. |
| `npm run test:ui` | **796 passed, 74 skipped**, 2.2 min. It needs Playwright's browsers, which this Mac has cached. On a machine without them it fails until `npx playwright install chromium webkit` runs. README omits that line; REFERENCE.md has it (`:483`). |

### SC10 audit: README.md (60 lines)
| Line | Claim | Today | Verdict |
|---|---|---|---|
| 3 | Search every NUS course … see which ones exchange students may take | matches the page and `/search` | true |
| 5 | "unofficial, not run by NUS or NUSMods" | matches the page footer (`public/index.html:176`) | true |
| 9-19 | queries, filters, phrase chips, exchange mode, the detail | match `public/`, `src/query-intent.js`, `/module` | true |
| 9-19 | (missing) | **The shortlist and its CSV and PDF exports** (Phase 6, SC3) aren't mentioned. They're the planning half of the site. | **gap** |
| 21-23 | FTS5 and an exact dense search over `bge-small-en-v1.5`, fused by RRF; "~10.7 MB bundle" | production bundle 10,758,136 bytes (`data/vectors.json`) | true, rounds to 10.8 MB |
| 24-25 | query understanding | `src/query-intent.js`, `src/typo.js` | true |
| 26-27 | `public/`, Plex, light and dark, Playwright and axe in Chromium and WebKit | `playwright.config.mjs`, the CI `ui` jobs | true |
| 31-35 | SC5: 195 queries, +0.120 nDCG@10 (CI 0.083 to 0.161); "Later changes are gated on a separate holdout" | `docs/evidence/phase3/sc5.md:7-9` | true but incomplete: since Phase 7, CI's ranking lock gates every ranking change too (`docs/REFERENCE.md:1202`) |
| 35-36 | "EVAL.md has the method, the Phase 2 baseline and what the numbers do not show" | true of EVAL.md as it stands, and that's the problem (next table) | follows EVAL.md |
| 40-44 | the four commands | all run (above) | true; `test:ui` needs the browser install line |
| 46-48 | deploying, re-ingesting, routes and cost are in REFERENCE.md | true | true |
| 50-55 | data sources and disclaimer | true | true |
| 57-59 | MIT; IBM Plex under the OFL (`public/fonts/OFL.txt`) | both files exist | true |

### SC10 audit: EVAL.md (342 lines)
EVAL.md describes the Phase 2 eval and the v1 eval. It doesn't describe the eval as it stands
after Phases 3 to 7.

| Line | Claim | Today | Verdict |
|---|---|---|---|
| 3 | "Phase 2 baseline (**current**)" | The shipped ranker is `a23601d` (`eval/lib/baseline.mjs:37`). SC5 passed on the sealed test set at `phase3-final` (`sc5.md`). | **stale** |
| 14 | "Vectorize search is approximate, while the replica's is exact" | Since 3-0, production's dense search is the exact in-Worker bundle (`sc5.md:12-13`); Vectorize is the standby | **stale** |
| 16-17 | production serves the 2026-11-04 catalogue (6,778 modules) | `current` is `prod-2026-2027-20261112`, 6,818 (`data/corpus.json`, `data/vectors.json`) | **stale** |
| 20 | query embeddings `emb-bge-small-v0` | the eval's default is `emb-bge-small-v1` since 3A-2 (`docs/REFERENCE.md:123`) | **stale** |
| 97-100 | "No look has been taken"; "Looks are spent only on Phase 3 candidates, at most 12" | 8 holdout looks and the one test look are spent (`eval/holdout-ledger.md`); L8 (5F) was a look outside Phase 3 | **wrong** |
| — | (missing) | the SC5 result; the ranking lock in CI (ADR 0011, `eval/ranking-lock.json`); ADR 0003's amendments (2026-11-06 to 2026-11-12: no-look routes, the count log's `route` column, the eval's pinned NG files); the shipped-ranker pin history | **gap** |
| 115-342 | the v1 eval, "historical" | Kept as history, but REFERENCE.md still quotes its conclusion as current (next table). Its "uncomfortable conclusion" (`:329-333`) is reversed by Phase 2 (`:70`) and by SC5. | **misleading in place**; belongs in `eval/v1/` |
| 158-160 | re-run after "the D1 free-tier daily row-read limit" | the account is on Workers Paid (ADR 0004) | historical, stale wording |

### SC10 audit: docs/REFERENCE.md (1,345 lines)
REFERENCE.md's Phase 7 sections are current. I checked these against the code: CI, Deploying,
Deploying from Actions, Rollback, Operations, the ranking lock, drift. The stale claims sit in the
older sections:

| Line | Claim | Today | Verdict |
|---|---|---|---|
| 13-17 | "the lexical half … accounts for essentially all of the measured improvement; the vector half does not currently earn its keep" | v1's conclusion; Phase 2 reversed it (EVAL.md:65-71: hybrid beats lexical by +0.103 nDCG, vector alone 0.672 vs lexical 0.609) | **wrong** |
| 50, 145 | "40 codes in 2026/27" NG-listed with no classes | `data/ng-unscheduled.json` count 43 (after the 2026-11-12 refresh) | **stale** |
| 98-107 | "How a search is answered" | omits 3B's pins and masks, 3C's typo correction (a second embedding, `src/typo.js:32`), 3F's groups, 3G's no-signal answer, the intents and the representative; step 1 pins only a whole-query code | **incomplete** |
| 124 | production "6,778 at the 3-0 cutover" | 6,818 now | stale, labelled as a past count; reword |
| 207-210 | 1,175 of 1,207 NG codes in the corpus | against production: 1,207 − 43 unscheduled = 1,164 (`data/ng-courses-2026-2027.json`, `data/ng-unscheduled.json`) | **stale** (pinned-corpus figure) |
| 306-307 | "The page is **Exchange Course Finder (unofficial, for NUS)**, the working name until Phase 8" | the page is "NUS Mod Finder (unofficial)" (`public/index.html:7`, ADR 0009) | **wrong** |
| 1198-1200 | "`EVAL.md` still describes [the v1 eval]" | true, which is the EVAL.md problem | follows EVAL.md |
| 1239-1244 | cost leads with the pre-3-0 Vectorize arithmetic | historical; correct as history | reorder: lead with today's limits |
| 1250 | 6,778 × 384 = 2,602,752 stored dims | the standby holds 6,818 × 384 = 2,618,112 (26%) | stale |
| 1253, 1258 | "~0.03 neurons a search" | 0.033 for an 18-token query; 0.066 when 3C corrects it (two embeddings); up to ~0.85 for a whole-query catalogue-only code (`related` embeds up to 2,000 characters, `src/search.js:714`) | incomplete |
| 1291-1294 | "If you blow the limit anyway, every D1 query fails until midnight UTC … or move to the Workers Paid plan" | the account is on Paid; overage is billed, not refused (D1 pricing FAQ) | **wrong** |
| 1296-1299 | the caveat names Vectorize and D1 allowances | the shared allowance that matters is Workers AI's 10,000 neurons a day: another project's busiest day this month used 68% (`docs/evidence/ops/2026-11.md`) | **stale** |
| 1308-1309 | "6,771 of the 21,130 records" | pinned-corpus figures; production has 6,818 offered | stale |
| 1324-1325 | one acad year "would … halve the uncached searches the queried-dimension allowance covers" | Vectorize is off the search path since 3-0 | **wrong** |
| 1336-1337 | "No natural-language constraint parsing" | 3H and 5F parse *no final exam*, *S/U*, *light workload*, level phrases (README:12-13); "no Friday classes" is still unparsed | **half wrong** |
| 1345 | "The vector half is unproven. See EVAL.md." | see 13-17 | **wrong** |
| 1149-1150 | Workers Logs: "Paid includes their volume" | true until 2026-12-01; then Cloudflare Observability pricing applies (50 GB ingestion, 10 GB-month storage included; `docs/evidence/phase7/measure.md:46-49`) | add the date |

### SC10: the vault page
The vault page belongs to the lead. **Deliverable for the lead:** update the project page after 8A
and 8B merge, to cover:
- the state: launched or not, per G2;
- the URL, the stack, the deploy (Actions after green CI);
- the privacy stance (G3) and the outage check (G4);
- where the launch checklist lives.

This plan doesn't read or write the vault.

### Launch risk: what a spike costs
**Per uncached `/search`.** One embedding of the query (`src/search.js:394-412`), a second when 3C
corrects a word (`EMBED_CORRECTED`, `src/typo.js:32`), and for a whole-query catalogue-only code an
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
  month, the Worker's p99 over all requests is 136.7 ms (`ops/2026-11.md`).
- **A visit:** `/` and its files are static assets: no Worker run, no request charge
  (`wrangler.jsonc` `assets`). `/facets` is 1 Worker request and 1 D1 row; `/module/:code` is 1 row,
  or 2 on a 404.

**A spike, against the account-wide allowances** (Workers Paid). Month to date, 11.4 days: CPU
4,526,846 ms (15.1%), requests 386,162, the busiest Workers AI day 6,805 neurons (68%, another
project), `ops/2026-11.md`.

| Uncached searches in one day | Neurons | CPU (*est.* 12 ms each) | D1 rows (*est.* 500 each) | What happens |
|---|---|---|---|---|
| 1,000 | 33–66 | 12k ms | 0.5M | nothing |
| 10,000 | 330–660 | 120k ms (0.4% of a month) | 5M (0.02%) | nothing |
| 50,000 | 1.7k–3.3k | 600k ms (2%) | 25M | on a day the other project matches its busiest, neurons cross 10,000 |
| 100,000 | 3.3k–6.6k | 1.2M ms (4%) | 50M | on such a day ~3.4k neurons over, billed at $0.011 per 1,000: **about $0.04** |

- **Billing, not refusal.** On Workers Paid, neurons over 10,000 a day are billed, not refused.
  Error 3036 ("daily free allocation") applies to the Free plan (Workers AI errors page).
- **Worst-case abuse.** Unique uncached searches cost about $1–2 per million (*est.*: neurons
  0.033–0.066 each, CPU at $0.02 per million ms, requests at $0.30 per million) once the
  allowances are spent. The per-IP burst guard (`SEARCH_LIMIT`, 20 per 10 s per IP and colo,
  `wrangler.jsonc`, `src/search.js:1211`) stops one runaway script, not a spread-out one. That
  stays the accepted residual risk REFERENCE.md names (`:1296-1299`).
- **The cache.**
  - It is checked before the limiter (`src/search.js:1204-1207`): a repeated search costs nothing
    and never counts against the limit. It is per data centre.
  - Live, the repeat of a miss was a hit in 24 ms. The hit carried `cache-control: public,
    max-age=14400`, not the stored 3600. The 4 hours come from outside the Worker, probably the
    zone's Browser Cache TTL. **Unconfirmed**: zone settings weren't read.
  - Every deploy changes the version id, which is in the key (`src/search.js:1201`). So each
    merged PR, docs included, empties the search cache for everyone.
- **Shared NAT.** The limiter's key is the client IP (`src/search.js:1212`). A room of students
  behind one address (a campus or dorm NAT) shares 20 searches per 10 s. The page searches on submit
  and on a filter change, not per keystroke (`public/keys.js`, `public/nav.js`). Over the limit, a visitor reads "Too many searches
  from your connection. Try again in a minute." (`public/messages.js:20`).

**If Workers AI or D1 fails** (SC7's fallback, `src/upstream.js`):

| Failure | What the Worker does | What a visitor reads |
|---|---|---|
| Workers AI error, timeout (1.5 s) or capacity 3040 | keyword-only answer (`degraded`), cached 60 s, not 1 hour; the dense circuit opens after 3 failures for 30 s per isolate | "Search is in a simpler mode right now: it finds only courses that contain the words you typed…" (`public/messages.js:95`) |
| Vectorize | nothing: it is off the search path (`DENSE_BACKEND=bundle`) | nothing |
| D1 error or timeout (3 s) | 502 `upstream_failure`, not cached | "The search service could not reach its course data. Try again in a moment." (`:21`) |
| an unhandled throw | JSON 500 with the `cf-ray` (`src/index.js:93-105`) | "Something went wrong in the search service. Try again in a moment." (`:22`) |
| rate limit | 429, `retry-after: 60` | the sentence above |

### Launch risk: what a visitor sees
From the live calls (end of §1) and the code:
- **A mistyped path** (`/no-such-page`): HTTP 404 `{"error":"not_found","message":"No route for
  /no-such-page."}` as raw JSON in the browser (`src/index.js:63`). `wrangler.jsonc` `assets` has
  no `not_found_handling`, so every path that isn't a file reaches the Worker.
- **`/favicon.ico`:** a JSON 404. The page links `/favicon.svg`, `/favicon-32.png` and
  `/apple-touch-icon.png`, which all exist, but browsers and crawlers that ask for `/favicon.ico`
  each spend a Worker request. This month 144 of the Worker's 303 requests were 404s
  (`ops/2026-11.md`); what they were is not recorded.
- **An unknown course** (`/module/ZZ9999`): 404 `kind: "unknown"`, cached 60 s. The page says
  "There is no course ZZ9999 in the NUS catalogue. Check the code." (`public/messages.js:74`).
- **No JavaScript:** the first screen's form renders but does nothing. The page has no
  `<noscript>` (`grep -n noscript public/index.html`: none).
- **Mobile:** SC8's 390×664 fold specs pass in both browsers (`test/ui/fold.spec.js`, fresh-clone
  run above). The phone layout is described at `docs/REFERENCE.md:335-338`.
- **Share preview:**
  - `og:title`, `og:description`, `og:image` (1200×630, `public/og.png`) and
    `twitter:card summary_large_image` are present (`public/index.html:13-23`).
  - The image says "NUS Mod Finder", "unofficial" and the URL.
  - Live `/og.png` is 200, `image/png`, 46,659 bytes.
  - No preview was rendered in a real messaging app.
- **robots and SEO:**
  - Live `/robots.txt` is 200 `text/plain`, 1,248 bytes. It is Cloudflare's managed robots.txt
    with content signals: the Worker sends no such file, and `public/` has none.
  - `<title>`, the meta description and the canonical link are present.
  - No sitemap. The site is one page with state in the query string, so a sitemap adds little.
- **Favicons:** SVG, 32 px PNG and the 180 px Apple touch icon exist (`file public/*.png`).

### Launch risk: privacy and legal
- **What is kept per request.**
  - `observability.enabled: true` with no `logs` block (`wrangler.jsonc:6`): Workers Logs keep an
    *invocation log* for every Worker request. Cloudflare documents it as carrying "the Request,
    Response, and related metadata" and "request metadata, and headers", for **7 days** on Paid
    (Workers Logs docs).
  - The request URL includes `q` (the search text, in full), `sem`, `study` and the filters.
  - Whether the client IP or IP-bearing headers appear in that log is **not measured**: reading a
    log needs the dashboard or a token this session doesn't use. 8-0 reads one.
  - The Worker's own `search` line (`src/search.js:1184-1187`) carries the query cut to 100
    characters, the filters, counts, spans, colo and version, and no IP or header
    (`src/search.js:53-55`).
  - Static asset requests (the page itself) run no Worker and write no Workers Log.
- **What the page keeps on the device:** `localStorage` for the year of study
  (`public/app.js:187-188`) and the last edited shortlist (`public/saved.js`). No cookies. No
  third-party request: fonts are self-hosted, and the CSP is `default-src 'none'` with `'self'`
  only (`public/_headers`).
- **A privacy note: none.** No page, footer line or README section says any of the above
  (`grep -rni privacy public/`: none).
- **"Unofficial" wherever the name appears:**
  - covered: `<title>`, `og:title`, the `<h1>` at every width (`public/index.html:7,16,43`),
    `og.png`, the footer (`:176`), the README (`:5`), the GitHub description, the export's foot
    (`docs/REFERENCE.md:406`);
  - gaps: `og:site_name` is "NUS Mod Finder" alone (`:15`). The meta descriptions say
    "Unofficial". The JSON 404 doesn't name the site.
- **NUSMods:**
  - The README and the footer credit it and link it.
  - NUSMods publishes no terms for its API beyond "Please be considerate and use these services
    responsibly" (`github.com/nusmodifications/nusmods` README); the old API repo is MIT.
  - Visitors never call NUSMods: the site reads D1. NUSMods sees one conditional GET a week
    (drift) and the manual refreshes. Launch traffic adds no load there.
- **NUS's text:**
  - Course titles, descriptions, prerequisites and preclusions are NUS's text, as NUSMods
    republishes them. The page shows them in full, and the export labels the description
    "Course description (NUS, via NUSMods)" (`docs/REFERENCE.md:410`).
  - NUS's own rules are quoted in short, attributed sentences, 19 of them indexed and checked
    against the archived sources (`year check --full`, `docs/evidence/phase7/exit.md:22`).
  - ADR 0011 G5 covers the sources: archived encrypted, not republished. The short quotes stay.
  - NUS's legal notice reserves reproduction (ADR 0011 G5). Showing course descriptions is what
    NUSMods has done for years. That's an accepted residual risk, answered by taking text down if
    NUS asks (8C).
  - nus.edu.sg was not fetched for this plan.
- **Fonts:** IBM Plex under the SIL OFL 1.1, the licence file shipped beside the fonts
  (`public/fonts/OFL.txt`) and named in the README.

### Launch risk: operability after launch
- **Who notices an outage:** nobody, automatically. ADR 0011 G3 declined a daily live check:
  "adds daily traffic to a site you can check yourself". Smoke runs only on a deploy.
  - The monthly report counts errors after the fact.
  - The drift workflow makes no live-site call (`docs/REFERENCE.md:1152-1155`).
  - **Launch changes the calculus.** Before launch, the only visitors were Jacob and the tests:
    303 Worker requests this month, of which 159 were 200s. After an announcement, strangers rely
    on it in a registration window, and an outage could last until Jacob next looks. Hence G4.
- **The monthly report:** `npm run ops:report` (7F) reads the account's usage. The reminder issue
  asks for it monthly. The 2026-11 report is committed.
- **Drift:** weekly; one issue so far (#110, closed by the refresh).
- **Runbooks:** deploy, rollback, `d1:restore`, smoke, the year refresh (`docs/REFERENCE.md`,
  `docs/year-refresh/`). No runbook covers "the site is down": what to look at first, and when to
  roll back.
- **Workers Logs pricing changes on 2026-12-01** (`measure.md:46-49`). At this traffic it stays
  inside the included volume.

### Accessibility and performance (cited, not re-measured)
- **SC8** (axe zero violations, keyboard, live region, 390 px fold) passed at Phase 5 and held over
  the shortlist at Phase 6 (`docs/evidence/phase6/exit.md:12`). CI's `ui` job runs the same specs
  on every page change, and they passed in today's fresh clone.
  - `public/` changed in Phase 7: 12 files, +85 −40 (`git diff --stat phase6-final origin/main --
    public/`). That's the unpublished-semester state and wording, all under those specs.
  - No live axe run has happened since Phase 6 (`p6-live`).
- **SC2** passes (`test/ui/sc2.spec.js`, every fixture code).
- **SC7**: pooled cache-miss p50 186.0 ms at the Phase 3 freeze (`docs/evidence/phase3/sc7.md:81`).
  - Today's 5 misses:
    - `total` 453, 243, 226, 298 and 225 ms;
    - `embed` 228, 224, 43, 232 and 82 ms.
  - Five calls on one connection is not a measurement. Phase 8 changes nothing on the search
    path, so SC7 is not re-measured.
- **Re-measure plan:** only where Phase 8 changes something. 8B adds or changes:
  - the 404 page;
  - `/favicon.ico`;
  - the `<noscript>` line;
  - the privacy note.

  The CI `ui` job covers them, and 8D checks them once live (≤ 10 GETs, no `/search`).

### What "launch" could mean
The site has been public since 2026-11-11 (ADR 0009), and nobody has announced it. "Launch" can
mean:
- **(a) No announcement.** It stays findable by search and by word of mouth.
- **(b) Jacob posts in a few channels he chooses**, for example NUS exchange-student groups or a
  partner university's outgoing-exchange group, with a short text 8C drafts.
- **(c) A broad post**, for example a public NUS forum.

**Timing:**
- Incoming Sem 2 students (January 2027) are choosing courses now. NUS's Sem 2 NG appeal timeline
  is out (`docs/evidence/phase6/facts.md`, "Updated: 11am, 7 Oct 2026").
- Sem 1 and full-year applicants apply from 21 March to 10 April.

Whatever Jacob picks, these must hold before any post (8C's checklist):
- SC10 met;
- 8B's visitor fixes live;
- the privacy note live;
- G4's outage check in place;
- a smoke-green deploy within the last day.

### Live calls (all GET, ≥ 4 s apart; 15 of the 25 allowed, 6 of the 10 `/search`)
Logged as one `ref` row in `docs/evidence/requests.tsv` (row 145).

| # | UTC | URL (on https://nusmodfinder.rcn.sh) | Status | Note |
|---|---|---|---|---|
| 1 | 12:51:39 | `/` | 200 | CSP present; 11,575 bytes |
| 2 | 12:51:44 | `/health` | 200 | tag `2fa2558`, data `7eb77cf0828b` |
| 3 | 12:51:49 | `/robots.txt` | 200 | Cloudflare's managed file, not ours |
| 4 | 12:51:55 | `/favicon.ico` | 404 | JSON |
| 5 | 12:52:00 | `/og.png` | 200 | 46,659 bytes |
| 6 | 12:52:05 | `/no-such-page` | 404 | JSON |
| 7 | 12:52:10 | `/module/CS3244` | 200 | `d1;dur=115` |
| 8 | 12:52:16 | `/module/ZZ9999` | 404 | `kind: unknown`, max-age 60 |
| 9 | 12:52:22 | `/?q=cs3244&open=CS3244` | 200 | same page bytes |
| 10 | 12:52:27 | `/search?q=machine+learning+for+beginners` | 200 | miss, 20 results, `total;dur=453` |
| 11 | 12:52:33 | same | 200 | hit, `total;dur=24`, `max-age=14400` |
| 12 | 12:52:38 | `/search?q=machne+lerning` | 200 | miss, 0 results, `no-signal` (two typos; see below) |
| 13 | 12:52:43 | `/search?q=intro+to+psychology&ng=1&study=ug2&sem=1` | 200 | miss, 20 results, `total;dur=226` |
| 14 | 12:52:49 | `/search?q=xqzvbnm+plorft` | 200 | miss, `no-signal` (SC4's gibberish case) |
| 15 | 12:53:04 | `/search?q=machne+learning` | 200 | miss, 20 results (EE2211 first), `total;dur=225` |

Call 12: SC4's example `machne learning` works (call 15). With two misspelt words, `machne
lerning` answers "Nothing in the catalogue matches". That's a search-quality limit (G4 in ADR
0011), recorded here and not planned.

## 2. Workstreams
| WS | Scope | Owner | Branch | Depends on |
|---|---|---|---|---|
| 8-0 | gate answers; one Workers Log read | Jacob (G1–G4), lead (the log read) | — | — |
| 8A | the docs describe the system as it is (SC10) | implementer agent | `phase8/docs` | — |
| 8B | what a visitor sees: 404 page, favicon, no-JS line, privacy note, logs per G3 | implementer agent | `phase8/visitor` | G3 |
| 8C | the launch checklist, the post text, the outage runbook, the outage check per G4 | implementer agent (docs, and code if G4 is b) | `phase8/launch` | G2, G4 |
| 8D | ship, live re-check, exit; the vault page | lead | — | 8A–8C |

Code workstreams write their tests first, in the first commit of the PR, and those tests fail
before the change. Pure docs are the exception. Every change is ranking-neutral: the ranking lock
must take its fast path or recompute equal. No holdout look.

### 8-0 Gate answers and one read
- Jacob answers G1–G4 (§5).
- **The lead reads one Workers Logs invocation log for a `/search`** in the dashboard and records
  which fields it holds (URL, headers, IP-bearing headers, `cf` geo) in
  `docs/evidence/phase8/measure.md`. Record the field names and redacted examples, never a
  visitor's values. G3's privacy note states what that read finds.

### 8A Docs as they are (SC10)
**Tests first.** `test/docs-facts.node.test.js` checks each volatile fact the docs keep against
its source:
- **Counts:** the production bundle's count (`data/vectors.json`), the NG-listed codes with no
  classes (`data/ng-unscheduled.json` `count`), the NG list's codes per semester
  (`data/ng-courses-<year>.json`), and the standby's stored dims (count × 384).
- **The eval:**
  - holdout and test looks spent (rows of `eval/holdout-ledger.md` by set);
  - the shipped pin (`SHIPPED_BASELINE`);
  - SC5's Δ and CI (`docs/evidence/phase3/sc5.md`).
- **Retired claims:** strings that must no longer appear in README.md, EVAL.md or REFERENCE.md
  outside a section headed "History":
  - "Exchange Course Finder";
  - "vector half is unproven";
  - "does not currently earn its keep";
  - "until midnight UTC";
  - "No look has been taken".
- **The README's commands:** every `npm run <x>` in the README exists in `package.json`, and the
  README names `npx playwright install` before `test:ui`.

Each fails on today's docs. Where a number need not be in prose, the fix removes it and points to
the file instead, so the next refresh can't make it stale.

**The changes** (each row of §1's three tables marked stale, wrong, gap or incomplete):
- **README:**
  - add the shortlist and its exports;
  - "Later changes are gated on a separate holdout and CI's ranking lock";
  - the browser install line.
- **EVAL.md, restructured with the current state first:**
  1. the shipped ranker and how a change ships (ranking lock, holdout looks 8 of 12, the no-look
     routes, the pin history in ADR 0003);
  2. SC5 on the sealed test set;
  3. the Phase 2 baseline, as the baseline;
  4. the replica and production: exact on both since 3-0; pinned 2026-09-04 corpus against
     production's `current`;
  5. what the numbers don't show (no human judge, a single judge, the pinned corpus).

  The v1 eval moves to `eval/v1/README.md` with a one-line link. Its conclusion is marked
  superseded.
- **REFERENCE.md:**
  - fix every row in §1's table;
  - rewrite "How a search is answered" as the current pipeline, briefly, linking each stage's
    module;
  - lead "Cost" with today's binding limits and §1's spike table; keep "How that number was
    brought down" as history;
  - name Workers AI as the shared allowance that matters;
  - date the Workers Logs pricing change.
- **The vault page (the lead's, in 8D):** see §1.

**Exit checks:**
- `docs-facts` passes;
- every §1 row is fixed or rebutted in the PR body;
- `npm test` passes;
- a fresh clone runs the README's commands as written.

### 8B What a visitor sees
**Tests first:**
- **Worker tests:**
  - an unknown path with `Accept: text/html` gets a small HTML 404 page with the name, "unofficial"
    and a link home;
  - with any other `Accept` (or none) it keeps today's JSON 404, so API callers see no change;
  - `/favicon.ico` is answered from `public/` (a 200, not a Worker run).
- **UI specs:**
  - with JavaScript off (Playwright `javaScriptEnabled: false`) the page shows one sentence saying
    the site needs JavaScript;
  - the 404 page and the privacy note pass axe in both themes and send `_headers`' CSP;
  - `headers.spec.js` covers the new files.
- **If G3 is (b) or (c):** a config test asserts `wrangler.jsonc`'s `observability.logs` settings.
  If (c), a Worker test asserts the `search` line carries no `q`.

**The changes:**
- **The 404:** the Worker returns `public/404.html`'s content when `Accept` prefers `text/html`.
  Static assets can't serve an HTML 404 to browsers and JSON to API callers from one path, so the
  Worker decides.
- **The icon and no-JS line:** `public/favicon.ico`, a `<noscript>` line.
- **The privacy note:** a short page, linked from the footer, saying in plain words:
  - what Cloudflare keeps per request and for how long, per 8-0's read and G3's choice;
  - what the site's own log keeps;
  - what stays on the device (the year of study, the last shortlist) and how to clear it;
  - no cookies, no trackers, no third parties.
- **`og:site_name`:** "NUS Mod Finder (unofficial)".
- **G3's logging choice** in `wrangler.jsonc` and, for (c), in `src/search.js`.

**Exit checks:** CI green, ranking lock unchanged; after the Actions deploy, smoke green; 8D's
live checks.

### 8C Launch checklist, post text, outage runbook, outage check
- **`docs/launch.md`**, short, for Jacob:
  - **Before any post:** §1's preconditions, each with how to check it, e.g. `/health`'s tag is
    `main`'s, a green smoke record under `docs/evidence/ops/runs/` from the last day, the privacy
    note live.
  - **The post text:** two or three sentences per G2 audience, saying what the site does, that it
    is unofficial, and to check with NUS. Jacob edits and posts it; nothing here posts.
  - **Launch week:**
    - Workers AI's daily neurons in the dashboard;
    - `npm run ops:report` a week after the post, committed;
    - the Worker's 4xx and 5xx counts.
  - **"The site is down":** the order to check (`/health`; a search; `wrangler deployments
    status`; the last deploy tag), then `npm run rollback` and `npm run smoke -- --expect <sha>`,
    as REFERENCE.md has them.
  - **If NUS or NUSMods asks for a change or removal:** reply, take the text or feature down
    within a day, record it in an ADR.
- **If G4 is (b):**
  - `.github/workflows/uptime.yml` and `scripts/uptime.mjs`. Hourly: GET `/health` (no D1, no
    neurons) and one `/module/<code>` (1 D1 row). Never `/search`.
  - A failure twice in a row opens one `uptime:down` issue, which GitHub emails to Jacob. The next
    good run comments and closes it.
  - Same shape as `drift.yml`: `contents: read`, `issues: write`, no secret but `GITHUB_TOKEN`, an
    issue marker, not a title match.
  - **Tests first:** fixture responses give the open, the comment and the close; one failure alone
    opens nothing; the cron matches the script's schedule.

**Exit checks:** `launch.md` committed and every precondition checked once. If G4 is (b), the
workflow ran green once by `workflow_dispatch`, and a forced failure (a bad URL passed by input in
a dry run) shows the issue text without creating an issue.

### 8D Ship, live re-check, exit
- **Ship:** 8A, 8B and 8C each merge after green CI, and Actions deploys each one. Smoke runs on
  every deploy (5 requests, one `/search`).
- **Live re-check** after 8B's deploy, ≤ 10 GETs, no `/search`, each ≥ 4 s apart, logged as a run
  record or a `requests.tsv` row:
  - `/no-such-page` with `Accept: text/html` gives the HTML 404, and without it the JSON;
  - `/favicon.ico`;
  - the privacy note;
  - `/`'s `<noscript>`;
  - `/health`.

  axe and the fold run in CI, not live. No `p6-live` run: the search path and the result page
  don't change.
- **Fresh clone again** at the exit commit: the README's commands.
- **Docs:** PLAN.md row 8; PROGRESS.md; `docs/evidence/phase8/exit.md`; ADR 0012 accepted; the vault
  page (the lead).

## 3. Cost, ops and risks
- **Remote, all of Phase 8 (*est.*):**
  - three or four Actions deploys, each with the guard (~21k D1 rows read) and a smoke (5
    requests, 1 search, ≤ 0.07 neurons);
  - 8-0's one dashboard log read;
  - 8D's ≤ 10 GETs.

  No D1 write, no Workers AI beyond the smokes, no Vectorize call, no migration.
- **G4 (b), if chosen:** 48 requests a day and 24 D1 rows a day, about 0.01% of the request
  allowance.
- **The spike:** §1's table. Under 100,000 uncached searches a day, the worst day costs cents.
- **Holdout:** no look. Every Phase 8 change is ranking-neutral, and the lock proves it.
- **Risks:**
  - **Deploy on every push** empties the search cache on each merge. During a launch week, merge
    only what's needed, and let docs batch.
  - **The shared Workers AI allowance.** Another project's busiest day used 68%. A spike on the
    same day is billed, not refused. If neurons ever were refused, search would fall back to
    keyword-only.
  - **Shared NAT and the burst limit.** A class searching together from one address can hit 429s.
    The message says to wait a minute. If launch-week reports show it, the limit is one number in
    `wrangler.jsonc`.
  - **NUS's text.** Course descriptions shown in full, as NUSMods shows them. Answered by
    `launch.md`'s takedown line.
  - **The 4-hour browser TTL on cached searches** (§1, unconfirmed). After a deploy, a returning
    visitor may see their own earlier answer for up to 4 hours. It doesn't affect correctness
    between data refreshes.
  - **Workers Logs pricing from 2026-12-01.** Measured volume is far inside the new inclusion.
  - **GitHub schedules** pause after 60 quiet days on a public repo. The drift monthly reminder
    already warns, and an uptime workflow would pause too.

## 4. Exit criteria
- **SC10:**
  - every stale, wrong, gap or incomplete row in §1's three audit tables is fixed or rebutted with
    evidence;
  - `test/docs-facts.node.test.js` runs in `npm test` and passes;
  - a fresh clone runs the README's commands as written;
  - the vault page is updated (the lead).
- **Name and domain:** G1 answered and recorded in ADR 0012.
- **Visitor-facing:** 8B live and checked: HTML 404 for browsers and JSON for API callers,
  `/favicon.ico`, `<noscript>`, the privacy note linked from the footer, and G3's logging choice
  deployed.
- **Launch:**
  - `docs/launch.md` committed, its preconditions each checked once;
  - G4's choice in place and, if (b), run green once.
  - The announcement itself is not an exit criterion. It's Jacob's, after the exit.
- **Ops:** every remote step has a run record or a `requests.tsv` row. No holdout look. Ranking
  lock unchanged.

## 5. Gate questions for Jacob
- **G1. The name and address.** The site is "NUS Mod Finder (unofficial)" at
  nusmodfinder.rcn.sh, as you chose in Phase 5 (ADR 0009). Keep both for the launch?
  - Options: keep both; or change one before any post.
  - *Recommended: keep both.* The name, the address, the share image and the GitHub repo all match
    already. A change after a post would break shared links.
- **G2. What launch means to you.**
  - (a) No announcement. The site stays public and findable.
  - (b) You post it in a few places you choose, such as NUS exchange-student groups or your home
    university's outgoing-exchange group, using a short text Phase 8 drafts for you to edit.
  - (c) A broad post, such as a public NUS forum.

  If (b) or (c): which groups or places, and roughly when?

  *Recommended: (b), soon after Phase 8 closes.* Incoming Sem 2 students are choosing courses now,
  and the next big wave applies from 21 March to 10 April. A few targeted posts reach the people
  the site is for. Any problem then reaches a small group first.
- **G3. What the site keeps about visitors.** Today Cloudflare keeps a log of every request to
  the site's search and course data for 7 days: the full address, which includes what someone
  searched for, and request details. The site's own log line keeps the search text cut to 100
  characters, with no IP address.
  - (a) Keep both, and say so in a privacy note.
  - (b) Turn off Cloudflare's per-request log and keep only the site's own line (search text, no
    IP, 7 days), and say so in a privacy note.
  - (c) Keep no search text at all, only counts and timings.

  *Recommended: (b).* The site's own line is enough to debug a bad search and to watch errors. The
  monthly usage report doesn't use Cloudflare's per-request log. A visitor's search, kept briefly
  and without who sent it, is easy to explain in two sentences.
- **G4. Who notices if the site goes down.** In Phase 7 you chose no daily live check. Once
  strangers rely on the site, an outage could last until you next look.
  - (a) Stay as is: you check it, and the monthly report shows errors after the fact.
  - (b) Once an hour, GitHub checks that the site and its course data answer (never a search, so
    no AI cost), and opens an issue, which GitHub emails you, if two checks in a row fail. It
    closes the issue itself on recovery.
  - (c) The same as (b), but only for the first month after you post.

  *Recommended: (b).* It costs about 50 requests a day, nothing on Workers AI, and no secret. It
  tells you within two hours, not whenever you next look.

## 6. Critic log
(Filled in by rounds 1–3.)
