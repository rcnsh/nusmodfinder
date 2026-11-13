// @ts-check
// The first screen: the page opens on the search, asking who is searching. An
// NUS student types what to study and searches every course; an exchange
// student also answers the exchange set-up (the semester at NUS, the year of
// study). "Browse all courses instead" is the way out. A link with any state
// skips it.
import { expect, test } from '@playwright/test';
import { EMPTY, query, searches, pill } from './support.mjs';

/** @param {import('@playwright/test').Page} page */
const asExchange = (page) => page.getByRole('radio', { name: /^Exchange student/ }).check();

test('the page opens on the search for an NUS student; the exchange questions wait for an exchange student', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find NUS courses in your own words' })).toBeVisible();
  const who = page.getByRole('group', { name: 'Who are you searching as?' }).getByRole('radio');
  await expect(who).toHaveCount(2);
  await expect(page.getByRole('radio', { name: /^NUS student/ })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Which semester will you study at NUS?' })).toBeHidden();
  await expect(page.getByRole('group', { name: 'Your year of study during your exchange' })).toBeHidden();
  await expect(page.locator('#setupSources')).toBeHidden();
  await expect(page.getByLabel('What do you want to study?')).toBeVisible();
  await expect(page.locator('#q')).toBeHidden();
  await asExchange(page);
  await expect(page.getByRole('group', { name: 'Which semester will you study at NUS?' }).getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('group', { name: 'Your year of study during your exchange' }).getByRole('radio')).toHaveCount(5);
  await expect(page.locator('#setupSources')).toContainText('01 Sep 2026');
  await expect(page.locator('#setupQNum')).toHaveText('04');
  await page.getByRole('radio', { name: /^NUS student/ }).check();
  await expect(page.getByRole('group', { name: 'Which semester will you study at NUS?' })).toBeHidden();
  await expect(page.locator('#setupQNum')).toHaveText('02');
});

test('an NUS student searches every course: no exchange mode, and the choice is remembered', async ({ page }) => {
  await page.goto('/');
  const sent = searches(page);
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect(page.locator('#setupError')).toHaveText('Type what you want to study.');
  await expect(page.getByLabel('What do you want to study?')).toBeFocused();
  expect(sent).toEqual([]);
  await page.getByLabel('What do you want to study?').fill('networks');
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect.poll(() => query(page)).toBe('q=networks');
  expect(sent).toEqual(['q=networks']);
  await expect(page.locator('#setup')).toBeHidden();
  await expect(page.locator('#ng')).not.toBeChecked();
  await expect(page.locator('#chips .chip')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByRole('radio', { name: /^NUS student/ })).toBeChecked();
});

test('it asks an exchange student for what is missing, one thing at a time, with focus on it; nothing is searched', async ({ page }) => {
  await page.goto('/');
  await asExchange(page);
  const sent = searches(page);
  const ask = page.locator('#setupError');
  await page.getByLabel('What do you want to study?').fill('accounting');
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect(ask).toHaveText('Choose the semester you will study at NUS.');
  await expect(page.getByRole('radio', { name: /^Sem 1/ })).toBeFocused();
  await page.getByRole('radio', { name: /^Sem 2/ }).check();
  await page.locator('#setupForm').getByRole('button', { name: 'Search' }).click();
  await expect(ask).toHaveText('Choose your year of study during your exchange.');
  await expect(page.getByRole('radio', { name: '1st year' })).toBeFocused();
  expect(sent).toEqual([]);
  expect(query(page)).toBe('');
});

test('answered, it searches in exchange mode: the URL holds the set-up, and the rail and chips show it', async ({ page }) => {
  await page.goto('/');
  await asExchange(page);
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
  await expect(pill(page, 'study', 'ug2')).toBeChecked();
  // Back goes to the empty search, not the set-up again: the student has left it.
  await page.goBack();
  await expect(page.locator('#status')).toHaveText(EMPTY);
  await expect(page.locator('#setup')).toBeHidden();
});

test('"Both semesters" searches with no sem, and the choice and year are remembered for the next visit', async ({ page }) => {
  await page.goto('/');
  await asExchange(page);
  await page.getByRole('radio', { name: /^Both semesters/ }).check();
  await page.getByRole('radio', { name: 'Graduate' }).check();
  await page.getByLabel('What do you want to study?').fill('networks');
  await page.locator('#setupForm').getByRole('button', { name: 'Search' }).click();
  await expect.poll(() => query(page)).toBe('q=networks&ng=1&study=grad');
  await expect(page.locator('#chips .chip')).toHaveText(['Both semesters', 'Graduate', 'Exchange students']);
  await page.goto('/');
  await expect(page.getByRole('radio', { name: /^Exchange student/ })).toBeChecked();
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

test('an exchange student who browses keeps exchange mode, with what they answered', async ({ page }) => {
  await page.goto('/');
  await asExchange(page);
  await page.getByRole('radio', { name: /^Sem 2/ }).check();
  await page.getByRole('radio', { name: '3rd year' }).check();
  await page.getByRole('button', { name: 'Browse all courses instead' }).click();
  await expect(page.locator('#setup')).toBeHidden();
  await expect(page.locator('#q')).toBeFocused();
  await expect.poll(() => query(page)).toBe('sem=2&ng=1&study=ug3');
  await expect(page.locator('#ng')).toBeChecked();
  await expect(page.locator('#status')).toHaveText(EMPTY);
});

test('a device with a year of study saved from before has the exchange student answer chosen', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('vnm.study', 'ug2'); sessionStorage.setItem('seeded', '1'); } });
  await page.goto('/');
  await expect(page.getByRole('radio', { name: /^Exchange student/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: '2nd year' })).toBeChecked();
});

test('the rail\'s answer is remembered for the first screen', async ({ page }) => {
  await page.goto('/?q=networks');
  await page.locator('label[for="ng"]').click();
  await page.goto('/');
  await expect(page.getByRole('radio', { name: /^Exchange student/ })).toBeChecked();
});

test('a link with any state skips the set-up', async ({ page }) => {
  for (const path of ['/?level=2', '/?ng=1&study=ug2', '/?q=networks']) {
    await page.goto(path);
    await expect(page.locator('#setup'), path).toBeHidden();
    await expect(page.locator('#q'), path).toBeVisible();
  }
});
