# <img src="public/favicon.svg" width="28" height="28" alt=""> NUS Mod Finder

Search every NUS course in plain English or by code, and see which ones exchange students may take.

**[nusmodfinder.rcn.sh](https://nusmodfinder.rcn.sh)** · unofficial, not run by NUS or NUSMods

Type what you want to study (`machine learning for beginners`, `i want to understand climate
change`, `how do i start my own company`) or a code like `CS3244` or `cs32`. Filter by semester,
level, units and faculty. Phrases such as *no final exam*, *S/U* or *light workload* are read as
filters, each with a chip to undo it.

The first question is whether you're an NUS student or an exchange student. Exchange students
then give their semester at NUS and year of study during the exchange, and the site
marks every course as open, open with a note, or closed to you, from the Registrar's
Non-Graduating course list and course restrictions. Each course opens a detail with its exams,
weekly workload, prerequisites and a link to NUSMods for class times.

Shortlist courses as primary picks and backups for each semester. The shortlist totals units,
flags exam clashes and preclusions, and, for exchange students, counts against NUS's limits and
orders NUS's application form; it downloads as a CSV or prints to PDF.
It lives in the page's link, so it needs no account.

<!-- year:live --> The site covers NUS's 2026/27 courses and exchange lists. It moves to the next
academic year in July, once NUSMods has it and NUS has published the next Sem 1 exchange list.

## How it works

One Cloudflare Worker, no framework and no build step.

- **Hybrid retrieval.** A D1 FTS5 (BM25) search and an exact dense search over
  `bge-small-en-v1.5` embeddings, fused by reciprocal rank. The corpus vectors ship inside the
  Worker as one bundle, so the dense half costs no network call. <!-- pointer --> The bundle's
  size and course count are in [`data/vectors.json`](data/vectors.json).
- **Query understanding.** Course codes are pinned, partial codes and GE pillars become filters,
  misspellings are corrected against the catalogue's own words, and phrases become constraints.
- **The page** is static files in `public/`: native ES modules, IBM Plex, light and dark, tested
  with Playwright and axe in Chromium and WebKit.

## Is the ranking any good?

It is measured, not assumed. Queries written for student personas are graded blind by a model
judge, and the ranker is scored offline over a pinned copy of the catalogue. On a sealed test set
of 195 queries, looked at once, the ranker raised nDCG@10 over the first hybrid version
(`eval-v0`) by **+0.120** (95% CI 0.083 to 0.161). Every later ranking change is compared with the
ranker in production: it merges after a passing look at a separate holdout set, or by a no-look
route the eval's rules allow, and CI's ranking lock fails any change to a ranked list that lacks
that evidence. [EVAL.md](EVAL.md) has how it is measured, how a change is checked and what the
numbers do not show.

## Run it locally

```sh
nvm use                                  # Node 22.12+
npm ci
npm run dev                              # the page over a seeded fixture; nothing remote
npm test                                 # Worker and unit tests
npx playwright install chromium webkit   # once: the browsers the UI tests use
npm run test:ui                          # Playwright, in Chromium and WebKit
```

`npm run dev` serves the real page and Worker over a few hundred fixture courses with a fake
embedder, so its ranking is not production's.

How it is built, deployed, refreshed each academic year and kept running is in
[docs/](docs/README.md): the API, the architecture, operations, the re-ingest runbook, cost and
the decision records. What to do when the site is down is in
[docs/incidents.md](docs/incidents.md).

## Data

Course data comes from the [NUSMods API](https://api.nusmods.com/v2/). Exchange-student
availability comes from the NUS Registrar's
[Non-Graduating course lists](https://www.nus.edu.sg/registrar/prospective-students/non-graduating).
Neither NUS nor NUSMods runs or endorses this site; check with NUS before you register.

The site sets no cookies and loads no trackers. Cloudflare keeps request logs, which include
searches and IP addresses, for 7 days; [the privacy note](https://nusmodfinder.rcn.sh/privacy)
says what is kept and where. The site names no contact.

## Licence

[MIT](LICENSE). IBM Plex is under the [SIL Open Font License](public/fonts/OFL.txt).
