# Phase 3 pre-registration (P-6)

Plan: [`phase3.md`](phase3.md), precondition P-6 (§3, lines 876–887). This commit fixes every
value a later selection could be tuned on, before any 3B–3H code merges and before the first
holdout look. Each value cites the plan line it comes from, or gives the reason it was chosen
here. Every value the plan left open is also listed under "Choices made at P-6" (§10).

Nothing here changes ranker behaviour: no file under `src/` changes. The values bind the
workstreams that implement them. A change to any of them goes through the lead, with the reason
logged, before that workstream's pooling round.

## 1. Files

| file | what it fixes |
|---|---|
| `docs/plans/phase3-prereg.md` | this document: every value, with its citation or reason |
| `eval/prereg/stopwords.json` | the stopword list now, and `stopwords-v2` |
| `eval/prereg/collision-list.json` | the collision list, with a reason per added entry |
| `eval/prereg/collision-review.json` | the C13 rule applied to every other offered prefix: each decision and its reason |
| `eval/prereg/ge-pillars.json` | the GE pillar table and the GE phrases |
| `eval/prereg/intent-phrases.json` | the 3D and 3H phrase lists, matching rules, precedence, negation, year window, union |
| `eval/prereg/cohort-only-prereq.json` | the cohort-only prerequisite pattern list (A3-7) |
| `eval/prereg/cohort-only.mjs` | the one executable reading of that pattern list |
| `eval/prereg/grids.json` | every grid and finite candidate set, the selection rules and the fallbacks |
| `eval/prereg/typo-threshold.mjs`, `typo-threshold.json` | the script that computes T, and its output |
| `eval/prereg/gibberish-split.mjs` | the seeded split of the gibberish set |
| `eval/dev/gibberish.json` | the gibberish set (40 strings) and its split |
| `test/sc4/queries.json` | the SC4 acceptance suite (90 items) |
| `test/sc4/needs-embedding.txt` | the 143 new texts that need a query embedding |
| `test/sc4/embeddings.json` | their query embeddings (156 forms) |
| `eval/prereg/sc4-custody.mjs` | the custodian's holdout overlap check of the suite (`--against dev` self-check) |
| `test/sc4/*.node.test.js`, `test/full/sc4-prereg.node.test.js` | the tests that hold all of the above together |

### Machine-readable lists
The tests read this table (`test/sc4/prereg-lists.node.test.js`) and fail if a count differs
from its file.

| list | file | key | count |
|---|---|---|---|
| stopwords now (`src/fts-query.js`) | `eval/prereg/stopwords.json` | `current` | 27 |
| stopwords-v2 additions | `eval/prereg/stopwords.json` | `v2Additions` | 8 |
| stopwords-v2 | `eval/prereg/stopwords.json` | `v2` | 35 |
| collision list, the plan's seed | `eval/prereg/collision-list.json` | `seed` | 16 |
| collision list, added at P-6 | `eval/prereg/collision-list.json` | `added` | 100 |
| collision list | `eval/prereg/collision-list.json` | `list` | 116 |
| collision review, added | `eval/prereg/collision-review.json` | `added` | 63 |
| collision review, kept off | `eval/prereg/collision-review.json` | `keptOff` | 156 |
| collision review, dictionary hit kept off | `eval/prereg/collision-review.json` | `dictionaryHitKeptOff` | 22 |
| GE pillar prefixes | `eval/prereg/ge-pillars.json` | `prefixes` | 10 |
| GE pillar names | `eval/prereg/ge-pillars.json` | `pillars` | 9 |
| GE generic phrases | `eval/prereg/ge-pillars.json` | `genericPhrases` | 3 |
| no-exam phrases | `eval/prereg/intent-phrases.json` | `constraints.exam.phrases` | 12 |
| S/U phrases | `eval/prereg/intent-phrases.json` | `constraints.su.phrases` | 4 |
| workload phrases | `eval/prereg/intent-phrases.json` | `constraints.hoursBelow.phrases` | 5 |
| no-prerequisite phrases | `eval/prereg/intent-phrases.json` | `constraints.prereq.phrases` | 5 |
| beginner phrases | `eval/prereg/intent-phrases.json` | `level.beginner.phrases` | 9 |
| graduate phrases | `eval/prereg/intent-phrases.json` | `level.graduate.phrases` | 4 |
| level-N phrases | `eval/prereg/intent-phrases.json` | `level.levelN.phrases` | 5 |
| year phrases | `eval/prereg/intent-phrases.json` | `level.year.phrases` | 9 |
| negators | `eval/prereg/intent-phrases.json` | `negators` | 4 |
| cohort-only removal patterns | `eval/prereg/cohort-only-prereq.json` | `remove` | 3 |
| α grid | `eval/prereg/grids.json` | `[3D].alpha` | 4 |
| β grid | `eval/prereg/grids.json` | `[3D].beta` | 3 |
| 3E grid points | `eval/prereg/grids.json` | `[3E].gridOrder` | 8 |
| 3H pooled runs | `eval/prereg/grids.json` | `[3H].pooled` | 4 |
| gibberish strings | `eval/dev/gibberish.json` | `strings` | 40 |
| gibberish derivation half | `eval/dev/gibberish.json` | `split.derivation` | 20 |
| gibberish gate half | `eval/dev/gibberish.json` | `split.gate` | 20 |
| SC4 suite items | `test/sc4/queries.json` | `items` | 90 |

## 2. 3A Vector half setup
- **3A-1** (plan 457–462): one candidate, the bge instruction prefix on the query only. No grid,
  no named retry (plan 911).
- **3A-2 variants** (plan 463–470), `grids.json` `3A-2`, embedding versions `emb-bge-small-v1…v3`:
  - v1 `CODE. Title. Level N (label). Description. Department. Faculty.`
  - v2 `CODE. Title. Level N (label). Description.`
  - v3 `Title. Level N (label). Description. Department. Faculty.`
  - Labels: 1 introductory, 2–3 intermediate, 4 advanced, 5–6 graduate (plan 470). **Level 8
    is "graduate"** (choice C24): the pinned corpus has 6 level-8 modules and the plan names no
    label for them.
  - **Note added 2026-11-06, after the v1 and v2 corpus passes and before any 3A-2 dev score
    was read** (PR #41 review). Each variant keeps the existing `MAX_BLOB_CHARS` = 1,900 cut,
    which applies after the fields are joined. On the pinned corpus it cuts 15 long modules
    mid-word, and they lose "Department. Faculty.":
    - BMA5013, BME5801, BMS5130, BMS5305, BMS5900, EBA5012, GMS5224, IS5007, LL4322, LL5322,
      LL6322, LLD5322, LLJ5322, MLE2102, RE1708.
    - So for 14 of them, v1 and v2 give the same text.
    - Four v3 texts end in a space: BMS5900, GMS5224, IS5007, MLE2102.

    The rule is the shipped one, already covered by a test. It is recorded here, not changed,
    because the v1 and v2 vectors are built on it.
- Selection: the general statistic (§8). Named retry: the second-ranked variant (plan 909–911:
  a change SC4 does not need, with a grid).

## 3. 3B Codes, GE pillars, keyword brittleness

### Parse order (plan 501–510), one order for every query
1. canonical q (trimmed, whitespace collapsed, ASCII letters lower-cased);
2. 3G's vocabulary test reads the pre-correction tokens (it decides only at the end);
3. 3C's correction of df-0 letter-only tokens of ≥ 5 letters;
4. **intent pass A**: every 3H phrase, matched and stripped from the lexical query before any join;
5. the code joins;
6. code resolution;
7. **intent pass B**: the 3D level phrases and the GE phrases, on what steps 4–6 left.

Two placements the plan does not state are fixed here (choices C14, C15):
- `no background` is in both the prerequisite and the beginner lists (plan 655–656). Pass A
  matches and strips it, and it sets the beginner intent as if pass B had read it.
- The GE phrases are read in pass B, after the joins, so `ge` can never take part in a join.
  - **Note added 2026-11-07, before any 3B dev score was read** (PR #44 review, lead decision).
    `ge` is a collision-list prefix, so `ge 2101` inside a longer query does not join. As written,
    pass B then read that `ge` as the GE phrase: `ge 2101 workload` masked every result to the
    pillars and removed GE2101 (Geography, offered) from both halves. That contradicts the plan's
    accepted cost (plan 529–530): a collision-list code in a longer query "is not pinned. It still
    reaches the lexical and dense halves as text." So in pass B, a `ge` token directly followed
    by a token that starts with a digit is not a GE phrase. It stays text, routes nothing and
    leaves `interpreted.ge` null. No SC4 item contains `ge` followed by digits.

### Code joins (plan 511–528)
On the canonical q with step 4's phrases removed ("the whole query" is that remainder). A join is
made only when its result is usable:
- letters on the collision list or the stopword list in force join with digits only when letters +
  digits (+ suffix) are the whole query **and** the joined code is offered or catalogue-only.
  Inside a longer query they never join and never reach resolution step 3;
- other known prefixes: letters + space + 4 digits join, and letters + space + 1–3 digits join;
- suffix join: code + space + 1–2 letters joins only when the joined code is offered or
  catalogue-only, and never when `/` or `-` follows the letters;
- the cost the rule accepts: a collision-list code inside a longer query is not pinned
  (SC4 guard `ee 2211 workload`).

### Code resolution (plan 529–552)
Only a known prefix (the letter part of an offered code in the pinned corpus; 304 prefixes) makes
a token code-shaped. First match wins:
1. an offered module → pinned, in query order, up to 3, still subject to the filters;
2. a catalogue-only code → as the whole query, `count: 0`, `results: []`,
   `noMatch: { reason: "not-offered", code, title, related }`;
3. shape `XX N000` with `XX` a known prefix off the collision and stopword lists → level = N
   and the `XX` prefix route (whole query: prefix ∩ level by exact dense score; inside a longer
   query: level filter, prefix members as the third RRF list);
4. otherwise, as the whole query → `count: 0`, `noMatch: { reason: "unknown-code" }`.

Inside a longer query, a catalogue-only or unknown code routes nothing, and its tokens stay in the
query text.

### Partial codes, letter-only tokens and the third list (plan 553–569)
- Whole-query partial code `[a-z]{2,4}\d{0,3}` with a known prefix: a hard mask over the range
  `[P(+'0' when P is letters only), P + ':')`, ordered by exact dense score; code order in
  `mode=lexical` and the keyword-only fallback.
- A code token inside a longer query: the prefix members form a third RRF list by exact dense
  score, with **w_c = 1** (plan 564–565, 678–679).
- A letter-only token never prefix-routes inside a multi-token query. As the whole query it routes
  only when it is a known prefix off the collision list.
- A bare pillar prefix (`GEX`, `gess`) is a partial code and echoes `interpreted.prefix`, not
  `interpreted.ge` (choice C10; plan 494–495: "a bare `GEX` routes to its pillar").

### Collision list (plan 491–495, §1 167–171), `eval/prereg/collision-list.json`
- The plan's seed (16): AI, AN, CE, DSA, EE, GE, IS, IT, JS, LAB, LL, MA, ME, PE, PR, SE.
- Added at P-6 (100), each an offered prefix that is an English word or a common abbreviation,
  with its reason in the file (choice C13). The first 37:
  AC, ACE, ADS, AH, BS, COS, DOS, EG, FT, HE, HI, ID, IDE, IE, LA, LAD, LAG, MD, MIC, MS, NG, NM,
  OPT, OT, PC, PLS, PM, PS, QT, RE, SEA, SWE, TBA, TIE, TS, UTC, VM.
- The other 63 come from applying C13's rule to all 241 offered prefixes that were on neither
  list; `eval/prereg/collision-review.json` records every decision and its reason:
  ABM, AIS, AR, ASP, AUD, BAA, BI, BIS, BL, BME, BMI, BMX, BPM, BPS, BST, CFA, CFG, CG, CL, CM, CP,
  DBA, DE, DL, DMA, DMS, EDT, EEK, ESP, FE, GI, GL, HM, HS, IDS, IFS, INT, IPS, LAH, LAT, LAV, LC,
  LCD, MB, MEM, MLE, MST, MT, MUA, NHS, PH, PLC, PP, SA, SH, SM, SN, SP, ST, STR, SW, TEE, TIC.
- Pillar prefixes are exempt (GEA, GEC, GEH, GEI, GEN, GEQ, GES, GESS, GET, GEX).

### GE (plan 497–498, 570–577), `eval/prereg/ge-pillars.json`
- Generic phrases `ge`, `gen ed`, `general education` → all ten pillar prefixes, never `GE\d`.
- Pillar names → prefixes: data literacy → GEA; cultures and connections → GEC; human cultures →
  GEH; digital literacy → GEI; communities and engagement → GEN; asking questions → GEQ;
  singapore studies → GES, GESS; thinking and expression → GET; critique and expression → GEX
  (choice C14). Each prefix's modules were checked against the pinned corpus. The NUS GE page URL
  is in the file, unfetched: P-6 makes no remote call, so 3B-0 confirms it.
- A whole GE query is the pillar mask by dense score; inside a longer query, a pre-retrieval
  candidate mask. Echoed as `interpreted.ge`, undone by `ignore=ge`.
- GE phrases are stripped from the lexical query, and the dense query stays raw, as for 3D
  (choice C15).

### Stopwords (plan 578–583), `eval/prereg/stopwords.json`
- Now (27): `src/fts-query.js` `STOPWORDS`, unchanged.
- `stopwords-v2` (35) = now + `class`, `course`, `courses`, `module`, `modules`, `nus`,
  `something`, `teach`. `intro` and `introductory` are not stopwords: they go to 3D.
- Screened alone under the general CI rule; joins L3 only if it passes dev alone.
- Fallback for 3B (plan 595): 3B without `stopwords-v2`.

## 4. 3C Typos and prefixes (plan 597–628)
- Per pre-correction token with df 0, in order:
  1. a token of **≥ 4 letters** becomes an FTS prefix term;
  2. only if that prefix term matches nothing, and only for tokens of **≥ 5 letters**: correct to
     the nearest vocabulary term by **OSA distance**, **≤ 1 for 5–7 letters, ≤ 2 for 8+**; ties
     go to the higher df, then to the lexicographically smaller term (choice C19);
  3. the original token stays in the OR.
- Intents are parsed after correction; 3G reads the pre-correction tokens.
- Variants: 3C-1 (lexical half only), 3C-2 (also embeds the corrected text, a second
  single-text call in parallel). Only a variant that passes the SC4 typo rule is eligible.
  Both are pooled in one round. Fallback: the other eligible variant.

## 5. 3D Level intent (plan 630–670), `eval/prereg/intent-phrases.json`

### Phrases
| intent | phrases | effect |
|---|---|---|
| beginner | `intro`, `introductory`, `beginner`, `beginners`, `for beginners`, `no background`, `first year`, `1st year`, `year 1` | window 1 ≤ level ≤ 4, plus α |
| graduate | `graduate`, `postgraduate`, `masters`, `phd` | level ≥ 5 |
| level N | `level N000`, `lvl N000`, `N000 level`, `N000-level`, `Nk` (and `XX N000` through code resolution) | level = N |
| year N | `2nd year`, `3rd year`, `4th year`, `second year`, `third year`, `fourth year`, `year 2`, `year 3`, `year 4` | window N ≤ level ≤ 4 |
| none | `advanced` alone; any level phrase with `not`, `non`, `except` or `beyond` among the two tokens before it | no level intent; the phrase stays in the text |

`year 1` is a beginner phrase (choice C16): `first year` and `1st year` are beginner phrases
(plan 1427–1428), and `year 1` says the same.

### Matching (choices C15, C17, C18)
- On the canonical query after correction. A phrase matches only where it is neither preceded nor
  followed by `[a-z0-9]`. A space in a phrase matches a run of whitespace or `-`; every other
  character is literal. In level phrases N is one digit 1–9; in hours phrases an integer 1–99.
- **Longest phrase wins** (plan 632–633): leftmost-longest, non-overlapping, within each pass.
- Negation applies to the level phrases only (the plan's "none" row is in 3D's table).
- **Several level phrases take the union** (plan 648–649): `min` is the smallest min, `max` the
  largest max (`null` when any is open), and `source` the sorted kinds. When the ranges are not
  adjacent the union is taken as this hull. No suite item has non-adjacent ranges. α applies iff
  `beginner` is among them.
- `level 1000`, `1000 level` and `1k` are level N = 1, not beginner (plan 646–647).
- Echoed as `interpreted.level` `{ min, max, source }`; `ignore=level` undoes it. Matched phrases
  are stripped from the lexical query only; the dense query stays raw (plan 652).

### Ranking grids (plan 657–670), `grids.json` `3D`
- α ∈ {0, 0.1, 0.2, 0.35}, each with the hard rules; score × (1 − α·p), p = 0 (levels 1–2), 0.5
  (3), 1 (4). Targeted route, target `level`.
- β ∈ {0.1, 0.2, 0.35} against 0, alone under the general CI rule; joins L5 only if it passes dev
  alone.
- Round 1 pools 4 α + 3 β (7 runs); the bundle rules + α* + β* is a second, dev-only round of one
  run, pooled only if β* passed alone.
- Fallback: the rules with α = 0 and no β.

## 6. 3E RRF weighting (plan 672–684), `grids.json` `3E`
- w_v/(k + r_v) + w_l/(k + r_l) + w_c/(k + r_c); w_l = 1, **w_c = 1**.
- Grid, in grid order: (w_v/w_l, k) = (1, 20), (1, 60), (1.25, 20), (1.25, 60), (1.5, 20),
  (1.5, 60), (2, 20), (2, 60). All 8 are new runs (new tiebreak), pooled in one round. "Grid
  order" for ties is this order (choice C28).
- Tiebreak: best single-list rank, then dense rank, then code.
- Named retry: the second-ranked point (plan 909–911).

## 7. 3F, 3G and 3H

### 3F (plan 686–708)
No grid. groups-v1 by its version string; gate by identity with the group-first projection, dev
`no-loss`, and the S8 finding test.

### 3G Gibberish and "no matches" (plan 710–749)
- **The gibberish set**: `eval/dev/gibberish.json`, 40 strings in four kinds: keyboard mash (10),
  filler (10), out-of-vocabulary slang (9), and mixed (11): eight strings that mix letters and
  digits within or across tokens (g-31 to g-38) and three of letter-only nonce words (g-30, g-39,
  g-40). Written before any 3G code, disjoint from SC4 and dev (tests). Every token has df 0 in the pinned corpus, no token of
  4+ letters is a prefix of a corpus token, and none is a module prefix or code-shaped
  (`test/full/sc4-prereg.node.test.js`), so each string can only be decided by τ (choice C21). This excludes the shape the plan names
  for the mixed kind, d-025's keyboard mash around a known-prefix code token (ambiguity A12).
- **Split** (A3-6): seed **20261106**; a Fisher–Yates shuffle with `eval/lib/stats.mjs` `rng`
  over the ids in file order; the first ⌊n/2⌋ form the derivation half, the rest the gate half.
  `node eval/prereg/gibberish-split.mjs --check` reproduces it. Derivation half: g-02, g-05,
  g-09, g-11, g-13, g-16, g-17, g-18, g-20, g-21, g-23, g-25, g-26, g-29, g-30, g-33, g-34, g-37,
  g-38, g-40. Gate half: the other 20.
- **τ candidates** (plan 723–729): the derivation half's top-1 exact cosine at its 90th and 95th
  percentiles by **nearest rank**, the ⌈p·n⌉-th smallest value, and its maximum, each + 1e-6,
  kept as distinct values. With n = 20: the 18th smallest, the 19th smallest and the 20th
  (choice C22 spells out the arithmetic).
- **Selection**: the largest candidate that passes every dev condition. **Fallback**: the next
  smaller candidate that passes on dev.
- **Gate half threshold: ≥ 90%** returns `count: 0` (plan 738): with 20 strings, at least 18.
- The other gate conditions stand as the plan and ADR 0003 state them.

### 3H No-exam, S/U, workload, prerequisite (plan 751–824)
- Phrases, longest first (plan 771–780), in pass A:
  - `exam=0`: `no exam(s)`, `no final(s)`, `no final exam(s)`, `without exam(s)`,
    `without final(s)`, `without final exam(s)` (12 strings);
  - `su=1`: `s/u`, `su-able`, `s/u-able`, `pass/fail`;
  - `hoursBelow=10`: `light workload`, `low workload`; `hoursBelow=N`: `under N hours`,
    `less than N hours`, `< N hours`, N an integer 1–99 (choice C26);
  - `prereq=none`: `no prereq(s)`, `no prerequisite(s)`, `no background`.
- **"light" = 10 h** (plan 781–784): `workload_hours < 10`; NULL excluded.
- **prereq semantics** (plan 785–790): (i) prerequisite IS NULL; (ii) NULL or cohort-only. Both
  pooled. Selection: mean ΔnDCG@10 over dev queries with a parsed prereq intent; (i) wins ties to 3
  decimals.
- **Cohort-only pattern list** (plan 758–760, A3-7), `eval/prereg/cohort-only-prereq.json`, read
  by `eval/prereg/cohort-only.mjs`. A prerequisite is cohort-only iff, after spacing out the
  glued connectors (`DegreeTHENmust`), deleting
  1. the degree wrapper (`if undertaking an undergraduate degree then`, `… a graduate degree
     coursework|research …`, `must be undertaking an … degree`),
  2. every cohort clause (`must (not) be in one of the cohorts from|to|prior to|after|before|between
     YYYY (…) (inclusive)`), and
  3. every programme clause (`must (not) be undertaking (1 of) <programme code, e.g. 0200ACCHON>
     …`, up to the next clause)

  leaves only parentheses, whitespace and `and`/`or`/`then`. Year standing, units, GPA, tests and
  completed courses are not cohort restrictions (choice C20). On the pinned corpus: 65 offered
  modules; ACC1701XA and ACC1701XC are cohort-only, ACC2706, FIN2704X and QF1100 are not
  (plan 192–196), and no prerequisite text without an academic requirement is missed. 3H-0
  re-derives and commits its own matches and count.
- **Raw vs stripped dense query** (plan 795–797): stripped wins unless raw's constraint-block
  mean nDCG@10 is higher by **≥ 0.05** and raw's overall dev Δ ≥ 0. Both pooled.
- **Pooled runs** (plan 823): (i) and (ii), each stripped and raw: 4.
- **Fallback** (plan 823–824, A3-7): the other prereq semantics with the same raw/stripped choice.
- **Constraint-exempt rule** (plan 816–822, C3-8): a dev query is exempt iff it parses a 3H
  intent and every one of its grade-≥1 documents fails that constraint under the candidate's
  semantics. A committed script computes the list per candidate from the qrels version in use;
  the dev report prints the exempt ids with their Δ (`--exempt`, ADR 0003). Dev screen only; L7's
  holdout rule has no exemption.

## 8. Selection, tie-break and named retries (plan 901–914)
- **Statistic.** General change: dev primary mean ΔnDCG@10 vs the shipped ranker. Targeted
  change: mean ΔnDCG@10 over the declared targets' answerable queries, among points with
  overall Δ ≥ 0.
- **Ties** (equal to 3 decimals): the point nearest the shipped configuration: fewest changed
  parameters, then the smallest change, then grid order. 3G and 3H's prereq semantics use their
  own rules (§7).
- **Named retries:**

| change | SC4 needs it | named retry |
|---|---|---|
| 3A-1 | no | none |
| 3A-2 | no | the second-ranked variant |
| 3B | yes | 3B without `stopwords-v2` |
| 3C | yes | the other eligible variant (3C-1 or 3C-2) |
| 3D | yes | the rules with α = 0 and no β |
| 3E | no | the second-ranked grid point |
| 3G | yes (no look) | the next smaller τ candidate that passes on dev |
| 3H | yes | the other prereq semantics, same raw/stripped choice |

Each SC4 fallback must itself pass SC4 on dev. A fallback that equals the failed candidate, or
does not exist, goes to Jacob (Q4).

## 9. SC4 acceptance suite (plan §4, 978–1043)

**SC4 suite sha256 `43bc618cd0e3fd45347e553d443a4e6813732b87ef8aa5cff5ffb81dbffa58e7`** (`test/sc4/queries.json`, version
`sc4-v1`). `test/sc4/suite.node.test.js` fails if the file changes without this line.
Implementers may not edit the suite; a change goes through the lead with the reason logged.
`test/sc4/consistency.node.test.js` checks what the items mean: each item's `interpreted` intents
are what the phrase rules (§3, §5, §7) give for its text, or for a typo item's clean form, in both
directions, and each rule's params agree with its `interpreted`.

### The `interpreted` schema
Every response echoes `interpreted` with exactly these eight keys, in this order. A key is `null`
when its intent is not set. Each suite item gives the exact object; any difference fails.

| key | set by | value |
|---|---|---|
| `pin` | 3B resolution step 1 | array of pinned offered codes, in query order (≤ 3) |
| `prefix` | 3B partial code, `XX N000`, or a code token in a longer query | the upper-case prefix route, e.g. `"CS32"`, `"CS"`, `"GESS"` |
| `ge` | 3B GE intent | sorted array of pillar prefixes |
| `level` | 3D (and `XX N000`) | `{ min, max, source }`; `max` `null` when open (graduate); `source` a sorted array of `beginner`, `graduate`, `level`, `year` |
| `exam` | 3H | `0` |
| `su` | 3H | `{ "value": 1, "basis": ["CS/CU", "su"] }`: the two bases the constraint accepts |
| `hoursBelow` | 3H | the integer N (10 for `light`/`low workload`) |
| `prereq` | 3H | `{ "value": "none", "semantics": "$selected" }` |

`$selected` stands for the prereq semantics 3H selects (`"i"` or `"ii"`). P-6 comes before that
selection, so the SC4 harness substitutes the selected value before comparing (choice C9).
`noMatch` is a top-level response field, not part of `interpreted`. 3C's corrections are not
echoed in `interpreted`, so a typo item's expected object is its clean form's.

### Item fields and rule kinds
Each item: `id` (`sc4-001`…`sc4-090`), `row` (§4's row), `text`, `topK`, `rule`, `params`,
`interpreted`, `origin` (`plan` for a §4 example, `dev:<id>` for the four dev texts §4 names,
`p6` for a text written here). No item sets filters (choice C5).

| rule | params | passes iff |
|---|---|---|
| `code-at-rank-1` | `code`, optional `allSatisfy` | `code` at rank 1; with `allSatisfy`, every result satisfies that explicit param |
| `codes-at-ranks` | `codes` | `codes[i]` at rank i + 1, in order |
| `prefix-level-mask` | `prefix`, `level` | every result has that prefix and level |
| `partial-mask` | `prefix`, `G` | every result is a member; count = G; every member is a result or a `variants` entry of one |
| `mixed-prefix` | `prefix`, `M` | ≥ M of the top 10 are prefix members |
| `routes-nothing` | `code` | count > 0, `interpreted.pin` and `prefix` null, no `noMatch` |
| `ge-mask` | `prefixes`, `pillarGroups`, `minCount` | every result is a pillar member; count ≥ `minCount` = min(10, `pillarGroups`) |
| `typo-overlap` | `clean`, `T` | top-10 overlap with the clean form's top 10 ≥ T |
| `beginner` | `answers`, `topN` | no level ≥ 5 in the top 10; one of `answers` in the top `topN` (3) |
| `top10-level-window` | `min`, `max` | every top-10 result has min ≤ level ≤ max (`max` null: no upper bound) |
| `constraint` | `param`, `reference`, `minOverlap` | every returned result satisfies `param` (under the selected semantics for prereq); top-10 overlap ≥ 7 with `/search?q=<reference>&<param>` |
| `no-match` | `reason`, optional `code`, `title` | `count: 0` and `noMatch.reason`; for `not-offered`, `noMatch.title` = `title` |
| `guard` | `collisionTokens`, `letterTokens`, optional `mustInclude` | count > 0 and `interpreted.prefix` null; when `collisionTokens` is empty, ≤ 2 of the top 10 have a code whose letter part equals any of `letterTokens`; every `mustInclude` code in the top 10 |

Every item also checks its `interpreted` exactly. Overlap@10 is over module codes (choice C2).
`reference` is the item's text with the matched phrase removed (choice C11).

### Thresholds (plan 998–1004)
- **T = 5.** Computed as §4 says by `eval/prereg/typo-threshold.mjs` (output
  `eval/prereg/typo-threshold.json`), offline, at the shipped-ranker pin `e8a7124`, on the pinned
  corpus and `emb-bge-small-v0`. The clean form of each dev typo query is its dev source, verbatim
  (choice C1). The oracle runs the clean text through the real Worker with its embedding key
  answered by the typo text's vector, so the lexical half sees the clean form and the dense half
  the typo form (choice C3). Oracle overlaps@10 with the clean form's top 10:

  | typo query | clean form (source) | oracle | uncorrected |
  |---|---|---|---|
  | d-093 `advanced molecuular bioogy 4000 level` | d-063 | 5 | 1 |
  | d-094 `Singapore society, multiculturalism, race and reliion` | d-044 | 10 | 10 |
  | d-095 `microbbiology bacteia` | d-057 | 5 | 3 |
  | d-096 `introducttory economics microoeconomics` | d-070 | 5 | 3 |
  | d-097 `machine desgin course gears bearings shafts` | d-028 | 7 | 7 |
  | d-099 `intro accunting no prerqeuisites` | d-011 | 7 | 5 |

  T = min(5, 10, 5, 5, 7, 7) = 5, under the cap of 7.
- **M = 3** (plan 1003–1004, proposed there; fixed here, choice C4).

### G, per partial-code and pillar item (plan 993–995, A3-3)
G = distinct groups-v1 groups among the members of the item's range in the pinned corpus (a
singleton is its own group), with no filters. All ≤ 50 (`test/full/sc4-prereg.node.test.js`).

| item | text | members | G |
|---|---|---|---|
| sc4-011 | `CS32` | 30 | 27 |
| sc4-012 | `cs101` | 7 | 1 |
| sc4-013 | `cs 32` | 30 | 27 |
| sc4-014 | `GEA` | 2 | 1 |
| sc4-015 | `gess` | 29 | 27 |
| sc4-016 | `GEX` | 16 | 14 |

The GE-inside-a-longer-query items count groups among all 141 pillar members: 102, so
`minCount` = 10.

### Per-row counts and texts
| row | n | texts |
|---|---|---|
| space code | 5 | `cs 1010s`, `ma 1521`, `cs1010 s`, `ee 2211`, `lsm 1301` |
| code vs level | 3 | `GEA1000`, `ES1000`, `cs 3000` |
| code joins | 2 | `cs2040 or cs2030`, `cs1231 s/u` |
| partial code or pillar (topK 50) | 6 | `CS32`, `cs101`, `cs 32`, `GEA`, `gess`, `GEX` |
| code inside a longer query | 2 | `cs32 machine learning`, `pl32 psychology lab` |
| unknown or not-offered code inside a longer query | 2 | d-016, `something like ACC1701X for engineers` |
| GE inside a longer query | 2 | d-079, d-022 |
| typo | 5 | `psycholgy of learning and memory`, `enviromental policy and sustainabilty`, `orgainc chemistry reactions`, `introductry statistics`, `marketting strategy for startups` |
| level: beginner | 4 | `introductory machine learning`, `programming for beginners`, `first year chemistry`, `economics with no background` |
| level: graduate | 2 | `graduate machine learning theory`, `masters level corporate finance` |
| level: N | 3 | `4000 level marketing`, `level 3000 econometrics`, `lvl 3000 urban planning` |
| level: year | 3 | `software engineering electives for 3rd year`, `2nd year data analytics`, `third year organic synthesis` |
| no-exam | 3 | d-024, `sociology module without final exam`, `no finals creative writing` |
| S/U | 3 | `s/u-able chemistry module`, `pass/fail art modules`, `su-able statistics` |
| workload | 3 | `light workload history elective`, `philosophy under 8 hours`, `low workload music module` |
| no prerequisite | 3 | `no prerequisites calculus`, `no prereq data visualisation`, `linguistics no prerequisite` |
| gibberish | 5 | `asdfgh`, `lmao idk`, `skibidi`, `xqzv 4412`, `frobnicate quux` |
| non-existent code | 3 | `CS9999`, `lsm 9876`, `ACC9123` |
| not-offered code | 2 | `GEQ1000` (Asking Questions), `GEH1001` (Globalisation and New Media) |
| guards | 29 | §4's 18 (`art history` … `give me 3000 level electives`), `what is 2000 level`, `is it 3000 level` (both from 3B's text), and `ee 2211 workload`, `it`, `it security`, `psychology electives for cs majors`, `final year project`, `philosophy for lsm students`, `se asia history`, `non graduate data science`, `beyond first year calculus` |
| **total** | **90** | |

### Custody and dev
- Dev texts appear only where §4 names them: d-016, d-022, d-024 and d-079, verbatim, each once,
  in its row. No other suite text, typo clean form or reference equals or near-duplicates a dev
  text (normalised equality with or without spaces, or token Jaccard ≥ 0.5; choice C27). The
  gibberish set is disjoint from the suite and dev by the same check.
- §4's own examples `is 4246` and `gec` are dev texts d-089 and d-092, which §4 does not name, so
  they are replaced by `ee 2211` and `gess` (choice C6; ambiguity A1).
- **Holdout check: 0 hits** (custodian, 2026-11-06, `eval/prereg/sc4-custody.mjs --custodian`).
  It covered 147 texts: the 90 suite texts, the 17 clean forms and references they are compared
  with, and the 40 gibberish strings. It applied the v2.1 code-overlap rule (a suite code token
  and a holdout code target where either is a prefix of the other) and query-embedding cosine
  ≥ 0.9 over every pair of embedded forms. It prints only the hit count and suite ids.
  - Its self-check on the open dev set (`--against dev`) hits 5 items: the items that carry the
    dev texts §4 names, and one code join on a dev target. So the check is not vacuous.
- An embedding check against dev (cosine ≥ 0.9, `test/sc4/embeddings.node.test.js`) passes: no
  text other than the four §4 names is a near-duplicate of a dev text.

### Query embeddings
The lead embedded every new text on 2026-11-06 (Workers AI REST, 2 requests, ~1.8 neurons,
`docs/evidence/neurons.tsv`). `test/sc4/needs-embedding.txt` lists all **143** (156 forms with
canonical variants): 86 suite item texts, 5 typo clean forms,
12 constraint references and the 40 gibberish strings. The plan's estimate of ~130 (§4, §6)
did not count the clean forms and references. They go into `test/sc4/embeddings.json` in the
eval cache format, and the embedding checks run.

## 10. Choices made at P-6
Each is a value the plan leaves open, with its one-line reason.

- **C1.** The clean form of each dev typo query is its dev `source` text, verbatim (d-063, d-044,
  d-057, d-070, d-028, d-011), with the same filters: the noise-model typos were derived from
  those texts, and their embeddings are committed.
- **C2.** Overlap@10 (T, the typo rule, the constraint rule) counts module codes, not groups: §4
  says "top-10 overlap", and both lists collapse the same way once 3F ships.
- **C3.** T is computed at the shipped-ranker pin `e8a7124` through the eval runner, with the
  oracle built by remapping embedding keys, so no ranker code changes and no embedding is made.
- **C4.** M = 3, as the plan proposes: CS32 and PL32 each have ≥ 18 members, so the rule can
  pass, and 3 of 10 shows the third list is working.
- **C5.** No suite item sets filters: SC4 tests the parse and the routes, and §4's "∩ filters"
  then reads as no restriction, so G and `minCount` are corpus facts.
- **C6.** `ee 2211` replaces `is 4246` and `gess` replaces `gec` (both dev texts §4 does not
  name). `ee 2211` keeps the collision-list whole-query join (EE2211 is offered); `gess` keeps a
  pillar with > 20 groups (27), the case topK = 50 exists for.
- **C7.** The texts §4 leaves to P-6: the fifth space code `lsm 1301`; `pl32 psychology lab`;
  `something like ACC1701X for engineers` (ACC1701X is catalogue-only); `GEH1001` as the second
  not-offered code; `CS9999`, `lsm 9876`, `ACC9123` (known prefix, in neither the offered list
  nor the catalogue, not `XX N000`); and every typo, level, constraint, gibberish and extra guard
  text in §9's table. Each targets one rule and was checked against dev.
- **C8.** The 11 extra guards cover the joins §3B names (`what is 2000 level`, `is it 3000
  level`, `ee 2211 workload`), collision tokens alone and in context (`it`, `it security`, `se asia history`), `final` outside
  an exam phrase (`final year project`), negation (`non graduate …`, `beyond first year …`), and
  the count rule on an off-list prefix (`psychology electives for cs majors`, `philosophy for lsm
  students`; C30).
- **C9.** The `interpreted` schema in §9, including `level.max = null` for graduate (levels reach
  8), `source` as a sorted array (the union can hold several kinds), and the `$selected`
  placeholder for the prereq semantics, which 3H fixes after P-6.
- **C10.** A bare pillar prefix is a partial code (`interpreted.prefix`), not the GE intent: the
  plan routes `GEX` to its pillar through the prefix route.
- **C11.** Constraint items' references are the item text with the phrase removed, so the
  comparison isolates the param. Every constraint text was written so that nothing but the
  phrase needs removing.
- **C12.** The guard count rule's tokens are the query's letter-only non-stopword tokens when it
  has no collision token; with a collision token there is no count rule (C2-8).
- **C13.** The collision list adds 100 offered prefixes to the plan's 16. The rule: add a prefix
  if its lowercase form is an English word, or a common abbreviation outside NUS that a student
  could type meaning something other than that department (units, chemistry, tech and chat terms:
  `cm`, `ph`, `dl`, `bmi`, `str` …). Leave it off if it is a department or subject code a student
  types to mean that department (`cs`, `lsm`, `fin`, `acc`), or if the suite routes or joins on
  it. When unsure, add it: an extra entry costs only its bare letters, which stay topical, and
  its spaced form, which joins only as the whole query (`st 2131`) and never level-routes
  (`st 2000`); the unspaced code (`st2131`) still pins. 37 were added first; the rule
  was then applied to all 241 offered prefixes on neither the list nor the pillar list (304
  in the pinned corpus): 63 added, 156 kept off, and 22 dictionary hits kept off as words a
  student would not type (obscure, a proper noun only, or a department code). The English-word
  source was `/usr/share/dict/words` (web2), read once; `eval/prereg/collision-review.json` is
  the committed result, so nothing reads the dictionary in CI.
- **C14.** The GE pillar names and their prefixes; GES and GESS both map to Singapore Studies;
  GE phrases are read in pass B (after joins), so `ge` never joins.
- **C15.** Phrase matching: token-boundary anchored, space matches whitespace or `-`,
  leftmost-longest within a pass; `no background` sets beginner from pass A; GE phrases are
  stripped from the lexical query and the dense query stays raw.
- **C16.** `year 1` is a beginner phrase, like `first year` and `1st year`.
- **C17.** Negation applies only to the level phrases, as the plan's "none" row sits in 3D's
  table. The 3H phrases are already negative.
- **C18.** The union of non-adjacent level ranges is their hull; the plan names only adjacent
  cases (d-045).
- **C19.** OSA ties after df go to the lexicographically smaller term, so correction is
  deterministic.
- **C20.** Cohort-only covers the degree-type wrapper, cohort clauses and programme clauses
  (including `must not be`); year standing, units, GPA and tests are academic requirements, not
  cohort restrictions. 65 modules on the pinned corpus.
- **C21.** The gibberish set: 40 strings in four kinds, each with no corpus signal the 3G trigger
  reads, so the τ derivation and gate measure the cosine and nothing else.
- **C22.** The split seed 20261106 (the P-6 date) and the Fisher–Yates method with the eval's
  `rng`. With n = 20 per half, the nearest-rank p90 is the 18th smallest top-1 cosine, p95 the
  19th, and the maximum the 20th.
- **C23.** 90% of the gate half is 18 of 20.
- **C24.** 3A-2's level label for level 8 is "graduate".
- **C25.** 3A-2's and 3E's named retries are their second-ranked points (plan 909–911); 3A-1 has
  none.
- **C26.** `hoursBelow` N in `under N hours` and the like is an integer 1–99.
- **C27.** Near-duplicate of a dev text: equal after lower-casing and collapsing non-alphanumerics
  (with or without spaces), or token Jaccard ≥ 0.5.
- **C28.** "Grid order" for 3E ties is w_v/w_l ascending, then k ascending.
- **C29.** The suite's and gibberish set's embeddings go in `test/sc4/embeddings.json`, the eval
  cache format, beside the suite.
- **C30.** Two guards make the count rule binding: `psychology electives for cs majors` (CS, 164
  offered modules) and `philosophy for lsm students` (LSM, 123). They replace two P-6 guards,
  `lab safety training` and `ma thesis writing`, whose collision-in-context shape `it security`
  and `se asia history` still cover. A count-rule token that is no offered prefix (`art`,
  `law`, `comp`, `psych`, `korean` …) passes on any output, and §4's 18 guards have no other
  kind, so before C30 the rule could not fail. `cs` and `lsm` belong off the collision list:
  each is the department's own code, a student types it to mean that department, and the suite's
  own joins and routes on it (`cs 1010s`, `cs 3000`, `cs 32`, `lsm 1301`, `lsm 9876`) need
  it off. Inside these texts the token names the student's cohort, not the subject asked for, so
  a correct ranking has few CS or LSM modules in its top 10, while a ranker that prefix-routed
  the letter-only token (a third list, as for a code token) would add its members.
  `test/full/sc4-prereg.node.test.js` checks that exactly these two guards bind.

## 11. Ambiguities and how they were resolved
- **A1.** §4's examples `is 4246` and `gec` are dev queries d-089 and d-092, but §4 names only
  d-024, d-079, d-022 and d-016 as dev texts in the suite. Replaced (C6).
- **A2.** "`interpreted.su` says which matched" (3H) could mean per result or per query. A parse
  echo cannot know which results will match, so `interpreted.su` names both accepted bases; a
  per-result basis, if the UI wants one, is a result field, outside `interpreted`.
- **A3.** The no-prerequisite items need "the selected semantics", which 3H chooses after P-6.
  The `$selected` placeholder keeps the expected JSON exact.
- **A4.** The parse order strips 3H phrases (step 4) before the 3D phrases are read (step 7), yet
  `no background` must set both intents. Resolved by the shared-phrase rule (C15).
- **A5.** The plan does not place the GE phrases in the parse order. Pass B (C14).
- **A6.** "Union of their ranges" for non-adjacent ranges (C18).
- **A7.** "year N" could include `year 1`, which the year window would make [1, 4] without α.
  Treated as beginner, like the other first-year phrases (C16).
- **A8.** §4's no-exam rule says "100% of results satisfy the constraint": read as every returned
  result, not only the top 10.
- **A9.** The plan's ~130 texts to embed (§4, §6) omits the typo clean forms and the constraint
  references; the actual count is 143.
- **A10.** `no final` also matches `no final year project`. The plan lists the phrase, so it stays;
  no suite item has that shape.
- **A11.** The full-corpus CI job fails if any `test/full` test is skipped, so the
  embedding-dependent checks live in `test/sc4/`, under `npm test`, where a skip is allowed.
- **A12.** 3G's set asks for "mixed tokens like d-025" (plan 719): d-025 is `asdkj qwpo cs44xx
  zzz`, keyboard mash around `cs44xx`, whose letter part is a known prefix. The set leaves that
  shape out (`test/full/sc4-prereg.node.test.js` forbids a token whose letter part is a module
  prefix). A known-prefix code token inside a longer query fires the prefix route (third list,
  plan 678), so 3G's first condition, "no code, prefix or GE route fired", cannot hold for it, and
  such a string could not measure τ. Its mixed strings keep d-025's other half: nonce letters
  mixed with digits, and code-like tokens off every prefix (`xj9k 2kq`, `zz9 xx8`).

## 12. Still to do, outside this commit
- 3B-0 confirms the GE page URL and re-runs critic C's prefix counts; 3H-0 re-derives the
  cohort-only matches.
