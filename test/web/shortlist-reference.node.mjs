// @ts-check
// The shortlist's independent reference (Phase 6 6B, SC3): the counting rules
// written again from docs/plans/phase6.md 6B, over a corpus's own columns (its
// allow mask and stored rule ids, its groups and data/ng-reasons.json's kinds),
// not through public/shortlist.js or the /module answers it reads. The 6B
// property test (test/web/shortlist.node.test.js) runs it over the fixture;
// scripts/p6-live.mjs (6E) over the production-normalised modules.
import { yearNote } from '../../src/year-note.js';

const STUDY_LIST = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
const CONDITIONS = ['quota', 'major', 'approval', 'graded', 'letter', 'fee'];

/**
 * @typedef {{ which: string, code: string, sem: string }} RefEntry an entry, `which` pick or alt, `sem` '1', '2' or ''
 * @typedef {'counted' | 'confirm' | 'invite' | 'out' | 'dup'} RefStanding
 * @typedef {{ counted: number, confirm: number, invite: number }} RefTotals units per semester
 * @typedef {{
 *   rowOf: (code: string) => any,
 *   groupOf: (code: string) => string[],
 *   reasons: Record<string, { kind: string }>,
 * }} RefData
 *   `rowOf`: a normalised module (the corpus's columns), or undefined for a code with no row;
 *   `groupOf`: the code's group, itself left out; `reasons`: ng-reasons.json's reasons by id
 */

/**
 * The reference over a list's entries, in rank order (picks first): each
 * entry's standing, and each semester's counted, to-confirm and only-if-invited
 * units (picks only).
 * @param {RefEntry[]} entries
 * @param {string} study a study level, or '' for browse mode
 * @param {string[]} inv the Business School and Law invitations ticked (`biz`, `law`)
 * @param {RefData} data
 * @returns {{ totals: Record<'1' | '2', RefTotals>, standings: (RefEntry & { standing: RefStanding })[] }}
 */
export function reference(entries, study, inv, { rowOf, groupOf, reasons }) {
  /** @param {string} text @param {string} code */
  const namesRef = (text, code) => {
    if (!text) return false;
    if (study === 'grad' && /^\s*\(?\s*if undertaking an undergraduate degree/i.test(text) && !/graduate degree coursework/i.test(text.split(/then/i)[0])) return false;
    if (new RegExp(`(^|[^A-Za-z])${code}(?=[^A-Za-z0-9]|$|OR|AND|THEN)`).test(text)) return true;
    return [...text.matchAll(/beginning with\s+([A-Z]+\d*)/g)].some((m) => code.startsWith(m[1]));
  };
  const classified = entries.map((e) => {
    const m = rowOf(e.code);
    /** @param {RefStanding} st */
    const as = (st) => ({ ...e, m, st });
    if (!m || !e.sem || m.credits === null) return as('out');
    if (m.semesters.length && m.semesters.every((/** @type {number} */ s) => s >= 3)) return as('out');
    const s = Number(e.sem);
    if (!study) return as(m.semesters.includes(s) ? 'counted' : 'out');
    const index = (s - 1) * 5 + STUDY_LIST.indexOf(study);
    if ((m.ngAllow & (1 << index)) === 0) return as('out');
    const kinds = (m.ng ? (m.ngRules?.[String(index)] ?? []) : []).map((/** @type {string} */ id) => reasons[id]?.kind ?? 'unknown');
    if (yearNote(m.prerequisite, /** @type {any} */ (study))) kinds.push('year');
    const fac = m.faculty === 'NUS Business School' ? 'biz' : m.faculty === 'Law' ? 'law' : '';
    if (fac && !inv.includes(fac)) return as('invite');
    return as(kinds.every((/** @type {string} */ k) => CONDITIONS.includes(k)) ? 'counted' : 'confirm');
  });
  /** @param {any} a @param {any} b */
  const same = (a, b) => {
    if (!groupOf(a.code).includes(b.code)) return false;
    if (a.m.ng && b.m.ng) return true;
    return namesRef(a.m.preclusion, b.code) || namesRef(b.m.preclusion, a.code);
  };
  const takes = (/** @type {any} */ x) => ['counted', 'confirm', 'invite'].includes(x.st);
  /** @type {any[]} */
  const kept = [];
  const picks = classified.filter((x) => x.which === 'pick' && takes(x));
  for (const x of [...picks.filter((p) => p.st === 'counted'), ...picks.filter((p) => p.st !== 'counted')]) {
    if (kept.some((k) => same(k, x))) x.st = 'dup';
    else kept.push(x);
  }
  // In tenths, so half units add exactly.
  /** @type {Record<'1' | '2', RefTotals>} */
  const totals = { 1: { counted: 0, confirm: 0, invite: 0 }, 2: { counted: 0, confirm: 0, invite: 0 } };
  for (const x of classified) {
    if (x.which !== 'pick' || !x.sem) continue;
    const t = totals[/** @type {'1' | '2'} */ (x.sem)];
    if (x.st === 'counted') t.counted += x.m.credits * 10;
    if (x.st === 'confirm') t.confirm += x.m.credits * 10;
    if (x.st === 'invite') t.invite += x.m.credits * 10;
  }
  for (const t of Object.values(totals)) { t.counted /= 10; t.confirm /= 10; t.invite /= 10; }
  return { totals, standings: classified.map(({ which, code, sem, st }) => ({ which, code, sem, standing: st })) };
}
