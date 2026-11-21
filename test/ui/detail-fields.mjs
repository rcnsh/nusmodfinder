// @ts-check
import { examLines, prereqView, workloadText } from '../../public/format.js';
import { STUDIES } from '../../src/ng-bit.js';
import { moduleWorkload } from '../../src/workload.js';
import { oracleShown } from '../oracle/oracle.mjs';

export const YEARS = Object.freeze(['1st year', '2nd year', '3rd year', '4th year or later', 'Graduate']);
const STATUSES = Object.freeze(['open', 'note', 'closed']);

/** @param {unknown} s */
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** @param {unknown} s */
const bare = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * @typedef {{
 *   head: string, description: string, prereq: string, prereqText: string, precl: string, preclText: string,
 *   exams: string[], workload: string, exchange: { year: string, statuses: string[] }[], nusmods: string,
 * }} DetailExpected
 * @typedef {{
 *   head: string, description: string, prereq: string, prereqText: string, precl: string, preclText: string,
 *   exams: string[], workload: string, exchange: { year: string, statuses: (string | null)[] }[], nusmods: string | null,
 * }} DetailFound
 */

/**
 * @param {any} m
 * @returns {DetailExpected}
 */
export function detailExpected(m) {
  const view = prereqView(m.prerequisite ?? null, m.prereqCohortOnly === true);
  return {
    head: `${m.code} ${m.title}`,
    description: squash(m.description) || 'No description listed',
    prereq: !view ? 'No prerequisites listed' : view.line ?? 'As NUS states it:',
    prereqText: view ? bare(m.prerequisite) : '',
    precl: squash(m.preclusion) ? 'As NUS states it:' : 'No preclusions listed',
    preclText: bare(m.preclusion),
    exams: examLines(m.examDates ?? []),
    workload: workloadText(moduleWorkload(m.workload ?? null)),
    exchange: STUDIES.map((study, i) => ({ year: YEARS[i], statuses: /** @type {const} */ ([1, 2]).map((sem) => oracleShown(m, { sem, study })) })),
    nusmods: `https://nusmods.com/courses/${m.code}`,
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} code
 * @param {number} [timeout]
 * @returns {Promise<DetailFound>}
 */
export async function readDetail(page, code, timeout = 15_000) {
  const toggle = page.locator(`#results button.card-toggle[data-code="${code}"][aria-expanded="true"]`);
  await toggle.waitFor({ state: 'visible', timeout });
  const region = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
  await region.locator('.sheet-head, .detail-error').first().waitFor({ state: 'visible', timeout });
  if (await region.locator('.detail-error').count()) throw new Error(`${code}: the detail failed to load: ${await region.textContent()}`);
  return region.evaluate((el) => {
    /** @param {string} title */
    const part = (title) => [...el.querySelectorAll('.fact')].find((s) => s.querySelector('h4')?.textContent === title);
    /** @param {Element | null | undefined} s @param {string} sel */
    const text = (s, sel) => (s?.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const prereq = part('Prerequisites');
    const precl = part('Preclusions');
    return {
      head: text(el, '.dtitle'),
      description: text(part('Description'), '.desc'),
      prereq: text(prereq, '.prereq-line, .as-stated-label') || text(prereq, 'p'),
      prereqText: text(prereq, '.nus-text'),
      precl: text(precl, '.as-stated-label') || text(precl, 'p'),
      preclText: text(precl, '.nus-text'),
      exams: [...(part('Final exam (Singapore time)')?.querySelectorAll('.exam-list li') ?? [])].map((li) => li.textContent ?? ''),
      workload: text(part('Workload'), '.wl-total'),
      exchange: [...el.querySelectorAll('table.exchange-table tbody tr')].map((r) => ({
        year: r.querySelector('th')?.textContent ?? '',
        statuses: [...r.querySelectorAll('td .exchange-status')].map((s) => s.getAttribute('data-status')),
      })),
      nusmods: el.querySelector('a.nusmods-link')?.getAttribute('href') ?? null,
    };
  });
}

/**
 * @param {DetailFound} got
 * @param {DetailExpected} want
 * @returns {string[]}
 */
export function detailProblems(got, want) {
  const out = [];
  /** @param {string} field @param {unknown} a @param {unknown} b */
  const same = (field, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${field}: ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
  same('head', got.head, want.head);
  same('description', got.description, want.description);
  same('prerequisites', got.prereq, want.prereq);
  same("prerequisites, NUS's text", bare(got.prereqText), want.prereqText);
  same('preclusions', got.precl, want.precl);
  same("preclusions, NUS's text", bare(got.preclText), want.preclText);
  same('exams', got.exams, want.exams);
  same('workload', got.workload, want.workload);
  same('exchange years', got.exchange.map((r) => r.year), YEARS);
  for (const [i, r] of got.exchange.entries()) {
    if (r.statuses.length !== 2 || r.statuses.some((s) => !STATUSES.includes(String(s)))) out.push(`exchange, ${r.year}: ${JSON.stringify(r.statuses)}, expected a status for Sem 1 and Sem 2`);
    else same(`exchange, ${r.year}`, r.statuses, want.exchange[i]?.statuses);
  }
  same('NUSMods link', got.nusmods, want.nusmods);
  return out;
}
