// @ts-check
// SC8's axe gate (Phase 5 5E; plan §3 5E): axe-core with every rule (no tag
// filter) on every state the plan lists, plus the loading list, the first
// screen's validation message, a missing year of study and a detail that
// failed to load, in both themes, at 1280 and at 390×664, in Chromium and
// WebKit. No violation is allowed. The fixture gives most states; the ones it
// can't (phrase chips, an error, 429, keyword-only, a held search, a failed
// detail) answer by request interception. The filters dialog exists only at
// phone width (at 1280 its controls are the rail, checked in every results
// state), so it runs at 390×664 alone.
import { expect, test } from '@playwright/test';
import { axeViolations, body, browse, settled } from './support.mjs';

/**
 * @typedef {{
 *   name: string,
 *   open: string | ((page: import('@playwright/test').Page) => Promise<void>),
 *   route?: (page: import('@playwright/test').Page) => Promise<unknown>,
 *   ready?: (page: import('@playwright/test').Page) => Promise<void>,
 *   phoneOnly?: boolean,
 * }} State
 */

/** @param {import('@playwright/test').Page} page @param {(route: import('@playwright/test').Route) => unknown} answer */
const onSearch = (page, answer) => page.route('**/search?**', answer);

/** @type {State[]} */
const STATES = [
  { name: 'first screen (the exchange set-up)', open: '/' },
  {
    name: 'first screen, a question left unanswered',
    open: async (page) => {
      await page.goto('/');
      await page.locator('#setupForm').getByRole('button', { name: 'Search' }).click();
      await expect(page.locator('#setupError')).toHaveText('Choose the semester you will study at NUS.');
    },
  },
  { name: 'empty search (browse all)', open: browse },
  {
    name: 'searching (the list busy)', open: '/?q=networks&ng=1&study=ug2&sem=1',
    route: (page) => onSearch(page, () => { /* held */ }),
    ready: async (page) => {
      await expect(page.locator('#status')).toHaveText('Searching…');
      await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'true');
    },
  },
  { name: 'results', open: '/?q=networks' },
  { name: 'exchange results, one semester', open: '/?q=networks&ng=1&study=ug2&sem=1' },
  { name: 'exchange results, both semesters', open: '/?q=ACC1701XB&ng=1&study=ug2' },
  { name: 'exchange mode without a year of study', open: '/?q=networks&ng=1&sem=1' },
  { name: 'detail open, exchange mode', open: '/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB' },
  { name: 'detail open, all years table', open: '/?q=CS3244&open=CS3244' },
  {
    name: 'detail that failed to load', open: '/?q=CS3244&open=CS3244',
    route: (page) => page.route('**/module/CS3244', (route) => route.fulfill({ status: 500, json: { error: 'internal' } })),
    ready: (page) => expect(page.locator('#results .detail-retry')).toBeVisible(),
  },
  { name: 'hidden codes', open: '/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1' },
  { name: 'not offered, inside a list', open: '/?q=CS2030+CS1001' },
  { name: 'not offered, the whole query (related courses)', open: '/?q=CS1001' },
  { name: 'partial code, the other semester has some', open: '/?q=CG32&ng=1&study=ug2&sem=1' },
  { name: 'partial code empty in both semesters', open: '/?q=AI52&ng=1&study=ug2&sem=1' },
  { name: 'filters, removable chips', open: '/?q=databases&level=2&credits=4&faculty=Computing' },
  {
    name: 'parsed-phrase chips', open: '/?q=history+no+final+exam+under+10+hours',
    route: (page) => onSearch(page, (route) => route.fulfill({ json: body({ query: 'history no final exam under 10 hours', interpreted: { exam: 0, hoursBelow: 10, prereq: { value: 'none', semantics: 'ii' } } }) })),
    ready: (page) => expect(page.locator('#status .intents li')).toHaveCount(3),
  },
  { name: 'no match', open: '/?q=qwzx+vbnm' },
  {
    name: 'error', open: '/?q=networks',
    route: (page) => onSearch(page, (route) => route.fulfill({ status: 502, json: { error: 'upstream_failure' } })),
    ready: (page) => expect(page.locator('#status.error')).toHaveCount(1),
  },
  {
    name: '429', open: '/?q=networks',
    route: (page) => onSearch(page, (route) => route.fulfill({ status: 429, headers: { 'retry-after': '30' }, json: { error: 'rate_limited' } })),
    ready: (page) => expect(page.locator('#status')).toHaveText('Too many searches from your connection. Try again in 30 seconds.'),
  },
  {
    name: 'keyword-only', open: '/?q=networks',
    route: (page) => onSearch(page, (route) => route.fulfill({ json: body({ degraded: { source: 'workers-ai', reason: 'timeout' } }) })),
    ready: (page) => expect(page.locator('#status .degraded')).toBeVisible(),
  },
  {
    name: 'the filters dialog', phoneOnly: true,
    open: async (page) => {
      await page.goto('/?q=networks&ng=1&study=ug2&sem=1&level=2');
      await settled(page);
      await page.getByRole('button', { name: 'Filters (4)' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
];
const WIDTHS = /** @type {const} */ ([['1280', 1280, 800], ['390×664', 390, 664]]);

for (const s of STATES) {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    for (const [label, width, height] of WIDTHS) {
      if (s.phoneOnly && width !== 390) continue;
      test(`[SC8] axe, every rule: ${s.name}, ${scheme}, ${label}: no violation`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await s.route?.(page);
        if (typeof s.open === 'string') await page.goto(s.open);
        else await s.open(page);
        if (s.ready) await s.ready(page);
        else await settled(page);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
}
