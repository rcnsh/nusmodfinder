# 0014: One production corpus in a manifest; NUS's documents archived encrypted

Status: accepted. The commands are in [docs/data.md](../data.md) and
[docs/year-refresh/](../year-refresh/README.md).

## One production corpus, in a manifest
- **`data/corpus.json`** lists every production corpus by its GitHub release asset
  (`prod-<year>-<yyyymmdd>`, the gzipped `moduleInfo.json`) with its sha256, size and the time
  NUSMods served it, and names `current`, the one production runs on. Ingest, the bundle builder
  and every per-corpus builder read only `current`, sha-checked; none fetches from NUSMods. So
  CI, any worktree and any machine can rebuild exactly what production runs.
- **The catalogue files are per corpus.** `data/catalogue-codes.json`, `data/prefixes.json` and
  `data/catalogue-only.json` are built from `current` (`scripts/build-catalogue-data.mjs`), and
  the deploy guard checks D1's `catalogueKey` against the bundled file, so search never calls a
  catalogue code unknown because the files followed another corpus.
- **The eval's pinned snapshot is separate** and never moves (ADR 0003).

## Republishing NUSMods data
The production corpus assets republish NUSMods' JSON, as the pinned corpus asset does for CI. The
repo's MIT licence covers its code, not this data. The assets exist only to make builds
reproducible, and the README credits NUSMods as the source.

## NUS's source documents are not republished in the clear
NUS's legal notice (https://www.nus.edu.sg/legal-information-notices) says no part of its web
content "may be reproduced, licensed, sold, published, transmitted ... without the prior written
permission of the University", and allows saving a copy "solely for your own information,
research or study". So each revision of the NG list, the restrictions PDF and the other sources
goes into the repo's releases **encrypted** (`npm run sources`), a private copy for the project's
own checks, with the key kept beside the holdout key and backed up in Bitwarden. The page's short,
attributed quotes of NUS's rules are a separate matter.

## Consequences
- A change to a source-derived input needs a committed `year check --full` run record before it
  deploys, and that needs the sources key. A hotfix that touches none doesn't.
- Without the key, the next source change can't be checked; deploys that touch no source-derived
  input still work.
