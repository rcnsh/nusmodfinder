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
