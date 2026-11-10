# 0007: Phase 4 exchange-mode plan

Status: accepted (Jacob, 2026-11-10). The plan converged at r3.1 after three critic rounds (eval
and gates; data, paths and deploy; the rules against NUS's sources). `docs/plans/phase4.md` §9
logs every objection and where it landed. No objection was declined.

## Context
SC1: exchange mode must never show a course the student can't take in the chosen semester at
their study level, verified over the whole NG list. Today `ng=1` is a yearly boolean (P1) and
there is no study-level input (P2). NUS states availability in two Registrar PDFs, the NG course
list (per semester) and the course-restrictions list, neither in the NUSMods API, and both
behind a bot wall.

## Decisions
- **Scope:** exchange mode applies the NG list and the restrictions PDF. `closed` courses are
  hidden; courses needing a home major, a partner institution, an audition or approval are shown
  with a note. Courses not on the NG list are hidden (amending the scope decision for rule E,
  Jacob's Q7).
- **Model:** one pure `eligibility(module, {sem, study}, rules)` run at ingest; `study` is
  `ug1`–`ug4` or `grad` and is required with `ng=1`. Its output is a 15-bit **allow** mask
  (`ng_allow`, zero or missing = closed) and per-bit rule ids (`ng_rules`). The Worker runs no
  rule logic. Under `ng=1`, `sem` only selects the bit.
- **Rules as data:** `data/ng-restrictions-<year>.json` with citations and titles, two
  independent transcriptions diffed, a 20% audit, and an interpretations register for every
  ambiguous reading. Jacob ruled the contested ones (plan §8).
- **Verification:** an independent oracle written from the sources and the register, run over
  every module; per-path set-equality tests in their own CI job; a ship-time oracle over the
  production catalogue; a live check; a persona red team diffed mechanically against the oracle.
- **No holdout look** gates Phase 4's correctness changes. They are gated by SC1's tests,
  per-list identity on dev through a test-only trace switch that can't be live in production,
  and an unfiltered guard. ADR 0003 is amended before 4A ships.
- **Storage:** no new Vectorize metadata (10 indexes, 8 used); the standby relies on the D1
  recheck at topK 100, with a recorded recall loss. The bundle keeps its 32-byte stride.
- **Carried from Phase 3:** S6 handled in exchange mode by `study`; 3D stays dropped; phrase
  parsing gets a compliance rule now and ships in Phase 5; S2–S4 stay open.

## Consequences
- One full-rewrite ship with a migration, three bundle rebuilds and a new pinned release.
- Every source refresh repeats the transcription, oracle and SC1 gate.
- The 5 remaining holdout looks each need a pre-registered rule.
