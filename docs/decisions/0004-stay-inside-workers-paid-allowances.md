# 0004: Stay inside the Workers Paid allowances; no overage

Status: accepted.

## Context
The Cloudflare account is on Workers Paid ($5 a month). Its allowances are per account, shared
with the owner's other projects. On Paid, going over an allowance is **billed**, not refused, and
nothing in Cloudflare stops Workers AI or D1 spending automatically. Monthly allowances reset on
the subscription renewal day, not at 00:00 UTC.

| | included | above it |
|---|---|---|
| D1 rows read | 25 billion / month | $0.001 / million |
| D1 rows written | 50 million / month | $1.00 / million |
| Vectorize queried dims | 50 million / month | $0.01 / million |
| Vectorize stored dims | 10 million | $0.05 / 100 million |
| Workers AI | 10,000 neurons / day | $0.011 / 1,000 neurons |
| Worker CPU | 30 million CPU-ms / month; 30 s per request by default | billed per million CPU-ms |
| D1 Time Travel | 30 days | — |

## Decision
- **No spending.** The project never runs up an overage. Every allowance above is a hard limit
  for design and operations, even though Cloudflare would bill rather than refuse.
- **Headroom before a remote D1 write.** Estimate it, check the month's account-wide usage, and
  proceed only if `estimate × 1.5` fits in the month's remaining included writes. Log every
  remote operation (run records, ADR 0011).
- **Measure on a small batch** before any forced or full re-ingest, and keep live checks light
  (at least 4 s between requests).
- **At most one forced re-ingest or corpus embed per UTC day.** A forced re-ingest spends about
  2,400 of the account's 10,000 daily neurons; searches need the rest.
- **No corpus embed or forced re-ingest in a week the site is announced**, so visitors' searches
  have the day's neurons.
- **A Cloudflare budget alert** at the lowest amount emails the day after a billed day. It caps
  nothing; the rules above are what keep the project inside the allowances.

## Consequences
- The binding limits are Workers CPU and the shared daily neurons (docs/cost.md has the
  arithmetic); D1 reads and Vectorize are far from theirs since dense search runs in the Worker
  (ADR 0006).
- Ingest's `--write-budget` (40,000 rows, ADR 0002) is a runaway guard well inside the monthly
  write allowance; a cold load passes a larger budget explicitly.
- The per-IP rate limits and the cross-site refusal (ADR 0012) protect the neurons from scripts
  and other sites; they don't protect against traffic spread over many addresses.
