// @ts-check
// Accessibility snapshots (Phase 5 5E, SC8): the accessibility tree of each
// state, committed in test/ui/aria.spec.js-snapshots/ (one file per state,
// shared by Chromium and WebKit and by every platform), so any drift in roles,
// names, headings, landmarks or the order a screen reader reads fails CI.
// Each file is the tree exactly as Playwright prints it, and the test asks
// for both: equal text (a node added anywhere fails), and Playwright's own
// toMatchAriaSnapshot against the same file.
//
// After a deliberate change: `VNM_ARIA_UPDATE=1 npx playwright test aria --project chromium`
// rewrites the files; read their diff before committing it. (Playwright's
// --update-snapshots writes a loosened template, with numbers as patterns,
// which the exact comparison would not accept.)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { body, settled } from './support.mjs';

/**
 * @param {import('@playwright/test').Locator} locator
 * @param {string} name the snapshot file
 */
async function snapshot(locator, name) {
  const file = fileURLToPath(new URL(`./aria.spec.js-snapshots/${name}`, import.meta.url));
  const tree = await locator.ariaSnapshot();
  if (process.env.VNM_ARIA_UPDATE) writeFileSync(file, `${tree}\n`);
  const committed = readFileSync(file, 'utf8').trimEnd();
  expect(tree, `${name}, exactly`).toBe(committed);
  await expect(locator).toMatchAriaSnapshot(committed);
}

/** The mockup's state 2 (6C): Sem 1, 2nd year, four picks and two backups. */
const VIEW_STATE = 'sem=1&ng=1&study=ug2&pick=CS2113.1&pick=GE2101.1&pick=PC3270.1&pick=ACC1701XA.1&alt=CS3244.1&alt=EE4407.1&view=shortlist';
/** The mockup's state 3 (6C): a full-year list, Sem 2 chosen. */
const FULL_YEAR = 'sem=2&ng=1&study=ug2&pick=CS2030.1&pick=CS3244.2&pick=GE2101.1&pick=HY1101E&pick=ACC1701XA.1&pick=EN3264.1&pick=PS3251.2&pick=MA3220.1&pick=ST2137.2&pick=GES1034.1&pick=LSM2212.1&alt=CS2113.1&alt=CM3267.1&alt=PC3232.1&alt=GESS1007.1&alt=PC4262.1&alt=TS2239.2&view=shortlist';

/** @param {import('@playwright/test').Page} page the open entry: its heading, facts, status and detail */
const openEntry = (page) => page.locator('#results > li').filter({ has: page.locator('button[aria-expanded="true"]') });

test.describe('at 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('[SC8] accessibility snapshot: the first screen', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await snapshot(page.locator('body'), 'first-screen-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: exchange results, Sem 1 (the header, the rail, the search and the entries)', async ({ page }) => {
    await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1&level=1');
    await settled(page);
    await snapshot(page.locator('body'), 'results-sem1-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: exchange results, both semesters', async ({ page }) => {
    await page.goto('/?q=ACC1701XB&ng=1&study=ug2&level=1');
    await settled(page);
    await snapshot(page.locator('#main'), 'results-both-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: a detail open in exchange mode', async ({ page }) => {
    await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB');
    await settled(page);
    await snapshot(openEntry(page), 'detail-exchange-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: a detail open with the all-years table', async ({ page }) => {
    await page.goto('/?q=CS3244&open=CS3244');
    await settled(page);
    await snapshot(openEntry(page), 'detail-all-years-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: hidden and not-offered codes', async ({ page }) => {
    await page.goto('/?q=CS2030+CS3244+CS5562+AR5801+CS1001&ng=1&study=ug2&sem=1');
    await settled(page);
    await snapshot(page.locator('#status'), 'hidden-codes-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: no match, a code not offered, and a partial code', async ({ page }) => {
    await page.goto('/?q=qwzx+vbnm');
    await settled(page);
    await snapshot(page.locator('#status'), 'no-match-1280.aria.yml');
    await page.goto('/?q=CS1001');
    await settled(page);
    await snapshot(page.locator('#status'), 'not-offered-1280.aria.yml');
    await page.goto('/?q=CG32&ng=1&study=ug2&sem=1');
    await settled(page);
    await snapshot(page.locator('#status'), 'partial-code-1280.aria.yml');
  });

  test('[6C] accessibility snapshot: the shortlist view, Sem 1, 2nd year (the mockup\'s state 2)', async ({ page }) => {
    await page.goto(`/?q=networks&${VIEW_STATE}`);
    await settled(page);
    await expect(page.locator('#slView .sl-ehead .title', { hasText: 'Loading…' })).toHaveCount(0);
    await snapshot(page.locator('#slView'), 'shortlist-view-1280.aria.yml');
  });

  test('[6C] accessibility snapshot: a full-year list after a Sem change (the mockup\'s state 3: the rail\'s button, the totals)', async ({ page }) => {
    await page.goto(`/?q=networks&${FULL_YEAR}`);
    await settled(page);
    await expect(page.locator('#slView .sl-ehead .title', { hasText: 'Loading…' })).toHaveCount(0);
    await snapshot(page.locator('.sl-rail'), 'shortlist-button-1280.aria.yml');
    await snapshot(page.locator('#slTotals'), 'shortlist-totals-1280.aria.yml');
  });

  test('[SC8] accessibility snapshot: an error, and the phrase chips', async ({ page }) => {
    await page.route('**/search?**', (route) => route.fulfill({ status: 429, headers: { 'retry-after': '30' }, json: { error: 'rate_limited' } }));
    await page.goto('/?q=networks');
    await expect(page.locator('#status.error')).toHaveCount(1);
    await snapshot(page.locator('#main'), 'error-429-1280.aria.yml');
    await page.unroute('**/search?**');
    await page.route('**/search?**', (route) => route.fulfill({ json: body({ query: 'history no final exam', interpreted: { exam: 0, hoursBelow: 10 } }) }));
    await page.goto('/?q=history+no+final+exam+under+10+hours');
    await expect(page.locator('#status .intents li')).toHaveCount(2);
    await snapshot(page.locator('#status'), 'phrase-chips-1280.aria.yml');
  });
});

test.describe('at 390×664', () => {
  test.use({ viewport: { width: 390, height: 664 } });

  test('[SC8] accessibility snapshot: the first screen on a phone', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await snapshot(page.locator('body'), 'first-screen-390.aria.yml');
  });

  test('[SC8] accessibility snapshot: exchange results on a phone (the Filters button, no rail)', async ({ page }) => {
    await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1&level=1');
    await settled(page);
    await snapshot(page.locator('body'), 'results-sem1-390.aria.yml');
  });

  test('[SC8] accessibility snapshot: the filters dialog', async ({ page }) => {
    await page.goto('/?q=networks&ng=1&study=ug2&sem=1&level=2');
    await settled(page);
    await page.getByRole('button', { name: 'Filters (4)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await snapshot(page.getByRole('dialog'), 'filters-dialog-390.aria.yml');
  });
});
