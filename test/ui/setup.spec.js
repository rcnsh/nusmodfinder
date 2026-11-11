// @ts-check
// The first screen (Phase 5 5D, D2 as ADR 0008 records it): the page opens on
// the exchange set-up (the semester at NUS, the year of study, then what to
// study), with "Browse all courses instead" as the way out. A link with any
// state skips it.
import { expect, test } from '@playwright/test';
import { EMPTY, query, searches } from './support.mjs';

test('the page opens on the exchange set-up: two questions, then the query', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find the NUS courses you can take on exchange' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Which semester will you study at NUS?' }).getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('group', { name: 'Your year of study at your home university' }).getByRole('radio')).toHaveCount(5);
  await expect(page.getByLabel('What do you want to study?')).toBeVisible();
  await expect(page.locator('#q')).toBeHidden();
  await expect(page.locator('#setupSources')).toContainText('01 Sep 2026');
});

test('it asks for what is missing, one thing at a time, with focus on it; nothing is searched', async ({ page }) => {
  await page.goto('/');
  const sent = searches(page);
  const ask = page.locator('#setupError');
  await page.getByLabel('What do you want to study?').fill('accounting');
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect(ask).toHaveText('Choose the semester you will study at NUS.');
  await expect(page.getByRole('radio', { name: /^Sem 1/ })).toBeFocused();
  await page.getByRole('radio', { name: /^Sem 2/ }).check();
  await page.locator('#setupForm').getByRole('button', { name: 'Search' }).click();
  await expect(ask).toHaveText('Choose your year of study at your home university.');
  await expect(page.getByRole('radio', { name: '1st year' })).toBeFocused();
  expect(sent).toEqual([]);
  expect(query(page)).toBe('');
});

test('answered, it searches in exchange mode: the URL holds the set-up, and the rail and chips show it', async ({ page }) => {
  await page.goto('/');
  const sent = searches(page);
  await page.getByRole('radio', { name: /^Sem 1/ }).check();
  await page.getByRole('radio', { name: '2nd year' }).check();
  await page.getByLabel('What do you want to study?').fill('ACC1701XB');
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect(page.locator('#status')).toContainText('shown: ACC1701XB');
  expect(query(page)).toBe('q=ACC1701XB&sem=1&ng=1&study=ug2');
  expect(sent).toEqual(['q=ACC1701XB&sem=1&ng=1&study=ug2']);
  await expect(page.locator('#setup')).toBeHidden();
  await expect(page.locator('#q')).toHaveValue('ACC1701XB');
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1', '2nd year', 'Exchange students']);
  await expect(page.locator('#ng')).toBeChecked();
  await expect(page.locator('#study')).toHaveValue('ug2');
  // Back goes to the empty search, not the set-up again: the student has left it.
  await page.goBack();
  await expect(page.locator('#status')).toHaveText(EMPTY);
  await expect(page.locator('#setup')).toBeHidden();
});

test('"Both semesters" searches with no sem, and the year chosen is remembered for the next visit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /^Both semesters/ }).check();
  await page.getByRole('radio', { name: 'Graduate' }).check();
  await page.getByLabel('What do you want to study?').fill('networks');
  await page.locator('#setupForm').getByRole('button', { name: 'Search' }).click();
  await expect.poll(() => query(page)).toBe('q=networks&ng=1&study=grad');
  await expect(page.locator('#chips .chip')).toHaveText(['Both semesters', 'Graduate', 'Exchange students']);
  await page.goto('/');
  await expect(page.getByRole('radio', { name: 'Graduate' })).toBeChecked();
});

test('"Browse all courses instead" leaves the set-up for the general search, focus in the query box', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browse all courses instead' }).click();
  await expect(page.locator('#setup')).toBeHidden();
  await expect(page.locator('#q')).toBeFocused();
  await expect(page.locator('#status')).toHaveText(EMPTY);
  await expect(page.locator('#ng')).not.toBeChecked();
  expect(query(page)).toBe('');
});

test('a link with any state skips the set-up', async ({ page }) => {
  for (const path of ['/?level=2', '/?ng=1&study=ug2', '/?q=networks']) {
    await page.goto(path);
    await expect(page.locator('#setup'), path).toBeHidden();
    await expect(page.locator('#q'), path).toBeVisible();
  }
});
