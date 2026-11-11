// @ts-check
// The shortlist worked out (Phase 6 6B; docs/plans/phase6.md 6B
// "shortlist.js"): from the list, the study level and each code's /module
// answer, what counts, what is to confirm with NUS and what isn't counted and
// why; the same course listed twice; NUS's form order for each semester; the
// totals for each semester; the exam-overlap and preclusion flags; NUS's
// notes on particular courses; and the lines NUS's own sources give. Pure: no
// DOM, no fetch; test/web/shortlist.node.test.js runs it in Node. The view
// (6C) and the exports (6D) render what it returns.
//
// Every entry is worked out at its own semester, whatever the state's `sem`,
// which only sets which semester's totals come first. Rank is the entry's
// place in its `pick` or `alt` sequence, one order for the year.
import { semLabel } from './format.js';
import { names } from './preclusion.js';
import { DEFAULT_ACAD_YEAR } from './year.js';

/** @typedef {import('./list.js').List} List */
/** @typedef {import('./list.js').Which} Which */
/** @typedef {import('./explain.js').ExchangeEntry} ExchangeEntry */
/** @typedef {import('./explain.js').Reason} Reason */
/**
 * A course: a /module/:code row, or a 404 of kind `ng-listed` (6A) read as one.
 * @typedef {{
 *   code?: string, title?: string | null, credits?: number | null, department?: string | null,
 *   faculty?: string | null, level?: number | null, semesters?: number[], ng?: boolean,
 *   ng_semesters?: number[], exchange?: ExchangeEntry[] | null,
 *   examDates?: { sem: number, date: string, durationMins: number | null }[] | null,
 *   preclusion?: string | null, otherCodes?: string[] | null, acad_year?: string, acadYear?: string,
 *   description?: string | null, prerequisite?: string | null, gradingBasis?: string | null, nusmodsUrl?: string,
 *   workload?: { lecture: number, tutorial: number, lab: number, project: number, prep: number, total: number } | { raw: string } | null,
 * }} Course
 * @typedef {{ kind: 'row', course: Course } | { kind: 'ng-listed', course: Course }
 *   | { kind: 'catalogue-only', title: string, description: string, acadYear: string } | { kind: 'unknown', acadYear: string }
 *   | { kind: 'loading' } | { kind: 'failed' }} Answer
 * @typedef {{ id: string, text: string, scope?: { departments?: string[], faculties?: string[], levels?: number[] } | null }} OffListRule
 *   /facets' `offListRules` (6A, data/ng-reasons.json): `levels` as digits (4 is level 4000)
 * @typedef {'counted' | 'confirm' | 'invite' | 'out' | 'pending' | 'duplicate'} Standing
 *   `invite`: a Business or Law course the student hasn't said they were invited for (to confirm, on a line of its own)
 * @typedef {{ kind: 'exam' | 'preclusion' | 'group', with: string, text: string, quote?: string }} Flag
 * @typedef {{
 *   code: string, which: Which, rank: number, sem: '' | '1' | '2', kind: Answer['kind'],
 *   course: Course | null, title: string, units: number | null,
 *   standing: Standing, why: string, status: 'open' | 'note' | 'closed' | null, reasons: Reason[],
 *   audition: boolean, faculty: '' | 'biz' | 'law', sameAs: string,
 *   lines: string[], notes: string[], flags: Flag[],
 *   form: { number: number | null, text: string, note: string },
 * }} Worked
 * @typedef {{
 *   picked: number, counted: number, confirm: number, invite: number, pending: number, economics: number,
 *   hours: number, overlap: boolean, over20: boolean, form: { units: number, line: string } | null,
 * }} Totals
 * @typedef {{
 *   entries: Worked[], sems: { '1': Totals, '2': Totals }, order: ('1' | '2')[],
 *   year: string, exchange: boolean, fullYear: boolean,
 * }} Result
 */

// ---------------------------------------------------------------- NUS's words
// Each quoted word for word from the source named beside it (docs/plans/phase6.md §1 "NUS's own words").

/** GRO, "Incoming Exchange Students", on Business, Law and Economics courses after the offer. */
export const GRO_POPULAR = 'If you are not successful in gaining placements into these popular courses at the point of offer, you are not able to add these courses during CourseReg';
/** GRO, on Business and Law courses. */
export const GRO_BIZ_LAW = 'Business and Law courses are only available to students who are invited by NUS Business School and NUS Law respectively to apply for the exchange during the nomination period';
/** The Registrar's restrictions, rule E, on courses off the exchange list. */
export const RULE_E = 'not available during application stage but may be available during Course registration';
/** GRO, on the semester's length. */
export const GRO_WEEKS = 'Each semester normally includes 13 weeks of instruction and 2 weeks of examinations';

/**
 * NUS's notes on particular courses (a lead rule: NUS's own cautions, cited).
 * GRO's level 4000 sentence is not one of them: under Jacob's ruling R6-2 it
 * is an exchange note on the /module answer (src/level-note.js), counted like
 * a quota note (CONDITION_KINDS), so the row says it once, among its notes.
 */
export const NOTES = Object.freeze({
  oversubscribed: 'NUS says these courses are extremely oversubscribed, gives priority to students majoring in them, and advises students with other majors against choosing them (GRO)',
  psychology: 'NUS says Psychology courses are extremely oversubscribed (GRO)',
  popular: `GRO: “${GRO_POPULAR}”`,
  language1: 'NUS needs a separate form in your application for a Level 1000 language course (GRO)',
  language2: '“Enrolment in higher level language courses (2XXX and above) will be conditional on the placement test result” (the Registrar\'s NG course list)',
  master: 'NUS: master-level courses are open only to students on a master-level exchange agreement (GRO)',
});

/** The lines on a Business or Law course's row. */
export const BIZ_LAW = Object.freeze({
  gro: `GRO: “${GRO_BIZ_LAW}”`,
  question: Object.freeze({
    biz: 'Did NUS Business School invite you to apply for its exchange programme (an invitation during the nomination period)?',
    law: 'Did NUS Law invite you to apply for its exchange programme (an invitation during the nomination period)?',
  }),
  invited: Object.freeze({
    biz: [
      'NUS Business School\'s exchange students add courses in CourseReg (NUS Business School\'s factsheet)',
      '“During the Online Application, only core BBA courses are available” (NUS Business School\'s factsheet)',
      '“At least 50% of a student\'s total course load must consist of Business School courses” (NUS Business School\'s factsheet)',
    ],
    law: [
      'NUS Law registers its exchange students for Law courses itself (GRO)',
      'Students taking Law courses who come from universities that don\'t teach in English need a TOEFL or IELTS result (NUS\'s document checklist)',
    ],
  }),
  uninvited: Object.freeze({
    biz: [
      'Only for students invited by NUS Business School',
      'If you\'re not sure whether you were, ask your exchange office',
      'NUS\'s CourseReg FAQ: “Only students who have been offered Business courses during the application stage will be able to see the courses”',
    ],
    law: ['Only for students invited by NUS Law', 'If you\'re not sure whether you were, ask your exchange office'],
  }),
});

/** Under the totals of each semester. */
export const TOTAL_LINES = Object.freeze({
  rate: 'NUS states hours a week only; your university\'s own conversion decides credit',
  weeks: `GRO: “${GRO_WEEKS}”`,
  admitted: 'To be admitted, NUS must accept you into at least 12 units in a semester (NUS\'s brochure; GRO: “three pre-registered courses (or 12 units)”)',
  courseReg: 'In CourseReg you must keep at least 12 units or three courses (GRO)',
  // G2, as Jacob worded it after the 6-0 fact check (ADR 0010): word for word, typographic apostrophes.
  maximum: 'NUS’s brochure says at most 23 units a semester, but NUS Global’s exchange page says 20 (NUS Business School’s exchange students: 20). Ask NUS before planning more than 20.',
  // What the maximum limits (G2): a semester's picks above 20 are flagged (Totals.over20), never refused.
  maximumScope: 'This limits the courses NUS enrols you in, not the courses you list',
});

/** The lines for applicants, under the form order. */
export const APPLICANT_LINES = Object.freeze([
  'NUS recommends listing as many relevant courses as you can, up to 40 units (GRO)',
  'NUS recommends ranking your compulsory courses among your top three choices, to increase your chances of securing them (GRO)',
  'NUS\'s form asks, for each course with a prerequisite, the home course that meets it (NUS\'s application guide)',
  'GRO: “If you did not secure any of the popular courses during the first round … please do not repeat your request for any of these courses in subsequent rounds”',
]);

/** NUS's form order: its heading's note, the browse-mode line and the full-year line. */
export const FORM_LINES = Object.freeze({
  /**
   * @param {string} year '2026/27', the rows' year
   * @param {string} listDate the NG list's "updated as at" date from /facets ('01 Sep 2026'), '' if it failed
   */
  applicants: (year, listDate) => {
    const dated = listDate ? ` (the ${year} list is dated ${listDate.replace(/^0/, '')})` : '';
    return `This order uses NUS's ${year} exchange list and exams. Applying for ${nextYear(year)}? NUS publishes Sem 1's list in March or April, Sem 2's later${dated}, and the timetable in July or August (the Registrar says mid-July): check each course there.`;
  },
  setYear: 'Set your year of study during the exchange to see NUS\'s form order',
  fullYear: 'NUS has asked full-year students to choose Sem 2 courses later, by email before Sem 1 ends (NUS info sheet, 2018/19): check with NUS whether to list them now',
  over: 'Won\'t fit in NUS\'s 40 units',
  ten: 'NUS has said up to 10 courses (NUS\'s 2018/19 exchange information sheet): check',
});

/** The CourseReg box, for admitted students: NUS's rules, each cited, then the page's own line, set apart. */
export const COURSEREG_BOX = Object.freeze({
  rules: Object.freeze([
    'Keep at least 12 units or three courses a semester (GRO)',
    'Drop any course that clashes (GRO)',
    `On Business, Law and Economics courses: “${GRO_POPULAR}” (GRO)`,
    'Missing the drop deadlines “could lead to a Grade \'W\' … or \'F\' printed on your transcript” (GRO)',
    'The Registrar\'s Non-Graduating Office signs your Learning Agreement or Study Plan (GRO)',
    '“no particular course can be guaranteed by NUS” (GRO)',
    'A course not approved at application can be requested in “Submit Course Requests” or appealed as “Unable to secure course” (NUS\'s CourseReg FAQ)',
    '“Students are not allowed to read courses with any kind of timetable clashes” (NUS\'s CourseReg FAQ)',
    'You can\'t drop below the minimum workload (NUS\'s CourseReg FAQ)',
    'You may request “up to 23 Units in one course request”; above that, a Max Workload Waiver (NUS\'s CourseReg FAQ)',
    `Courses not on the exchange course list “are ${RULE_E}” (the Registrar's course restrictions, rule E)`,
    '“To check if the course is offered to Non-Graduating students, refer to the Vacancy Report” (NUS\'s CourseReg FAQ)',
    'Get your home university\'s approval before changing your study plan (NUS\'s brochure)',
  ]),
  page: 'This page can\'t see your offer. Your offer and CourseReg show which courses are yours.',
});

// ---------------------------------------------------------------- helpers

/**
 * Note kinds the student can meet: counted, "if NUS accepts you into each".
 * `supply` is GRO's level 4000 note (R6-2), a condition like `quota`.
 */
export const CONDITION_KINDS = Object.freeze(['quota', 'supply', 'major', 'approval', 'graded', 'letter', 'fee']);
const OFF_LIST = ['ng-list:not-listed', 'ng-list:not-in-semester'];
const RULE_E_ID = 'E-offerings-list';
/** NUS's 40 units, in tenths. */
const FORM_TENTHS = 400;
/** NUS's rate: 2.5 hours a week per unit (the Registrar's transcript legend; the brochure's 4 units for about 10 hours). */
const HOURS_PER_UNIT = 2.5;

/** '2026-2027' → '2026/27'. @param {string} ay */
export const yearLabel = (ay) => {
  const m = /^(\d{4})-\d{2}(\d{2})$/.exec(ay);
  return m ? `${m[1]}/${m[2]}` : ay;
};
/** '2026/27' → '2027/28'. @param {string} label */
function nextYear(label) {
  const m = /^(\d{4})\/(\d{2})$/.exec(label);
  return m ? `${Number(m[1]) + 1}/${String((Number(m[2]) + 1) % 100).padStart(2, '0')}` : 'a later year';
}

/** A sum in tenths, so 2.5 + 1.5 is 4. @param {number} n */
const tenths = (n) => Math.round(n * 10);
/** @param {number} t tenths */
const fromTenths = (t) => t / 10;

/** The letters a code starts with: CS2030S → CS. @param {string} code */
const lettersOf = (code) => /^[A-Z]+/.exec(code)?.[0] ?? '';
/** @param {unknown} v @returns {number[]} */
const nums = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
/** @param {unknown} v @returns {string[]} */
const strs = (v) => (Array.isArray(v) ? v.map(String) : []);

/** Business or Law, by faculty, as NUSMods names them. @param {Course | null} c @returns {'' | 'biz' | 'law'} */
const facultyKind = (c) => (c?.faculty === 'NUS Business School' ? 'biz' : c?.faculty === 'Law' ? 'law' : '');

/**
 * A /module or /search outcome (api.js) as an answer: a row, a 404's kind
 * (6A: `error.detail.kind`; a 404 without one is `unknown`), loading
 * (no outcome yet) or failed.
 * @param {any} outcome
 * @returns {Answer}
 */
export function answerOf(outcome) {
  if (!outcome) return { kind: 'loading' };
  if (outcome.kind === 'ok') return outcome.body && typeof outcome.body === 'object' ? { kind: 'row', course: outcome.body } : { kind: 'failed' };
  if (outcome.kind === 'error' && outcome.error?.status === 404) {
    const d = outcome.error.detail && typeof outcome.error.detail === 'object' ? outcome.error.detail : {};
    const acadYear = typeof d.acadYear === 'string' ? d.acadYear : '';
    if (d.kind === 'ng-listed') {
      // NUS lists it for these semesters; NUSMods shows no classes in any.
      const listed = nums(d.ngSemesters ?? d.ng_semesters ?? d.semesters);
      return { kind: 'ng-listed', course: { ...d, ng: true, semesters: [], ng_semesters: listed, acad_year: acadYear } };
    }
    if (d.kind === 'catalogue-only') {
      // Its title and description, so the exports carry its text (6A, 6D).
      return { kind: 'catalogue-only', title: typeof d.title === 'string' ? d.title : '', description: typeof d.description === 'string' ? d.description : '', acadYear };
    }
    return { kind: 'unknown', acadYear };
  }
  return { kind: 'failed' };
}

/**
 * The exchange entry at a semester and study level.
 * @param {Course} c @param {number} sem @param {string} study
 */
const exchangeAt = (c, sem, study) => (Array.isArray(c.exchange) ? c.exchange : []).find((x) => String(x.sem) === String(sem) && x.study === study);

/**
 * The semesters (of 1 and 2) a course is open in at `study` (exchange mode),
 * or taught in (browse mode): what a new entry's tag is chosen from (list.js tagFor).
 * @param {Answer} answer
 * @param {string} study
 * @returns {number[]}
 */
export function openSems(answer, study) {
  if (answer.kind !== 'row' && answer.kind !== 'ng-listed') return [];
  const c = answer.course;
  if (!study) return nums(c.semesters).filter((s) => s === 1 || s === 2);
  return [1, 2].filter((s) => {
    if (answer.kind === 'ng-listed' && !nums(c.ng_semesters).includes(s)) return false;
    const x = exchangeAt(c, s, study);
    return !!x && x.status !== 'closed';
  });
}

/**
 * The semesters an entry's buttons offer: those the course is taught in or,
 * in exchange mode, on NUS's list for (ACC1701XB: listed for both, taught in
 * Sem 2); an NG-listed 404, the semesters NUS lists it for; any other 404, none.
 * @param {Answer} answer
 * @param {string} study
 * @returns {number[]}
 */
export function semChoices(answer, study) {
  if (answer.kind === 'ng-listed') return nums(answer.course.ng_semesters).filter((s) => s === 1 || s === 2);
  if (answer.kind !== 'row') return [];
  const c = answer.course;
  const sems = new Set([...nums(c.semesters), ...(study ? nums(c.ng_semesters) : [])]);
  return [1, 2].filter((s) => sems.has(s));
}

/** Whether a course is taught only in special terms. @param {Answer} answer */
const specialOnly = (answer) => answer.kind === 'row' && nums(answer.course.semesters).length > 0 && nums(answer.course.semesters).every((s) => s >= 3);

/**
 * The year the shortlist prints: the rows' (the first loaded row in the
 * list's order), else a 404's, else public/year.js's.
 * @param {List} list
 * @param {Map<string, Answer>} answers
 */
export function yearOf(list, answers) {
  const all = [...list.pick, ...list.alt].map((e) => answers.get(e.code));
  for (const a of all) if (a && (a.kind === 'row' || a.kind === 'ng-listed') && typeof a.course.acad_year === 'string' && a.course.acad_year) return a.course.acad_year;
  for (const a of all) if (a && (a.kind === 'catalogue-only' || a.kind === 'unknown') && a.acadYear) return a.acadYear;
  return DEFAULT_ACAD_YEAR;
}

/**
 * "Made with 2026/27 courses; showing 2027/28's" when the link's `ay` isn't
 * the rows' year; '' otherwise (or before any row loads).
 * @param {string} ay the list's `ay`
 * @param {string} rowsYear the loaded rows' acad_year, '' before any
 */
export function yearLine(ay, rowsYear) {
  return ay && rowsYear && ay !== rowsYear ? `Made with ${yearLabel(ay)} courses; showing ${yearLabel(rowsYear)}'s` : '';
}

/**
 * Loaded rows from an older acad year than the newest one loaded (an ingest
 * within the cache's 5 minutes): refetched once with `cache: 'reload'`.
 * @param {Map<string, Answer>} answers
 * @returns {string[]}
 */
export function staleRows(answers) {
  /** @type {[string, string][]} */
  const years = [];
  for (const [code, a] of answers) if (a.kind === 'row' && typeof a.course.acad_year === 'string') years.push([code, a.course.acad_year]);
  const newest = years.map(([, y]) => y).sort().at(-1) ?? '';
  return years.filter(([, y]) => y < newest).map(([code]) => code);
}

/**
 * Whether an off-list rule's scope covers a course: one of its departments
 * (and, if it names levels, one of them, as digits: 4 is level 4000), or one
 * of its faculties. Never by code prefix. Rule E's scope is `{}`: it covers
 * nothing on its own, and is the line used when no other rule does.
 * @param {OffListRule['scope']} scope
 * @param {Course} c
 */
function covers(scope, c) {
  const departments = strs(scope?.departments);
  const faculties = strs(scope?.faculties);
  if (!departments.length && !faculties.length) return false;
  if (departments.length && !departments.includes(String(c.department ?? ''))) return false;
  if (faculties.length && !faculties.includes(String(c.faculty ?? ''))) return false;
  const levels = nums(scope?.levels);
  return !levels.length || levels.includes(Number(c.level));
}

/**
 * Why an entry off NUS's exchange list for its semester isn't counted, with
 * what NUS says about adding it later: a department's or faculty's no-appeal
 * rule, GRO's sentence for an EC-coded or Law course, else rule E. With no
 * rules (/facets failed), "ask NUS whether it can be added later".
 * @param {string} code @param {Course} c @param {number} sem @param {OffListRule[] | null} rules @param {string} year
 */
function offListWhy(code, c, sem, rules, year) {
  const head = `Not on NUS's ${year} exchange course list for ${semLabel(sem)}`;
  if (!rules) return `${head}: ask NUS whether it can be added later`;
  const rule = rules.find((r) => r.id !== RULE_E_ID && covers(r.scope, c));
  if (rule) return `${head}. NUS: “${rule.text}”`;
  if (lettersOf(code) === 'EC' || facultyKind(c) === 'law') return `${head}. GRO: “${GRO_POPULAR}”`;
  return `${head}. Courses not on the list “are ${RULE_E}” (the Registrar's course restrictions, rule E)`;
}

// ---------------------------------------------------------------- one entry

/**
 * An entry's standing at its own semester and the study level, before the
 * same-course rule.
 * @param {{ code: string, sem: '' | '1' | '2', which: Which, rank: number }} e
 * @param {Answer} answer
 * @param {{ study: string, rules: OffListRule[] | null, inv: string[], year: string }} ctx
 * @returns {Worked}
 */
function workEntry(e, answer, ctx) {
  const course = answer.kind === 'row' || answer.kind === 'ng-listed' ? answer.course : null;
  const credits = course && typeof course.credits === 'number' && Number.isFinite(course.credits) ? course.credits : null;
  /** @type {Worked} */
  const w = {
    ...e, kind: answer.kind, course, title: course ? String(course.title ?? '') : answer.kind === 'catalogue-only' ? answer.title : '',
    units: credits, standing: 'out', why: '', status: null, reasons: [], audition: false, faculty: facultyKind(course), sameAs: '',
    lines: [], notes: [], flags: [], form: { number: null, text: '', note: '' },
  };
  /** @param {Standing} standing @param {string} why */
  const as = (standing, why) => Object.assign(w, { standing, why });
  if (answer.kind === 'loading') return as('pending', 'Still loading: the totals say “at least”');
  if (answer.kind === 'failed') return as('pending', 'Its details could not be loaded: the totals say “at least”');
  if (answer.kind === 'catalogue-only') return as('out', `Not offered in ${ctx.year}`);
  if (answer.kind === 'unknown') return as('out', `No course with this code in ${ctx.year}`);
  const c = /** @type {Course} */ (course);
  const ngListed = answer.kind === 'ng-listed';
  if (w.faculty) w.lines.push(BIZ_LAW.gro);
  if (specialOnly(answer)) {
    // Its closed stamp at the chosen semester (SC1); the reason is the line below.
    if (e.sem && ctx.study) w.status = exchangeAt(c, Number(e.sem), ctx.study)?.status ?? 'closed';
    return as('out', 'Taught only in special terms: this page plans Sem 1 and Sem 2');
  }
  if (!e.sem) return as('out', 'No semester chosen');
  if (credits === null) return as('out', 'NUS lists no units for it');
  const sem = Number(e.sem);
  const ngLine = `NUS lists it for ${semLabel(sem)} in ${ctx.year}, but NUSMods shows no classes: ask NUS`;
  if (ngListed && !nums(c.ng_semesters).includes(sem)) {
    // Its closed stamp, as a row's (SC1); the reason is the line below, not a note.
    if (ctx.study) w.status = exchangeAt(c, sem, ctx.study)?.status ?? 'closed';
    return as('out', `Not on NUS's exchange list for ${semLabel(sem)} in ${ctx.year}`);
  }
  if (!ctx.study) {
    // Browse mode: no study level, so no exchange status. A pick counts by its units if it is taught then.
    if (ngListed) { w.lines.push(ngLine); return as('confirm', ngLine); }
    if (!nums(c.semesters).includes(sem)) return as('out', `Not taught in ${semLabel(sem)}`);
    return as('counted', 'Counted: exchange status not checked');
  }
  const x = exchangeAt(c, sem, ctx.study);
  if (!x) return as('out', 'NUS\'s exchange status for it could not be read: ask NUS');
  w.status = x.status;
  w.reasons = Array.isArray(x.reasons) ? x.reasons : [];
  if (x.status === 'closed') {
    if (w.reasons.some((r) => OFF_LIST.includes(r.id))) return as('out', offListWhy(e.code, c, sem, ctx.rules, ctx.year));
    return as('out', `Not open to exchange students in ${semLabel(sem)}`);
  }
  const kinds = w.reasons.map((r) => r.kind);
  w.audition = kinds.includes('audition');
  if (ngListed) w.lines.push(ngLine);
  if (w.faculty) {
    if (ctx.inv.includes(w.faculty)) w.lines.push(...BIZ_LAW.invited[w.faculty]);
    else {
      w.lines.push(...BIZ_LAW.uninvited[w.faculty]);
      // Its quota gives priority to the faculty's own partners: not a chance for everyone.
      for (const r of w.reasons) if (r.kind === 'quota') w.lines.push(`If you were invited: ${r.text}`);
      return as('invite', w.faculty === 'biz' ? 'Only for students invited by NUS Business School' : 'Only for students invited by NUS Law');
    }
  }
  if (ngListed) return as('confirm', ngLine);
  if (w.audition) return as('confirm', 'Apply separately: see the note');
  if (kinds.some((k) => !CONDITION_KINDS.includes(k))) return as('confirm', 'To confirm with NUS: read its notes');
  return as('counted', x.status === 'open' ? 'Counted' : 'Counted, if NUS accepts you: read its notes');
}

/**
 * NUS's notes on particular courses (a lead rule): oversubscribed subjects,
 * Economics after the offer, language courses and master-level supply (level
 * 4000 supply is an exchange note, R6-2).
 * @param {Worked} w
 * @param {string} study
 */
function nusNotes(w, study) {
  const c = w.course;
  if (!c) return [];
  const letters = lettersOf(w.code);
  const level = Number(c.level);
  const out = [];
  if (['AR', 'CE', 'CS', 'EC'].includes(letters)) out.push(NOTES.oversubscribed);
  if (letters === 'PL') out.push(NOTES.psychology);
  if (letters === 'EC') out.push(NOTES.popular);
  if (c.department === 'Centre for Language Studies') {
    if (level === 1) out.push(NOTES.language1);
    else if (level >= 2) out.push(NOTES.language2);
  }
  if (level >= 5 && study && w.status === 'closed') out.push(NOTES.master);
  return out;
}

// ---------------------------------------------------------------- the list

/** Entries that take part in the same-course rule, the form and the flags. @param {Worked} w */
const takesPart = (w) => w.standing === 'counted' || w.standing === 'confirm' || w.standing === 'invite';

/** Whether either code's group (`otherCodes`) lists the other. @param {Worked} a @param {Worked} b */
const grouped = (a, b) => strs(a.course?.otherCodes).includes(b.code) || strs(b.course?.otherCodes).includes(a.code);
/** On NUS's exchange list (an NG-listed code with no classes is). @param {Worked} w */
const onNgList = (w) => w.kind === 'ng-listed' || w.course?.ng === true;

/**
 * Two codes are the same course when one group holds both (either side's
 * `otherCodes`) and both are on the NG list (whose groups are each one
 * course), or either's preclusion names the other.
 * @param {Worked} a @param {Worked} b @param {string} study
 */
function sameCourse(a, b, study) {
  if (!grouped(a, b)) return false;
  if (onNgList(a) && onNgList(b)) return true;
  return names(a.course?.preclusion, b.code, study) || names(b.course?.preclusion, a.code, study);
}

/**
 * Settles the same course listed twice, once for the year: counted picks in
 * rank order, then to-confirm picks, each compared only with picks already
 * kept (the relation isn't transitive); then backups in rank order against
 * kept picks and earlier kept backups. The others say "the same course as …"
 * and take no total, number or flag.
 * @param {Worked[]} entries @param {string} study
 */
function settleSameCourse(entries, study) {
  /** @type {Worked[]} */
  const kept = [];
  /** @param {Worked} w @param {Worked[]} against */
  const check = (w, against) => {
    const dup = against.find((k) => sameCourse(k, w, study));
    if (!dup) return true;
    Object.assign(w, { standing: 'duplicate', sameAs: dup.code, why: `The same course as ${dup.code}` });
    return false;
  };
  const picks = entries.filter((w) => w.which === 'pick' && takesPart(w));
  for (const w of picks.filter((p) => p.standing === 'counted')) if (check(w, kept)) kept.push(w);
  for (const w of picks.filter((p) => p.standing !== 'counted')) if (check(w, kept)) kept.push(w);
  /** @type {Worked[]} */
  const keptAlts = [];
  for (const w of entries.filter((x) => x.which === 'alt' && takesPart(x))) if (check(w, [...kept, ...keptAlts])) keptAlts.push(w);
}

/**
 * The exam for a semester, as a time span; null when none is listed.
 * @param {Worked} w @param {string} sem
 */
function examIn(w, sem) {
  const e = (Array.isArray(w.course?.examDates) ? w.course?.examDates ?? [] : []).find((x) => String(x.sem) === sem);
  if (!e) return null;
  const start = Date.parse(e.date);
  return Number.isNaN(start) ? null : { start, mins: typeof e.durationMins === 'number' && e.durationMins > 0 ? e.durationMins : null };
}

/**
 * Whether two exams overlap: start plus duration; a missing duration overlaps
 * only an identical start. Adjacent exams don't.
 * @param {{ start: number, mins: number | null }} a @param {{ start: number, mins: number | null }} b
 */
function overlaps(a, b) {
  if (a.mins === null || b.mins === null) return a.start === b.start;
  return a.start < b.start + b.mins * 60_000 && b.start < a.start + a.mins * 60_000;
}

/**
 * The flags: exam overlaps between any two entries taking part in one
 * semester, picks or backups; preclusions between picks only (a backup a pick
 * precludes is a normal alternative); and group members that aren't the same
 * course, with the check line.
 * @param {Worked[]} entries @param {string} study @param {string} year
 */
function flag(entries, study, year) {
  const live = entries.filter(takesPart);
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const [a, b] = [live[i], live[j]];
      if (a.sem && a.sem === b.sem) {
        const [ea, eb] = [examIn(a, a.sem), examIn(b, b.sem)];
        if (ea && eb && overlaps(ea, eb)) {
          const text = `${a.code} and ${b.code}: their ${year} exams overlap. If they still do in the year you go, NUS won't approve both and its form won't take both (GRO). NUS publishes each year's timetable in July or August (the Registrar says mid-July).`;
          a.flags.push({ kind: 'exam', with: b.code, text });
          b.flags.push({ kind: 'exam', with: a.code, text });
        }
      }
      if (a.which === 'pick' && b.which === 'pick') {
        for (const [x, y] of [[a, b], [b, a]]) {
          if (!names(x.course?.preclusion, y.code, study)) continue;
          const text = `${x.code}'s preclusions name ${y.code}`;
          const quote = String(x.course?.preclusion ?? '');
          x.flags.push({ kind: 'preclusion', with: y.code, text, quote });
          y.flags.push({ kind: 'preclusion', with: x.code, text, quote });
        }
      }
      if (grouped(a, b)) {
        const text = 'NUSMods lists these with the same title: check they are different courses';
        a.flags.push({ kind: 'group', with: b.code, text });
        b.flags.push({ kind: 'group', with: a.code, text });
      }
    }
  }
}

/**
 * NUS's application form order, per semester (G5): counted and to-confirm
 * entries only (not duplicates, audition courses or uninvited Business and
 * Law), picks then backups, each in rank order, numbered while the semester's
 * units stay at or under 40. An entry that would pass 40 is marked and takes
 * no number; a later, smaller one that fits takes the next. Past the 10th
 * number each is marked, keeping its number.
 * @param {Worked[]} entries
 * @param {boolean} exchange
 * @returns {{ '1': { units: number, line: string } | null, '2': { units: number, line: string } | null }}
 */
function formOrder(entries, exchange) {
  for (const w of entries) {
    w.form = { number: null, note: '', text: !exchange ? FORM_LINES.setYear
      : w.standing === 'duplicate' ? `The same course as ${w.sameAs}`
        : w.standing === 'invite' ? 'On the form only if invited'
          : w.audition && w.standing === 'confirm' ? 'Apply separately: see the note'
            : w.standing === 'pending' ? 'On the form once its details load'
              : 'Not on the form' };
  }
  if (!exchange) return { 1: null, 2: null };
  /** @type {{ '1': { units: number, line: string } | null, '2': { units: number, line: string } | null }} */
  const out = { 1: null, 2: null };
  for (const sem of /** @type {('1' | '2')[]} */ (['1', '2'])) {
    const order = [...entries.filter((w) => w.which === 'pick'), ...entries.filter((w) => w.which === 'alt')]
      .filter((w) => w.sem === sem && (w.standing === 'counted' || w.standing === 'confirm') && !w.audition);
    let units = 0;
    let n = 0;
    for (const w of order) {
      const u = tenths(w.units ?? 0);
      if (units + u > FORM_TENTHS) { w.form = { number: null, text: FORM_LINES.over, note: '' }; continue; }
      units += u;
      n += 1;
      const core = w.faculty === 'biz' ? ', if it\'s a core BBA course' : '';
      w.form = { number: n, text: `Application form, ${semLabel(sem)}: ${n}${core}`, note: n > 10 ? FORM_LINES.ten : '' };
    }
    out[sem] = { units: fromTenths(units), line: `${semLabel(sem)} on NUS's form: ${fromTenths(units)} of 40 units` };
  }
  return out;
}

/**
 * The shortlist worked out.
 * @param {{
 *   list: List, sem: string, study: string, answers: Map<string, Answer>,
 *   rules: OffListRule[] | null,
 * }} input `sem` the state's (it orders the totals); `study` '' in browse
 *   mode; `rules` /facets' offListRules, null if /facets failed
 * @returns {Result}
 */
export function workOut({ list, sem, study, answers, rules }) {
  const year = yearLabel(yearOf(list, answers));
  const ctx = { study, rules, inv: list.inv, year };
  /** @type {Worked[]} */
  const entries = [
    ...list.pick.map((e, i) => ({ ...e, which: /** @type {Which} */ ('pick'), rank: i + 1 })),
    ...list.alt.map((e, i) => ({ ...e, which: /** @type {Which} */ ('alt'), rank: i + 1 })),
  ].map((e) => workEntry(e, answers.get(e.code) ?? { kind: 'loading' }, ctx));
  settleSameCourse(entries, study);
  flag(entries, study, year);
  const forms = formOrder(entries, !!study);
  for (const w of entries) w.notes = nusNotes(w, study);
  /** @param {'1' | '2'} s @returns {Totals} */
  const totals = (s) => {
    const picks = entries.filter((w) => w.which === 'pick' && w.sem === s);
    /** @param {Standing} st */
    const sum = (st) => fromTenths(picks.filter((w) => w.standing === st).reduce((t, w) => t + tenths(w.units ?? 0), 0));
    const counted = sum('counted');
    const confirm = sum('confirm');
    const invite = sum('invite');
    return {
      // "Units picked" (the shortlist button, the sentences): every loaded pick's units, counted or not.
      picked: fromTenths(picks.reduce((t, w) => t + tenths(w.units ?? 0), 0)),
      counted, confirm, invite,
      pending: picks.filter((w) => w.standing === 'pending').length,
      economics: fromTenths(picks.filter((w) => (w.standing === 'counted' || w.standing === 'confirm') && lettersOf(w.code) === 'EC')
        .reduce((t, w) => t + tenths(w.units ?? 0), 0)),
      hours: fromTenths(tenths(counted * HOURS_PER_UNIT)),
      overlap: entries.some((w) => w.sem === s && w.flags.some((f) => f.kind === 'exam')),
      over20: tenths(counted + confirm + invite) > 200,
      form: forms[s],
    };
  };
  const tagged = new Set(entries.map((w) => w.sem).filter(Boolean));
  return {
    entries,
    sems: { 1: totals('1'), 2: totals('2') },
    order: sem === '2' ? ['2', '1'] : ['1', '2'],
    year,
    exchange: !!study,
    fullYear: tagged.has('1') && tagged.has('2'),
  };
}

/**
 * The lines under one semester's totals: the units picked (counted, then to
 * confirm, then only if invited), the hours at NUS's rate, the Economics and
 * exam-overlap lines when they apply, and NUS's minimum and maximum.
 * @param {'1' | '2'} sem
 * @param {Totals} t
 * @param {{ exchange: boolean, year: string }} r
 * @returns {string[]}
 */
export function totalLines(sem, t, { exchange, year }) {
  const atLeast = t.pending ? 'at least ' : '';
  const out = [`${semLabel(sem)}: ${atLeast}${t.counted} units picked, ${exchange ? 'if NUS accepts you into each' : 'exchange status not checked'}`];
  if (t.confirm) out.push(`plus ${t.confirm} units to confirm with NUS`);
  if (t.invite) out.push(`plus ${t.invite} units only if invited`);
  out.push(`About ${t.hours} hours a week at NUS's rate (2.5 hours a week per unit)`, TOTAL_LINES.rate, TOTAL_LINES.weeks);
  if (t.economics) out.push(`Includes ${t.economics} units of Economics courses. GRO: “${GRO_POPULAR}”`);
  if (t.overlap) out.push(`Picks with overlapping ${year} exams: NUS approves at most one of each pair`);
  out.push(TOTAL_LINES.admitted, TOTAL_LINES.courseReg, TOTAL_LINES.maximum, TOTAL_LINES.maximumScope);
  return out;
}

/**
 * The view's one sentence after a settings change: "Sem 2 first: 12 units
 * picked; Sem 1: 8", in units picked as the shortlist button counts them.
 * @param {Result} r
 */
export function summary(r) {
  const [first, second] = r.order;
  return `${semLabel(first)} first: ${r.sems[first].picked} units picked; ${semLabel(second)}: ${r.sems[second].picked}`;
}

/**
 * Whether an entry can be asked its semester: not once its answer shows it
 * can't take one (taught only in special terms, a catalogue-only or unknown
 * 404). A row still loading can, until it answers.
 * @param {Answer | undefined} answer
 */
export const askable = (answer) => !(answer && (answer.kind === 'catalogue-only' || answer.kind === 'unknown' || specialOnly(answer)));

/**
 * The question before an export (6C asks it, 6D waits on it): the year of
 * study in browse mode, and a semester for each untagged entry that can take
 * one. Entries that can't (taught only in special terms, a catalogue-only or
 * unknown 404) are exempt.
 * @param {{ list: List, study: string, answers: Map<string, Answer> }} input
 * @returns {{ ask: boolean, year: boolean, entries: string[] }}
 */
export function exportQuestion({ list, study, answers }) {
  const entries = [...list.pick, ...list.alt].filter((e) => !e.sem && askable(answers.get(e.code))).map((e) => e.code);
  const year = !study && list.pick.length + list.alt.length > 0;
  return { ask: year || entries.length > 0, year, entries };
}
