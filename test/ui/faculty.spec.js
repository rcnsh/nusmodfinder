// @ts-check
// The faculty filter is a combobox (public/choice.js): the list opens under the
// box, typing narrows it (a name that starts with the text first, then a word
// that does), arrows and Enter or a click choose, and Escape or leaving puts the
// chosen name back. In the phone's filters dialog Escape closes the list only.
import { expect, test } from '@playwright/test';
import { facultyOptions, openFaculty, query, searches, settled } from './support.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

test('typing narrows the list, best match first; Down and Enter choose; the URL and chip follow', async ({ page }) => {
  await page.goto('/?q=networks');
  await settled(page);
  const box = page.locator('#faculty');
  await expect(box).toHaveAttribute('placeholder', 'Any faculty');
  await box.click();
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.type('sci');
  // "Science" starts with it; "Arts and Social Science" only has a word that does.
  await expect(facultyOptions(page).first()).toHaveText('Science');
  await expect(box).toHaveAttribute('aria-activedescendant', 'faculty-list-0');
  await page.keyboard.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', 'faculty-list-1');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(() => query(page)).toBe('q=networks&faculty=Science');
  await expect(box).toHaveValue('Science');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#chips .chip[data-filter="faculty"]')).toHaveText('Science');
});

test('a choice from outside while the student types takes effect, and their text stays until they leave', async ({ page }) => {
  await page.goto('/?q=networks&faculty=Computing');
  await settled(page);
  const box = page.locator('#faculty');
  await page.locator('#q').fill('databases');
  await page.locator('#q').press('Enter');
  await expect.poll(() => query(page)).toBe('q=databases&faculty=Computing');
  await box.click();
  await page.keyboard.type('Law');
  await page.keyboard.press('Enter');
  await expect.poll(() => query(page)).toBe('q=databases&faculty=Law');
  // A click on the focused box selects the name again, so typing replaces it.
  await box.click();
  await page.keyboard.type('sci');
  await expect(box).toHaveValue('sci');
  await page.evaluate(() => history.back());
  await expect.poll(() => query(page)).toBe('q=networks&faculty=Computing');
  await expect(box).toHaveAttribute('data-value', 'Computing');
  await expect(box).toHaveValue('sci');
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('Computing');
});

test('Escape and leaving put the chosen name back without a change; a click on an option chooses it', async ({ page }) => {
  await page.goto('/?q=networks&faculty=Computing');
  await settled(page);
  const box = page.locator('#faculty');
  await expect(box).toHaveValue('Computing');
  await box.click();
  await page.keyboard.type('law');
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('Computing');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  expect(query(page)).toBe('q=networks&faculty=Computing');
  await page.keyboard.type('zzz');
  await expect(page.locator('#faculty-list')).toHaveText('No faculty matches “zzz”');
  await page.locator('#q').click();
  await expect(box).toHaveValue('Computing');
  await openFaculty(page);
  await facultyOptions(page).filter({ hasText: /^Any faculty$/ }).click();
  await expect.poll(() => query(page)).toBe('q=networks');
  await expect(box).toHaveValue('');
  await expect(page.locator('#chips .chip[data-filter="faculty"]')).toHaveCount(0);
});

test('in the phone\'s filters dialog the list opens under the box, and Escape closes the list, not the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/?q=networks');
  await settled(page);
  await page.getByRole('button', { name: /^Filters/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = dialog.locator('#faculty');
  await box.click();
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  // Clear of the dialog's sticky head, with the list below it.
  const [head, b] = [await dialog.locator('.dlg-head').boundingBox(), await box.boundingBox()];
  if (!head || !b) throw new Error('no box');
  expect(b.y).toBeGreaterThanOrEqual(head.y + head.height);
  await expect(dialog.locator('#faculty-list [role="option"]').first()).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
  await expect(box).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('typing then leaving changes nothing: no search, and an open detail stays open', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244');
  await settled(page);
  const sent = searches(page);
  await page.locator('#faculty').click();
  await page.keyboard.type('law');
  await page.locator('#q').click();
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect(query(page)).toBe('q=CS3244&open=CS3244');
});

test('the first letter typed makes the best match active, not the current choice', async ({ page }) => {
  await page.goto('/?q=networks&faculty=Arts+and+Social+Science');
  await settled(page);
  await page.locator('#faculty').click();
  await page.keyboard.type('l');
  await expect(page.locator('#faculty')).toHaveAttribute('aria-activedescendant', 'faculty-list-0');
  await page.keyboard.press('Enter');
  await expect.poll(() => query(page)).not.toContain('Arts');
});
