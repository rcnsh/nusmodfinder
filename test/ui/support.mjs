// @ts-check
// Shared by the Playwright specs in test/ui/.

/**
 * Records the query string of every /search request the page makes, in order.
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

/** The query string the page's URL holds now. @param {import('@playwright/test').Page} page */
export const query = (page) => new URL(page.url()).search.slice(1);

/**
 * A /search body in the Worker's shape, for intercepted responses.
 * @param {Record<string, unknown>} [over]
 */
export function body(over = {}) {
  return {
    query: 'networks', filters: {}, count: 1, mode: 'hybrid', interpreted: {}, retrieval: { vector: 1, lexical: 1, fused: 1 },
    results: [{ code: 'CS2105', title: 'Introduction to Computer Networks', department: 'Computer Science', faculty: 'Computing', credits: 4, semesters: [1, 2], score: 0.03 }],
    ...over,
  };
}

/** The empty state's sentence (it names the next step). */
export const EMPTY = 'Type what you want to study in the box above, then press Search.';

/**
 * Opens the page and leaves the first screen (the exchange set-up) by
 * "Browse all courses instead", for a test of the general search.
 * @param {import('@playwright/test').Page} page
 */
export async function browse(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browse all courses instead' }).click();
  await page.locator('#q').waitFor({ state: 'visible' });
}

/**
 * The count line for a query: "20 courses match “networks”".
 * @param {string} q
 */
export const matchFor = (q) => `match “${q}”`;

/**
 * Waits until everything the page fetches after an answer has landed: /facets
 * (the sources' dates), an open detail's content, each hidden code's reason
 * and the other-semester check of a partial code. Not for a search held in
 * flight on purpose.
 * @param {import('@playwright/test').Page} page
 */
export async function settled(page) {
  const { expect } = await import('@playwright/test');
  await expect(page.locator('#setupSources td').nth(1)).not.toHaveText('…');
  await expect(page.locator('#status')).not.toHaveText('Searching…');
  await expect(page.locator('#results .detail-loading')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#status .hidden-codes .why')]
    .filter((el) => /isn't shown with these settings\.$/.test(el.textContent ?? '')).length)).toBe(0);
  await expect.poll(() => page.evaluate(() => {
    const p = document.querySelector('#status .partial');
    // Settled: a "see the other semester" button, or the either-semester sentence.
    return !p || !!document.querySelector('#status .see-other') || /either semester/.test(p.textContent ?? '');
  })).toBe(true);
}

/**
 * The rule left out of axeViolations: WCAG AAA's 7:1 contrast. The page's bar
 * is AA (`npm run contrast`), which the page's stamps, note scopes and
 * source dates meet at 6.2:1 and up; AAA would change D's colours.
 */
export const AXE_OFF = Object.freeze(['color-contrast-enhanced']);

/**
 * axe-core with every rule it has but AXE_OFF: no tag filter, and the
 * rules axe leaves off by default (the experimental ones, the other AAA ones)
 * on too. The violations as `rule: targets` lines, [] when there are none.
 * @param {import('@playwright/test').Page} page
 */
export async function axeViolations(page) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { default: axe } = await import('axe-core');
  const every = axe.getRules().map((r) => r.ruleId).filter((id) => !AXE_OFF.includes(id));
  const { violations } = await new AxeBuilder({ page }).options({ runOnly: { type: 'rule', values: every } }).analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** The polite live region: one per page. @param {import('@playwright/test').Page} page */
export const live = (page) => page.locator('#live');

/**
 * Logs every text the live region holds, from the page's first load: read it
 * with liveLog(page). Call before page.goto.
 * @param {import('@playwright/test').Page} page
 */
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
