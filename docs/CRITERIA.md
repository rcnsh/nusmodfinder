# Success criteria and finding IDs

Copied from the mission brief so the repo is self-contained.

## Success criteria

- **SC1** Exchange mode never shows a course the user can't take in the chosen semester at the
  chosen study level. Verified by an automated test over the whole NG list.
- **SC2** Every result card can be opened: description, prereqs and preclusions, exam date,
  workload in hours per week, exchange availability per semester, and "Open in NUSMods".
- **SC3** A shortlist with primary and backup picks and a running units total lives in the URL
  with no account, and exports to CSV and PDF with syllabus text and estimated hours.
- **SC4** Search handles real student queries: codes with spaces or partial codes (`cs 1010s`,
  `CS32`), GE pillars (`GEA`), typos (`machne learning`), level intent (`for beginners`), and
  no-exam / S/U / workload intents. Gibberish returns "no matches".
- **SC5** A rebuilt eval shows the shipped ranker beating the current one on the held-out set on
  nDCG@10 and P@5, with a paired bootstrap CI excluding zero.
- **SC6** No known recall bug from filters; re-ingest catches every field change and deletes
  dropped modules; a forced full re-ingest stays under 10% of the daily D1 read limit, measured.
- **SC7** Search p50 server time under 250 ms on a cache miss, measured with `Server-Timing` from
  the deployed Worker. Graceful fallback to keyword-only if Workers AI or Vectorize fails.
- **SC8** axe-core zero violations. Keyboard-only and screen-reader flows work. Mobile at 390px
  shows the first result above the fold.
- **SC9** Everything in git with CI (tests, lint, eval gate), migrations rebuild the database
  from scratch, and the deployed version is traceable to a commit.
- **SC10** README, EVAL.md and the vault page describe the system as it is.

## Finding IDs

Every ID below must have a row in `FINDINGS.md` with a status (`scripts/check-findings.mjs`).

<!-- ids:start -->
B1 B2 B3 B4 B5 B6 B7 B8 B9
S1 S2 S3 S4 S5 S6 S7 S8
P1 P2 P3
F1 F2 F3 F4 F5 F6 F7 F8 F9 F10
V1
O1 O2 O3 O4
<!-- ids:end -->

V1 is the visual-design critique; O1–O4 are the ops findings (O1 database not rebuildable from
README, O2 no tests/CI/lint/types, O3 `NG_LIST_UPDATED` kept in two places, O4 no scheduled
refresh).
