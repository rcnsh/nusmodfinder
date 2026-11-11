// @ts-check
// The shortlist UI (Phase 6 6C; docs/plans/phase6.md 6C "Tests first"), and
// the view's history cases 6B left to it: the cards' and the detail head's
// toggles, the shortlist button, the view's rows, Move, Make, the semester
// buttons, Remove and Undo, the export question, Copy link, Try again, G3's
// restore and forget, and the view's entries in history (a 429 and a 500
// behind it, Escape, Back and Forward, a submit from it). Focus is asserted
// after every move the page makes, with the control in view and not covered,
// driven by real clicks and keys (Playwright WebKit doesn't scroll for a
// programmatic focus). Both browsers; the row tests at 1280 and 390×664.
import { expect, test } from '@playwright/test';
import { live, query, searches, settled } from './support.mjs';

/** A link's query string, built as the page writes it. @param {string} qs */
const at = (qs) => `/?${qs}`;
/** @param {import('@playwright/test').Page} page */
const view = (page) => page.locator('#slView');
/** @param {import('@playwright/test').Page} page @param {string} code */
const row = (page, code) => page.locator(`#slView li.sl-entry[data-code="${code}"]`);
/** @param {import('@playwright/test').Page} page @param {string} name */
const button = (page, name) => page.getByRole('button', { name, exact: true });
/**
 * Activates a control by keyboard, as SC8's keyboard user does: focus on it,
 * then a real Enter (Space for a checkbox or radio). The page's own focus moves
 * then run inside a key event, in both browsers (WebKit, like Safari, doesn't
 * focus a button on a mouse click).
 * @param {import('@playwright/test').Page} page @param {string | import('@playwright/test').Locator} target a button's name, or a locator
 */
async function activate(page, target) {
  const el = typeof target === 'string' ? button(page, target) : target;
  await el.focus();
  const role = await el.evaluate((x) => (x instanceof HTMLInputElement ? x.type : 'button'));
  await page.keyboard.press(role === 'checkbox' || role === 'radio' ? 'Space' : 'Enter');
}
/** The shortlist button the layout shows (the rail's, or the phone's under the form). @param {import('@playwright/test').Page} page */
const openButton = (page) => page.locator('.sl-open:visible');
/** The focused element, named as the tests name it. @param {import('@playwright/test').Page} page */
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'body';
  return a.id ? `#${a.id}` : (a.getAttribute('aria-label') ?? a.textContent ?? '').replace(/\s+/g, ' ').trim();
});
/**
 * Whether the focused control is in the viewport and not covered (as
 * keyboard.spec.js checks): 'ok', or what is wrong.
 * @param {import('@playwright/test').Page} page
 */
const inView = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return 'focus on the page';
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return 'no box';
  if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return `off screen (${Math.round(r.top)})`;
  const x = Math.min(Math.max(r.left + Math.min(r.width / 2, 20), 0), innerWidth - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  if (top && !el.contains(top) && !top.contains(el)) return `covered by ${top.tagName.toLowerCase()}.${top.className}`;
  return 'ok';
});
/**
 * Asserts focus is on `name` (an aria-label, text or #id) and in view.
 * @param {import('@playwright/test').Page} page @param {string} name
 */
async function focusOn(page, name) {
  await expect.poll(() => focused(page)).toBe(name);
  expect(await inView(page)).toBe('ok');
}
/** The codes in a list, in order. @param {import('@playwright/test').Page} page @param {'slPickList' | 'slAltList'} id */
const codes = (page, id) => page.locator(`#${id} > li`).evaluateAll((lis) => lis.map((li) => li.getAttribute('data-code')));
/** The view is shown and every row has loaded or failed. @param {import('@playwright/test').Page} page */
async function rowsIn(page) {
  await expect(view(page)).toBeVisible();
  await expect(page.locator('#slView .sl-ehead .title', { hasText: 'Loading…' })).toHaveCount(0);
}

test.describe('the toggle and the list', () => {
  test('[6C] three added from results: toggles pressed; reload, Back, Forward and a fresh context show the same lists', async ({ page, browser }) => {
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1'));
    await settled(page);
    await page.locator('#q').fill('ACC1701XB CS2113 CS2030');
    await page.locator('#q').press('Enter');
    await expect(page.locator('#results > li.card')).not.toHaveCount(0);
    await settled(page);
    for (const code of ['ACC1701XB', 'CS2113', 'CS2030']) {
      const t = button(page, `Shortlist, ${code}`);
      await t.click();
      await expect(t).toHaveAttribute('aria-pressed', 'true');
    }
    const want = 'pick=ACC1701XB.1&pick=CS2113.1&pick=CS2030.1';
    await expect.poll(() => query(page)).toContain(want);
    await expect(openButton(page)).toContainText('Your shortlist');
    await expect(openButton(page)).toContainText('Sem 1: 12 units picked');
    // The list is page-wide: Back keeps it, and writes it into the entry it reaches.
    await page.goBack();
    await expect.poll(() => query(page)).toContain('q=networks');
    await expect.poll(() => query(page)).toContain(want);
    await page.goForward();
    await expect.poll(() => query(page)).toContain('q=ACC1701XB');
    await expect(button(page, 'Shortlist, CS2113')).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(button(page, 'Shortlist, CS2030')).toHaveAttribute('aria-pressed', 'true');
    const url = page.url();
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await p2.goto(url);
    await openButton(p2).click();
    await expect.poll(() => codes(p2, 'slPickList')).toEqual(['ACC1701XB', 'CS2113', 'CS2030']);
    await fresh.close();
  });

  test('[6C] the card\'s and the detail head\'s toggles agree after either is pressed, and after Remove in the view', async ({ page }) => {
    await page.goto(at('q=CS3244&ng=1&study=ug2&sem=2&open=CS3244'));
    await settled(page);
    const both = page.getByRole('button', { name: 'Shortlist, CS3244' });
    await expect(both).toHaveCount(2);
    await both.nth(1).click();
    for (const i of [0, 1]) await expect(both.nth(i)).toHaveAttribute('aria-pressed', 'true');
    await both.nth(0).click();
    for (const i of [0, 1]) await expect(both.nth(i)).toHaveAttribute('aria-pressed', 'false');
    await both.nth(0).click();
    await openButton(page).click();
    await activate(page, 'Remove, CS3244');
    await activate(page, 'Back to results');
    await expect(view(page)).toBeHidden();
    await expect(button(page, 'Shortlist, CS3244')).toHaveAttribute('aria-pressed', 'false');
  });

  test('[6C] a card\'s toggle off removes from either list and offers Undo beside the shortlist button', async ({ page }) => {
    await page.goto(at('q=CS2113+CS2030&ng=1&study=ug2&sem=1&pick=CS2030.1&alt=GE2101.1&alt=CS2113.1'));
    await settled(page);
    await activate(page, 'Shortlist, CS2113');
    await expect(live(page)).toHaveText('CS2113 removed from your backups (2 of 2). Undo');
    const undo = page.locator('.sl-undo:visible').getByRole('button', { name: 'Undo, put CS2113 back' });
    await activate(page, undo);
    await expect.poll(() => query(page)).toContain('alt=GE2101.1&alt=CS2113.1');
    await expect(button(page, 'Shortlist, CS2113')).toHaveAttribute('aria-pressed', 'true');
    await focusOn(page, 'Shortlist, CS2113');
  });

  test('[6C] the card\'s Undo is offered again the second time the same course is taken off (review finding 1)', async ({ page }) => {
    await page.goto(at('q=CS2113+CS2030&ng=1&study=ug2&sem=1&pick=CS2030.1&pick=CS2113.1'));
    await settled(page);
    const undo = page.locator('.sl-undo:visible').getByRole('button', { name: 'Undo, put CS2113 back' });
    await activate(page, 'Shortlist, CS2113');
    await activate(page, undo);
    await expect(button(page, 'Shortlist, CS2113')).toHaveAttribute('aria-pressed', 'true');
    await activate(page, 'Shortlist, CS2113');
    await expect(page.locator('.sl-undo:visible')).toHaveText('CS2113 removed. Undo');
    await expect(undo).toBeVisible();
  });

  test('[6C] a list of backups only: the button says so, not "no semester yet" (review finding 3)', async ({ page }) => {
    await page.goto(at('q=CS2030&ng=1&study=ug2&sem=1&alt=CS2030.1'));
    await expect(openButton(page).locator('small')).toHaveText('1 backup, no primary picks yet');
  });

  test('[6C] adding from a card with /module held: the total once it settles; held past 2 s, the loading sentence', async ({ page }) => {
    /** @type {import('@playwright/test').Route[]} */
    const held = [];
    await page.route('**/module/CS2113', (route) => { held.push(route); });
    await page.goto(at('q=CS2113+CS2030&ng=1&study=ug2&sem=1&pick=CS2030.1'));
    await settled(page);
    await expect(openButton(page)).toContainText('Sem 1: 4 units picked');
    await activate(page, 'Shortlist, CS2113');
    await expect.poll(() => held.length).toBe(1);
    await held[0].continue();
    await expect(live(page)).toHaveText('CS2113 added to your picks: Sem 1, 8 units picked so far');
    await page.unroute('**/module/CS2113');

    await page.route('**/module/GE2101', () => { /* held */ });
    await page.goto(at('q=GE2101+CS2030&ng=1&study=ug2&sem=1&pick=CS2030.1'));
    await settled(page);
    await activate(page, 'Shortlist, GE2101');
    await expect(live(page)).toHaveText('GE2101 added to your picks: Sem 1, 4 units so far, 1 course still loading', { timeout: 5000 });
  });
});

test.describe('the view at 1280 and 390×664', () => {
  for (const [label, width, height] of /** @type {const} */ ([['1280', 1280, 800], ['390×664', 390, 664]])) {
    test.describe(label, () => {
      test.use({ viewport: { width, height } });

      test(`[6C] every row control by keyboard on a full-year list, before and after a Sem change: focus kept, in view (${label})`, async ({ page }) => {
        await page.goto(at('ng=1&study=ug2&pick=CS2113.1&pick=CS2030.2&pick=GE2101.1&view=shortlist'));
        await rowsIn(page);
        // Move down on the first row with the page at the top: the neighbour moves, focus stays and scrolls in view.
        await activate(page, 'Move down, CS2113');
        await focusOn(page, 'Move down, CS2113');
        await expect.poll(() => codes(page, 'slPickList')).toEqual(['CS2030', 'CS2113', 'GE2101']);
        await expect(live(page)).toHaveText('CS2113 moved down: pick 2 of 3, number 1 on the form');
        await page.keyboard.press('Enter');
        await focusOn(page, 'Move down, CS2113');
        await expect.poll(() => codes(page, 'slPickList')).toEqual(['CS2030', 'GE2101', 'CS2113']);
        // At an end: aria-disabled, nothing moves, it says so.
        await expect(button(page, 'Move down, CS2113')).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Enter');
        await focusOn(page, 'Move down, CS2113');
        await expect(live(page)).toHaveText('CS2113 is already last');
        await activate(page, 'Move up, CS2030');
        await expect(live(page)).toHaveText('CS2030 is already first');
        await focusOn(page, 'Move up, CS2030');
        await activate(page, 'Move up, CS2113');
        await focusOn(page, 'Move up, CS2113');
        await expect.poll(() => codes(page, 'slPickList')).toEqual(['CS2030', 'CS2113', 'GE2101']);

        // A Sem change while the view is shown: the view stays, its sentence is said.
        if (width === 1280) await page.locator('#semSegOptions').getByText('Sem 2', { exact: true }).click();
        else {
          await page.getByRole('button', { name: /^Filters/ }).click();
          await page.getByRole('dialog').locator('#semSegOptions').getByText('Sem 2', { exact: true }).click();
          await page.getByRole('button', { name: 'Done' }).click();
          // The rest of the page is inert until the modal dialog has closed.
          await expect(page.getByRole('dialog')).toBeHidden();
        }
        await expect.poll(() => query(page)).toContain('sem=2');
        await expect(view(page)).toBeVisible();
        await expect(page.locator('.sl-sentence')).toContainText('Sem 2 first: 4 units picked; Sem 1: 8');

        // A semester button keeps its element: "Move to Sem 1" becomes "Move to Sem 2".
        await activate(page, 'Move to Sem 1, CS2030');
        await focusOn(page, 'Move to Sem 2, CS2030');
        await expect(live(page)).toHaveText('CS2030 moved to Sem 1');
        await expect.poll(() => query(page)).toContain('pick=CS2030.1');

        // Make backup moves the row itself: focus on its same control in its new place.
        await activate(page, 'Make backup, GE2101');
        await focusOn(page, 'Make primary, GE2101');
        await expect.poll(() => codes(page, 'slAltList')).toEqual(['GE2101']);
        await expect(live(page)).toHaveText('GE2101 is now a backup');

        // Remove: the next row's Remove, else the previous; an empty list's heading; the view's heading.
        await activate(page, 'Remove, CS2030');
        await focusOn(page, 'Remove, CS2113');
        await expect(live(page)).toHaveText('CS2030 removed: Sem 1, 4 units picked. Undo is at the top of the list');
        await page.keyboard.press('Enter');
        await focusOn(page, '#slPicks');
        await activate(page, 'Remove, GE2101');
        await focusOn(page, '#slTitle');
        await expect(page.locator('#slView .sl-none').first()).toBeVisible();
      });

      test(`[6C] Remove then Undo restores the entry in its place, and its focus (${label})`, async ({ page }) => {
        await page.goto(at('ng=1&study=ug2&sem=1&pick=CS2113.1&pick=CS2030.1&pick=GE2101.1&view=shortlist'));
        await rowsIn(page);
        await activate(page, 'Remove, CS2030');
        await expect(page.locator('.sl-removed')).toHaveText('CS2030 removed.Undo');
        await activate(page, page.getByRole('button', { name: 'Undo, put CS2030 back' }));
        await expect.poll(() => codes(page, 'slPickList')).toEqual(['CS2113', 'CS2030', 'GE2101']);
        await focusOn(page, 'Remove, CS2030');
        await expect(live(page)).toHaveText('CS2030 is back on your shortlist');
      });

      test(`[6C] a course taught in one semester: "Sem 2, CS5562" becomes aria-disabled "Sem 2 chosen", focus kept (${label})`, async ({ page }) => {
        await page.goto(at('pick=CS5562&view=shortlist'));
        await rowsIn(page);
        await activate(page, 'Sem 2, CS5562');
        await focusOn(page, 'Sem 2 chosen, CS5562');
        await expect(button(page, 'Sem 2 chosen, CS5562')).toHaveAttribute('aria-disabled', 'true');
        await expect.poll(() => query(page)).toContain('pick=CS5562.2');
      });

      test(`[6C] opening and closing the view: its button, Escape, Back, Forward, and the button while it is shown (${label})`, async ({ page }) => {
        await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1'));
        await settled(page);
        await openButton(page).click();
        await focusOn(page, '#slTitle');
        await expect(page.locator('#status')).toBeHidden();
        await expect.poll(() => query(page)).toContain('view=shortlist');
        const length = await page.evaluate(() => history.length);
        await openButton(page).click();
        await focusOn(page, '#slTitle');
        expect(await page.evaluate(() => history.length)).toBe(length);
        await page.keyboard.press('Escape');
        await expect(view(page)).toBeHidden();
        await expect.poll(() => focused(page)).toMatch(/^#slOpen(Rail|Phone)$/);
        expect(await inView(page)).toBe('ok');
        await expect.poll(() => query(page)).not.toContain('view=');
        await page.goForward();
        await expect(view(page)).toBeVisible();
        await focusOn(page, '#slTitle');
        await page.goBack();
        await expect(view(page)).toBeHidden();
        await expect.poll(() => focused(page)).toMatch(/^#slOpen(Rail|Phone)$/);
        await openButton(page).click();
        await activate(page, 'Back to results');
        await expect(view(page)).toBeHidden();
        await expect.poll(() => focused(page)).toMatch(/^#slOpen(Rail|Phone)$/);
        await expect(page.locator('#results > li.card')).not.toHaveCount(0);
      });
    });
  }
});

test.describe('the view\'s history (6B, built in 6C)', () => {
  test('[6C] open the view, change Sem to 2, close: sem=2 stays, no view, the first card\'s stamp is Sem 2\'s, the count said', async ({ page }) => {
    await page.goto(at('q=ACC1701XB&ng=1&study=ug2&sem=1&pick=CS2113.1'));
    await settled(page);
    await openButton(page).click();
    await page.locator('#semSegOptions').getByText('Sem 2', { exact: true }).click();
    await expect(live(page)).toHaveText('Sem 2 first: 0 units picked; Sem 1: 4');
    await activate(page, 'Back to results');
    await expect.poll(() => query(page)).toBe('q=ACC1701XB&sem=2&ng=1&study=ug2&pick=CS2113.1');
    await expect(page.locator('#results > li.card').first().locator('.exchange-status').first()).toContainText('Sem 2');
    await expect(live(page)).toContainText('ACC1701XB');
  });

  test('[6C] a detail open, the view opened, closed, then Back: the previous query shows', async ({ page }) => {
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1'));
    await settled(page);
    await page.locator('#q').fill('CS3244');
    await page.locator('#q').press('Enter');
    await page.locator('#results > li.card').first().getByRole('button', { expanded: false }).first().click();
    await expect.poll(() => query(page)).toContain('open=');
    await openButton(page).click();
    await expect.poll(() => query(page)).toContain('view=shortlist');
    await expect.poll(() => query(page)).not.toContain('open=');
    await activate(page, 'Back to results');
    await expect(view(page)).toBeHidden();
    await page.goBack();
    await expect.poll(() => query(page)).toContain('q=networks');
    await expect(page.locator('#q')).toHaveValue('networks');
  });

  test('[6C] a submit from the view closes it by a push: the list kept, the results said', async ({ page }) => {
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1'));
    await settled(page);
    await openButton(page).click();
    await page.locator('#q').fill('CS2030');
    await page.locator('#q').press('Enter');
    await expect(view(page)).toBeHidden();
    await expect.poll(() => query(page)).toBe('q=CS2030&sem=1&ng=1&study=ug2&pick=CS2113.1');
    await expect(live(page)).toContainText('CS2030');
    await page.goBack();
    await expect(view(page)).toBeVisible();
    await focusOn(page, '#slTitle');
  });

  test('[6C] text typed in the box with the view open stays after Escape, after Back, and through a Sem change', async ({ page }) => {
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1'));
    await settled(page);
    await openButton(page).click();
    await page.locator('#q').fill('databases');
    await page.locator('#semSegOptions').getByText('Sem 2', { exact: true }).click();
    await expect(view(page)).toBeVisible();
    await expect(page.locator('#q')).toHaveValue('databases');
    await expect.poll(() => query(page)).toContain('q=networks');
    await page.locator('#q').press('Escape');
    await expect(view(page)).toBeHidden();
    await expect(page.locator('#q')).toHaveValue('databases');
    await openButton(page).click();
    await page.locator('#q').fill('history');
    await page.goBack();
    await expect(view(page)).toBeHidden();
    await expect(page.locator('#q')).toHaveValue('history');
  });

  test('[6C] behind a 500: open the view, Back searches again; behind a 429: Back and Escape don\'t, and five edits send no search', async ({ page }) => {
    let status = 500;
    await page.route('**/search?**', (route) => route.fulfill({ status, headers: status === 429 ? { 'retry-after': '30' } : {}, json: { error: status === 429 ? 'rate_limited' : 'internal' } }));
    const seen = searches(page);
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1&pick=CS2030.1'));
    await expect(page.locator('#status.error')).toHaveCount(1);
    expect(seen.length).toBe(1);
    await openButton(page).click();
    await expect(view(page)).toBeVisible();
    expect(seen.length).toBe(1);
    await page.goBack();
    await expect.poll(() => seen.length).toBe(2);

    status = 429;
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1&pick=CS2030.1'));
    await expect(page.locator('#status.error')).toHaveCount(1);
    const before = seen.length;
    await openButton(page).click();
    await rowsIn(page);
    await activate(page, 'Move down, CS2113');
    await activate(page, 'Make backup, CS2030');
    await activate(page, 'Move to Sem 2, CS2113');
    await activate(page, 'Remove, CS2113');
    await page.getByRole('button', { name: 'Undo, put CS2113 back' }).click();
    await page.goBack();
    await expect(view(page)).toBeHidden();
    await page.goForward();
    await expect(view(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(view(page)).toBeHidden();
    await page.waitForTimeout(300);
    expect(seen.length).toBe(before);
    await expect(page.locator('#status')).toHaveText('Too many searches from your connection. Try again in 30 seconds.');
  });

  test('[6C] Escape with the filters dialog open over the view closes only the dialog (390×664)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1&view=shortlist'));
    await page.getByRole('button', { name: /^Filters/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(view(page)).toBeVisible();
    expect(query(page)).toContain('view=shortlist');
  });
});

test.describe('rows', () => {
  test('[6C] rows arriving keep focus: a held row\'s Move down keeps focus when the rows answer 200 and 404', async ({ page }) => {
    /** @type {import('@playwright/test').Route[]} */
    const held = [];
    await page.route(/\/module\/(CS2113|CS9999)$/, (route) => { held.push(route); });
    await page.goto(at('pick=GE2101.1&pick=CS2113.1&pick=CS9999.1&view=shortlist'));
    await expect.poll(() => held.length).toBe(2);
    await activate(page, 'Remove, GE2101');
    await focusOn(page, 'Remove, CS2113');
    await button(page, 'Move down, CS2113').focus();
    const before = await focused(page);
    expect(before).toBe('Move down, CS2113');
    for (const r of held) await r.continue();
    await expect(row(page, 'CS9999').locator('.title')).toHaveText('No course with this code');
    await expect(row(page, 'CS2113').locator('.title')).toHaveText(/Software Engineering/);
    expect(await focused(page)).toBe(before);
  });

  test('[6C] a closed pick and each 404 kind from a link: each reads as its kind says and keeps Move, Make and Remove', async ({ page }) => {
    await page.goto(at('ng=1&study=ug2&sem=1&pick=CS3244.1&pick=CS1010J.1&pick=EE4407.1&pick=CS9999.1&view=shortlist'));
    await rowsIn(page);
    await expect(row(page, 'CS3244').locator('.exchange-status')).toHaveText('Sem 1 · Not open to exchange students');
    await expect(row(page, 'CS3244').locator('.count')).toContainText('Not counted: not on NUS\'s 2026/27 exchange course list for Sem 1');
    await expect(row(page, 'CS1010J').locator('.title')).not.toBeEmpty();
    await expect(row(page, 'CS1010J')).toContainText('Not counted: not offered in 2026/27');
    await expect(row(page, 'EE4407').locator('.title')).toHaveText('Analog Electronics');
    await expect(row(page, 'EE4407')).toContainText('To confirm with NUS: NUS lists it for Sem 1 in 2026/27, but NUSMods shows no classes: ask NUS');
    await expect(row(page, 'EE4407')).not.toContainText('Not open');
    await expect(row(page, 'CS9999')).toContainText('Not counted: no course with this code in 2026/27');
    for (const code of ['CS3244', 'CS1010J', 'EE4407', 'CS9999']) {
      for (const name of ['Move up', 'Move down', 'Make backup', 'Remove']) await expect(button(page, `${name}, ${code}`)).toBeVisible();
    }
    // The totals count none of them; the 404s are in no semester's totals.
    await expect(page.locator('#slTotals .sl-total .big')).toHaveText('0 units counted, if NUS accepts you into each');
  });

  test('[6C] Try again: focus on the row\'s first control, then how it ended (loaded; a 404; still failing)', async ({ page }) => {
    const tries = { CS3244: 0, CS2113: 0, GE2101: 0 };
    await page.route(/\/module\/(CS3244|CS2113|GE2101)$/, (route) => {
      const code = /** @type {keyof typeof tries} */ (new URL(route.request().url()).pathname.split('/').pop());
      tries[code] += 1;
      if (tries[code] === 1 || code === 'GE2101') return route.fulfill({ status: 500, json: { error: 'internal' } });
      if (code === 'CS2113') return route.fulfill({ status: 404, json: { error: 'not_found', kind: 'unknown', acadYear: '2026-2027' } });
      return route.continue();
    });
    await page.goto(at('ng=1&study=ug2&sem=1&pick=CS3244.2&pick=CS2113.1&pick=GE2101.1&view=shortlist'));
    await expect(page.locator('#slView .sl-title')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Try again,/ })).toHaveCount(3);
    await activate(page, 'Try again, CS3244');
    await focusOn(page, 'Move up, CS3244');
    await expect(live(page)).toHaveText('CS3244 loaded');
    await activate(page, 'Try again, CS2113');
    await focusOn(page, 'Move up, CS2113');
    await expect(live(page)).toHaveText('CS2113: no course with this code in 2026/27');
    await activate(page, 'Try again, GE2101');
    await focusOn(page, 'Move up, GE2101');
    await expect(live(page)).toHaveText('GE2101 still could not be loaded');
  });
});

test.describe('the export question, Copy link, the invitation, G3', () => {
  test('[6C] browse mode: Download CSV focuses the question; choosing a year keeps focus in it, arrowing starts nothing, and turns on exchange mode', async ({ page }) => {
    await page.addInitScript(() => {
      /** @type {any} */ (globalThis).printed = 0;
      window.print = () => { /** @type {any} */ (globalThis).printed += 1; };
    });
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    await page.goto(at('pick=CS5562.2&view=shortlist'));
    await rowsIn(page);
    await expect(page.locator('#slAsk')).toBeVisible();
    await activate(page, page.locator('.sl-actions').getByRole('button', { name: 'Download CSV' }));
    await focusOn(page, '#slAskTitle');
    await expect(live(page)).toHaveText('Two questions before your download');
    await activate(page, page.getByRole('radio', { name: '1st year' }));
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: '2nd year' })).toBeChecked();
    expect(await page.evaluate(() => !!document.activeElement?.closest('#slAsk'))).toBe(true);
    await expect.poll(() => query(page)).toContain('ng=1&study=ug2');
    await expect(view(page)).toBeVisible();
    expect(downloads).toBe(0);
    expect(await page.evaluate(() => /** @type {any} */ (globalThis).printed)).toBe(0);
  });

  test('[6C] an untagged entry gets its own semester question; a 404 in browse mode asks the year', async ({ page }) => {
    await page.goto(at('ng=1&study=ug2&pick=CS2113&view=shortlist'));
    await rowsIn(page);
    await activate(page, page.getByRole('group', { name: 'CS2113: which semester?' }).getByRole('radio', { name: 'Sem 2' }));
    await expect.poll(() => query(page)).toContain('pick=CS2113.2');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#slAsk'))).toBe(true);
    await page.goto(at('pick=CS9999&view=shortlist'));
    await rowsIn(page);
    await expect(page.getByRole('group', { name: 'Your year of study during the exchange at NUS' })).toBeVisible();
  });

  test('[6C] the export question is worked out again as rows arrive: an unknown code drops out, a one-semester course offers only its semester (review finding 2)', async ({ page }) => {
    /** @type {import('@playwright/test').Route[]} */
    const held = [];
    await page.route(/\/module\/(CS9999|CS5562)$/, (route) => { held.push(route); });
    await page.goto(at('ng=1&study=ug2&pick=CS9999&pick=CS5562&view=shortlist'));
    await expect.poll(() => held.length).toBe(2);
    for (const r of held) await r.continue();
    await rowsIn(page);
    await expect(page.locator('#slAsk legend')).toHaveText(['CS5562: which semester?']);
    const group = page.getByRole('group', { name: 'CS5562: which semester?' });
    await expect(group.getByRole('radio')).toHaveCount(1);
    await expect(group.getByRole('radio', { name: 'Sem 2' })).toBeVisible();
  });

  test('[6C] the view\'s sentence and the shortlist button count "units picked" the same way (review finding 4)', async ({ page }) => {
    await page.goto(at('q=CS2030&ng=1&study=ug2&sem=1&pick=CS3244.1&pick=CS2030.1&view=shortlist'));
    await rowsIn(page);
    await page.locator('#semSegOptions').getByText('Sem 2', { exact: true }).click();
    await expect(live(page)).toHaveText('Sem 2 first: 0 units picked; Sem 1: 8');
    await expect(openButton(page).locator('small')).toHaveText('Sem 1: 8 units picked');
  });

  test('[6C] Copy link: writeText called within the click; when it rejects, the link in a field labelled "Shortlist link", selected', async ({ page }) => {
    await page.addInitScript(() => {
      const g = /** @type {any} */ (globalThis);
      g.copied = [];
      g.reject = false;
      document.addEventListener('click', () => { g.inClick = true; setTimeout(() => { g.inClick = false; }, 0); }, true);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (/** @type {string} */ t) => { g.copied.push({ t, inClick: g.inClick }); return g.reject ? Promise.reject(new Error('no')) : Promise.resolve(); } },
      });
    });
    await page.goto(at('q=networks&ng=1&study=ug2&sem=1&pick=CS2113.1&view=shortlist'));
    await rowsIn(page);
    await activate(page, 'Copy link');
    await expect(live(page)).toHaveText('Link copied');
    const [first] = await page.evaluate(() => /** @type {any} */ (globalThis).copied);
    expect(first.inClick).toBe(true);
    expect(new URL(first.t).search).toBe('?sem=1&ng=1&study=ug2&pick=CS2113.1&ay=2026-2027&view=shortlist');
    await page.evaluate(() => { /** @type {any} */ (globalThis).reject = true; });
    await activate(page, 'Copy link');
    const field = page.getByLabel('Shortlist link');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(first.t);
    await focusOn(page, '#slLinkField');
    expect(await page.evaluate(() => { const f = /** @type {HTMLInputElement} */ (document.activeElement); return (f.selectionEnd ?? 0) - (f.selectionStart ?? 0); })).toBe(first.t.length);
  });

  test('[6C] the invitation checkbox: only for the faculty the list holds; ticking counts Business and says so', async ({ page }) => {
    await page.goto(at('ng=1&study=ug2&sem=1&pick=ACC1701XA.1&pick=CS2113.1&view=shortlist'));
    await rowsIn(page);
    await expect(page.getByRole('group', { name: /Did NUS Law invite you/ })).toBeHidden();
    const box = page.getByRole('checkbox', { name: 'Yes, NUS Business School invited me' });
    await expect(row(page, 'ACC1701XA')).toContainText('On the form only if invited');
    await activate(page, box);
    await expect.poll(() => query(page)).toContain('inv=biz');
    await expect(live(page)).toHaveText('Business courses counted: Sem 1, 8 units picked');
    await expect(row(page, 'ACC1701XA')).toContainText('Application form, Sem 1: 1, if it\'s a core BBA course');
    await focusOn(page, '#slInvBiz');
  });

  test('[6C, G3] Restore on the first screen opens the view with the device\'s list; Forget clears only the device\'s copy', async ({ page }) => {
    await page.goto(at('q=CS2113&ng=1&study=ug2&sem=1'));
    await settled(page);
    await activate(page, 'Shortlist, CS2113');
    await expect.poll(() => query(page)).toContain('pick=CS2113.1');
    await page.goto('/');
    await expect(page.locator('#slRestoreSetup')).toContainText('Your last shortlist is kept on this device (1 course).');
    await activate(page, 'Restore your last shortlist');
    await expect(view(page)).toBeVisible();
    await focusOn(page, '#slTitle');
    await expect.poll(() => query(page)).toBe('pick=CS2113.1&view=shortlist');
    await expect(live(page)).toHaveText('Your last shortlist is restored: 1 course');
    await activate(page, 'Forget this list on this device');
    await focusOn(page, '#slTitle');
    await expect.poll(() => query(page)).toContain('pick=CS2113.1');
    await page.goto('/');
    await expect(page.locator('#slRestoreSetup')).toBeHidden();
  });

  test('[6C] a refused push is retried: the URL catches up and equals the screen', async ({ page }) => {
    await page.addInitScript(() => {
      const g = /** @type {any} */ (globalThis);
      g.refuse = 0;
      for (const name of /** @type {const} */ (['replaceState', 'pushState'])) {
        const real = history[name].bind(history);
        history[name] = (/** @type {any[]} */ ...args) => {
          if (g.refuse > 0) { g.refuse -= 1; throw new DOMException('refused', 'SecurityError'); }
          return /** @type {(...a: any[]) => void} */ (real)(...args);
        };
      }
    });
    await page.goto(at('q=CS2113+CS2030&ng=1&study=ug2&sem=1'));
    await settled(page);
    await page.evaluate(() => { /** @type {any} */ (globalThis).refuse = 2; });
    await activate(page, 'Shortlist, CS2113');
    await activate(page, 'Shortlist, CS2030');
    await expect.poll(() => query(page), { timeout: 8000 }).toMatch(/^q=CS2113\+CS2030&sem=1&ng=1&study=ug2&pick=CS2113\.1&pick=CS2030\.1(&ay=2026-2027)?$/);
  });
});
