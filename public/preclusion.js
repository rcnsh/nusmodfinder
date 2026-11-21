// @ts-check

const CODE_AT = /(?<![A-Za-z])([A-Z]{1,4}\d{4}[A-Z0-9]{0,5}?)(?=[^A-Za-z0-9]|$|OR|AND|THEN)/g;
const PREFIX_AT = /beginning with\s+([A-Z]{1,4}\d{0,4}[A-Z0-9]{0,5}?)(?=[^A-Za-z0-9]|$|OR|AND|THEN)/g;
const UNDERGRAD_IF = /if undertaking (?:an? )?undergraduate degree([\s\S]*?)then/i;
const COHORT_IF = /cohort[\s\S]*then/i;
const JOIN = /^(?:AND|OR)(?=[\s(a-z])/;

/**
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
