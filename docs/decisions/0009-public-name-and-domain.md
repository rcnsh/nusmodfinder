# 0009: Public name, domain and icon

Status: accepted.

## Decision
- The site is **NUS Mod Finder**, at `https://nusmodfinder.rcn.sh`, and the repo is
  `rcnsh/nusmodfinder`. The page title and header say "NUS Mod Finder (unofficial)", and the
  footer says it is not run by NUS or NUSMods.
- The icon is a plum (`#6A2E56`) rounded tile with a white magnifier (`public/favicon.svg`). It
  uses none of NUS's crest, colours or lion.
- The Worker is `nusmodfinder`. Its workers.dev URL is off (`workers_dev: false`): the custom
  domain, applied by `wrangler triggers deploy`, is the only address. The Worker's version history
  starts at its creation under this name, so no older version is a rollback target.
- Internal identifiers keep the `vnm-` prefix (schema ids, seeds, temp dirs, `localStorage` keys,
  test Worker configs): they are inside sealed-set hashes, the vectors bundle and the pinned
  ranker hash, so renaming them would break the eval record for no visible gain.

## Why
- `nusmods` is NUSMods' name, and `nusearch` collides with NUS Libraries' NUSearch+, which would
  read as an official NUS service. "Mod" is ordinary NUS slang and "NUS" names the university
  whose courses these are, with "unofficial" beside it everywhere the name appears.
- The search works for any NUS student; exchange mode is one feature, so the name doesn't narrow
  it.

## Consequences
- The live checks, smoke and uptime check target the custom domain by default.
- `test/web/source.node.test.js` and `test/ui/branding.spec.js` assert the title and the
  footer's "not run by NUS or NUSMods" line.
