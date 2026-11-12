# NUS Mod Finder: maintainer guide for coding agents

Plain-English and code search over NUS courses, with exchange-student (NG) availability and a
shortlist, at https://nusmodfinder.rcn.sh. One Cloudflare Worker (D1, Workers AI, static assets),
no framework, no build step. Docs index: [docs/README.md](docs/README.md).

## Layout

| Path | What |
|---|---|
| `src/` | the Worker: routes (`index.js`), search pipeline (`search.js`), eligibility, notes |
| `public/` | the page: static ES modules, DOM nodes only ([docs/page.md](docs/page.md)) |
| `migrations/` | the D1 schema, the only one |
| `data/` | committed data: manifests, vocabulary, groups, NG lists and rules, per year |
| `scripts/` | ingest, deploy, rollback, smoke, remote, year refresh, builders, ops |
| `eval/` | the ranking eval: sets, harness, gate, ranking lock ([EVAL.md](EVAL.md)) |
| `test/` | Vitest (`*.test.js` in workerd, `*.node.test.js` in Node), `full/`, `oracle/`, `ui/` (Playwright) |
| `ops/runs/`, `ops/reports/` | run records of every remote operation; monthly usage reports |
| `docs/` | architecture, API, operations, data, exchange mode, cost, incidents, year refresh, ADRs |

## Commands

```sh
npm test                    # Worker and unit tests (excludes test/full and test/oracle)
npm run test:full           # test/full over the pinned corpus and bundle (needs .data/)
npm run test:oracle         # exchange-mode correctness over production's corpus (needs `npm run corpus -- restore`)
npm run test:ui             # Playwright, Chromium and WebKit; `npx playwright install chromium webkit` once
npm run lint && npm run typecheck
npm run eval:lock -- --check   # the eval gate: did a ranked list move?
npm run dev                 # the page over the fixture, nothing remote
npm run deploy              # the only way to deploy; `-- --preflight` before any D1 write
npm run smoke               # after a deploy or rollback from the Mac
npm run rollback            # then the `npm run smoke -- --expect <sha>` it prints
npm run year -- next <year> | check [--full]   # the yearly refresh (docs/year-refresh/)
```

Commit before `eval:lock -- --check`: it reads committed content only.

## Rules that bite

- **Ranking changes pass the eval gate.** Run `npm run eval:lock -- --check` on any change to
  `src/`, `data/`, `migrations/`, `scripts/lib.mjs` or the test Worker config. Equal lists: done.
  Moved lists: the change needs a passing holdout look (custodian only, needs the key) or a
  no-look route, then `eval:lock -- --evidence …`, and the PR moves `SHIPPED_BASELINE` in
  `eval/lib/baseline.mjs` and appends a `- shipped pin:` line to ADR 0003. Follow EVAL.md,
  "Checking a ranking change". Never decrypt an encrypted set or take a look on your own.
- **Hash pins.** These fail tests when their content changes; re-pin deliberately:
  - `eval/dev/queries.json`, `eval/holdout/*.enc`, `eval/groups.json`, `eval/pinned/*`: hashes in
    ADR 0003. Change only with a new set or eval corpus, and the ADR in the same PR.
  - The ranking lock's `inputsHash` covers the ranker and runner files; a neutral edit takes CI's
    slow path and passes. Rewrite the lock only with evidence (above) or for a new embedding.
  - The inline script's CSP hash: `test/web/source.node.test.js` prints the new one.
  - Aria snapshots: `VNM_ARIA_UPDATE=1 npx playwright test aria --project chromium`.
  - Data manifests (`data/vectors.json`, `data/corpus.json`): rebuilt by their scripts, never by hand.
- **`vnm-` identifiers stay** (schema ids, seeds, temp dirs, storage keys): they sit inside
  sealed-set hashes, the bundle and the pinned ranker hash (ADR 0009).
- **Migrations are append-only.** Add the next numbered file; never rename, edit or squash an
  applied one (wrangler tracks them by name; ADR 0001). `npm run db:rebuild-check` must pass.
- **Deploy guard.** `npm run deploy` refuses unless: the tree is clean (new run records aside),
  `HEAD` is `origin/main`'s tip, `HEAD`'s CI push run is green, wrangler vars hold only
  `DENSE_BACKEND`, the production bundle matches D1, `corpus check` and `year check` pass, and a
  source-derived input change has a committed `year check --full` record. Never run
  `npx wrangler deploy` (it ships the fixture bundle) or `wrangler secret put INGEST_SECRET`.
- **D1 writes run on the Mac, through the runbook**, in order: merge, preflight, `d1:bookmark`,
  `npm run remote -- ingest --d1-only`, `verify --pre-deploy`, deploy, smoke, standby
  ([docs/data.md](docs/data.md), "Re-ingesting"). Ask the owner before any remote write.
- **Run records** go to `ops/runs/` from every script that touches a remote; commit them with the
  change they belong to. Use `scripts/run-record.mjs` (`startRun`) in any new remote script, and
  give it no default URL.
- **No spending.** Stay inside the Workers Paid allowances (ADR 0004): at most one forced
  re-ingest or corpus embed per UTC day, and keep live requests at least 4 s apart.
- **Docs are tested.** `test/docs-facts.node.test.js` checks README.md, EVAL.md and `docs/*.md`:
  `<!-- year:live -->` and `<!-- year:pinned -->` sentences state the right year and NG counts,
  `<!-- pointer -->` sentences hold no number, and README commands exist. Other tests read named
  headings (`docs/data.md` "## Re-ingesting", `docs/cost.md`, ADR 0003's "No-look routes" and
  "Shipped-ranker pin", `docs/year-refresh/README.md` sections); grep `test/` before renaming one.
- **Years in code** live only in `scripts/lib.mjs`, `public/year.js` and the header in
  `public/index.html`; `test/year-scan.node.test.js` fails on any other.
- **Exchange-mode rules are data.** Change `data/ng-restrictions-<year>.json` through its builder,
  the overlay and the register, then `npm run test:oracle`
  ([docs/exchange-mode.md](docs/exchange-mode.md)).
- **Page code builds DOM nodes**; lint bans `innerHTML` and other HTML sinks in `public/`.

## Writing

- Commits: Conventional Commits (`type(scope): summary`).
- Comments and docs: present tense, what the code does and why. Record a new decision as the
  next ADR in `docs/decisions/` and add it to the index in `docs/README.md`.
- When the site is down: [docs/incidents.md](docs/incidents.md).
