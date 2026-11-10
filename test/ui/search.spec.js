// @ts-check
// The page's search, exchange set-up, DOM-only rendering (F8) and IME (F9), in
// the browser against the fixture.
import { expect, test } from '@playwright/test';
import { body, query, searches } from './support.mjs';

test('a typed search renders cards, and the URL holds the query', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Type a query to begin.');
  await page.locator('#q').fill('machine learning');
  await page.locator('#q').press('Enter');
  await expect(page.locator('#status')).toContainText('20 results for machine learning');
  await expect(page.locator('#results > li')).toHaveCount(20);
  await expect(page.locator('#results > li').first().locator('.code')).toHaveText(/^[A-Z]{2,}\d{4}/);
  expect(query(page)).toBe('q=machine+learning');
});

test('exchange mode asks for the year of study first, then keeps ng=1 and study in the URL', async ({ page }) => {
  await page.goto('/?q=networks');
  await expect(page.locator('#status')).toContainText('results for networks');
  // The checkbox is drawn as a switch; the student clicks its label.
  await page.getByText('Open to exchange students only').click();
  await expect(page.locator('#ng')).toBeChecked();
  await expect(page.locator('#status')).toHaveText('Choose your year of study to see the courses open to you as an exchange student.');
  await expect(page.locator('#study')).toBeFocused();
  await page.locator('#study').selectOption('ug2');
  await expect(page.locator('#status .chip')).toHaveText(['exchange students only', '2nd year']);
  expect(query(page)).toBe('q=networks&ng=1&study=ug2');
  await page.locator('#sem').selectOption('1');
  await expect(page.locator('#status .chip')).toHaveText(['sem: Sem 1', 'exchange students only', '2nd year']);
  expect(query(page)).toBe('q=networks&sem=1&ng=1&study=ug2');
});

test('the remembered year of study only pre-fills: a link without one gets it, and the URL then says so', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('vnm.study', 'ug3'));
  const sent = searches(page);
  await page.goto('/?q=networks&ng=1');
  await expect(page.locator('#study')).toHaveValue('ug3');
  await expect(page.locator('#status .chip')).toHaveText(['exchange students only', '3rd year']);
  expect(query(page)).toBe('q=networks&ng=1&study=ug3');
  expect(sent).toEqual(['q=networks&ng=1&study=ug3']);
  // The URL wins over the remembered one.
  await page.goto('/?q=networks&ng=1&study=grad');
  await expect(page.locator('#study')).toHaveValue('grad');
});

test('[F8] result fields render as text, never as markup', async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await page.route('**/search?**', (route) => route.fulfill({
    json: body({
      query: evil, filters: { faculty: evil },
      results: [{
        code: evil, title: evil, department: evil, credits: '<b>4</b>', semesters: ['<i>1</i>'], score: '<u>1</u>',
        ng: true, ngSemesters: ['<s>2</s>'], exchange: { status: 'note', reasons: [{ id: 'x', kind: 'quota', text: evil }] },
      }],
    }),
  }));
  await page.goto('/?q=x');
  const card = page.locator('#results > li').first();
  await expect(card.locator('.code')).toHaveText(evil);
  await expect(card.locator('.meta')).toContainText('<b>4</b> units');
  await expect(card.locator('.meta')).toContainText('<i>1</i>');
  await expect(card.locator('.notes li')).toHaveText(evil);
  await expect(card.locator('.ng')).toHaveText('NG <s>2</s>');
  await expect(page.locator('#status strong')).toHaveText(evil);
  await expect(page.locator('#status .chip')).toHaveText(`faculty: ${evil}`);
  expect(await page.locator('#results img, #results b, #results i, #results s, #results u, #status img').count()).toBe(0);
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).__pwned)).toBeUndefined();
});

test('[F9] Enter during IME composition does not search; Enter after it does', async ({ page }) => {
  await page.goto('/');
  const sent = searches(page);
  await page.locator('#q').fill('とうきょう');
  /** @param {{ composing: boolean, keyCode: number }} init */
  const enter = (init) => page.locator('#q').evaluate((el, { composing, keyCode }) => {
    const e = new (/** @type {any} */ (globalThis).KeyboardEvent)('keydown', { key: 'Enter', isComposing: composing, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    el.dispatchEvent(e);
  }, init);
  await enter({ composing: true, keyCode: 229 });
  await enter({ composing: true, keyCode: 13 });
  // Safari: the keydown that ends a composition, after compositionend.
  await enter({ composing: false, keyCode: 229 });
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
  expect(query(page)).toBe('');
  await page.locator('#q').press('Enter');
  await expect.poll(() => sent).toEqual([`q=${encodeURIComponent('とうきょう')}`]);
});

test('no-match answers are plain sentences: a code not offered, and a query with no signal', async ({ page }) => {
  await page.goto('/?q=CS1001');
  await expect(page.locator('#status')).toHaveText("CS1001 (External Course) isn't offered this academic year.");
  await page.goto('/?q=qwzx+vbnm');
  await expect(page.locator('#status')).toHaveText('Nothing in the catalogue matches “qwzx vbnm”. Try other words for the topic.');
  await page.goto('/?q=networks&ng=1&study=ug2&sem=3');
  await expect(page.locator('#status')).toHaveText("The Registrar's exchange-student list covers Semesters 1 and 2 only, so there is nothing to show for a special term.");
});
