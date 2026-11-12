// @ts-check
// The shortlist's export (Phase 6 6D; docs/plans/phase6.md 6D), as one
// document both exports draw: the CSV (csv.js) and the print page (print.js).
// Pure: no DOM; test/web/csv.node.test.js runs it in Node.
//
// Every entry is worked out at its own semester (shortlist.js), as in the
// view. The document holds, in order: the head; each semester present, Sem 1
// then Sem 2, with its primary picks then its backups in rank order and its
// totals; the entries closed, or off NUS's exchange list, in their semester;
// the entries not placed in a semester; then the foot: NUS's form order and
// the lines for applicants, the CourseReg box and the closing lines.
// The description is NUS's, labelled as such, never called a syllabus (G1).
import { noteLead, reasonLine, stampText } from './explain.js';
import { cleanPrereq, examLine, examLines, semLabel } from './format.js';
import { APPLICANT_LINES, COURSEREG_BOX, FORM_LINES, TOTAL_LINES, totalLines } from './shortlist.js';

/** @typedef {import('./shortlist.js').Result} Result */
/** @typedef {import('./shortlist.js').Worked} Worked */
/** @typedef {import('./shortlist.js').Answer} Answer */
/** @typedef {import('./shortlist.js').Course} Course */
/** @typedef {import('./explain.js').Source} Source */
/**
 * @typedef {{ key: string, label: string, value: string }} Line a label and its value (the CSV's label/value rows)
 * @typedef {{ key: string, label: string }} Column
 * @typedef {{
 *   code: string, which: 'pick' | 'alt', rank: number, sem: '' | '1' | '2', status: 'open' | 'note' | 'closed' | null,
 *   cells: Record<string, string>,
 * }} Entry one course's block: `cells` by column key, every value plain text
 * @typedef {{ heading: string, entries: Entry[] }} Group
 * @typedef {{ id: '1' | '2' | 'closed' | 'unplaced', heading: string, groups: Group[], totals: string[] }} Section
 * @typedef {{ number: string, code: string, list: string, units: string, note: string, mark: boolean }} FormRow
 *   `list` "pick 1"; `note` the 10-course caution, or why it takes no number (the 40-unit mark)
 * @typedef {{ sem: '1' | '2', caption: string, rows: FormRow[], note: string }} FormTable
 * @typedef {{
 *   stem: string, title: string, head: Line[], columns: Column[], sections: Section[],
 *   form: { heading: string, intro: string, tables: FormTable[], applicants: string[] },
 *   courseReg: { heading: string, rules: string[], page: string }, closing: Line[],
 * }} Doc
 */

/** The site, by its name and canonical URL (ADR 0009, ADR 0010). */
export const SITE_NAME = 'NUS Mod Finder';
export const SITE_URL = 'https://nusmodfinder.rcn.sh';

/** The sections after the semesters'. */
export const SECTION = Object.freeze({
  closed: 'Closed, or not on NUS\'s exchange list, in that semester',
  unplaced: 'Not placed in a semester',
});

/** G1: NUS's description, labelled as such. */
export const DESCRIPTION_LABEL = 'Course description (NUS, via NUSMods)';
/** G1, and the Registrar's NG course list: where the syllabus is. */
export const CANVAS_LINE = 'NUS posts each course\'s full syllabus on Canvas when the semester starts; the text here is NUS\'s course description (the Registrar\'s NG course list)';
/** NUS's rate (the Registrar's transcript legend; the brochure's 4 units for about 10 hours). */
const HOURS_PER_UNIT = 2.5;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The year of study, as the head says it. @type {Readonly<Record<string, string>>} */
const STUDY_YEAR = Object.freeze({ ug1: '1', ug2: '2', ug3: '3', ug4: '4 or later', grad: 'Graduate' });

/** @param {number} n */
const num = (n) => String(Math.round(n * 100) / 100);
/** A sentence's full stop, unless it has one. @param {string} s */
const end = (s) => (/[.!?]["”)]?$/.test(s) ? s : `${s}.`);
/** 'Not on NUS's …' → 'not on NUS's …', for after "Not counted:". @param {string} s */
const lower = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * Every column of the CSV, in order; the print page labels its facts the same way.
 * @param {string} year 'YYYY/YY', the rows' year
 * @returns {Column[]}
 */
export function columnsFor(year) {
  return [
    { key: 'section', label: 'Section' }, { key: 'sem', label: 'Semester' }, { key: 'list', label: 'List' }, { key: 'rank', label: 'Rank' },
    { key: 'form', label: 'NUS\'s application form' }, { key: 'code', label: 'Code' }, { key: 'title', label: 'Title' }, { key: 'units', label: 'Units' },
    { key: 'department', label: 'Department' }, { key: 'faculty', label: 'Faculty' }, { key: 'level', label: 'Level' }, { key: 'grading', label: 'Grading' },
    { key: 'counts', label: 'Counts' }, { key: 'status', label: 'Exchange status' }, { key: 'notes', label: 'Exchange notes' },
    { key: 'nus', label: 'NUS\'s notes' }, { key: 'exam', label: `${year} exam` }, { key: 'workload', label: 'Workload (NUSMods)' },
    { key: 'estimate', label: 'Estimated study time' }, { key: 'description', label: DESCRIPTION_LABEL },
    { key: 'prerequisite', label: 'Prerequisite' }, { key: 'preclusion', label: 'Preclusion' }, { key: 'flags', label: 'Flags' },
    { key: 'nusmods', label: 'NUSMods' },
  ];
}

/**
 * The level from its digit, as the brochure and the Registrar put it.
 * @param {unknown} level
 */
export function levelText(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n <= 3) return 'Level 1000–3000, undergraduate';
  if (n === 4) return 'Level 4000, Honours';
  return 'Level 5000 and above, graduate';
}

/**
 * NUSMods' workload as listed: each of the five parts labelled, hours a week;
 * that it lists no lecture, tutorial or lab hours when so; NUS's own text
 * when it isn't the five-number form; or that it isn't listed.
 * @param {Course['workload']} w
 */
export function workloadLine(w) {
  if (!w) return 'Not listed';
  if ('raw' in w) return `As NUS lists it: ${w.raw}`;
  const parts = `Lecture ${num(w.lecture)}, tutorial ${num(w.tutorial)}, lab ${num(w.lab)}, project ${num(w.project)}, preparation ${num(w.prep)} hours a week (${num(w.total)} in all)`;
  return w.lecture === 0 && w.tutorial === 0 && w.lab === 0 ? `${parts}. NUSMods lists no lecture, tutorial or lab hours` : parts;
}

/**
 * The estimated study time (G1): hours a week at NUS's rate, with NUSMods'
 * own total where it differs, and that the student's university decides credit.
 * @param {number | null} units
 * @param {Course['workload']} w
 */
export function estimateLine(units, w) {
  const listed = w && !('raw' in w) ? w.total : null;
  const nusmods = listed !== null ? `NUSMods lists ${num(listed)} hours a week for this course` : '';
  const rate = `${TOTAL_LINES.rate}.`;
  if (units === null) return `No estimate: NUS lists no units for it.${nusmods ? ` ${nusmods}.` : ''} ${rate}`;
  if (units === 0) return `NUS lists it as 0 units, so NUS's rate gives no hours.${nusmods ? ` ${nusmods}.` : ''} ${rate}`;
  const est = units * HOURS_PER_UNIT;
  const differs = listed !== null && Math.round(listed * 100) !== Math.round(est * 100);
  return `About ${num(est)} hours a week (NUS's rate: ${HOURS_PER_UNIT} hours a week per unit)${differs ? `; ${nusmods}` : ''}. ${rate}`;
}

/** "12 Nov YYYY", the date the student made it on (their own clock). @param {Date} d */
export const madeOn = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** @param {Source[] | null | undefined} sources @param {RegExp} name */
const dateOf = (sources, name) => {
  const s = (sources ?? []).find((x) => name.test(String(x?.name ?? '')));
  return typeof s?.updatedAsAt === 'string' ? s.updatedAsAt : '';
};

/** Whether an entry's course is taught only in special terms. @param {Worked} w */
const specialOnly = (w) => {
  const sems = Array.isArray(w.course?.semesters) ? w.course.semesters.map(Number) : [];
  return w.kind === 'row' && sems.length > 0 && sems.every((s) => s >= 3);
};

/**
 * Where an entry goes: its semester; the closed section (closed, or off
 * NUS's list, or not taught then, in its semester); or not placed (untagged,
 * taught only in special terms, a catalogue-only or unknown 404).
 * @param {Worked} w
 * @returns {Section['id']}
 */
function placeOf(w) {
  if (!w.sem || w.kind === 'catalogue-only' || w.kind === 'unknown' || specialOnly(w)) return 'unplaced';
  if (w.standing === 'out' && w.course && w.units !== null) return 'closed';
  return w.sem;
}

/** Whether the entry counts, and why or why not. @param {Worked} w @param {boolean} exchange */
function countsLine(w, exchange) {
  switch (w.standing) {
    case 'counted': return exchange ? 'Counted, if NUS accepts you into it' : 'Counted: exchange status not checked';
    case 'confirm': return `To confirm with NUS: ${end(lower(w.why.replace(/^To confirm with NUS: /, '')))}`;
    case 'invite': return `${w.why} (not counted unless you say you were invited)`;
    case 'duplicate': return `Not counted: the same course as ${w.sameAs}.`;
    case 'pending': return w.kind === 'failed' ? 'Details could not be loaded: the totals say “at least”.' : 'Still loading: the totals say “at least”.';
    default: return `Not counted: ${end(lower(w.why))}`;
  }
}

/** NUS's form: the entry's number, or why none. @param {Worked} w @param {boolean} exchange */
function formLine(w, exchange) {
  if (!exchange) return '';
  if (w.form.number) return w.form.note ? `${w.form.text}. ${end(w.form.note)}` : w.form.text;
  if (w.form.text === 'Not on the form' && w.sem && w.status === 'closed') return `Not on the form: not open in ${semLabel(w.sem)}`;
  if (w.form.text === 'Not on the form' && !w.sem && (w.kind === 'row' || w.kind === 'ng-listed')) return 'Not on the form until you choose a semester';
  return w.form.text;
}

/**
 * The exchange entry at a semester and study level, from a course's `exchange`.
 * @param {Course | null} c @param {number} sem @param {string} study
 */
const exchangeAt = (c, sem, study) => (Array.isArray(c?.exchange) ? c.exchange : []).find((x) => String(x.sem) === String(sem) && x.study === study);

/**
 * The stamp's words and every note in full, with its source and date: at its
 * own semester, or each semester's when none is chosen.
 * @param {Worked} w @param {string} study @param {string} year @param {Source[] | null} sources
 * @returns {{ status: string, notes: string[] }}
 */
function statusOf(w, study, year, sources) {
  const c = w.course;
  /** @type {string[]} */
  const notes = [];
  /** @param {import('./explain.js').Reason} r @param {number} sem */
  const note = (r, sem) => `${noteLead(r.kind)} ${reasonLine(r, sem, sources)}`;
  let status = '';
  if (w.kind === 'catalogue-only') status = `Not offered in ${year}`;
  else if (w.kind === 'unknown') status = `No course with this code in ${year}`;
  else if (w.kind === 'failed' || w.kind === 'loading') status = 'Details could not be loaded';
  else if (!study) status = 'Not checked: no year of study set';
  else if (w.sem) {
    status = w.status ? stampText(w.status, Number(w.sem), w.reasons) : 'Could not be read: ask NUS';
    for (const r of w.reasons) notes.push(note(r, Number(w.sem)));
  } else {
    const per = [1, 2].map((s) => ({ s, x: exchangeAt(c, s, study) })).filter((p) => p.x);
    status = per.map((p) => stampText(/** @type {any} */ (p.x).status, p.s, p.x?.reasons ?? [], true)).join('; ');
    for (const p of per) for (const r of p.x?.reasons ?? []) notes.push(`${semLabel(p.s)}: ${note(r, p.s)}`);
  }
  // A Business or Law quota note "If you were invited: …" is said under the totals, as in the view.
  for (const line of w.lines) if (line !== w.why && !line.startsWith('If you were invited:')) notes.push(end(line));
  return { status, notes };
}

/** The exam at its semester, in Singapore time with its length. @param {Worked} w */
function examOf(w) {
  const c = w.course;
  if (!c) return '';
  if (w.kind === 'ng-listed') return 'Exam timetable not published in NUSMods';
  const exams = Array.isArray(c.examDates) ? c.examDates : [];
  if (w.sem) {
    const e = exams.find((x) => String(x.sem) === w.sem);
    return e ? `${examLine({ ...e, durationMins: e.durationMins ?? 0 }).replace(/^[^:]+: /, '')} (Singapore time)` : 'No final exam listed';
  }
  const lines = examLines(exams.map((e) => ({ ...e, durationMins: e.durationMins ?? 0 })));
  return exams.length ? `${lines.join('; ')} (Singapore time)` : lines[0];
}

/** A flag as its line. @param {import('./shortlist.js').Flag} f */
const flagLine = (f) => (f.kind === 'preclusion' && f.quote ? `${f.text}. NUS: “${cleanPrereq(f.quote)}”` : end(f.text));

/**
 * One course's block.
 * @param {Worked} w @param {Section['id']} place @param {{ result: Result, study: string, sources: Source[] | null, answers: Map<string, Answer> }} ctx
 * @returns {Entry}
 */
function entryOf(w, place, { result, study, sources, answers }) {
  const c = w.course;
  const answer = answers.get(w.code);
  const { status, notes } = statusOf(w, study, result.year, sources);
  const catalogue = answer?.kind === 'catalogue-only' ? answer : null;
  const description = c ? String(c.description ?? '') : catalogue ? catalogue.description : w.kind === 'failed' || w.kind === 'loading' ? 'Details could not be loaded' : '';
  const nusText = (/** @type {string | null | undefined} */ t) => (c ? cleanPrereq(t) || 'None listed' : '');
  const grading = c && typeof c.gradingBasis === 'string' && c.gradingBasis && c.gradingBasis !== 'Graded' ? c.gradingBasis : '';
  return {
    code: w.code, which: w.which, rank: w.rank, sem: w.sem, status: w.status,
    cells: {
      section: place === 'closed' ? SECTION.closed : place === 'unplaced' ? SECTION.unplaced : semLabel(place),
      sem: w.sem ? semLabel(w.sem) : 'No semester chosen',
      list: w.which === 'pick' ? 'Primary pick' : 'Backup',
      rank: String(w.rank),
      form: formLine(w, result.exchange),
      code: w.code,
      title: w.kind === 'unknown' ? 'No course with this code' : w.kind === 'failed' || w.kind === 'loading' ? 'Details could not be loaded' : w.title,
      units: w.units !== null ? num(w.units) : c ? 'Not listed' : '',
      department: String(c?.department ?? ''),
      faculty: String(c?.faculty ?? ''),
      level: levelText(c?.level),
      grading,
      counts: countsLine(w, result.exchange),
      status,
      notes: notes.join('\n'),
      nus: w.notes.map(end).join('\n'),
      exam: examOf(w),
      workload: c ? workloadLine(c.workload) : '',
      estimate: c ? estimateLine(w.units, c.workload ?? null) : '',
      description,
      prerequisite: nusText(c?.prerequisite),
      preclusion: nusText(c?.preclusion),
      flags: w.flags.map(flagLine).join('\n'),
      nusmods: c?.nusmodsUrl || (c || catalogue ? `https://nusmods.com/courses/${w.code}` : ''),
    },
  };
}

/**
 * The semesters the document plans: those with an entry placed in them (not
 * one closed then, nor one not placed in a semester). They name the title, the
 * file and the semester sections, so none is named with nothing planned in it.
 * @param {Result} result
 * @returns {('1' | '2')[]}
 */
const plannedSems = (result) => /** @type {('1' | '2')[]} */ (['1', '2']).filter((s) => result.entries.some((w) => placeOf(w) === s));

/**
 * The file name's stem: the semesters planned (`sem1`, `sem1-sem2`, none) and
 * the rows' year (shortlist.js: the rows', else a 404's, else public/year.js).
 * @param {Result} result
 */
export function stemOf(result) {
  const sems = plannedSems(result).map((s) => `sem${s}-`).join('');
  return `exchange-shortlist-${sems}${result.year.replace('/', '-')}-courses`;
}

/** The file name: the stem and its extension. @param {Doc} doc @param {string} ext */
export const fileName = (doc, ext) => `${doc.stem}.${ext}`;

/**
 * The export's document.
 * @param {{
 *   result: Result, list: import('./list.js').List, study: string, sources: Source[] | null,
 *   link: string, today: Date, answers?: Map<string, Answer>, yearNote?: string,
 * }} input `study` '' in browse mode; `sources` /facets' ngSources (null if it failed);
 *   `link` the shortlist link; `yearNote` the "Made with YYYY/YY courses" line, if any
 * @returns {Doc}
 */
export function buildExport({ result, list, study, sources, link, today, answers = new Map(), yearNote = '' }) {
  const year = result.year;
  const ctx = { result, study, sources, answers };
  const tagged = plannedSems(result);
  const semsText = tagged.map(semLabel).join(' and ');
  const title = `Courses planned${semsText ? ` for ${semsText}` : ''}, based on NUS's ${year} courses, exams and exchange list`;
  const listDate = dateOf(sources, /offered/i);
  const rulesDate = dateOf(sources, /restriction/i);

  /** @type {Line[]} */
  const head = [
    { key: 'title', label: 'Shortlist', value: title },
    { key: 'study', label: 'Year of study during the exchange', value: STUDY_YEAR[study] ?? 'Not set: exchange status not checked' },
    { key: 'made', label: 'Made on', value: madeOn(today) },
    { key: 'link', label: 'Shortlist link', value: link },
  ];
  if (yearNote) head.push({ key: 'year', label: 'Year of the data', value: yearNote });
  const invited = list.inv.map((x) => (x === 'biz' ? 'NUS Business School' : 'NUS Law'));
  if (invited.length) head.push({ key: 'invited', label: 'Invited to apply by', value: invited.join(' and ') });
  head.push(
    { key: 'later', label: 'For a later year', value: `For a later year, check that year's: NUS publishes the exchange course list in March or April and updates it later (${listDate ? `this one is dated ${listDate.replace(/^0/, '')}` : 'this one\'s date is unavailable'}), and publishes the course descriptions and exam timetable in July or August (NUS Global; the Registrar says the timetable comes mid-July).` },
    { key: 'site', label: 'Made with', value: `${SITE_NAME}, ${SITE_URL}` },
  );

  /** @param {Worked[]} ws @returns {Group[]} */
  const groups = (ws) => [
    { heading: 'Primary picks', entries: ws.filter((w) => w.which === 'pick') },
    { heading: 'Backups', entries: ws.filter((w) => w.which === 'alt') },
  ].filter((g) => g.entries.length).map((g) => ({ heading: g.heading, entries: g.entries.map((w) => entryOf(w, placeOf(w), ctx)) }));

  /** @type {Section[]} */
  const sections = tagged.map((sem) => {
    const inSem = result.entries.filter((w) => placeOf(w) === sem);
    const quota = result.entries.filter((w) => w.sem === sem && w.standing === 'invite').flatMap((w) => w.lines.filter((l) => l.startsWith('If you were invited:')));
    return {
      id: sem, heading: semLabel(sem), groups: groups(inSem),
      totals: [...totalLines(sem, result.sems[sem], { exchange: result.exchange, year }), ...new Set(quota)],
    };
  });
  for (const id of /** @type {const} */ (['closed', 'unplaced'])) {
    const ws = result.entries.filter((w) => placeOf(w) === id);
    if (ws.length) sections.push({ id, heading: SECTION[id], groups: groups(ws), totals: [] });
  }

  /** @type {FormTable[]} */
  const tables = [];
  if (result.exchange) {
    for (const sem of /** @type {('1' | '2')[]} */ (['1', '2'])) {
      const t = result.sems[sem].form;
      const order = [...result.entries.filter((w) => w.which === 'pick'), ...result.entries.filter((w) => w.which === 'alt')]
        .filter((w) => w.sem === sem && (w.form.number || w.form.text === FORM_LINES.over));
      if (!t || !order.length) continue;
      tables.push({
        sem, caption: t.line, note: result.fullYear && sem === '2' ? end(FORM_LINES.fullYear) : '',
        rows: order.map((w) => ({
          number: w.form.number ? String(w.form.number) : '–', code: w.code, list: `${w.which === 'pick' ? 'pick' : 'backup'} ${w.rank}`,
          units: w.units === null ? '?' : num(w.units), note: w.form.number ? (w.form.note ? end(w.form.note) : '') : lower(w.form.text), mark: !w.form.number,
        })),
      });
    }
  }

  return {
    stem: stemOf(result),
    title,
    head,
    columns: columnsFor(year),
    sections,
    form: {
      heading: 'NUS\'s application form order, for applicants',
      intro: result.exchange ? FORM_LINES.applicants(year, listDate) : end(FORM_LINES.setYear),
      tables,
      applicants: [...APPLICANT_LINES],
    },
    courseReg: { heading: 'Already admitted? NUS\'s rules for CourseReg', rules: [...COURSEREG_BOX.rules], page: COURSEREG_BOX.page },
    closing: [
      { key: 'canvas', label: 'Syllabus', value: CANVAS_LINE },
      { key: 'transfer', label: 'Credit', value: '“Transfer of units is entirely at the discretion of your home university” (GRO)' },
      { key: 'lists', label: 'Lists', value: `NG course list updated as at${listDate ? ` ${listDate}` : ': date unavailable'}; NG course restrictions updated as at${rulesDate ? ` ${rulesDate}` : ': date unavailable'}` },
      { key: 'unchecked', label: 'Not checked', value: 'Class times and corequisites aren\'t checked here' },
      { key: 'syllabi', label: 'Prerequisites', value: 'For courses that have prerequisites, NUS asks for the syllabi of the courses you have completed or are taking (NUS\'s brochure)' },
      { key: 'unofficial', label: 'Unofficial', value: 'Unofficial. Check with NUS before you register.' },
    ],
  };
}
