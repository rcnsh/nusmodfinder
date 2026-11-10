// @ts-check
// History (Phase 5 5B, F3): the transition table of docs/plans/phase5.md 5B in
// the browser, for the actions the 5B page has. Opening a detail needs the
// card's button, which is 5C's; those rows are covered in Node
// (test/web/state.node.test.js) until 5C adds them here.
import { expect, test } from '@playwright/test';
import { query, searches } from './support.mjs';

/** @param {import('@playwright/test').Page} page @param {string} q */
async function submit(page, q) {
  await page.locator('#q').fill(q);
  await page.locator('#q').press('Enter');
}
/** @param {import('@playwright/test').Page} page @param {string} q */
const resultsFor = (page, q) => expect(page.locator('#status')).toContainText(`results for ${q}`);
const historyLength = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => /** @type {any} */ (globalThis).history.length);

test('[F3] each submitted query is an entry: Back and Forward restore its results from memory, with no new fetch', async ({ page }) => {
  await page.goto('/');
  const sent = searches(page);
  for (const q of ['networks', 'databases', 'machine learning']) {
    await submit(page, q);
    await resultsFor(page, q);
  }
  expect(sent).toHaveLength(3);
  await page.goBack();
  await resultsFor(page, 'databases');
  await expect(page.locator('#q')).toHaveValue('databases');
  expect(query(page)).toBe('q=databases');
  await page.goBack();
  await resultsFor(page, 'networks');
  await page.goForward();
  await resultsFor(page, 'databases');
  expect(sent).toHaveLength(3);
  // Back past the first search is the empty page, not another site.
  await page.goBack();
  await page.goBack();
  await expect(page.locator('#status')).toHaveText('Type a query to begin.');
  expect(page.url()).toMatch(/\/$/);
});

test('[F3] submitting the same query again adds no entry', async ({ page }) => {
  await page.goto('/');
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  const before = await historyLength(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  expect(await historyLength(page)).toBe(before);
});

test('[F3] a filter change replaces the entry: Back goes to the previous query, not the unfiltered one', async ({ page }) => {
  await page.goto('/');
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  await submit(page, 'databases');
  await resultsFor(page, 'databases');
  const before = await historyLength(page);
  await page.locator('#level').selectOption('2');
  await expect(page.locator('#status .chip')).toHaveText(['level: 2']);
  expect(query(page)).toBe('q=databases&level=2');
  expect(await historyLength(page)).toBe(before);
  await page.goBack();
  await resultsFor(page, 'networks');
  await expect(page.locator('#level')).toHaveValue('');
  await page.goForward();
  await expect(page.locator('#level')).toHaveValue('2');
});

test('[F3] clearing the query pushes the URL without it; Back restores the cleared results', async ({ page }) => {
  await page.goto('/?level=2');
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  await submit(page, '');
  await expect(page.locator('#status')).toHaveText('Type a query to begin.');
  await expect(page.locator('#results > li')).toHaveCount(0);
  expect(query(page)).toBe('level=2');
  await page.goBack();
  await resultsFor(page, 'networks');
  expect(query(page)).toBe('q=networks&level=2');
});

test('[F3] a shared link restores its state on load and on reload', async ({ page }) => {
  await page.goto('/?q=databases&level=2&credits=4');
  await resultsFor(page, 'databases');
  await expect(page.locator('#level')).toHaveValue('2');
  await expect(page.locator('#credits')).toHaveValue('4');
  await page.reload();
  await resultsFor(page, 'databases');
  await expect(page.locator('#q')).toHaveValue('databases');
});

test('open= from a shared link: Escape closes it by replace (this page pushed no entry), and a filter change drops it', async ({ page }) => {
  await page.goto('/?q=networks&open=cs5562');
  expect(query(page)).toBe('q=networks&open=CS5562');
  await resultsFor(page, 'networks');
  const before = await historyLength(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => query(page)).toBe('q=networks');
  expect(await historyLength(page)).toBe(before);

  await page.goto('/?q=networks&open=CS5562&pick=CS5562');
  await resultsFor(page, 'networks');
  await page.locator('#sem').selectOption('1');
  await expect.poll(() => query(page)).toBe('q=networks&sem=1&pick=CS5562');
});

test('Back to an exchange-mode entry with no year of study takes the chosen one, and the URL says so', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Open to exchange students only').click();
  await expect.poll(() => query(page)).toBe('ng=1');
  await submit(page, 'networks');
  await expect(page.locator('#status')).toHaveText('Choose your year of study to see the courses open to you as an exchange student.');
  await page.locator('#study').selectOption('ug1');
  await expect(page.locator('#status .chip')).toHaveText(['exchange students only', '1st year']);
  await page.goBack();
  await expect.poll(() => query(page)).toBe('ng=1&study=ug1');
  await expect(page.locator('#study')).toHaveValue('ug1');
});

test('a link with an intent /search cannot undo still searches, and keeps no ignore=', async ({ page }) => {
  await page.goto('/?q=networks&ignore=bogus');
  await resultsFor(page, 'networks');
  expect(query(page)).toBe('q=networks');
});
