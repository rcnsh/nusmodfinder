# Eval harness (Phase 2)

Plan: [`docs/plans/phase2.md`](../docs/plans/phase2.md) (later sections supersede earlier ones).
This directory holds the tooling. The query sets come from workstream 2b and the judgments from 2d.

## What a run is

A **variant** is (ranker ref × embedding version × query set). A run executes the **actual
Worker** (default export of `src/index.js`) inside workerd under `vitest.eval.config.mjs`, which
is not part of `npm test`:

- local D1 built from the ranker's own `migrations/`, seeded with the full pinned corpus
  (release `data-2026-2027-20260904`, sha-checked) **through the Worker's own `/admin/ingest`**;
- the fake Vectorize from `test/fakes.js`, filled by that ingest with **real** corpus embeddings;
- a fake AI (`runner/lookup-ai.js`) that returns **real** precomputed `bge-small-en-v1.5` vectors
  by `sha256(model + "\n" + text)` and throws loudly, naming `npm run eval:embed`, for any text
  without one;
- one `/search` per query with production defaults (no `topK`, so 20; depth as the Worker
  computes it) plus the query's `filters` as API params. One test per query, named by its
  opaque id.

Embeddings enter workerd through `provide`/`inject` as one base64 Float32 string. Results leave
it through `runner/reporter.mjs`, a Vitest reporter reading `task.meta`, which writes the run
file (ciphertext only for encrypted sets). No Cloudflare call is made during a run.

`--ref <git ref>` builds a workspace in `.eval-work/` from that ref's `src/`, `migrations/`,
`scripts/lib.mjs` and `data/` (the embedding text is part of the ranker) with the HEAD runner
overlaid. Without `--ref` the working tree is the ranker. `ranker.sha` is what `git rev-parse`
says; `ranker.treeHash` is a content hash of the ranker files actually extracted into the
workspace (`treeHash()` in `lib/workspace.mjs`: sha256 over sorted `path\0kind\0sha256` lines
of `src/`, `migrations/`, `scripts/lib.mjs`, `data/`). The self-test checks that a
`--ref eval-v0` run's `treeHash` equals the hash of `git archive eval-v0` of those paths, and
differs from the working tree's whenever git says the trees differ.

## Commands

```bash
npm run eval -- --variant v0 --ref eval-v0                # dev set, baseline ranker
npm run eval -- --variant head --baseline v0              # working tree; prints table, CIs, gate
npm run eval -- --variant typo-fix --baseline v0 --target-shapes typo
npm run eval -- --variant cutoff --baseline v0 --change-kind cutoff
npm run eval -- --variant head-unf --unfiltered           # secondary: filters dropped
npm run eval:report -- --run head --baseline v0           # recompute from run files + qrels only
npm run eval:pool -- --runs v0,head [--unjudged]          # blind pool for judges
npm run eval:embed                                        # embed dev query texts missing from the cache
npm run eval -- --variant rewrite --embed-missing         # embed missing texts (cap 500), then run; local only
npm run test:eval                                         # self-test on the fixture set (CI)
npm run eval:verify                                       # ciphertext sha256 vs manifests (CI, no key)
```

`--set dev|holdout|test` (default `dev`; `--holdout` = `--set holdout`). `--set-dir <dir>` points
a set at another directory (tests). It never moves a custody set's look ledger: `holdout` and
`test` always count looks in `eval/holdout-ledger.md`, so pointing `--set-dir` at the real
ciphertexts, or a copy of them, cannot start a fresh count. `--embedding <version>` picks a corpus embedding version
(default from `embeddings.json`). Run files go to `eval/runs/<variant>.json` (dev).

**Reproduce the fixture end to end (one command, no Cloudflare, no `.data/` needed):**
`npm run test:eval`.

## Sets and files

| set | where | format | output |
|---|---|---|---|
| `dev` | `eval/dev/{queries,qrels,embeddings}.json`, runs `eval/runs/` | plaintext | full table, CIs, per-shape, gate |
| `holdout` | `eval/holdout/*.enc` (queries, qrels, embeddings, `run-<variant>.json.enc`) | AES-256-GCM | verdict + overall Δ with CI; ledger; ≤ 12 looks |
| `test` (sealed, SC5) | `eval/sealed/*.enc` | AES-256-GCM | SC5 verdict + Δ; ledger; 1 look |
| `fixture` | `eval/fixtures/` (own 23-module corpus) | plaintext | synthetic; harness self-test only |
| `selftest` | `--set-dir` (the self-test's throwaway copy of the fixture) | AES-256-GCM | holdout rules; ledger at `<set-dir>/ledger.md` |

`queries.json`:
```json
{ "schema": "vnm-eval-queries/1", "set": "dev", "version": "dev-v1", "queries": [
  { "id": "d-001", "text": "…", "filters": { "ng": true, "sem": 1 },
    "constraints": { "level": [1, 2] }, "shapes": ["topical"], "persona": "cs-us",
    "narrative": "relevant = …; partially relevant = …; not relevant = …",
    "noAnswerByRule": false, "source": "d-000" } ] }
```
- `id`: opaque (`[A-Za-z0-9_-]`); never put text in it. `filters` keys: `sem`, `ng`, `level`,
  `credits`, `faculty` (the UI state; sent to `/search`). `constraints` (optional, defaults to
  `filters`) are the hard constraints used for violations@10.
- `shapes` tags: `topical`, `home-course`, `alternatives`, `language`, `sea-content`,
  `level-equivalence`, `jargon`, `typo`, `code-exact`, `code-space`, `code-partial`,
  `ge-pillar`, `level-intent`, `constraint` (feature-gap block), `no-answer`.
- `noAnswerByRule: true` for non-existent codes: never answerable, scored on correct-empty.
- `source`: the id a derived typo/code variant came from (splits follow provenance).

`qrels.json`:
```json
{ "schema": "vnm-eval-qrels/1", "set": "dev", "version": "qrels-dev-v1",
  "corpus": { "moduleInfoSha256": "…", "ngSha256": "…" }, "embedding": "emb-bge-small-v0",
  "groups": [["TR3202I", "TR3202S", "TR3202T"]],
  "queries": { "d-001": { "judgments": { "CS1010": 2, "CS2030": { "grade": 1, "judges": {} } },
                          "groups": [] } } }
```
Grades 0/1/2; a judgment is a number or an object with `grade` (judge ids and rationales may
ride along). `groups` (global and per query) mark duplicate groups. `corpus` is required:
`eval:report` and `npm run eval` refuse (`CorpusMismatchError`) when a run's corpus
`moduleInfoSha256` differs from the qrels', or its `ngSha256` does when the qrels record one.
`npm run eval` checks the baseline before any retrieval (on an encrypted set, before the look
is reserved) and the candidate after. Comparison output names the qrels version (`paired over
n primary answerable queries · qrels <version>`; holdout `holdout verdict: PASS · qrels
<version>`).

Run file (`vnm-eval-run/1`): `variant`, `set`, `ranker` (ref, sha, dirty, `treeHash`, runner sha), `corpus`
(release, moduleInfo sha256, NG sha256, module count, sha256 of all embedding texts),
`embedding` (corpus version, model, text ref), `queries` (version, sha256, count), `config`,
`results` (`id → { status, codes, error? }`, top 20 as returned), `docs` (metadata of every
returned code, for violations). No query text.

## Metrics (`lib/metrics.mjs`, `lib/stats.mjs`)

- nDCG@10, gain 2^g − 1, discount log2(rank + 1). Duplicate-group aware: only the first member
  of a group to appear earns gain; the ideal ranking has one document per group (best grade).
- P@5: group-first documents with grade ≥ 1 in the top 5, divided by 5. MRR@10 likewise.
- Unjudged = grade 0; judged@10 coverage reported; gates need 100%.
- Answerable iff some judged document has grade ≥ 1 and not `noAnswerByRule`. Primary metrics
  are macro means over answerable queries **without** a feature-gap shape (`constraint`); those
  are reported as their own block. No-answer queries: correct-empty rate (nothing returned) and
  false positives.
- **Errors.** A non-200 response is an error, never an answer: it is never correct-empty, and
  nothing in it is relevant (nDCG, P@5 and MRR are 0). `summarise().errors` counts them (the
  `non-200 responses` row), and `npm run eval` prints `errors: n of N queries returned a non-200
  response` after every dev run.
- violations@10: top-10 documents breaking `constraints` (semester; NG means NG *in that
  semester*; level; credits; faculty).
- Paired over the primary set: BCa bootstrap 95% CI (10,000 resamples, seed 20261104; checked
  against scipy in `test/eval/stats.node.test.js`), two-sided sign-flip randomisation p (exact up
  to 16 non-zero deltas), persona-clustered percentile bootstrap. Per-shape breakdown (dev only)
  with a one-sided 95% upper bound (two-sided 90% BCa).

## Gate (`lib/gate.mjs`)

Per change, vs the shipped ranker:
- **every gate** (dev, holdout, cutoff, SC5): **no new errors**: fails if the candidate has more
  errored (non-200) queries than the baseline.
- **dev** (screen): ΔnDCG@10 BCa 95% lower bound > 0, or, if the change declares
  `--target-shapes`, every target's ΔnDCG@10 > 0 and overall Δ ≥ 0. Tripwire on target shapes
  only: fails if a target's one-sided 95% upper bound on ΔnDCG@10 is below 0.
- **holdout**: ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates), no exact-code regression (a
  `code-exact` query whose baseline rank-1 is relevant keeps that rank-1), judged@10 100%.
- **cutoff changes** (`--change-kind cutoff`): the no-answer trade-off replaces the Δ rules on
  both sets: correct-empty gain ≥ 0.25 and answerable ΔnDCG@10 ≥ −0.01.
- **SC5** (test set): BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, judged 100%.

Small samples (every gate, every set):
- **Insufficient queries.** A gate whose decisive comparison (the paired primary answerable
  queries) has fewer than 10 queries fails with `insufficient queries: n primary answerable,
  need 10`, however large the gain.
- **Degenerate intervals.** With zero variance (one query, or every delta equal up to float
  noise) `bcaInterval` returns the point as both bounds and sets `degenerate: true`. A CI-based
  check (dev's lower bound > 0, SC5's lower bounds > 0, a tripwire's upper bound ≥ 0) never
  passes on a degenerate interval; the check's detail says `degenerate: no variance`.
- **Small shapes.** A target-shape tripwire over fewer than 3 answerable queries has no usable
  interval and falls back to "point estimate ΔnDCG@10 ≥ 0".

## Embeddings

- `scripts/embed.mjs` calls Workers AI REST `@cf/baai/bge-small-en-v1.5` (default pooling,
  batches of 100) with the token from `wrangler auth token` (per run, never stored or printed)
  and the account from `$CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami`. It estimates neurons from
  token counts (1,841 / M tokens) before any call, refuses above the cap (500 for queries,
  2,500 for `--corpus`), and appends every spend to `docs/evidence/neurons.tsv`. Local only;
  CI never calls Cloudflare.
- Corpus: `emb-bge-small-v0` (release asset; sha256s in `embeddings.json`, verified on every
  download/use): 5,920 unique embedding texts of the pinned corpus, text = `embeddingText()` at
  `eval-v0`. A new embedding text needs a new version:
  `npm run eval:embed -- --corpus --ref <ref> --version <new>`, then
  `gh release create <new> .data/emb/<new>/corpus.* --notes "<sha256s>"` and an entry here.
- **Workers AI is not bit-deterministic across batches.** The same text in two REST calls:
  cosine 0.9994–0.9998 (3 texts); fixture texts embedded in a batch of 31 vs the corpus pass's
  batches of 100: min 0.9797, median 0.9957 (23 texts). Production's own vectors were embedded
  in other batches, so the offline replica can differ from live ranking near ties; the fidelity
  check (2c) measures how much.

## Holdout custody

Procedural, honour-system plus encryption at rest (ADR 0003 states this). The custodian:

```bash
node scripts/holdout.mjs keygen                                   # once; key at ~/.config/vnm/holdout.key
node scripts/holdout.mjs encrypt /secure/queries.json --as queries.json   # also qrels.json, embeddings.json
npm run eval:embed -- --set holdout                               # encrypted query cache
npm run eval -- --holdout --variant v0 --ref eval-v0 --store-only # stored, no verdict, no look
npm run eval -- --holdout --variant cand --baseline v0            # verdict + Δ; one ledger row
npm run eval:pool -- --set holdout --runs v0,cand --custodian     # encrypted pool for judges
```

Ciphertexts (`VNMENC2`) bind the set name and the file name as AES-GCM additional data
(`holdout/qrels.json`), so a file renamed into another slot, or copied into another set's
directory (holdout files read as `test` or `selftest`), fails to decrypt. `holdout.mjs encrypt`
and `decrypt` infer the set for `eval/holdout` and `eval/sealed` and need `--set` anywhere else.
That binding is what lets the `selftest` set keep its ledger in its own directory: real holdout
ciphertexts cannot be read through it.

`$VNM_HOLDOUT_KEY_FILE` overrides the key path. The key never enters the repo, CI, logs or
error messages. Plaintext is decrypted in memory; `decrypt` refuses to write inside the repo.
Holdout runs use only the eval reporter, with console output silenced, so no id, text or
per-query error reaches the terminal. Any error in a holdout or test command prints one line,
`eval: holdout run failed (<error class>); details withheld`, and nothing else; the class
(`DecryptionError`, `KeyFileError`, `LookLimitError`, `LedgerTamperError`, `LedgerLockError`,
`CorpusMismatchError`, `QrelsError`, `RunFileError`, see `lib/errors.mjs`) says what went wrong.
Metrics errors carry no judgment content in any set: a bad grade is reported by its value and
position (`query #3, judgment #2 has grade 7`), never its rationale, query id or code. Every verdict appends a row to `eval/holdout-ledger.md`;
a 13th holdout look (2nd test-set look) is refused before any retrieval runs. Every table row
except the header and separator lines counts, however it is spaced; a row whose set cell is not
a known set counts against every set. A look is also refused (`LedgerTamperError`) when the
ledger has fewer rows than its copy at `HEAD` or `origin/main`, or is missing while git has it:
the ledger is append-only, so commit it after every look.

Parallel looks cannot pass the limit. Check-then-append runs under an exclusive lock,
`<ledger>.lock` (created with `O_EXCL`, removed when done). A second eval waits up to 2 minutes
and then fails with `LedgerLockError`. A lock older than 30 minutes is treated as abandoned and
removed, with a message saying so. `eval:report` checks, computes and appends inside the lock.
`npm run eval` reserves its look before retrieval starts: it appends a `reserved <token>` row,
which counts as a look. It then replaces that row with the verdict, or with `aborted` (the run
failed) or `unjudged` (judged@10 < 100%); either way the look stays counted. CI never has the
key: `npm run eval:verify` checks only that each ciphertext matches its `MANIFEST.json` sha256.

## Fixture set and self-test

`eval/fixtures/`: 23 modules hand-picked from `test/fixtures/corpus.json`, 11 synthetic queries
covering every scoring path (duplicate groups, filters, an NG-semester violation, no-answer, a
non-existent code, a feature-gap query, a > 200-character query that returns 400), complete
synthetic qrels, and real embeddings for all 31 texts (embedded once, 6.7 neurons).
`expected-v0.json` is the golden output at `eval-v0`; regenerate it only on a deliberate harness
or embedding change. `npm run test:eval` runs everything above through the CLI with a throwaway
key; it is in CI.
