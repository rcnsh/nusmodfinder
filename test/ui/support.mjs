// @ts-check
// Shared by the Playwright specs in test/ui/ (Phase 5 5B).

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

/** The empty state's sentence (5D: it names the next step). */
export const EMPTY = 'Type what you want to study in the box above, then press Search.';

/**
 * Opens the page and leaves the first screen (the exchange set-up, D2) by
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
 * axe-core with every rule (no tag filter) on the page as it is: the
 * violations as `rule: targets` lines, [] when there are none.
 * @param {import('@playwright/test').Page} page
 */
export async function axeViolations(page) {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** The polite live region (5E): one per page. @param {import('@playwright/test').Page} page */
export const live = (page) => page.locator('#live');
