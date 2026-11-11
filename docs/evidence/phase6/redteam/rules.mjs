// @ts-check
// Phase 6 red team (docs/plans/phase6.md §3 6E "Red team"): the brief-to-answer
// rules, committed and pushed before any persona runs so they cannot drift.
// Phase 5's rules (../../phase5/redteam/rules.mjs) with the rows the plan adds.
// The expected answer for a (persona, course, semester) comes from the
// independent SC1 oracle (test/sc1/oracle.node.mjs, `explainShown`: the R3
// year note included, as Jacob ruled after Phase 5) over production-normalised
// modules and the persona's brief (personas.json `brief`) alone, never from
// the page or the Worker's stored reasons.
//
// The table (most restrictive wins: no > ask NUS > yes if > yes):
//   closed                                  -> no
//   open, no note                           -> yes
//   quota, approval, supply                 -> yes if (the condition)
//   graded, fee, major, letter              -> yes if the brief meets it, no if it doesn't,
//                                              yes if (unsettled) when the brief doesn't say
//   partner                                 -> set by the brief if it says, else ask NUS
//   restricted-elsewhere, semester, year,
//   unknown                                 -> ask NUS
// Rows Phase 6 adds:
//   Business or Law (faculty "NUS Business School" or "Law")
//                                           -> "yes if invited, or already given": yes when the
//                                              brief says invited by that school; no when it says
//                                              not invited; yes if when the brief doesn't say
//   a course NUS already gave the student at its offer (brief `given`), not closed -> yes
//   audition                                -> ask NUS: apply separately
//   an NG-listed 404 (NG-listed, no classes) -> ask NUS (closed by NUS's restrictions -> no)
//
// After the run, Jacob's ruling R6-2 (2026-11-12, ../redteam.md "Rulings and
// follow-up", ADR 0010): GRO's level-4000 sentence is a condition like a
// quota. The oracle's explainShown() gives it as an `R6-2:` note (its G1-G3:
// a level 4000 course outside Law, for an undergraduate), kind `supply`, so
// such a course expects "yes if there's a place"; expected.json was rebuilt
// with this script's expected.mjs.
//
// "When the brief doesn't say" (null) is new in Phase 6: the advisor persona
// answers from the link and the PDF alone, so it knows none of the student's
// own facts. Phase 5's personas always knew them.
//
// The oracle's notes are free text; NOTE_KINDS maps each to a kind (and, for
// `major`, the major it asks for). A note no pattern matches throws, so a new
// oracle note can't silently fall through.

/** @typedef {'yes' | 'yes-if' | 'ask' | 'no'} Answer */
/**
 * @typedef {{
 *   majors: string[] | null, acceptsGraded: boolean | null, acceptsFee: boolean | null,
 *   hasLetter: boolean | null, partner: boolean | null,
 *   invited: { biz: boolean | null, law: boolean | null }, given: string[],
 * }} Brief
 */

/** Most restrictive first. */
export const ORDER = /** @type {const} */ (['no', 'ask', 'yes-if', 'yes']);

/** @type {[RegExp, string, string?][]} [oracle note pattern, kind, major asked for] */
export const NOTE_KINDS = [
  [/^R2: /, 'semester'],
  [/^R3: /, 'year'],
  [/^R6-2: /, 'supply'],
  [/^C2 restricted elsewhere: /, 'restricted-elsewhere'],
  [/^Business: must be majoring in business/, 'major', 'business'],
  [/^Law: must be majoring in Law/, 'major', 'law'],
  [/^Architecture majors \(or related disciplines\) only$/, 'major', 'architecture'],
  [/^C4: twin of AR\d+, Architecture majors/, 'major', 'architecture'],
  [/^Landscape Architecture majors \(or related disciplines\) only$/, 'major', 'landscape architecture'],
  [/^Industrial Design students only/, 'major', 'industrial design'],
  [/^Architecture design studio: letter of confirmation/, 'letter'],
  [/graded basis|no audit|cannot be audited|Cannot be read on audit basis/i, 'graded'],
  [/^Limited quota$/, 'quota'],
  [/approval|application form/i, 'approval'],
  [/audition or placement test/, 'audition'],
  [/tuition fee/, 'fee'],
  [/partner|CEMS/, 'partner'],
];

/** @param {string} note an oracle note @returns {{ kind: string, major?: string }} */
export function kindOf(note) {
  for (const [re, kind, major] of NOTE_KINDS) if (re.test(note)) return major ? { kind, major } : { kind };
  throw new Error(`rules.mjs: no kind for oracle note ${JSON.stringify(note)}`);
}

/** A brief fact: met, not met, or not said. @param {boolean | null | undefined} v @returns {Answer} */
const fact = (v) => (v === true ? 'yes' : v === false ? 'no' : 'yes-if');

/**
 * One note's answer under a brief.
 * @param {{ kind: string, major?: string }} k
 * @param {Brief} brief
 * @returns {Answer}
 */
export function noteAnswer(k, brief) {
  switch (k.kind) {
    case 'quota': case 'approval': case 'supply': return 'yes-if';
    case 'graded': return fact(brief.acceptsGraded);
    case 'fee': return fact(brief.acceptsFee);
    case 'major': return brief.majors === null ? 'yes-if' : brief.majors.includes(/** @type {string} */ (k.major)) ? 'yes' : 'no';
    case 'letter': return fact(brief.hasLetter);
    case 'partner': return brief.partner === true ? 'yes' : brief.partner === false ? 'no' : 'ask';
    case 'invite': return fact(brief.invited[/** @type {'biz' | 'law'} */ (k.major)]);
    default: return 'ask'; // audition, ng-listed, restricted-elsewhere, semester, year, unknown
  }
}

/** @param {Answer[]} answers @returns {Answer} */
export const mostRestrictive = (answers) => /** @type {Answer} */ (ORDER.find((a) => answers.includes(a)) ?? 'yes');

/** The Business or Law school a course belongs to, by NUSMods faculty. @param {{ faculty?: string | null }} m */
export const schoolOf = (m) => (m.faculty === 'NUS Business School' ? 'biz' : m.faculty === 'Law' ? 'law' : null);

/**
 * The expected answer from the oracle's explainShown() result, the course and the brief.
 * @param {{ result: 'open' | 'note' | 'closed', closed: string[], notes: string[] }} o
 * @param {{ code: string, faculty?: string | null, ngListed404?: boolean }} m the module (`ngListed404`: NG-listed, no classes)
 * @param {Brief} brief
 * @returns {{ answer: Answer, kinds: string[] }}
 */
export function expected(o, m, brief) {
  if (o.result === 'closed') return { answer: 'no', kinds: ['closed'] };
  const ks = o.notes.map(kindOf);
  const school = schoolOf(m);
  if (school) ks.push({ kind: 'invite', major: school });
  if (m.ngListed404) ks.push({ kind: 'ng-listed' });
  // A course NUS already gave the student at its offer is settled: yes.
  if (brief.given.includes(m.code)) return { answer: 'yes', kinds: [...ks.map((k) => (k.major ? `${k.kind}:${k.major}` : k.kind)), 'given'] };
  return {
    answer: mostRestrictive(ks.map((k) => noteAnswer(k, brief))),
    kinds: ks.map((k) => (k.major ? `${k.kind}:${k.major}` : k.kind)),
  };
}

/**
 * A persona's free-text answer, normalised: "yes", "yes if …", "no", "ask NUS" (or "ask NUS: …").
 * @param {string} s @returns {Answer | null}
 */
export function normalise(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (/^yes if\b/.test(t) || t === 'yes-if') return 'yes-if';
  if (t === 'yes') return 'yes';
  if (t === 'no') return 'no';
  if (/^ask( nus)?\b/.test(t)) return 'ask';
  return null;
}

/**
 * The advisor's brief from the link it was given (fixed before the run): it
 * knows none of the student's facts, except an invitation the link records
 * (`inv=biz`, `inv=law`), which the page shows. Its year of study and
 * semesters are the link's.
 * @param {URLSearchParams} q the link's query
 * @returns {Brief}
 */
export function advisorBrief(q) {
  const inv = q.getAll('inv');
  return {
    majors: null, acceptsGraded: null, acceptsFee: null, hasLetter: null, partner: null,
    invited: { biz: inv.includes('biz') ? true : null, law: inv.includes('law') ? true : null }, given: [],
  };
}
