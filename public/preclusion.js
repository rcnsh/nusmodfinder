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
// doesn't skip it. At `study=grad`, a rule opening with a clause naming
// undergraduates alone is skipped; one naming "Graduate Degree Coursework" too
// is kept.

const CODE_AT = /(?<![A-Za-z])([A-Z]{1,4}\d{4}[A-Z0-9]{0,5}?)(?=[^A-Za-z0-9]|$|OR|AND|THEN)/g;
const PREFIX_AT = /beginning with\s+([A-Z]{1,4}\d{0,4}[A-Z0-9]{0,5}?)(?=[^A-Za-z0-9]|$|OR|AND|THEN)/g;
const UNDERGRAD_OPENING = /^\s*\(?\s*if undertaking an undergraduate degree/i;
/** An AND or OR joining two branches: not inside a word, followed by a space, "(" or a glued lower-case word. */
const JOIN = /^(?:AND|OR)(?=[\s(a-z])/;

/**
 * Whether the rule opens with a clause naming undergraduates alone.
 * @param {string} text
 */
function undergradOnly(text) {
  if (!UNDERGRAD_OPENING.test(text)) return false;
  const clause = text.split(/then/i)[0];
  return !/graduate degree coursework/i.test(clause);
}

/**
 * Whether the text at `index` sits in a branch conditioned on an NUS cohort:
 * at some nesting level around it, the branch it is in (from the last AND or
 * OR at that level) says "cohort" and then "THEN" before it.
 * @param {string} text
 * @param {number} index
 */
function cohortConditioned(text, index) {
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
    if (/cohort[\s\S]*then/i.test(text.slice(branch, to))) return true;
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
  if (study === 'grad' && undergradOnly(text)) return false;
  for (const m of text.matchAll(CODE_AT)) {
    if (m[1] === code && !cohortConditioned(text, m.index ?? 0)) return true;
  }
  for (const m of text.matchAll(PREFIX_AT)) {
    if (code.startsWith(m[1]) && !cohortConditioned(text, m.index ?? 0)) return true;
  }
  return false;
}
