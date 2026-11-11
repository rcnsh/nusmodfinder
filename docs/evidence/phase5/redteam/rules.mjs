// @ts-check
// Phase 5 red team (docs/plans/phase5.md §3 5G): the brief-to-answer rules,
// committed before any persona runs so they cannot drift. The expected answer
// for a (persona, course, semester) comes from the independent oracle
// (test/sc1/oracle.node.mjs) and the persona's brief (personas.json `brief`)
// alone, never from the page or the Worker's stored reasons.
//
// The plan's table:
//   closed                               -> no
//   open, no note                        -> yes
//   quota, approval, audition            -> yes if (the condition)
//   graded, fee                          -> yes if the brief accepts the condition, else no
//   major                                -> yes if the brief's major meets it, else no
//   letter                               -> yes if the brief has the letter, else no
//   partner                              -> set by the brief if it says, else ask NUS
//   restricted-elsewhere, semester, unknown -> ask NUS
// With several notes the most restrictive wins: no > ask NUS > yes if > yes.
//
// The oracle's notes are free text; NOTE_KINDS maps each to a kind (and, for
// `major`, the major it asks for). A note no pattern matches throws, so a new
// oracle note can't silently fall through.

/** @typedef {'yes' | 'yes-if' | 'ask' | 'no'} Answer */
/** @typedef {{ majors: string[], acceptsGraded: boolean, acceptsFee: boolean, hasLetter: boolean, partner: boolean | null }} Brief */

/** Most restrictive first. */
export const ORDER = /** @type {const} */ (['no', 'ask', 'yes-if', 'yes']);

/** @type {[RegExp, string, string?][]} [oracle note pattern, kind, major asked for] */
export const NOTE_KINDS = [
  [/^R2: /, 'semester'],
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

/**
 * One note's answer under a brief.
 * @param {{ kind: string, major?: string }} k
 * @param {Brief} brief
 * @returns {Answer}
 */
export function noteAnswer(k, brief) {
  switch (k.kind) {
    case 'quota': case 'approval': case 'audition': return 'yes-if';
    case 'graded': return brief.acceptsGraded ? 'yes' : 'no';
    case 'fee': return brief.acceptsFee ? 'yes' : 'no';
    case 'major': return brief.majors.includes(/** @type {string} */ (k.major)) ? 'yes' : 'no';
    case 'letter': return brief.hasLetter ? 'yes' : 'no';
    case 'partner': return brief.partner === true ? 'yes' : brief.partner === false ? 'no' : 'ask';
    default: return 'ask'; // restricted-elsewhere, semester, unknown
  }
}

/** @param {Answer[]} answers @returns {Answer} */
export const mostRestrictive = (answers) => /** @type {Answer} */ (ORDER.find((a) => answers.includes(a)) ?? 'yes');

/**
 * The expected answer from the oracle's explain() result and the brief.
 * @param {{ result: 'open' | 'note' | 'closed', closed: string[], notes: string[] }} o
 * @param {Brief} brief
 * @returns {{ answer: Answer, kinds: string[] }}
 */
export function expected(o, brief) {
  if (o.result === 'closed') return { answer: 'no', kinds: ['closed'] };
  const ks = o.notes.map(kindOf);
  return { answer: mostRestrictive(ks.map((k) => noteAnswer(k, brief))), kinds: ks.map((k) => k.major ? `${k.kind}:${k.major}` : k.kind) };
}

/**
 * A persona's free-text answer, normalised: "yes", "yes if …", "no", "ask NUS".
 * @param {string} s @returns {Answer | null}
 */
export function normalise(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (/^yes if\b/.test(t) || t === 'yes-if') return 'yes-if';
  if (t === 'yes') return 'yes';
  if (t === 'no') return 'no';
  if (/^ask( nus)?$/.test(t)) return 'ask';
  return null;
}
