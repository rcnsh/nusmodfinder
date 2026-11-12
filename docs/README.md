# docs

How NUS Mod Finder works and how to maintain it. For what the site is, start at the
[README](../README.md); for how ranking quality is measured and how a ranking change is checked,
[EVAL.md](../EVAL.md). Coding agents start at [CLAUDE.md](../CLAUDE.md).

| Path | What it holds |
|---|---|
| [architecture.md](architecture.md) | The pieces, how a search is answered, the vectors bundle, data aliases, the standby, failure behaviour, logging, known limits |
| [api.md](api.md) | Every route, its parameters and responses, refusals, rate limits and caching |
| [exchange-mode.md](exchange-mode.md) | Exchange-student availability: the NG list, the restrictions, the source manifest, the notes read per request, source changes |
| [page.md](page.md) | The frontend: what it shows, the shortlist and exports, its modules, running it locally, the UI tests |
| [data.md](data.md) | NUSMods data, the corpus manifest, the catalogue files, the re-ingest runbook and what ingest does |
| [operations.md](operations.md) | Setup, CI, deploying, rollback, D1 bookmarks, smoke, live checks, remote sessions, run records, the usage report, drift issues, the uptime check |
| [incidents.md](incidents.md) | What an uptime alert means, what to do when the site is down, the checks before announcing it |
| [cost.md](cost.md) | Cost against the Workers Paid allowances, the binding limits, a spike, why D1 reads per search are low |
| [year-refresh/](year-refresh/README.md) | The yearly switch and mid-year source revisions: runbook, briefs, registers, transcriptions |
| [decisions/](decisions/) | Architecture decision records, below |

## Decision records

| ADR | Decision |
|---|---|
| [0001](decisions/0001-schema-migrations.md) | The schema is `migrations/`, tracked by wrangler |
| [0002](decisions/0002-exact-filtered-lexical-search.md) | Filtered keyword search stays exact, paid for with filter indexes |
| [0003](decisions/0003-eval-holdout-and-gate.md) | Eval query sets, holdout custody and the pre-committed gate (with the set hashes and the shipped-ranker pin) |
| [0004](decisions/0004-stay-inside-workers-paid-allowances.md) | Stay inside the Workers Paid allowances; no overage |
| [0005](decisions/0005-d1-primary-apac.md) | The D1 primary is in APAC, with read replication on |
| [0006](decisions/0006-search-pipeline.md) | The search pipeline: exact vectors in the Worker, query understanding, duplicate groups |
| [0007](decisions/0007-exchange-mode-eligibility.md) | Exchange-mode eligibility is computed at ingest from NUS's rules as data |
| [0008](decisions/0008-static-page.md) | The page is static, framework-free and accessible to WCAG AA |
| [0009](decisions/0009-public-name-and-domain.md) | Public name, domain and icon |
| [0010](decisions/0010-shortlist-in-the-url.md) | The shortlist lives in the URL and exports from the browser |
| [0011](decisions/0011-deploy-from-green-ci.md) | Deploys follow green CI and leave a trace; remote work goes through recording scripts |
| [0012](decisions/0012-public-site-safeguards.md) | Public-site safeguards: logging, rate limits, outage alerts, docs held to the code |
| [0013](decisions/0013-ranking-lock.md) | CI's eval gate is a committed ranking lock |
| [0014](decisions/0014-corpus-and-source-custody.md) | One production corpus in a manifest; NUS's documents archived encrypted |
| [0015](decisions/0015-yearly-refresh.md) | The academic year switches in July, through a rehearsed procedure |
| [0016](decisions/0016-one-relevance-judge.md) | One relevance judge, checked across model families |

A new decision gets the next number and a kebab-case title naming the decision. Change a record
when the decision changes, and keep its reasons.
