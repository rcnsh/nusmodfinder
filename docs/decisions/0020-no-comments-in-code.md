# 0020: The code carries no comments; decisions live in ADRs and workarounds in issues

Status: accepted. The tooling is `scripts/comments.mjs` and the `/delete-comment` skill
(`.claude/skills/delete-comment/`).

## Context
The JavaScript held about 11,800 comments over 72,000 lines. Sorted one by one, three quarters
restated the code they sat on: its names, its types, or the obvious control flow. A few narrated
history the code no longer had. A handful excused a workaround that should have been fixed, and
those excuses spread, because the next change copied both the workaround and the sentence that
made it look deliberate. The rest recorded real decisions, such as a SQLite or Workers limit, an
invariant, or why the obvious version is wrong. But a comment is read only by whoever opens that
file, it isn't checked, and nothing ties it to the ADR that owns the decision, so many of those
had drifted from the ADRs or duplicated them.

## Decision
- **No comments in `*.js`, `*.mjs` or `*.cjs`.** The ESLint rule `local/no-comments`
  (`scripts/eslint-no-comments.mjs`, over `scripts/comment-core.mjs` `allowed()`) fails any
  comment except:
  - tool directives: `@ts-check`, `@ts-nocheck`, `@ts-expect-error` and `@ts-ignore`; `eslint-*`
    directives, with or without a `-- reason`; `global`/`globals`; and `/// <reference … />`;
  - JSDoc that holds only types: `@type`, `@param {T} name`, `@returns`, `@typedef`, `@template`,
    `@import`, `@property`, `@callback`, `@satisfies` and the like, with no prose. tsc reads
    these under `checkJs`, so they are code, not comments.
- **What a comment said goes somewhere checked or owned.** A decision goes into the ADR that
  owns it, as a bullet in its `## In the code` section, or into a new ADR. A workaround becomes
  an issue that names the fix. A tautology or stale note is deleted. Code that needed a comment
  to be understood gets a better name first: a well-named variable or function carries the why.
- **Empty `catch` blocks are allowed** (`no-empty` with `allowEmptyCatch`). An empty catch says
  the call is best effort and its failure is ignored, which is what the comments in them used to
  say.
- **Generators write no comments.** `scripts/gen-fts-separators.mjs`, `scripts/vectors-manifest.mjs`
  `writeShim()` and `scripts/year.mjs`'s stubs emit code only. A stub is marked by
  `export const stub = true`, and new oracle readings go in the year's register.
- **A ratchet for what remains.** Comments a change can't remove yet are carried in ESLint's bulk
  suppressions file, `eslint-suppressions.json`, as a count per file. A file whose count goes up
  fails lint. A file whose count goes down fails until `npm run lint -- --prune-suppressions`
  shrinks the entry, so the file only ever shrinks. Only a new lint rule is baselined with
  `--suppress-rule`. This change removed every comment, so the committed file starts empty
  (`{}`).
- **Not covered:** comments in HTML, CSS, SQL, YAML and JSONC, which ESLint doesn't parse. Applied
  migrations keep theirs because migrations are append-only (ADR 0001).

## Consequences
- About 8,700 lines left the code. The 1,000 comments that recorded a decision were merged into
  ADRs 0001–0019 (about 400 were already written there or in `docs/`) and into the new ADRs 0021
  (safe writes within the platform's limits) and 0022 (isolated tests).
- An ADR now changes in the same PR as the code whose decision it records.
- `npm run comments -- list|apply|count` finds, deletes and counts comments with the same
  `allowed()` test as the rule. `apply` keeps a JSDoc block's type tags and drops its prose.
- The ranking lock's `inputsHash` covers ranker files whose comments were removed. That edit
  is ranking-neutral, so CI's eval gate took the slow path once.
