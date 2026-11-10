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
