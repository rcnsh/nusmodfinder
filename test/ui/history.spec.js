// @ts-check
// History (Phase 5 5B, 5C, F3): the transition table of docs/plans/phase5.md
// 5B in the browser, every row: queries, filters, clearing, and (5C) opening,
// switching and closing a card's detail, with focus back on its button.
import { expect, test } from '@playwright/test';
import { EMPTY, browse, matchFor, query, searches } from './support.mjs';

/** @param {import('@playwright/test').Page} page @param {string} q */
async function submit(page, q) {
  await page.locator('#q').fill(q);
  await page.locator('#q').press('Enter');
}
/** @param {import('@playwright/test').Page} page @param {string} q */
const resultsFor = (page, q) => expect(page.locator('#status')).toContainText(matchFor(q));
const historyLength = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => /** @type {any} */ (globalThis).history.length);

test('[F3] each submitted query is an entry: Back and Forward restore its results from memory, with no new fetch', async ({ page }) => {
  await browse(page);
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
  await expect(page.locator('#status')).toHaveText(EMPTY);
  expect(page.url()).toMatch(/\/$/);
});

test('[F3] submitting the same query again adds no entry', async ({ page }) => {
  await browse(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  const before = await historyLength(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  expect(await historyLength(page)).toBe(before);
});

test('[F3] a filter change replaces the entry: Back goes to the previous query, not the unfiltered one', async ({ page }) => {
  await browse(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  await submit(page, 'databases');
  await resultsFor(page, 'databases');
  const before = await historyLength(page);
  await page.locator('#level').selectOption('2');
  await expect(page.locator('#chips .chip')).toHaveText(['Level 2000']);
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
  await expect(page.locator('#status')).toHaveText(EMPTY);
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
  await browse(page);
  await page.getByText('Only courses open to exchange students').click();
  await expect.poll(() => query(page)).toBe('ng=1');
  await submit(page, 'networks');
  await expect(page.locator('#status')).toHaveText('Choose your year of study to see the courses open to you as an exchange student.');
  await page.locator('#study').selectOption('ug1');
  await expect(page.locator('#chips .chip')).toHaveText(['Both semesters', '1st year', 'Exchange students']);
  await page.goBack();
  await expect.poll(() => query(page)).toBe('ng=1&study=ug1');
  await expect(page.locator('#study')).toHaveValue('ug1');
});

test('a link with an intent /search cannot undo still searches, and keeps no ignore=', async ({ page }) => {
  await page.goto('/?q=networks&ignore=bogus');
  await resultsFor(page, 'networks');
  expect(query(page)).toBe('q=networks');
});

/** @param {import('@playwright/test').Page} page @param {string} code */
const toggle = (page, code) => page.locator(`#results button.card-toggle[data-code="${code}"]`);

test('[F3] opening a detail with none open pushes; Back closes it, with focus on its button', async ({ page }) => {
  await page.goto('/?q=CS3244');
  await expect(toggle(page, 'CS3244')).toBeVisible();
  const before = await historyLength(page);
  await toggle(page, 'CS3244').click();
  await expect(toggle(page, 'CS3244')).toHaveAttribute('aria-expanded', 'true');
  expect(query(page)).toBe('q=CS3244&open=CS3244');
  expect(await historyLength(page)).toBe(before + 1);
  await page.goBack();
  await expect.poll(() => query(page)).toBe('q=CS3244');
  await expect(toggle(page, 'CS3244')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`#${await toggle(page, 'CS3244').getAttribute('aria-controls')}`)).toBeHidden();
  await expect(toggle(page, 'CS3244')).toBeFocused();
});

test('[F3] opening another detail while one is open replaces: one open at a time, and Back goes to the list', async ({ page }) => {
  await browse(page);
  await submit(page, 'machine learning');
  await resultsFor(page, 'machine learning');
  const buttons = page.locator('#results button.card-toggle');
  const [a, b] = [await buttons.nth(0).getAttribute('data-code'), await buttons.nth(1).getAttribute('data-code')];
  await buttons.nth(0).click();
  await expect.poll(() => query(page)).toBe(`q=machine+learning&open=${a}`);
  const opened = await historyLength(page);
  await buttons.nth(1).click();
  await expect.poll(() => query(page)).toBe(`q=machine+learning&open=${b}`);
  expect(await historyLength(page)).toBe(opened);
  await expect(buttons.nth(0)).toHaveAttribute('aria-expanded', 'false');
  await expect(buttons.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#results .detail:not([hidden])')).toHaveCount(1);
  await page.goBack();
  await expect.poll(() => query(page)).toBe('q=machine+learning');
  await expect(page.locator('#results .detail:not([hidden])')).toHaveCount(0);
  await expect(buttons.nth(1)).toBeFocused();
});

test('[F3] closing a detail this page opened goes back, by its button, its Close button or Escape; focus returns to its button', async ({ page }) => {
  await page.goto('/?q=CS3244');
  const t = toggle(page, 'CS3244');
  const before = await historyLength(page);
  for (const close of ['toggle', 'close', 'escape']) {
    await t.click();
    await expect.poll(() => query(page)).toBe('q=CS3244&open=CS3244');
    // Opening again from the list entry pushes over the forward entry Back left.
    expect(await historyLength(page), close).toBe(before + 1);
    if (close === 'toggle') await t.click();
    else if (close === 'close') await page.getByRole('button', { name: 'Close details' }).click();
    else await page.keyboard.press('Escape');
    await expect.poll(() => query(page), close).toBe('q=CS3244');
    // back(), not a new entry: the open entry is Forward from here.
    expect(await historyLength(page), close).toBe(before + 1);
    await expect(t, close).toHaveAttribute('aria-expanded', 'false');
    await expect(t, close).toBeFocused();
  }
  await page.goForward();
  await expect(t).toHaveAttribute('aria-expanded', 'true');
});

test('a detail opened from a shared link closes by replace, and focus goes to its button', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244');
  const t = toggle(page, 'CS3244');
  await expect(t).toHaveAttribute('aria-expanded', 'true');
  const before = await historyLength(page);
  await t.click();
  await expect.poll(() => query(page)).toBe('q=CS3244');
  expect(await historyLength(page)).toBe(before);
  await expect(t).toBeFocused();
});

test('a filter change while a detail is open drops open= and closes it (A3-3)', async ({ page }) => {
  await page.goto('/?q=CS3244');
  await toggle(page, 'CS3244').click();
  await expect.poll(() => query(page)).toBe('q=CS3244&open=CS3244');
  await page.locator('#sem').selectOption('1');
  await expect.poll(() => query(page)).toBe('q=CS3244&sem=1');
  await expect(toggle(page, 'CS3244')).toHaveAttribute('aria-expanded', 'false');
});

test('open= survives a reload and Back/Forward for every code shape (LC6009GRSII)', async ({ page }) => {
  await page.goto('/?q=LC6009GRSII');
  await toggle(page, 'LC6009GRSII').click();
  await expect.poll(() => query(page)).toBe('q=LC6009GRSII&open=LC6009GRSII');
  await page.reload();
  await expect(toggle(page, 'LC6009GRSII')).toHaveAttribute('aria-expanded', 'true');
  expect(query(page)).toBe('q=LC6009GRSII&open=LC6009GRSII');
});

test('Escape that ends an IME composition in the query box leaves the detail open', async ({ page }) => {
  await page.goto('/?q=CS3244');
  await toggle(page, 'CS3244').click();
  await expect.poll(() => query(page)).toBe('q=CS3244&open=CS3244');
  await page.locator('#q').focus();
  await page.locator('#q').evaluate((el) => {
    el.dispatchEvent(new (/** @type {any} */ (globalThis).KeyboardEvent)('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  expect(query(page)).toBe('q=CS3244&open=CS3244');
  await expect(page.locator('#q')).toBeFocused();
});
