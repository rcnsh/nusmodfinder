# 3C typo diagnostic (dev only)

Noise-model variants of clean dev queries, for 3C (plan `docs/plans/phase3.md` "3C Typos and
prefixes", A-N8). The set is dev-only. It is reported and never gated: `eval:report` on it prints
the tables and no verdict.

It lives in its own set directory, so the locked dev files (`eval/dev/`) never change:

    npm run eval -- --set dev --set-dir eval/diag/typo --variant <name> [--ref <ref>]
    npm run eval:report -- --set dev --set-dir eval/diag/typo --run <name> [--baseline <name>]

Its query embeddings go in `eval/diag/typo/embeddings.json`, made the same way as dev's:

    npm run eval:embed -- --set dev --set-dir eval/diag/typo
    npm run eval:embed -- --set dev --set-dir eval/diag/typo --corrected-from-ref <ref>   # 3C-2 only

## What is in it

`queries.json` holds one variant (`dt-001`…) of each dev query that is a source:

- its shape is topical, abbreviation, level, language, SEA or mapping;
- it is at most 60 characters, and not a typo, code, no-answer or constraint query;
- it has at least one grade-≥1 judgment in `qrels-dev-v5`;
- it has a letter-only word of 4 or more letters.

Each variant keeps its source's id (`source`) and filters.

## Noise model

Phase 2b's model, the one that made the dev typo queries (`eval/v2/build-queries.mjs`), with its own
recorded seed, **`vnm-3c-diag-typo-2026-11-07`**. The random stream is sha256(`<seed>:<n>`) read as
a fraction. For each source:

1. 1 or 2 words, with even odds, are taken from its letter-only words of 4+ letters, in a seeded
   shuffle.
2. Each of those words is edited once, at an interior position (never the first or last letter),
   by one of four edits with equal odds:
   - a substitution by a QWERTY neighbour (same row, or the row above or below);
   - a transposition with the next letter;
   - a deletion;
   - a doubling.
3. A variant equal to its source, or to any dev text, is drawn again.

## Qrels

`qrels.json` gives each variant its **source dev query's judgments**, verbatim from `qrels-dev-v5`.
A typo does not change what the student is looking for, so the source's judgments are the
variant's. `derivedFrom` names the dev qrels version; the corpus ids are copied from it.

## Custody

`MANIFEST.json` records the sha256 of `queries.json` and `qrels.json`. Every read of either goes
through it (`eval/lib/sets.mjs`), so an edited file is refused. Rebuild all three with
`node eval/diag/build-typo.mjs`; `--check` confirms the committed files are what it builds.
