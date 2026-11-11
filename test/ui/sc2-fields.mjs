// @ts-check
// SC2's fields in an open detail (Phase 5 5G), shared by the CI spec
// (test/ui/sc2.spec.js, every fixture code) and the live check
// (scripts/p5-live.mjs, 20 drawn production codes), so both read the page the
// same way and expect the same things:
// - the head: the code and title;
// - the description;
// - prerequisites and preclusions: the cohort-only line, NUS's text, or "No … listed";
// - each exam in Singapore time, or "No final exam listed";
// - the workload, or "Workload not listed" (NUS's raw text when it isn't the 5-number form);
// - exchange availability per semester: the all-years table outside exchange
//   mode, a status per year and semester;
// - the NUSMods link.
// Expected values come from a normalised module (scripts/lib.mjs's shape: the
// fixture corpus, or the production modules) through the page's own pure
// formatters and /module's workload rule, so a field the page leaves out, or
// one it fills from the wrong course, is a problem.
import { examLines, prereqView, workloadText } from '../../public/format.js';
import { moduleWorkload } from '../../src/workload.js';

/** The detail's years of study, in the all-years table's order. */
export const YEARS = Object.freeze(['1st year', '2nd year', '3rd year', '4th year or later', 'Graduate']);
const STATUSES = Object.freeze(['open', 'note', 'closed']);

/** @param {unknown} s */
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @typedef {{
 *   head: string, description: string, prereq: string, precl: string,
 *   exams: string[], workload: string, nusmods: string,
 * }} Sc2Expected
 * @typedef {{
 *   head: string, description: string, prereq: string, prereqText: string, precl: string, preclText: string,
 *   exams: string[], workload: string, exchange: { year: string, statuses: (string | null)[] }[], nusmods: string | null,
 * }} Sc2Found
 */

/**
 * What the detail must say for a normalised module.
 * @param {any} m
 * @returns {Sc2Expected}
 */
export function sc2Expected(m) {
  const view = prereqView(m.prerequisite ?? null, m.prereqCohortOnly === true);
  return {
    head: `${m.code} ${m.title}`,
    description: squash(m.description) || 'No description listed',
    prereq: !view ? 'No prerequisites listed' : view.line ?? 'As NUS states it:',
    precl: squash(m.preclusion) ? 'As NUS states it:' : 'No preclusions listed',
    exams: examLines(m.examDates ?? []),
    workload: workloadText(moduleWorkload(m.workload ?? null)),
    nusmods: `https://nusmods.com/courses/${m.code}`,
  };
}

/**
 * Waits for a code's detail to be open and loaded (`?q=CODE&open=CODE`), then
 * reads every SC2 field from it. Rejects if the entry or the detail never
 * appears, or the detail failed to load.
 * @param {import('@playwright/test').Page} page
 * @param {string} code
 * @param {number} [timeout]
 * @returns {Promise<Sc2Found>}
 */
export async function readSc2(page, code, timeout = 15_000) {
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
 * Every way the detail falls short of SC2 for this module: [] when it holds.
 * @param {Sc2Found} got
 * @param {Sc2Expected} want
 * @returns {string[]}
 */
export function sc2Problems(got, want) {
  const out = [];
  /** @param {string} field @param {unknown} a @param {unknown} b */
  const same = (field, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${field}: ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
  same('head', got.head, want.head);
  same('description', got.description, want.description);
  same('prerequisites', got.prereq, want.prereq);
  if (want.prereq !== 'No prerequisites listed' && !got.prereqText) out.push("prerequisites: NUS's text is missing");
  same('preclusions', got.precl, want.precl);
  if (want.precl !== 'No preclusions listed' && !got.preclText) out.push("preclusions: NUS's text is missing");
  same('exams', got.exams, want.exams);
  same('workload', got.workload, want.workload);
  same('exchange years', got.exchange.map((r) => r.year), YEARS);
  for (const r of got.exchange) {
    if (r.statuses.length !== 2 || r.statuses.some((s) => !STATUSES.includes(String(s)))) out.push(`exchange, ${r.year}: ${JSON.stringify(r.statuses)}, expected a status for Sem 1 and Sem 2`);
  }
  same('NUSMods link', got.nusmods, want.nusmods);
  return out;
}
