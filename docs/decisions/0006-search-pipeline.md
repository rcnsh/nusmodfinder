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
  into the Worker as one `Data` module (`src/vector-bundle.js` documents the layout: 384 floats
  and a 32-byte filter row per module). It is parsed on the first dense search, costs no I/O per
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
  64 MiB limit. The filter row is 32 B, not the ~12 B first estimated, because 16 B are reserved
  for the prefix id, group id and constraint fields.
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
- **A beginner phrase is a hard exclusion.** An explicit beginner phrase removes level ≥ 5 and
  adds a soft prior for levels 1–2. It is echoed in `interpreted` and undone with `ignore=level`.
- **Year as a level window.** `3rd year` means 3 ≤ level ≤ 4, because the judged answers to a
  "3rd year" query are level 4000 courses as well as 3000. `level 3000`, `3000 level` and `3k` stay exact.
  Several level phrases take the union.
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
