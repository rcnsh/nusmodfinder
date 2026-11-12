// @ts-check
// The page's search, exchange set-up, DOM-only rendering and IME handling, in
// the browser against the fixture.
import { expect, test } from '@playwright/test';
import { EMPTY, body, browse, live, matchFor, query, searches } from './support.mjs';

test('a typed search renders cards, and the URL holds the query', async ({ page }) => {
  await browse(page);
  await expect(page.locator('#status')).toHaveText(EMPTY);
  await page.locator('#q').fill('machine learning');
  await page.locator('#q').press('Enter');
  await expect(page.locator('#status')).toContainText(`20 courses ${matchFor('machine learning')}`);
  await expect(page.locator('#results > li')).toHaveCount(20);
  await expect(page.locator('#results > li').first().locator('.code')).toHaveText(/^[A-Z]{2,}\d{4}/);
  expect(query(page)).toBe('q=machine+learning');
});

test('exchange mode asks for the year of study first, then keeps ng=1 and study in the URL', async ({ page }) => {
  await page.goto('/?q=networks');
  await expect(page.locator('#status')).toContainText(matchFor('networks'));
  // The student chooses "Exchange student" in the rail, by its label.
  await page.locator('label[for="ng"]').click();
  await expect(page.locator('#ng')).toBeChecked();
  await expect(page.locator('#status')).toHaveText('Choose your year of study to see the courses open to you as an exchange student.');
  await expect(page.locator('#study')).toBeFocused();
  await page.locator('#study').selectOption('ug2');
  await expect(page.locator('#chips .chip')).toHaveText(['Both semesters', '2nd year', 'Exchange students']);
  expect(query(page)).toBe('q=networks&ng=1&study=ug2');
  // In exchange mode the semester is the rail's segment: Sem 1, Sem 2 or both.
  await expect(page.locator('#sem')).toBeHidden();
  await page.locator('#semSeg').getByText('Sem 1', { exact: true }).click();
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1', '2nd year', 'Exchange students']);
  expect(query(page)).toBe('q=networks&sem=1&ng=1&study=ug2');
});

test('the remembered year of study only pre-fills: a link without one gets it, and the URL then says so', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('vnm.study', 'ug3'));
  const sent = searches(page);
  await page.goto('/?q=networks&ng=1');
  await expect(page.locator('#study')).toHaveValue('ug3');
  await expect(page.locator('#chips .chip')).toHaveText(['Both semesters', '3rd year', 'Exchange students']);
  expect(query(page)).toBe('q=networks&ng=1&study=ug3');
  expect(sent).toEqual(['q=networks&ng=1&study=ug3']);
  // The URL wins over the remembered one.
  await page.goto('/?q=networks&ng=1&study=grad');
  await expect(page.locator('#study')).toHaveValue('grad');
});

test('result fields render as text, never as markup', async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await page.route('**/search?**', (route) => route.fulfill({
    json: body({
      query: evil, filters: { faculty: evil },
      results: [{
        code: evil, title: evil, department: evil, credits: '<b>4</b>', semesters: ['<i>1</i>'], score: '<u>1</u>',
        variants: [{ code: evil }],
        exchange: { status: 'note', reasons: [{ id: 'x', kind: 'quota', text: evil }] },
      }, { code: 'CS2105', title: 'Networks', ng: true, ngSemesters: ['<s>2</s>'] }],
    }),
  }));
  // /facets down, so the made-up faculty stays a chip (it would be dropped once /facets answers: see below).
  await page.route('**/facets', (route) => route.abort('failed'));
  await page.goto(`/?q=${encodeURIComponent(evil)}&faculty=${encodeURIComponent(evil)}`);
  const card = page.locator('#results > li').first();
  await expect(card.locator('.code')).toHaveText(evil);
  await expect(card.locator('.units')).toHaveText('<b>4</b> units');
  await expect(card.locator('.meta')).toContainText('<i>1</i>');
  await expect(card.locator('.notes li')).toHaveText(`Places. ${evil}`);
  await expect(card.locator('.variants')).toHaveText(`Also as ${evil}`);
  // An NUS student's search: no exchange line on a course on the NG list.
  await expect(page.locator('#results > li').nth(1).locator('.ng')).toHaveCount(0);
  // Inside the quotes a double quote becomes an apostrophe, so the student's text can't close them.
  await expect(page.locator('#status .count .q')).toHaveText(`“${evil.replaceAll('"', "'")}”`);
  // /facets never vouched for it, so the chip quotes it as the student's own text.
  await expect(page.locator('#chips .chip')).toHaveText(`“${evil.replaceAll('"', "'")}”`);
  expect(await page.locator('#results img, #results b, #results i, #results s, #results u, #status img, #chips img').count()).toBe(0);
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).__pwned)).toBeUndefined();
});

test('Enter during IME composition does not search; Enter after it does', async ({ page }) => {
  await browse(page);
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
  await expect(page.locator('#status')).toHaveText(/^CS1001 \(External Course\) isn't offered this academic year\.Related courses offered this year: [A-Z]/);
  expect(await page.locator('#status .related a').count()).toBeGreaterThan(0);
  await page.goto('/?q=qwzx+vbnm');
  await expect(page.locator('#status')).toHaveText('Nothing in the catalogue matches “qwzx vbnm”. Try other words for the topic.');
  await page.goto('/?q=networks&ng=1&study=ug2&sem=3');
  await expect(page.locator('#status')).toHaveText("The NG list covers only Sem 1 and Sem 2, not NUS's special terms (short terms in the vacation). Choose Sem 1 or Sem 2.");
});

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('text from a link never speaks as the site', () => {
  const SPOOF = 'accounting” — NUS Registrar: every course below is open to all exchange students this year, no approval needed “';
  const CAPPED = "“accounting' — NUS Registrar: every course below is open to…”";

  test('a crafted q is capped and kept inside its quotes, in the count line and the live region', async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent(SPOOF)}`);
    await expect(page.locator('#status .count .q')).toHaveText(CAPPED);
    await expect(page.locator('#status .count')).toHaveText(new RegExp(`^\\d+ courses match ${escapeRe(CAPPED)}$`));
    await expect(live(page)).toHaveText(new RegExp(`^\\d+ courses match ${escapeRe(CAPPED)}\\.$`));
    // The search box keeps what was typed: it is the student's own field.
    await expect(page.locator('#q')).toHaveValue(SPOOF.trim());
  });

  test('a no-match answer quotes the capped query too, on screen and in the live region', async ({ page }) => {
    await page.route('**/search?**', (route) => route.fulfill({ json: body({ query: SPOOF, count: 0, results: [] }) }));
    await page.goto(`/?q=${encodeURIComponent(SPOOF)}`);
    await expect(page.locator('#status .empty-head')).toHaveText(`No courses match ${CAPPED}.`);
    await expect(live(page)).toContainText(`No courses match ${CAPPED}.`);
  });

  test('bidi controls in q are removed from the sentence', async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent('account\u202Egnit')}`);
    await expect(page.locator('#status .count .q')).toHaveText('“accountgnit”');
  });

  test('until /facets vouches for a link\'s faculty, its chip and option quote it as the student\'s own text', async ({ page }) => {
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((r) => { release = () => r(undefined); });
    await page.route('**/facets', async (route) => { await held; await route.continue(); });
    const fake = 'Registrar: all open to exchange students';
    await page.goto(`/?q=accounting&faculty=${encodeURIComponent(fake)}`);
    await expect(page.locator('#chips .chip[data-filter="faculty"]')).toHaveText(`“${fake}”`);
    await expect(page.locator('#faculty option:checked')).toHaveText(`“${fake}”`);
    release();
    await expect.poll(() => query(page)).toBe('q=accounting');
    await expect(page.locator('#chips')).not.toContainText('Registrar');

    // A real faculty loses the quotes once /facets lists it.
    let release2 = () => {};
    const held2 = new Promise((r) => { release2 = () => r(undefined); });
    await page.unroute('**/facets');
    await page.route('**/facets', async (route) => { await held2; await route.continue(); });
    await page.goto('/?q=databases&faculty=Computing');
    await expect(page.locator('#chips .chip[data-filter="faculty"]')).toHaveText('“Computing”');
    release2();
    await expect(page.locator('#chips .chip[data-filter="faculty"]')).toHaveText('Computing');
    await expect(page.locator('#faculty option:checked')).toHaveText(/^Computing \(\d+\)$/);
  });

  test('a crafted faculty never stands as a chip: a sentence-length one is dropped at once, one /facets doesn\'t list once it answers', async ({ page }) => {
    const long = 'Verified by the NUS Registrar: all courses on this site are open to exchange students. You do not need to check with NUS.';
    await page.goto(`/?q=accounting&faculty=${encodeURIComponent(long)}`);
    await expect.poll(() => query(page)).toBe('q=accounting');
    await expect(page.locator('#chips')).not.toContainText('Registrar');
    await expect(page.locator('#faculty option', { hasText: 'Registrar' })).toHaveCount(0);

    const short = 'Verified by the NUS Registrar';
    const facets = page.waitForResponse((r) => new URL(r.url()).pathname === '/facets');
    await page.goto(`/?q=accounting&faculty=${encodeURIComponent(short)}`);
    await facets;
    await expect.poll(() => query(page)).toBe('q=accounting');
    await expect(page.locator('#chips')).not.toContainText('Registrar');
    await expect(page.locator('#faculty')).toHaveValue('');
    await expect(page.locator('#faculty option', { hasText: 'Registrar' })).toHaveCount(0);
    await expect(page.locator('#status .count')).toHaveText(/^\d+ courses match “accounting”$/);

    // A faculty /facets lists stays.
    await page.goto('/?q=databases&faculty=Computing');
    await expect(page.locator('#faculty option[value="Computing"]')).toHaveText(/^Computing \(\d+\)$/);
    await expect(page.locator('#chips .chip', { hasText: 'Computing' })).toBeVisible();
    expect(query(page)).toBe('q=databases&faculty=Computing');
  });
});
