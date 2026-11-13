// @ts-check
// On a phone: 16px inputs (iOS zooms into anything smaller);
// after the first search the form is one bar that keeps the query field and the
// Search button in view; the exchange set-up and filters open in a modal
// <dialog> from a "Filters (n)" button: focus stays inside it, Escape closes
// it, and focus returns to the button.
import { expect, test } from '@playwright/test';
import { pill, query } from './support.mjs';

/** The chosen pill of a filter, by what it says. @param {import('@playwright/test').Page} page @param {string} name */
const chosen = (page, name) => page.locator(`label:has(> input[name="${name}"]:checked)`);

test.use({ viewport: { width: 390, height: 664 } });

const fontSize = (/** @type {import('@playwright/test').Locator} */ l) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

test('every text input is at least 16px, on the first screen and after a search', async ({ page }) => {
  await page.goto('/');
  for (const el of await page.locator('#setup input[type="search"]').all()) expect(await fontSize(el)).toBeGreaterThanOrEqual(16);
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await page.getByRole('button', { name: /^Filters/ }).click();
  const controls = page.locator('input[type="search"], input[role="combobox"]');
  expect(await controls.count()).toBeGreaterThanOrEqual(2);
  for (const el of await controls.all()) expect(await fontSize(el), await el.getAttribute('id') ?? '').toBeGreaterThanOrEqual(16);
});

test('after the first search the form is one bar: the query field and Search side by side, in view; the rail is behind "Filters (n)"', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /^Exchange student/ }).check();
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
  await expect(page.locator('#studyWrap')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters (3)' })).toBeVisible();
});

test('Filters opens a modal dialog with the set-up and filters; a change applies at once; Escape closes it and focus returns', async ({ page }) => {
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  const button = page.getByRole('button', { name: 'Filters (3)' });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Who is searching, and filters' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.matches(':modal'))).toBe(true);
  // Focus starts inside, on the first control.
  await expect(page.locator('#ng')).toBeFocused();
  await expect(dialog.locator('#studyWrap')).toBeVisible();
  await pill(dialog, 'level', '2').check();
  await expect.poll(() => query(page)).toBe('q=networks&sem=1&level=2&ng=1&study=ug2');
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1', '2nd year', 'Exchange students', 'Level 2000']);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters (4)' })).toBeFocused();
  // The controls are back in the rail (hidden on a phone), and one copy of each exists.
  await expect(page.locator('#levelWrap')).toHaveCount(1);
  expect(await page.locator('#levelWrap').evaluate((el) => !!el.closest('.rail'))).toBe(true);
  // Escape closed the dialog only: the results are still there.
  expect(query(page)).toBe('q=networks&sem=1&level=2&ng=1&study=ug2');
});

test('focus is trapped in the dialog: Tab and Shift+Tab wrap around inside it', async ({ page }) => {
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

test('Done closes the dialog and returns focus to the button', async ({ page }) => {
  await page.goto('/?q=networks&level=3');
  const button = page.getByRole('button', { name: 'Filters (1)' });
  await button.click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(button).toBeFocused();
});

test('a chip removes its filter, and focus moves to the next chip', async ({ page }) => {
  await page.goto('/?q=databases&level=2&credits=4&faculty=Computing');
  await expect(page.locator('#chips .chip')).toHaveText(['Level 2000', '4 units', 'Computing']);
  await page.getByRole('button', { name: 'Remove filter: Level 2000' }).click();
  await expect.poll(() => query(page)).toBe('q=databases&credits=4&faculty=Computing');
  await expect(page.getByRole('button', { name: 'Remove filter: 4 units' })).toBeFocused();
  await expect(pill(page, 'level', '')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Filters (2)' })).toBeVisible();
  // Removing "Exchange students" leaves exchange mode; the semester and year stay in the rail.
  await page.goto('/?q=networks&sem=1&ng=1&study=ug2');
  await page.getByRole('button', { name: 'Remove filter: Exchange students' }).click();
  await expect.poll(() => query(page)).toBe('q=networks&sem=1');
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1']);
});

test('level and units take several at once: Any clears them, a chip drops one, clearing the last checks Any', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=databases');
  await pill(page, 'level', '2').check();
  await pill(page, 'level', '3').check();
  await pill(page, 'credits', '4').check();
  await expect.poll(() => query(page)).toBe('q=databases&level=2%2C3&credits=4');
  await expect(pill(page, 'level', '')).not.toBeChecked();
  await expect(page.locator('#chips .chip')).toHaveText(['Level 2000', 'Level 3000', '4 units']);
  await page.getByRole('button', { name: 'Remove filter: Level 2000' }).click();
  await expect.poll(() => query(page)).toBe('q=databases&level=3&credits=4');
  await expect(pill(page, 'level', '3')).toBeChecked();
  await expect(pill(page, 'level', '2')).not.toBeChecked();
  await pill(page, 'level', '3').uncheck();
  await expect.poll(() => query(page)).toBe('q=databases&credits=4');
  await expect(pill(page, 'level', '')).toBeChecked();
  await pill(page, 'level', '5').check();
  await pill(page, 'level', '').check();
  await expect.poll(() => query(page)).toBe('q=databases&credits=4');
  await expect(pill(page, 'level', '5')).not.toBeChecked();
});

test('filters are labelled one way everywhere: "Sem 2", "Level 2000", "4 units", in the pills (as said) and the chips', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=databases&sem=2&level=2&credits=4');
  await expect(chosen(page, 'sem')).toHaveText('Sem 2');
  await expect(page.getByRole('checkbox', { name: 'Level 2000', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '4 units', exact: true })).toBeChecked();
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 2', 'Level 2000', '4 units']);
  await expect(page.locator('#semWrap label')).toHaveText(['Any', 'Sem 1', 'Sem 2', 'Special term 1', 'Special term 2']);
});

test('no results with filters on names the next step: remove a filter', async ({ page }) => {
  await page.goto('/?q=qwzx+vbnm&level=2');
  await expect(page.locator('#status')).toContainText('Nothing in the catalogue matches');
  await page.route('**/search?**', (route) => route.fulfill({ json: { query: 'networks', filters: { level: 6 }, count: 0, results: [], interpreted: {}, hiddenPins: [], notOffered: [] } }));
  await page.goto('/?q=networks&level=6');
  await expect(page.locator('#status')).toHaveText('No courses match “networks”.Remove a filter above to see more courses, or try other words.');
  await expect(page.getByRole('button', { name: 'Remove filter: Level 6000' })).toBeVisible();
});

test('in exchange mode the next step is never to drop the set-up: only real filters are offered', async ({ page }) => {
  const empty = { query: 'basket weaving', count: 0, results: [], interpreted: {}, hiddenPins: [], notOffered: [] };
  await page.route('**/search?**', (route) => route.fulfill({ json: { ...empty, filters: { sem: 1, ng: true, study: 'ug2' } } }));
  await page.goto('/?q=basket+weaving&sem=1&ng=1&study=ug2');
  // Plain language: the exchange set-up emptied the list, so say that; other words won't help.
  await expect(page.locator('#status')).toHaveText('No course that matches “basket weaving” is open to you in Sem 1 as a 2nd-year exchange student.');
  await page.unroute('**/search?**');
  await page.route('**/search?**', (route) => route.fulfill({ json: { ...empty, filters: { sem: 1, level: 2, ng: true, study: 'ug2' } } }));
  await page.goto('/?q=basket+weaving&sem=1&level=2&ng=1&study=ug2');
  await expect(page.locator('#status')).toContainText('Remove a filter above to see more courses');
});

test('an option a link adds is labelled as the chips are: "Level 7000", "3 units"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=design&level=7&credits=3');
  await expect(chosen(page, 'level')).toHaveText('Level 7000');
  await expect(chosen(page, 'credits')).toHaveText('3 units');
  await expect(page.locator('#chips .chip')).toHaveText(['Level 7000', '3 units']);
});

// One test per width: forty page loads in one test ran past its 30 s budget on a loaded runner.
// Each page is measured once it has rendered: the set-up, the first card, or the open detail.
for (const width of [320, 390, 560, 641, 667, 700, 760, 900, 1040, 1100]) {
  test(`no sideways scroll at ${width}px: the first screen, results and an open detail`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/', '/?q=introductory+accounting&ng=1&study=ug2', '/?q=ACC1701XB&open=ACC1701XB', '/?q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB']) {
      await page.goto(path);
      if (path === '/') await expect(page.locator('#setup')).toBeVisible();
      else await expect(page.locator('#results > li.card').first()).toBeVisible();
      if (path.includes('open=')) await expect(page.locator('#results .detail-close')).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, `${width}px ${path}`).toBeLessThanOrEqual(0);
    }
  });
}

test('focus stays on a control when the one it was on goes away: a special term changed to Sem 1, and the dialog closed by widening', async ({ page }) => {
  await page.goto('/?q=networks&sem=3&ng=1&study=ug2');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.locator('#semWrap')).toBeVisible();
  await pill(page, 'sem', '1').check();
  await expect.poll(() => query(page)).toBe('q=networks&sem=1&ng=1&study=ug2');
  await expect(page.locator('#semWrap')).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Sem 1', exact: true })).toBeFocused();
  await pill(page, 'study', 'ug2').focus();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(pill(page, 'study', 'ug2')).toBeFocused();
});

test('a link with any state never shows the first screen, even before the scripts run', async ({ page }) => {
  await page.route('**/app.js', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.goto('/?q=introductory+accounting&sem=1&ng=1&study=ug2', { waitUntil: 'commit' });
  await page.locator('#q').waitFor({ state: 'attached' });
  await expect(page.locator('#setup')).toBeHidden();
  await expect(page.locator('#results > li.card').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#setup')).toBeHidden();
});

test('at 1280 the rail is beside the results and there is no Filters button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await expect(page.locator('.rail')).toBeVisible();
  await expect(page.locator('#studyWrap')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
  await expect(page.locator('#chips .chip')).toHaveText(['Sem 1', '2nd year', 'Exchange students']);
});

test('the dialog closes if the window widens past the phone layout, and the rail shows the controls', async ({ page }) => {
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.rail #studyWrap')).toBeVisible();
});

// The shortlist in the same
// reflow loop. The view with LC6009GRSII's row (the longest code) and the
// Copy-link fallback field, and results with the toggles and the shortlist
// button's longest label (two semesters with half units; the fixture has no
// half-unit course, so the label is set to it), at every width; and the rail's
// button never wider than the rail.
const LONGEST = 'Sem 1: 22.5 · Sem 2: 21.5 units picked';
const WIDTHS = [320, 390, 560, 641, 667, 700, 760, 900, 1040, 1100];

/** @param {import('@playwright/test').Page} page @param {string} where */
async function noSideways(page, where) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, where).toBeLessThanOrEqual(0);
}
/** @param {import('@playwright/test').Page} page */
const longestLabel = (page) => page.locator('.sl-open small').evaluateAll((els, t) => { for (const el of els) el.textContent = t; }, LONGEST);

test('no width scrolls sideways: the view with LC6009GRSII\'s row and the link field, and results with toggles and the longest label', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('no')) } });
  });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?ng=1&study=ug2&sem=1&pick=LC6009GRSII.1&pick=CS2113.2&alt=ACC1701XB.1&view=shortlist');
    await expect(page.locator('#slView li.sl-entry[data-code="LC6009GRSII"] .title')).not.toHaveText('Loading…');
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.getByLabel('Shortlist link')).toBeVisible();
    await noSideways(page, `${width}px the view`);
    await page.goto('/?q=introductory+accounting&ng=1&study=ug2&pick=ACC1701XB.1&pick=CS2113.2');
    await expect(page.locator('#results > li.card .sl-toggle').first()).toBeVisible();
    await longestLabel(page);
    await noSideways(page, `${width}px results`);
  }
});

test('the rail\'s shortlist button stays inside the rail with the longest label, at 641, 900 and 1280', async ({ page }) => {
  for (const width of [641, 900, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?q=networks&ng=1&study=ug2&pick=ACC1701XB.1&pick=CS2113.2');
    await expect(page.locator('#slOpenRail')).toBeVisible();
    await longestLabel(page);
    const [b, rail] = await Promise.all([page.locator('#slOpenRail').boundingBox(), page.locator('.rail').boundingBox()]);
    if (!b || !rail) throw new Error('no box');
    expect(b.x + b.width, `${width}px`).toBeLessThanOrEqual(rail.x + rail.width + 0.5);
    expect(await page.locator('#slOpenRail small').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${width}px label clipped`).toBe(true);
  }
});
