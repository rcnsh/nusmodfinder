// @ts-check
import { expect } from '@playwright/test';

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
export function searches(page) {
  /** @type {string[]} */
  const seen = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname === '/search') seen.push(u.search.slice(1));
  });
  return seen;
}

/** @param {import('@playwright/test').Page} page */
export const query = (page) => new URL(page.url()).search.slice(1);

/** @param {Record<string, unknown>} [over] */
export function body(over = {}) {
  return {
    query: 'networks', filters: {}, count: 1, mode: 'hybrid', interpreted: {}, retrieval: { vector: 1, lexical: 1, fused: 1 },
    results: [{ code: 'CS2105', title: 'Introduction to Computer Networks', department: 'Computer Science', faculty: 'Computing', credits: 4, semesters: [1, 2], score: 0.03 }],
    ...over,
  };
}

export const EMPTY = 'Type what you want to study in the box above, then press Search.';

/** @param {import('@playwright/test').Page} page */
export async function browse(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browse all courses instead' }).click();
  await page.locator('#q').waitFor({ state: 'visible' });
}

/** @param {string} q */
export const matchFor = (q) => `match “${q}”`;

/** @param {import('@playwright/test').Page} page */
export async function settled(page) {
  const { expect } = await import('@playwright/test');
  await expect(page.locator('#setupSources td').nth(1)).not.toHaveText('…');
  await expect(page.locator('#status')).not.toHaveText('Searching…');
  await expect(page.locator('#results .detail-loading')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#status .hidden-codes .why')]
    .filter((el) => /isn't shown with these settings\.$/.test(el.textContent ?? '')).length)).toBe(0);
  await expect.poll(() => page.evaluate(() => {
    const p = document.querySelector('#status .partial');
    return !p || !!document.querySelector('#status .see-other') || /either semester/.test(p.textContent ?? '');
  })).toBe(true);
}

export const AXE_OFF = Object.freeze(['color-contrast-enhanced']);

/** @param {import('@playwright/test').Page} page */
export async function axeViolations(page) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { default: axe } = await import('axe-core');
  const every = axe.getRules().map((r) => r.ruleId).filter((id) => !AXE_OFF.includes(id));
  const { violations } = await new AxeBuilder({ page }).options({ runOnly: { type: 'rule', values: every } }).analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** @param {import('@playwright/test').Page} page */
export const live = (page) => page.locator('#live');

/** @param {import('@playwright/test').Page} page */
export async function recordLive(page) {
  await page.addInitScript(() => {
    /** @type {any} */ (globalThis).liveLog = [];
    document.addEventListener('DOMContentLoaded', () => {
      const el = /** @type {HTMLElement} */ (document.getElementById('live'));
      new MutationObserver(() => /** @type {any} */ (globalThis).liveLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
  });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
export const liveLog = (page) => page.evaluate(() => /** @type {any} */ (globalThis).liveLog);

/**
 * @param {import('@playwright/test').Page | import('@playwright/test').Locator} page
 * @param {string} name
 * @param {string} value
 */
export const pill = (page, name, value) => page.locator(`input[name="${name}"][value="${value}"]`);

/** @param {import('@playwright/test').Page} page */
export const facultyOptions = (page) => page.locator('#faculty-list [role="option"] .combo-name');

/** @param {import('@playwright/test').Page} page */
export async function openFaculty(page) {
  const box = page.locator('#faculty');
  if (await box.getAttribute('aria-expanded') !== 'true') await box.click();
  await expect(box).toHaveAttribute('aria-expanded', 'true');
}
