# 0009. Public name, domain and icon

Status: accepted (Jacob, 2026-11-11)

## Decision

- The site is **NUS Mod Finder**, at `https://nusmodfinder.rcn.sh`, and the repo is
  `rcnsh/nusmodfinder`. The page title and header say "NUS Mod Finder (unofficial)".
- The icon is a plum (`#6A2E56`) rounded tile with a white magnifier (`public/favicon.svg`; option B
  in the ephemera set `vector-nusmods-nusmodfinder-icon-rlvvsy`). It uses none of NUS's crest,
  colours or lion.
- The Worker is `nusmodfinder` (Jacob, 2026-11-11; it was created under the project's first name and
  moved, so its version history starts at the move). Its workers.dev URL is off
  (`workers_dev: false`): the custom domain is the only address.
- Internal identifiers keep the `vnm-` prefix (schema ids, seeds, temp dirs), and the test Worker
  configs keep theirs: they are inside sealed-set hashes, the vectors bundle and the pinned
  ranker hash, so renaming them would break the eval record for no visible gain.

## Why

- `nusmods` is NUSMods' name, and `nusearch` collides with NUS Libraries' NUSearch+, which would
  read as an official NUS service. "Mod" is ordinary NUS slang and "NUS" names the university
  the courses belong to, with "unofficial" beside it everywhere the name appears.
- The search works for any NUS student; exchange mode is one feature. The name does not narrow it.

## Consequences

- `scripts/p5-live-plan.mjs` checks the custom domain by default.
- The 5G provenance check (test/web/source.node.test.js, test/ui/p3.spec.js) now asserts the new
  title. The footer's "not run by NUS or NUSMods" line is unchanged.
