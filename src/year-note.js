// @ts-check
// Jacob's ruling R3 (docs/decisions/0008-phase5-frontend-plan.md): a NUS
// prerequisite that requires an undergraduate year of study ("If undertaking
// an Undergraduate Degree THEN must be Year 4") does not change a course's
// exchange status, but an undergraduate whose home year is below that year
// gets an "ask NUS" note on it.
//
// Read at request time from the stored prerequisite text (no stored column),
// and only where the text is unambiguous: one undergraduate branch (or no
// branch at all), and a "must be Year N" item that every undergraduate must
// meet, i.e. one that no OR sits beside at its own level or at any level
// around it. A year item that is one alternative among others ("GPA of 3.2 or
// greater OR must be Year 4"), a text with several "if undertaking" branches,
// or unbalanced brackets gives no note. test/year-note.node.test.js lists the
// patterns; the SC1 oracle (test/sc1/oracle.mjs) reads them on its own.

/** @typedef {import('./ng-bit.js').Study} Study */

/** The reason id of the note. Never stored in D1: computed per request. */
export const YEAR_NOTE = 'prereq:year-of-study';

/** "must be Year 4", "must be in Year 4", "must be Year 3 or 4", "must be Year 2,3 or 4". */
const YEAR_ITEM = /must\s+be\s+(?:in\s+)?year\s+(\d(?:\s*,\s*\d)*(?:\s+or\s+\d)?)(?![\d,])/gi;
/** Stands in for a year item while the text around it is scanned. */
const MARK = '\u0000';

/**
 * NUS's keywords glued to their neighbours ("DegreeTHENmust", "DANDmust",
 * ")OR(", "Year 4AND(") get their spaces back. A capital word that merely
 * contains one ("MAJOR", "STANDARD") is left alone, since a capital comes
 * before it.
 * @param {string} s
 */
const respace = (s) => s
  .replace(/(?<=[a-z\d)])(THEN|AND|OR)/g, ' $1 ')
  .replace(/(THEN|AND|OR)(?=[a-z(])/g, ' $1 ');

/**
 * The years the prerequisite requires of every undergraduate, or null when
 * it requires none or the text is not unambiguous (see the header).
 * @param {string | null | undefined} prerequisite
 * @returns {number[] | null} the strictest year item's years, ascending
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
    // A bracket opened before "if" closes at the end; drop the pair.
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
  // "a GPA of 3.2 or greater" is a comparison, not an alternative.
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
  // Every kept item binds: the one with the highest lowest year is the strictest.
  return kept.reduce((a, b) => (b[0] > a[0] ? b : a));
}

/** @param {number[]} years ascending */
const yearsPhrase = (years) => (years.length === 1 ? `Year ${years[0]}`
  : `Year ${years.slice(0, -1).join(', ')} or ${years[years.length - 1]}`);

/**
 * The note for a student at `study`, or null: only an undergraduate (a
 * graduate is not "Year N") whose home year is below the lowest year the
 * prerequisite names.
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
