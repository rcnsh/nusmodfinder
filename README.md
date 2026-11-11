# <img src="public/favicon.svg" width="28" height="28" alt=""> NUS Mod Finder

Search every NUS course in plain English or by code, and see which ones exchange students may take.

**[nusmodfinder.rcn.sh](https://nusmodfinder.rcn.sh)** · unofficial, not run by NUS or NUSMods

Type what you want to study (`machine learning for beginners`, `i want to understand climate
change`, `how do i start my own company`) or a code like `CS3244` or `cs32`. Filter by semester,
level, units and faculty. Phrases such as *no final exam*, *S/U* or *light workload* are read as
filters, each with a chip to undo it.

Exchange mode asks for your semester at NUS and your year of study at home, then marks every
course as open, open with a note, or closed to you, from the Registrar's Non-Graduating course
list and course restrictions. Each course opens a detail with its exams, weekly workload,
prerequisites and a link to NUSMods for class times.

## How it works

One Cloudflare Worker, no framework and no build step.

- **Hybrid retrieval.** A D1 FTS5 (BM25) search and an exact dense search over
  `bge-small-en-v1.5` embeddings, fused by reciprocal rank. The corpus vectors ship inside the
  Worker as a ~10.7 MB bundle, so the dense half costs no network call.
- **Query understanding.** Course codes are pinned, partial codes and GE pillars become filters,
  misspellings are corrected against the catalogue's own words, and phrases become constraints.
- **The page** is static files in `public/`: native ES modules, IBM Plex, light and dark, tested
  with Playwright and axe in Chromium and WebKit.

## Is the ranking any good?

It is measured, not assumed. Student queries are graded blind, and the ranker is scored offline
against the first hybrid version (`eval-v0`). On a sealed test set of 195 queries, looked at once,
the Phase 3 ranker raised nDCG@10 by **+0.120** (95% CI 0.083 to 0.161)
([evidence](docs/evidence/phase3/sc5.md)). Later changes are gated on a separate holdout.
[EVAL.md](EVAL.md) has the method, the Phase 2 baseline and what the numbers do not show.

## Run it locally

```sh
nvm use            # Node 22.12+
npm ci
npm run dev        # the page against a seeded fixture database; nothing remote
npm test           # Worker and unit tests
npm run test:ui    # Playwright
```

Deploying, re-ingesting a new academic year, the API routes and the cost model are in
[docs/REFERENCE.md](docs/REFERENCE.md). How the project was planned and checked, phase by phase,
is in [docs/](docs/README.md).

## Data

Course data comes from the [NUSMods API](https://api.nusmods.com/v2/). Exchange-student
availability comes from the NUS Registrar's
[Non-Graduating course lists](https://www.nus.edu.sg/registrar/prospective-students/non-graduating).
Neither NUS nor NUSMods runs or endorses this site; check with NUS before you register.

## Licence

[MIT](LICENSE). IBM Plex is under the [SIL Open Font License](public/fonts/OFL.txt).
