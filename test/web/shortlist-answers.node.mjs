// @ts-check
// /module answers for the shortlist's Node tests (Phase 6 6B), built from the
// fixture (test/fixtures/corpus.json) and its groups (test/fixtures/groups.json)
// the way the Worker answers them (src/modules.js handleModule; `otherCodes`
// as 6A adds it), without importing the Worker. Synthetic answers stand in for
// what the fixture lacks.
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { bitOf, NG_SEMS, OFF_NG_LIST, STUDIES } from '../../src/ng-bit.js';
import { yearNote } from '../../src/year-note.js';

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

/** @type {{ modules: any[] }} */
const corpus = readJson('../fixtures/corpus.json');
/** @type {{ groups: string[][] }} */
const groupsFile = readJson('../fixtures/groups.json');
/** @type {{ acadYear: string, reasons: Record<string, { kind: string, text: string }>, sources: any[] }} */
export const REASONS_FILE = readJson('../../data/ng-reasons.json');

/** Every fixture module, by code. @type {Map<string, any>} */
export const FIXTURE = new Map(corpus.modules.map((m) => [m.code, m]));
/** A code's group, itself left out. @type {Map<string, string[]>} */
export const GROUP_OF = new Map(groupsFile.groups.flatMap((g) => g.map((c) => [c, g.filter((x) => x !== c)])));

/** @param {string} id */
export const reason = (id) => {
  const r = REASONS_FILE.reasons[id];
  return r ? { id, kind: r.kind, text: r.text } : { id, kind: 'unknown', text: 'unknown' };
};

/**
 * src/ng-reasons.js exchangeAll over a fixture row: closed where the allow
 * bit is clear, else open or noted, with the stored reasons and R3's year note.
 * @param {any} m a fixture module
 */
function exchangeOf(m) {
  return NG_SEMS.flatMap((sem) => STUDIES.map((study) => {
    const bit = bitOf(sem, study);
    const ids = m.ng ? (m.ngRules?.[String(Math.log2(bit))] ?? []) : [OFF_NG_LIST];
    const reasons = ids.map(reason);
    if (((m.ngAllow ?? 0) & bit) === 0) return { sem, study, status: 'closed', reasons };
    const year = yearNote(m.prerequisite, study);
    if (year) reasons.push(year);
    return { sem, study, status: reasons.length ? 'note' : 'open', reasons };
  }));
}

/**
 * The /module/:code answer for a fixture code, as api.js's outcome.
 * @param {string} code
 */
export function fixtureOutcome(code) {
  const m = FIXTURE.get(code);
  if (!m) return { kind: 'error', error: { code: 'not_found', status: 404 } };
  return {
    kind: 'ok',
    body: {
      code: m.code, title: m.title, description: m.description, credits: m.credits, department: m.department, faculty: m.faculty,
      level: m.level, semesters: m.semesters, prerequisite: m.prerequisite, preclusion: m.preclusion, acad_year: m.acadYear,
      ng: m.ng, ng_semesters: m.ngSemesters, exchange: exchangeOf(m), examDates: m.examDates, otherCodes: GROUP_OF.get(code) ?? [],
    },
  };
}

/**
 * A synthetic exchange array: the same status and reasons at every study
 * level, per semester (`any` follows Sem 1).
 * @param {Record<string, [string, string[]]>} bySem keys '1', '2'
 * @param {Record<string, Record<string, [string, string[]]>>} [byStudy] overrides per study level
 */
export function exchange(bySem, byStudy = {}) {
  return NG_SEMS.flatMap((sem) => STUDIES.map((study) => {
    const [status, ids] = byStudy[study]?.[String(sem === 'any' ? 1 : sem)] ?? bySem[String(sem === 'any' ? 1 : sem)] ?? ['closed', [OFF_NG_LIST]];
    return { sem, study, status, reasons: ids.map(reason) };
  }));
}

/**
 * A synthetic row (a course the fixture lacks), open with no notes in Sem 1
 * and Sem 2 unless `exchange` says otherwise.
 * @param {string} code
 * @param {Record<string, any>} [over]
 */
export function synthOutcome(code, over = {}) {
  return {
    kind: 'ok',
    body: {
      code, title: `Synthetic ${code}`, credits: 4, department: 'Synthetic', faculty: 'Synthetic', level: Number(/\d/.exec(code)?.[0] ?? 1),
      semesters: [1, 2], preclusion: null, acad_year: '2026-2027', ng: true, ng_semesters: [1, 2],
      exchange: exchange({ 1: ['open', []], 2: ['open', []] }), examDates: [], otherCodes: [], ...over,
    },
  };
}

/**
 * A 404 of kind `ng-listed` (6A: an NG-listed code with no classes, from
 * data/ng-unscheduled.json), as api.js passes its detail through.
 * @param {string} code
 * @param {Record<string, any>} over
 */
export function ngListedOutcome(code, over) {
  return {
    kind: 'error',
    error: {
      code: 'not_found', status: 404,
      detail: { error: 'not_found', kind: 'ng-listed', code, acadYear: '2026-2027', title: `Listed ${code}`, credits: 4, faculty: 'Synthetic', department: 'Synthetic', level: 4, examDates: [], otherCodes: [], preclusion: null, ...over },
    },
  };
}
