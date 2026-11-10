# Phase 4 persona red team (exit criterion, plan §7)

Eight personas, one per semester × study level the plan names (ug2, ug3, ug4 and grad, each in
Sem 1 and Sem 2), with home faculties where the rules are densest: Architecture, Business,
Arts and Social Sciences (level 4000), Music (`redteam/personas.json`). Run on 2026-11-10
against the live Worker, version `efd3dc25` (tag `9d91605`).

## Method
- **Blind to the system's reading.** Each persona was a fresh subagent that read only:
  - the sources (the NG list, the restrictions PDF, the self-funded list, the compulsory LLB
    list, YST's non-music-majors pages);
  - Jacob's answers verbatim (`redteam/answers.md`), never the register or the plan;
  - NUSMods facts per code (title, department, faculty, semesters).

  Brief: `redteam/brief.md`.
- **10 fresh searches each** through `redteam/search.mjs`, at most one call per 4 s across all
  personas. The helper printed codes and NUSMods facts only, never the planner's
  `exchange.status` or reasons, so no persona saw the system's call. 80 searches, all 200
  (`redteam/searches-*.jsonl`: query, and every shown code with its live status).
- **The lookup sample** (`redteam/draw.mjs`, seed 20261110, drawn before any run;
  `redteam/sample.json`), 117 codes:
  - every Q1 code (24) and Q5 code (39);
  - the 6 AR pair codes;
  - 20 random NG codes;
  - for Q7: 20 random non-NG courses, plus 5 Business and 5 CE/ISE ones.

  Every persona judged every sample code for its own (semester, study).
- **The mechanical diff** (`redteam/diff.mjs` → `redteam/diff.json`) compares each persona's
  `open`/`note`/`closed` call with the independent oracle (`test/sc1/oracle.node.mjs`) over
  the production-normalised modules. It also checks every live card against the oracle.

The first launch was lost when the machine restarted mid-run and cleared `/tmp`, kit and logs
included. An unknown number of its searches (at most 80) reached production. The second launch
used a fresh kit outside `/tmp` and the same brief.

## Results
| check | count | disagreements |
|---|---|---|
| persona calls (8 × shown ∪ sample) | 1,975 | 16 |
| live cards (80 searches × 20) | 1,600 | 0: every card's status equals the oracle's |
| shown courses (results and variants) the oracle closes | 0 | — |
| shown courses a persona called `closed` (a leak) | 0 | — |

The 16 disagreements:
- **R1: PC5202, PC5206, PC5211 for a graduate in Sem 2 (p8): persona `open`, system `closed`.**
  - The persona followed Jacob's Q1c answer ("PC5202/5206/5211 open to graduate students
    only") and flagged the conflict itself.
  - The system closes them by rule A, because all three are on the self-funded graduate list.
    That list was found after Q1 was answered, and register C5 records the closure as a lead
    call.
  - Two other personas (p1, p7) also noted the conflict, but in their contexts the courses are closed
    either way (Sem 1, or an undergraduate).
  - This is over-hiding against a Jacob answer. It stays a finding until he rules.
- **R2: "All courses cannot be audited"** (Southeast Asian, South Asian and Malay Studies):
  13 calls, p3 (11) and p5 (2), say `open` where the system says `note`.
  - The other six personas called it a note, as the system does, and p3's and p5's reports
    name it as ambiguous.
  - The course is shown either way; only the note differs.
  - Jacob has not ruled on it, so it stays a finding until he does.

No persona found an over-hidden course outside R1. One persona (p6) expected AR2225 and GE2231
in its searches. Both are allowed for it (`note` and `open`), so their absence is ranking, which
SC1's path tests (a filter that equals the oracle's open ∪ note set) rule out as hiding.

## Process notes
- p6 issued searches 4–10 as one batch. The helper's lock still ran them one at a time, 4 s apart.
- All personas reported that they couldn't see the planner's notes. That was intended; the live
  card check above covers it mechanically.
