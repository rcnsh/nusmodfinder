// @ts-check
// Whether one course's NUS preclusion text names another (Phase 6 6B): the
// shortlist's preclusion flag and its same-course rule. Pure; checked on NUS's
// own texts in test/web/preclusion.node.test.js.
//
// A match is:
// - a code with a non-letter before it (YSC2216 is not SC2216) and, after it,
//   a non-alphanumeric, the end, or a glued OR, AND or THEN ("ME2134ORmust");
// - or a prefix after "beginning with" ("any Courses (Modules) beginning with
//   CS1010"), matched against the start of the other code.
// Programme codes (0300CS2MJ) are not course codes, so they never match.
// A match whose branch is conditioned on an NUS intake cohort ("if in one of
// the cohorts from 2018 inclusive THEN …") is skipped: exchange students are
// in no NUS cohort. A "cohort" in another branch (DAO2702X's programme rule)
// doesn't skip it. At `study=grad`, a match in a branch conditioned on an
// undergraduate degree alone ("If undertaking (an) Undergraduate Degree THEN")
// is skipped; a condition naming "Graduate Degree Coursework" too is kept, and
// so is a later graduate branch of the same rule (CS5462).

const CODE_AT = /(?<![A-Za-z])([A-Z]{1,4}\d{4}[A-Z0-9]{0,5}?)(?=[^A-Za-z0-9]|$|OR|AND|THEN)/g;
const PREFIX_AT = /beginning with\s+([A-Z]{1,4}\d{0,4}[A-Z0-9]{0,5}?)(?=[^A-Za-z0-9]|$|OR|AND|THEN)/g;
/** A condition on an undergraduate degree, up to its THEN; group 1 is the rest of the condition. */
const UNDERGRAD_IF = /if undertaking (?:an? )?undergraduate degree([\s\S]*?)then/i;
/** A branch conditioned on an NUS intake cohort. */
const COHORT_IF = /cohort[\s\S]*then/i;
/** An AND or OR joining two branches: not inside a word, followed by a space, "(" or a glued lower-case word. */
const JOIN = /^(?:AND|OR)(?=[\s(a-z])/;

/**
 * Whether a branch's text before a match holds a condition that leaves the
 * student out: an NUS cohort, or (at grad) an undergraduate degree alone.
 * @param {string} branch
 * @param {string} study
 */
function excludes(branch, study) {
  if (COHORT_IF.test(branch)) return true;
  if (study !== 'grad') return false;
  const m = UNDERGRAD_IF.exec(branch);
  return !!m && !/graduate degree coursework/i.test(m[1]);
}

/**
 * Whether the text at `index` sits in a branch whose condition leaves the
 * student out: at some nesting level around it, the branch it is in (from the
 * last AND or OR at that level) holds such a condition before it.
 * @param {string} text
 * @param {number} index
 * @param {string} study
 */
function conditioned(text, index, study) {
  /** @type {number[]} */
  const opens = [];
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '(') opens.push(i);
    else if (text[i] === ')') opens.pop();
  }
  const starts = [-1, ...opens];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k] + 1;
    const to = k + 1 < starts.length ? starts[k + 1] : index;
    let depth = 0;
    let branch = from;
    for (let i = from; i < to; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0 && !/[a-z]/.test(text[i - 1] ?? '') && JOIN.test(text.slice(i, i + 4))) branch = i;
    }
    if (excludes(text.slice(branch, to), study)) return true;
  }
  return false;
}

/**
 * Whether NUS's preclusion `text` names `code`, for a student at `study`
 * ('' in browse mode: every rule is read).
 * @param {string | null | undefined} text
 * @param {string} code
 * @param {string} study
 */
export function names(text, code, study) {
  if (!text) return false;
  for (const m of text.matchAll(CODE_AT)) {
    if (m[1] === code && !conditioned(text, m.index ?? 0, study)) return true;
  }
  for (const m of text.matchAll(PREFIX_AT)) {
    if (code.startsWith(m[1]) && !conditioned(text, m.index ?? 0, study)) return true;
  }
  return false;
}
