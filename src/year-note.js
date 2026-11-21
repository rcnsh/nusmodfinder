// @ts-check

/** @typedef {import('./ng-bit.js').Study} Study */

export const YEAR_NOTE = 'prereq:year-of-study';

const YEAR_ITEM = /must\s+be\s+(?:in\s+)?year\s+(\d(?:\s*,\s*\d)*(?:\s+or\s+\d)?)(?![\d,])/gi;
const MARK = '\u0000';

/** @param {string} s */
const respace = (s) => s
  .replace(/(?<=[a-z\d)])(THEN|AND|OR)/g, ' $1 ')
  .replace(/(THEN|AND|OR)(?=[a-z(])/g, ' $1 ');

/**
 * @param {string | null | undefined} prerequisite
 * @returns {number[] | null}
 */
export function requiredYears(prerequisite) {
  if (typeof prerequisite !== 'string' || !/year/i.test(prerequisite)) return null;
  let text = respace(prerequisite);
  const branches = text.match(/\bif\s+undertaking\b/gi)?.length ?? 0;
  if (branches > 1) return null;
  if (branches === 1) {
    const head = /^\s*\(?\s*if\s+undertaking\s+(?:an\s+)?undergraduate\s+degree\s+then\b/i.exec(text);
    if (!head) return null;
    text = text.slice(head[0].length);
    if (head[0].includes('(')) {
      if (!/\)\s*$/.test(text)) return null;
      text = text.replace(/\)\s*$/, '');
    }
  } else if (/(?<!under)graduate/i.test(text)) {
    return null;
  }
  /** @type {number[][]} */
  const items = [];
  text = text.replace(YEAR_ITEM, (_m, list) => {
    items.push(String(list).split(/\s*(?:,|\bor\b)\s*/i).map(Number).sort((a, b) => a - b));
    return ` ${MARK} `;
  });
  if (!items.length) return null;
  text = text.replace(/\bor\s+(?:greater|higher|better|above|more)\b/gi, ' ');

  /** @type {{ own: string, marks: number[] }[]} */
  const stack = [{ own: '', marks: [] }];
  /** @type {boolean[]} */
  const binding = items.map(() => true);
  let next = 0;
  /** @param {{ own: string, marks: number[] }} f */
  const close = (f) => {
    if (/\bor\b/i.test(f.own)) for (const i of f.marks) binding[i] = false;
  };
  for (const ch of text) {
    const top = stack[stack.length - 1];
    if (ch === '(') stack.push({ own: '', marks: [] });
    else if (ch === ')') {
      if (stack.length === 1) return null;
      const f = /** @type {{ own: string, marks: number[] }} */ (stack.pop());
      close(f);
      const parent = stack[stack.length - 1];
      parent.marks.push(...f.marks);
      parent.own += ' ';
    } else if (ch === MARK) top.marks.push(next++);
    else top.own += ch;
  }
  if (stack.length !== 1) return null;
  close(stack[0]);
  const kept = items.filter((_, i) => binding[i]);
  if (!kept.length) return null;
  return kept.reduce((a, b) => (b[0] > a[0] ? b : a));
}

/** @param {number[]} years */
const yearsPhrase = (years) => (years.length === 1 ? `Year ${years[0]}`
  : `Year ${years.slice(0, -1).join(', ')} or ${years[years.length - 1]}`);

/**
 * @param {string | null | undefined} prerequisite
 * @param {Study} study
 * @returns {{ id: string, kind: string, text: string } | null}
 */
export function yearNote(prerequisite, study) {
  const home = /^ug([1-4])$/.exec(study);
  if (!home) return null;
  const years = requiredYears(prerequisite);
  if (!years || Number(home[1]) >= years[0]) return null;
  return {
    id: YEAR_NOTE,
    kind: 'year',
    text: `NUS lists this course for ${yearsPhrase(years)} students. Ask the department whether your year of study during your exchange counts.`,
  };
}
