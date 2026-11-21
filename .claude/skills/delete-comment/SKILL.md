---
name: delete-comment
description: Classify every comment in a path, move decisions into ADRs, file issues for workarounds, delete the rest, and shrink the lint ratchet.
disable-model-invocation: true
---

# /delete-comment [paths…]

Clears the comments in the given paths (the whole repo if none) under ADR 0020. Read ADR 0020
and `docs/README.md` first. Every comment ends up in exactly one place: an ADR, an issue, or
nowhere. Lint fails on any new comment, so the comments this finds are the ones the ratchet
(`eslint-suppressions.json`) carries, or ones in files a newly widened rule covers.

## 1. List

```sh
npm run comments -- count [paths…]          # how many, and the lines they cost
npm run comments -- list [paths…] > /tmp/comments.jsonl
```

Each line has an `id` (`file:line:col`; a run of `//` lines is one comment), its `text`, the
`code` after it, and for JSDoc the `typesKept`. The tool keeps those type tags whatever you decide;
judge only the prose. When there are more than about 500 comments, split them by directory and
give each batch to a subagent along with this step and step 2. Subagents classify only; the
main thread applies.

## 2. Classify: one verdict per id

Read the file around each comment, not just the snippet.

- **tautology**: restates the names, types, or obvious flow. Banners and docblock summaries
  usually land here.
- **stale**: names code, files or history the code no longer has (`git grep` what it cites).
- **excuse**: covers for a workaround, gap or hack someone should fix. A sound trade-off with
  its reason is a decision.
- **decision**: a non-obvious *why* that the code can't show: an outside constraint (SQLite,
  D1, Workers, NUS's data, a browser), an invariant, why the obvious version is wrong, a pin.
  Grep `docs/` first; many are already written down.
- **keep**: deleting it breaks something mechanically (a test reads its text, a generator writes
  it). The note names the dependent. Fix the dependent instead whenever you can: re-anchor the
  test on code, or make the generator emit none. Only a comment the ratchet already carries can
  stay as a keep.

Write the ledger as `[{ "id", "verdict", "text", "note"? }]`, copying `text` from the listing.
It covers every id from step 1, each once. `apply` refuses the whole ledger, writing nothing,
when an id no longer holds that text or a deletion would change the parsed program.

## 3. Home what matters

- **decision**: add a bullet to the owning ADR's `## In the code` section (create the section at
  the end if it's missing; leave the ADR's other sections alone). Write it in present tense,
  name the file and function, give the constraint and what breaks if it's "simplified", and check
  each fact against the code. When no ADR owns the topic, write the next-numbered ADR and add it
  to `docs/README.md`. Merge repeats; drop what the docs already say.
- **excuse**: file one issue per workaround (not per comment) with `gh issue create`. The body
  gives the code's current behaviour, file:line, and the fix.

## 4. Apply and repair

```sh
npm run comments -- apply /tmp/ledger.json
npm run lint -- --prune-suppressions        # the ratchet shrinks with what you removed
npm run lint && npm run typecheck && npm test
```

The usual fallout:
- a block left empty: `catch {}` is allowed; any other empty block gets rewritten so a name
  carries what the comment said;
- `test/year-scan.node.test.js` allow-list entries that cited the comment's text: drop them;
- a test that read comment text: re-anchor it on code.

Run `npm run eval:lock -- --check` after committing, whenever `src/`, `data/`, `migrations/` or
`scripts/lib.mjs` changed (CLAUDE.md, "Rules that bite").

## Done when

`npm run comments -- count [paths…]` shows only the keeps, `eslint-suppressions.json` carries
exactly those (pruned), lint, typecheck and tests are green, and every decision and excuse id is in an
ADR bullet or an issue. Report the counts per verdict, the issues filed, the ADRs changed, and
the lines shed (`git diff --shortstat`).
