// @ts-check
// F10 (Phase 5 5D): on a phone, 16px inputs (iOS zooms into anything smaller);
// after the first search the form is one bar that keeps the query field and the
// Search button in view; the exchange set-up and filters open in a modal
// <dialog> from a "Filters (n)" button: focus stays inside it, Escape closes
// it, and focus returns to the button.
import { expect, test } from '@playwright/test';
import { query } from './support.mjs';

test.use({ viewport: { width: 390, height: 664 } });

const fontSize = (/** @type {import('@playwright/test').Locator} */ l) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test('[F10] every text input and select is at least 16px, on the first screen and after a search', async ({ page }) => {
  await page.goto('/');
  for (const el of await page.locator('#setup input[type="search"], #setup select').all()) expect(await fontSize(el)).toBeGreaterThanOrEqual(16);
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const controls = page.locator('input[type="search"], select');
  expect(await controls.count()).toBeGreaterThanOrEqual(5);
  for (const el of await controls.all()) expect(await fontSize(el), await el.getAttribute('id') ?? '').toBeGreaterThanOrEqual(16);
});

test('[F10] after the first search the form is one bar: the query field and Search side by side, in view; the rail is behind "Filters (n)"', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /^Sem 1/ }).check();
  await page.getByRole('radio', { name: '2nd year' }).check();
  await page.getByLabel('What do you want to study?').fill('accounting');
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect.poll(() => query(page)).toBe('q=accounting&sem=1&ng=1&study=ug2');
  const q = page.locator('#q');
  const go = page.locator('#go');
  await expect(q).toBeInViewport({ ratio: 1 });
  await expect(go).toBeInViewport({ ratio: 1 });
  const [qb, gb] = [await q.boundingBox(), await go.boundingBox()];
  if (!qb || !gb) throw new Error('no box');
  expect(Math.abs(qb.y - gb.y)).toBeLessThan(4);
  expect(gb.x).toBeGreaterThan(qb.x + qb.width - 1);
  expect(gb.x + gb.width).toBeLessThanOrEqual(390);
  await expect(page.locator('.rail')).toBeHidden();
  await expect(page.locator('#study')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters (3)' })).toBeVisible();
});

test('[F10] Filters opens a modal dialog with the set-up and filters; a change applies at once; Escape closes it and focus returns', async ({ page }) => {
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  const button = page.getByRole('button', { name: 'Filters (3)' });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Your exchange and filters' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
  // Focus starts inside, on the first control.
  await expect(page.locator('#ng')).toBeFocused();
  await expect(dialog.locator('#study')).toBeVisible();
  await dialog.locator('#level').selectOption('2');
  await expect.poll(() => query(page)).toBe('q=networks&sem=1&level=2&ng=1&study=ug2');
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1', '2nd year', 'Exchange students', 'Level 2000']);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters (4)' })).toBeFocused();
  // The controls are back in the rail (hidden on a phone), and one copy of each exists.
  await expect(page.locator('#level')).toHaveCount(1);
  expect(await page.locator('#level').evaluate((el) => !!el.closest('.rail'))).toBe(true);
  // Escape closed the dialog only: the results are still there.
  expect(query(page)).toBe('q=networks&sem=1&level=2&ng=1&study=ug2');
});

test('[F10] focus is trapped in the dialog: Tab and Shift+Tab wrap around inside it', async ({ page }) => {
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('dialog'));
  /** @type {string[]} */
  const seen = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab');
    expect(await inside(), `Tab ${i + 1}`).toBe(true);
    seen.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent || ''));
  }
  // It went round: the Done button, then the first control again, the
  // exchange checkbox (the page moves focus itself, so WebKit, whose own Tab
  // skips checkboxes, stops there too).
  expect(seen).toContain('filtersDone');
  expect(seen.indexOf('ng', seen.indexOf('filtersDone'))).toBeGreaterThan(seen.indexOf('filtersDone'));
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside(), `Shift+Tab ${i + 1}`).toBe(true);
  }
});

test('[F10] Done closes the dialog and returns focus to the button', async ({ page }) => {
  await page.goto('/?q=networks&level=3');
  const button = page.getByRole('button', { name: 'Filters (1)' });
  await button.click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(button).toBeFocused();
});

test('[V1] a chip removes its filter, and focus moves to the next chip', async ({ page }) => {
  await page.goto('/?q=databases&level=2&credits=4&faculty=Computing');
  await expect(page.locator('#chips .chip')).toHaveText(['Level 2000', '4 units', 'Computing']);
  await page.getByRole('button', { name: 'Remove filter: Level 2000' }).click();
  await expect.poll(() => query(page)).toBe('q=databases&credits=4&faculty=Computing');
  await expect(page.getByRole('button', { name: 'Remove filter: 4 units' })).toBeFocused();
  await expect(page.locator('#level')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Filters (2)' })).toBeVisible();
  // Removing "Exchange students" leaves exchange mode; the semester and year stay in the rail.
  await page.goto('/?q=networks&sem=1&ng=1&study=ug2');
  await page.getByRole('button', { name: 'Remove filter: Exchange students' }).click();
  await expect.poll(() => query(page)).toBe('q=networks&sem=1');
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1']);
});

test('[V1] filters are labelled one way everywhere: "Sem 2", "Level 2000", "4 units", in the options and the chips', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=databases&sem=2&level=2&credits=4');
  await expect(page.locator('#sem option:checked')).toHaveText('Sem 2');
  await expect(page.locator('#level option:checked')).toHaveText('Level 2000');
  await expect(page.locator('#credits option:checked')).toHaveText('4 units');
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 2', 'Level 2000', '4 units']);
  await expect(page.locator('#sem option')).toHaveText(['Any semester', 'Sem 1', 'Sem 2', 'Special term 1', 'Special term 2']);
});

test('[V1] no results with filters on names the next step: remove a filter', async ({ page }) => {
  await page.goto('/?q=qwzx+vbnm&level=2');
  await expect(page.locator('#status')).toContainText('Nothing in the catalogue matches');
  await page.route('**/search?**', (route) => route.fulfill({ json: { query: 'networks', filters: { level: 6 }, count: 0, results: [], interpreted: {}, hiddenPins: [], notOffered: [] } }));
  await page.goto('/?q=networks&level=6');
  await expect(page.locator('#status')).toHaveText('No courses match “networks”.Remove a filter above to see more courses, or try other words.');
  await expect(page.getByRole('button', { name: 'Remove filter: Level 6000' })).toBeVisible();
});

test('at 1280 the rail is beside the results and there is no Filters button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await expect(page.locator('.rail')).toBeVisible();
  await expect(page.locator('#study')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1', '2nd year', 'Exchange students']);
});

test('the dialog closes if the window widens past the phone layout, and the rail shows the controls', async ({ page }) => {
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.rail #study')).toBeVisible();
});
