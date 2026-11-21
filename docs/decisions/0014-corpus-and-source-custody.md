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

## In the code
**The corpus and its caches**
- `data/corpus.json` stores no data version: it depends on the NG files too (`src/rowhash.js`), so
  `checkCurrent` (CI's `corpus check`) recomputes it, and a stored copy would go stale on the first
  mid-year NG revision.
- `publishCorpus` (`scripts/corpus-manifest.mjs`) takes the corpus's year from the URL
  `corpus fetch` recorded, or its file name, and refuses to publish it under another year, because
  ingest writes every row with the manifest's year.
- The download cache, `CACHE_DIR` (`scripts/lib.mjs`), is `.data/cache/`, never `.data/`, where
  the eval's pinned snapshot lives (`test/cache-dir.node.test.js`): a NUSMods download there would
  overwrite the snapshot the eval and `test/full` sha-check and move every eval result. For the
  same reason `loadPinnedCorpus` (`scripts/pinned-corpus.mjs`) reads the snapshot straight from
  `.data/` against `PINNED_RELEASE`'s sha256, never through `fetchAcadYearFile`, which fetches from
  api.nusmods.com when the file is missing.
- `fetchAcadYearFile` serves or revalidates a cache entry only when its sidecar's sha256 matches
  the body; otherwise it does a full GET with no validators, so a 304 can't bless a truncated or
  edited body. It writes the body before the sidecar, each atomically, so a sidecar never vouches
  for a body that isn't on disk. A failed revalidation throws; `offline` is the only way to use a
  stale copy.
- The builders write committed JSON one row per line (`corpusFiles` in
  `scripts/build-catalogue-data.mjs`, `scripts/build-fixture.mjs`), so a corpus change diffs row
  by row. `--check` compares bytes, so a reformat changes the builder and its outputs together.

**NUS's documents**
- `scripts/sources.mjs` never reads the holdout key: `keyPath` refuses a path named `holdout.key`
  (compared without case, since macOS's file system ignores it) or the holdout key's own path, and
  `readKey` follows symlinks and refuses a file that is `VNM_HOLDOUT_KEY_FILE` by device and inode,
  without opening the holdout key. It never replaces a published archive (a second publish of a
  revision is refused) and accepts only plain base names in a manifest, so `../x` can't be read
  from outside `--from` or written outside the restore dir. Its tests use fake documents and a
  throwaway key; the real documents stay on the Mac.
- `scripts/yst-text.mjs` writes one text node per line in a fixed format (scripts, styles and
  comments dropped, entities decoded, only ASCII white space collapsed, nodes trimmed of every
  space including no-break, empty nodes dropped) that reproduces the committed extractions byte
  for byte. `scripts/build-ng-restrictions.mjs` parses that format: a heading line carries
  `(N units` and its codes start that line or one of the three above it. Changing the format
  breaks the builder and the committed `textSha256`.
