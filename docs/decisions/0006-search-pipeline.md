# 0006: The search pipeline: exact vectors in the Worker, query understanding, duplicate groups

Status: accepted. How a search is answered, step by step, is in
[docs/architecture.md](../architecture.md); this records why it is built that way.

## Exact dense search inside the Worker; Vectorize as the cold standby

### Context
With Vectorize on the search path, a warm search spent about 232 ms in Vectorize and 88 ms
embedding the query, so the server time sat near 350 ms. Vectorize is also approximate, so the
offline eval (an exact search) and production disagreed near ties, and its queried dimensions
were the account's binding allowance (about 4,100 uncached searches a day).

### Decision
- **Dense search is a brute-force dot product** over L2-normalised float32 corpus vectors bundled
  into the Worker as one `Data` module (the layout is in
  [docs/architecture.md](../architecture.md#the-vectors-bundle): 384 floats and a 32-byte filter
  row per module). It is parsed on the first dense search, costs no I/O per
  request, and deploys and rolls back with the code that reads it.
- **One keyed builder** (`scripts/vectors.mjs`) makes a fixture, a pinned and a production
  bundle. The manifest (`data/vectors.json`) records each bundle's data version, rows, sha256 and
  `rowsKey` (the sha256 of its sorted code and `text_hash` pairs). The deploy guard refuses a
  bundle that differs from D1, and `npm run deploy` refuses any bundle but production's.
- **Every corpus change follows one runbook order:** the manifest and an offline data version
  merge first, then D1 is written in a D1-only mode behind a Time Travel bookmark, then the deploy
  and smoke, and Vectorize last, with every code upserted and the mutation awaited.
- **Vectorize stays an identical cold standby** behind `DENSE_BACKEND=vectorize`. The flip is
  degraded service: masks fall back to code order, and constraint filters apply after hydrate. No
  new Vectorize metadata is added (10 indexes allowed, 8 used), so the standby relies on the D1
  recheck at topK 100, with a recorded recall loss.
- **The search cache key** carries the deployed version id and every parameter in parsed form, so
  every deploy starts a fresh cache.

### Measured
- Bundle: 32 B of filter row plus 384 float32 per module, about 10.7 MB, 16% of the Worker's
  64 MiB limit. The filter row is 32 B, not the ~12 B first estimated, because its second half holds the
  exam, S/U, prerequisite and workload fields, with two reserved slots
  ([docs/architecture.md](../architecture.md#byte-layout)).
- Startup: 0 ms active CPU locally (the module is an ArrayBuffer); the deploy refuses a version
  whose `startup_time_ms` is over 200.
- CPU: the exact search takes 1.44 ms warm and unfiltered locally (0.17–0.99 ms filtered). Live,
  CPU per request was p50 9.1 ms, p75 15.5 ms, and 33–34 ms on a fresh isolate's first search.
  A warm burst read server `total` p50 131 ms against 332 ms with Vectorize.
- Identity: on dev, 98 of 98 queries return the same results as the Vectorize-era replica; the
  fixture's dense differences were all swaps of exact ties (|Δ| ≤ 2.2e-16).

### Consequences
- Production dense search is exact, so the replica-against-production caveat narrows to the
  corpus and query-embedding noise (ADR 0003, "Replica fidelity").
- Vectorize queried dimensions drop to about 0; Workers CPU and the shared neurons become the
  binding allowances (ADR 0004).
- Every corpus change needs a deploy, and the guard blocks deploys from `main` between the merge
  and the D1 write.

## Query understanding
- **Typed codes pin.** Up to 3 typed course codes are pinned to the top; partial codes, code
  prefixes and GE pillar phrases become code-range masks; a whole query that is one of these
  answers that set in dense order.
- **Typos are corrected against the catalogue's own words** (`src/typo.js`,
  `data/vocabulary.json`), and a corrected query is embedded once more.
- **No signal, no answer.** A query with no route and no catalogue word whose best cosine is below
  τ answers `noMatch: { reason: "no-signal" }` instead of the least-bad results.
- **Level phrases are specified, not in force.** The Worker reads a level only from a code token
  (`CS3000`, a prefix with its level). The query suite's reference parser
  (`test/query-suite/intents.node.mjs`) defines the level phrases below, and
  `test/full/query-suite.test.js` skips the items that need them (`level-phrases`). Reading them
  in `src/query-intent.js` moves ranked lists, so it ships as a ranking change through the eval
  gate, with a holdout look.
  - **A beginner phrase is a hard exclusion.** An explicit beginner phrase removes level ≥ 5 and
    adds a soft prior for levels 1–2. It is echoed in `interpreted` and undone with `ignore=level`.
  - **Year as a level window.** `3rd year` means 3 ≤ level ≤ 4, because the judged answers to a
    "3rd year" query are level 4000 courses as well as 3000. `level 3000`, `3000 level` and `3k`
    stay exact. Several level phrases take the union.
- **Constraints are hard filters.** `exam=0`, `su=1`, `hoursBelow=N` and `prereq=none` filter
  exactly, as params and as phrases read from the query (*no final exam*, *S/U*, *light
  workload*). Each parsed phrase is echoed so the page can show a chip that undoes it
  (`ignore=`). Parsed phrases are gated by the compliance rule (ADR 0003), because a relevance
  look scores a hard filter's intended removals as loss.
- **The query suite** (`test/query-suite/`) holds pre-registered queries, each with its exact
  expected `interpreted` JSON. It runs on the pinned bundle in CI and is checked against the
  holdout by count only.

## Duplicate groups
- **groups-v1 is the product's duplicate rule**, the same rule the eval scores by (variant
  families and exact cross-listings; ADR 0003). A result list shows one entry per group; the other
  members ride as `variants`, with their credits.
- **The semester representative.** When the request names a semester (`sem=1|2`, with or
  without `ng=1`), each group is shown as its highest-ranked member that passes the result filters
  and is on NUSMods' timetable that semester; if none is, the first-ranked passing member. A member
  outside the ranked list ranks after every ranked one, in code order (`semesterRepresentative`,
  `src/groups.js`). The group keeps its place and its first member's score; only the member shown
  changes, and the swapped-out one is listed in `variants`.
  - A typed code is never swapped: it is the student's explicit choice.
  - Unchanged: requests with no semester, `related`, the order of mask pages, and
    `COLLAPSE_GROUPS=off`. Outside exchange mode `sem` already filters on the timetable, so in
    practice the rule acts under `ng=1`, where `sem` picks only the allow-mask bit.
  - **Why:** members of one group share their text, so which ranks first is close to arbitrary;
    a Sem 1 page could show ACC1701XB, which is off NUSMods' Sem 1 timetable, while ACC1701XC,
    taught in Sem 1, sat in its variants.
  - **Where:** `attachVariants` in `src/search.js` already reads every member of each shown group
    from D1; with a semester named that read takes a whole card's columns, so a swap costs no
    extra read. Every path goes through it.
  - Gated by the representative-only route (ADR 0003).

## In the code

**The vectors bundle** (`src/vector-bundle.js`; the byte layout is in
[docs/architecture.md](../architecture.md#the-vectors-bundle))
- Filters and constraints are implemented three times with one meaning: `filterSql` in
  `src/lexical.js` (SQL), `compileMask` in `src/vector-bundle.js` (the filter table, keeping the
  semantics of the Vectorize metadata filter it replaced: every given filter must hold, a null
  field never matches) and `localMatchesFilters` in `src/search.js` (the post-hydrate recheck). A
  change to one is a change to all three. D1, not the bundle, decides membership at hydrate: a
  bundle row whose D1 row has since moved is dropped only by a filter that now fails on D1's
  values.
- `exactSearch` keeps the top `depth` by score, ties in row order, which is code order, so exact
  ties are deterministic. `compileMask` keeps a plain comparison for a single level or credits
  value because the mask runs on every row of the scan.
- `ngIgnoreAllow` exists only for the oracle trace (`oracleTraceMode`), never live.
- `scripts/vectors-manifest.mjs` `shimPath` points the `vectors-bundle` alias at a small `.js`
  module that imports the `.bin`: wrangler collects a `.bin` as a `Data` module only when a module
  imports it, not when it is an alias target.
- The fixture bundle (`test/fixtures/vectors.bin`) holds the fake embedder's vectors for exactly
  the modules `seed()` puts in the fake Vectorize, and `test/dense.test.js` lets the bundle and
  the standby differ only by near-tie swaps (the fake embedder's integer word counts tie exactly).
  Where the two paths read to different depths (the group collapse reads the bundle deeper; the
  NG standby reads 100 deep before D1's mask), the fused pages may differ by design.
- The exact search's CPU cost is measured in `test/full/vectors.test.js`, not from production
  traces, because workerd's clock reads about 0 for CPU work there. Under Vitest
  `performance.now()` ticks in whole milliseconds, so the test times batches of 200 searches; its
  bound is loose on purpose, a measurement rather than a timing gate.

**Fusion and depth** (`src/search.js`)
- `fuse` is reciprocal-rank fusion with `RRF_K` = 60 (Cormack et al.), so cosine and bm25 never
  need to be commensurable. Each retriever reads `CANDIDATE_MULTIPLIER` (3) times the page, so a
  document mid-list in one and top in the other can still surface. RRF ties are frequent and
  break by a stable hash of the code; an alphabetical tie-break would favour early-alphabet codes.
- Each list is capped at `MAX_TOPK` (50): a deeper fused list changes RRF's sums and so the
  ranking. Only a single list (lexical, or the bundle's dense order with no code list) reads
  deeper, 100 (Vectorize's topK cap), to fill a collapsed page, since it only continues the same
  order. All of these are ranking inputs behind the eval gate.
- `mergeDense` (the `3c2` typo variant, two query vectors) keeps each code at its best cosine and
  is exact: a code in the true top `depth` by best score is in the top `depth` of the vector that
  gives it that score.
- `vectorSearch` and `embedOne` raise a `DenseFailure` with its source (`workers-ai`, `vectorize`
  or `dense-index`) at the call that failed; guessing the source from the error text labelled
  Workers AI failures as Vectorize.
- The cache key (`searchCacheKey`) folds case and whitespace in `q` because every stage ignores
  both: bge-small-en-v1.5 is uncased and the FTS query folds them. A case-sensitive stage would
  make the key serve one spelling's answer to another.
- `env.EMBEDDING_MODEL` overrides `DEFAULT_MODEL` (`src/embedding.js`) so tests can drive the
  upstream-failure path with a bogus model; production sets none, since the deploy refuses any
  var but `DENSE_BACKEND`.

**Parsing the query** (`src/query-intent.js`)
- `parseQuery` runs in one fixed order: canonical `q`, the no-signal vocabulary test on the
  pre-correction tokens, typo correction, pass A's constraint phrases (read and stripped before
  any code join), code joins, code resolution, then pass B. Everything after the correction reads
  the corrected text, and corrections are not echoed in `interpreted`; the query suite's expected
  `interpreted` JSON pins this order. So no constraint-phrase word may be one the typo step
  corrects, or the phrase never matches (`test/full/vocabulary.node.test.js` checks this over the
  pinned vocabulary).
- `canonicalQuery` lower-cases ASCII letters only: full Unicode lower-casing maps the Kelvin sign
  (U+212A) to `k` and would let a code match that the raw query never matched.
- `codeRange` maps a partial code P to the key range [P, P + `:`) (P + `0` when P is letters
  only), `:` being the character after `9`. Every code has digits after its letters, so `CS`
  excludes CSA6101 and `GES` excludes GESS1000, which a string-prefix match would not.
- `joinCodes` joins letters on the collision list or the stopword list with digits only when they
  are the whole query and the result is a known code (`ee 2211`); joins a 1–2-letter suffix word
  only into a known code and never across `/` or `-` (`cs1231 s/u` stays CS1231); and a
  letter-only token routes only as the whole query and off the collision list. Pass B masks a
  joined token's words, so `ge 2101` is Geography's code, never the GE intent. Loosening any of
  these turns ordinary words into codes.
- A token is a code only when its prefix is an offered one (`prefixes-data`), so a catalogue code
  under a prefix no offered course has (EX2991) is not answered as not-offered;
  `test/oracle/catalogue.test.js` lists those instead of failing on them.
- `ParsedQuery.codes` (every code-shaped token, at most `MAX_CODES`) feeds only `/search`'s
  `hiddenPins` and `notOffered`, never the ranking; only the first `MAX_PINS` offered codes pin.
  `public/explain.js` `unpinnedLine` explains codes past the limit only when the pin list is full,
  because the page's `typedCodes` can't check prefixes against the catalogue and would otherwise
  name code-shaped words that aren't courses.
- `parseWithCorpus` (`src/search.js`) answers "offered" from the bundle's code list, then from D1
  for any code the bundle lacks: between a D1-only ingest and the deploy that bundles its vectors,
  a new module is in D1 but not the bundle and must still pin. When the bundle doesn't parse,
  every question goes to D1.

**Keyword query and typos** (`src/fts-query.js`, `src/typo.js`, `src/vocabulary.js`)
- `ftsMatch` reduces the query to bare tokens, quotes each and ORs them: FTS5 MATCH is its own
  query language, so raw user text is a syntax error, and no token can hold a `"` because `"` is
  a separator. Recall comes from the OR, ranking from `rank`.
- Stopwords are dropped first (else "how do i start my own company" matches every "Design Your
  Own Course" on "own"); the list is the offline BM25 baseline's, so neither retriever gets an
  easier query. The stopword test strips diacritics as FTS5 does (`ánd` is `and`).
- A correction only adds matches: a df-0 token of 4+ letters becomes a prefix term, and a
  corrected token's original follows the correction as a prefix term. The thresholds
  (`PREFIX_MIN_LETTERS` 4; `CORRECT_MIN_LETTERS` 5 and only when the prefix term matches nothing;
  OSA distance ≤ 1 for 5–7 letters, ≤ 2 for 8+; ties to the higher df, then the smaller term) are
  the pre-registered variant's.
- The typo step leaves a token that isn't letter-only ASCII (`naïve`) as typed: `unicode61`
  strips diacritics itself, so folding in JS would duplicate the tokeniser and could drift.
- `correctQuery` memoises its last result because `parseWithCorpus` re-runs the parse when D1 must
  say whether a code is offered, and the nearest-term scan is the costly part. `osaDistance`
  stops once a row's minimum exceeds the bound, which is exact because a transposition reaches
  back two rows only from a cell the row between already improves on.

**The tokeniser and stemmer match FTS5** (`src/fts-separators.js`, `src/porter.js`)
- `queryTokens` splits on `src/fts-separators.js`, so a query splits exactly where `modules_fts`'s
  `porter unicode61` splits text; a `[^a-z0-9]` split cuts "naïve" into "na", "ve". The table is
  probed from SQLite by `scripts/gen-fts-separators.mjs`, not written as `[^\p{L}\p{N}]`, because
  `unicode61` (default options, as migration 0006 declares it) classifies by Unicode 6.1: later
  code points, emoji included, are token characters, combining diacritics it can strip (U+0308 in
  a decomposed "naïve") are token characters, and every other mark separates. Lone surrogates
  can't be stored as UTF-8, so they are listed as separators. The ranges are built with `RegExp`
  rather than a literal class because they start and end on combining marks. `--check` fails on a
  stale table.
- `src/porter.js` ports FTS5's porter stemmer rule for rule over UTF-8 bytes, keeping SQLite's
  departures from Porter's paper (y as a vowel after a consonant, bli→ble and logi→log, the first
  matching suffix decides even when its condition fails, tokens under 3 or over 64 bytes
  unstemmed). FTS5 stems a prefix query's token too, so `src/vocabulary.js` can decide whether
  `"tok"*` matches anything without a D1 query only with the identical stemmer.
- `test/fts-tokenizer.node.test.js` and `test/porter.node.test.js` check both against
  node:sqlite's FTS5 (the same frozen Unicode 6.1 tables D1 uses); the separator probe covers
  every code point, not a sample (about 5 s), and ASCII queries keep their MATCH strings byte for
  byte against a copy of the old ASCII tokeniser. A token of only strippable diacritics folds to
  no term, which FTS5 treats as matching nothing, without an error.

**Groups and results** (`src/groups.js`, `src/search.js`)
- groups-v1 never cross-lists on an empty or placeholder description ("Not Available"), or nine
  departments' "Graduate Seminars" (BN5999 … MT5999) would collapse into one group; a variant
  family also needs the same normalised title, so MA2101 and MA2101S stay apart. Change the rule
  only with a new `GROUPS_VERSION` and the eval's groups (ADR 0003).
- `attachVariants` filters variants by the request's filters, the constraint intents and the
  level window, not by the query's code ranges, so a GES result still lists its GESS
  cross-listing.
- A no-match answer's `related` neighbours are a courtesy: when their D1 recheck fails the answer
  carries none, never unfiltered ones and never a 500. On the Vectorize standby they come straight
  from Vectorize unless a constraint param is set.

**Data the Worker reads** (`scripts/`)
- `scripts/build-catalogue-data.mjs` mirrors `eval/query-rules/` (GE pillars, collision list,
  constraint phrases, cohort-only rule) into `data/`, because the Worker bundle and the eval
  workspace can read `data/` but not `eval/`. `eval/query-rules/` stays the one source and
  `--check` fails on a drifted mirror. The pinned `catalogue-only.json` is never committed:
  `pinnedCatalogueOnlyPath` builds it into `.data/catalogue/` for `test/full`.
- The fixture vocabulary (`scripts/build-vocabulary.mjs`, `withPhraseWords`) adds every
  constraint-phrase word the fixture's texts lack at df 1, so the Worker tests don't "correct" a
  phrase word the production vocabulary leaves alone (`hours` to `tours`). Only the fixture gets
  this: `buildVocabulary` builds every eval run's vocabulary from the corpus alone, and phrase
  words there would change rankings.
- `EMBEDDING_TEXT_VERSION` (`scripts/lib.mjs`) is part of `text_hash` with the model and the
  text; bump it whenever `embeddingText()` changes, or old vectors stay that ingest believes are
  current. `MAX_BLOB_CHARS` (1,900) keeps embedding text under bge-small-en-v1.5's 512-token input
  at about 4 characters a token; raising it lets the model cut text the hash claims was embedded.
- `MODULE_CODE_RE` (`scripts/lib.mjs`) allows 1–4 letters, four digits and up to five
  alphanumerics of suffix, for codes like DMR1201GEQA and LC6009GRSII. It can be loose because a
  query short-circuits to a code only when that code exists; drift uses it as the only shape of
  code it puts in an issue.
- `test/query-suite/intents.node.mjs` derives each item's intents from
  `eval/query-rules/intent-phrases.json` and `ge-pillars.json` alone, importing nothing from the
  Worker's parser, so `consistency.node.test.js` is an independent check of the suite's
  `interpreted` objects. A typo item's intents come from its clean form, since `interpreted` does
  not echo corrections.

**Ingest and the standby** (`scripts/ingest-core.mjs`, `scripts/vectors-core.mjs`,
`scripts/verify-core.mjs`)
- `runIngest` sends `rowHash` and `ftsHash`, but `/admin/ingest` (`writeRows`, `src/ingest.js`)
  recomputes `row_hash` from the columns it binds, so a script and Worker that disagree on hashing
  can't store a hash that doesn't describe the row.
- After a confirmed Vectorize wait, failing to clear the pending-mutation store only warns: a
  stale confirmed entry is harmless (the next wait is satisfied at once). `epochMs` accepts
  `processedUpToDatetime` as an ISO 8601 string (what wrangler and the binding return) or a number
  (what workers-types declares) and gives null otherwise, so the wait never compares with `NaN`.
  `MAX_OWN_IDS` (2,000) only bounds `.data/ingest-state.json` across many carried-over reruns.
- `fileStateStore` (`scripts/ingest.mjs`) keeps every Worker URL's pending mutation in one file and
  replaces it through its own temp file (pid plus a random UUID), so two writers never rename each
  other's; the run lock keeps two ingests from interleaving.
- `scripts/vectors-core.mjs` (standby) and `scripts/verify-core.mjs` take the admin API, the
  vector id listing and the parsed bundle injected and use no Node API, so the Worker tests run
  this exact code against the real `/admin/vectors` and `/admin/verify` routes. Standby upserts
  every code D1 holds (nothing tracks which changed) and deletes the index's ids D1 no longer holds
  plus `.data/d1-only-deletes.json` as a floor: the file alone isn't enough, because a resumed
  `ingest --d1-only` loses the codes it already deleted.
- `runPreDeployVerify` requires each D1 row's exam dates to name exactly the bundle's exam
  semesters, since `exam_dates` isn't in the bundle; a Worker that doesn't answer `examDates`
  counts as having none.

**Tests**
- The timeout tests in `test/regressions/backend.test.js` ("timeouts and errors") are
  behavioural (pending just before the budget, settled just after) and don't spy on `setTimeout`,
  so they hold however `withTimeout` arms its timer.
