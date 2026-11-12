// @ts-check
// History: the page's transition table (public/nav.js) in the browser, every
// row: queries, filters, clearing, and opening,
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

test('each submitted query is an entry: Back and Forward restore its results from memory, with no new fetch', async ({ page }) => {
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

test('submitting the same query again adds no entry', async ({ page }) => {
  await browse(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  const before = await historyLength(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  expect(await historyLength(page)).toBe(before);
});

test('a filter change replaces the entry: Back goes to the previous query, not the unfiltered one', async ({ page }) => {
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

test('clearing the query pushes the URL without it; Back restores the cleared results', async ({ page }) => {
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

test('a shared link restores its state on load and on reload', async ({ page }) => {
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
  await page.getByText('Only courses open to exchange students', { exact: true }).click();
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

test('opening a detail with none open pushes; Back closes it, with focus on its button', async ({ page }) => {
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

test('opening another detail while one is open replaces: one open at a time, and Back goes to the list', async ({ page }) => {
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

test('closing a detail this page opened goes back, by its button, its Close button or Escape; focus returns to its button', async ({ page }) => {
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

test('a filter change while a detail is open drops open= and closes it', async ({ page }) => {
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

// ---------------------------------------------------------------------------
// The shortlist's state. The list is page-wide; every history write goes
// through one writer (public/history.js). These drive the list through the
// page's test hooks (`vnmTest`).

/**
 * Installs the page's test hooks before it loads.
 * @param {import('@playwright/test').Page} page
 * @param {{ forceCoalesce?: boolean }} [opts]
 */
const hooks = (page, opts = {}) => page.addInitScript((o) => { /** @type {any} */ (globalThis).vnmTest = { ...o }; }, opts);
/**
 * An edit through the hooks, as the view's controls will make it.
 * @param {import('@playwright/test').Page} page
 * @param {string} fn
 * @param {unknown[]} args
 */
const edit = (page, fn, ...args) => page.evaluate(([f, a]) => /** @type {any} */ (globalThis).vnmTest.edit[/** @type {string} */ (f)](.../** @type {unknown[]} */ (a)), [fn, args]);
/** The list's URL part, from the page's own URL. @param {import('@playwright/test').Page} page */
const listPart = (page) => [...new URL(page.url()).searchParams].filter(([k]) => ['pick', 'alt', 'ay', 'inv'].includes(k)).map(([k, v]) => `${k}=${v}`).join('&');

test('an edit on a later entry: Back and Forward keep the list, and write it into the entry they reach', async ({ page }) => {
  await hooks(page);
  await browse(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  await submit(page, 'databases');
  await resultsFor(page, 'databases');
  const before = await historyLength(page);
  expect(await edit(page, 'add', 'CS2105', '1')).toEqual({ ok: true });
  expect(await edit(page, 'add', 'GE2101', '')).toEqual({ ok: true });
  expect(query(page)).toBe('q=databases&pick=CS2105.1&pick=GE2101');
  // An edit replaces: no new entry, and no search.
  expect(await historyLength(page)).toBe(before);
  await page.goBack();
  await resultsFor(page, 'networks');
  await expect.poll(() => query(page)).toBe('q=networks&pick=CS2105.1&pick=GE2101');
  await page.goForward();
  await resultsFor(page, 'databases');
  await expect.poll(() => query(page)).toBe('q=databases&pick=CS2105.1&pick=GE2101');
  await page.reload();
  await resultsFor(page, 'databases');
  expect(query(page)).toBe('q=databases&pick=CS2105.1&pick=GE2101');
});

test('coalescing forced: two edits then Back within 100 ms; the previous query shows and its entry holds both edits', async ({ page }) => {
  await hooks(page, { forceCoalesce: true });
  await browse(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  await expect.poll(() => query(page)).toBe('q=networks');
  await submit(page, 'databases');
  await resultsFor(page, 'databases');
  await expect.poll(() => query(page)).toBe('q=databases');
  await edit(page, 'add', 'CS2105', '1');
  await edit(page, 'add', 'CS2030', '1');
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.pending())).toBe(true);
  await page.goBack();
  await resultsFor(page, 'networks');
  await expect(page.locator('#q')).toHaveValue('networks');
  await expect.poll(() => query(page)).toBe('q=networks&pick=CS2105.1&pick=CS2030.1');
});

test('coalescing forced: two edits then a code link; the URL\'s q matches the screen after 1 s', async ({ page }) => {
  await hooks(page, { forceCoalesce: true });
  await page.goto('/?q=CS3244&open=CS3244');
  const link = page.locator('#results .detail a[data-search="CS2040"]').first();
  await expect(link).toBeVisible();
  await edit(page, 'add', 'CS3244', '2');
  await edit(page, 'add', 'CS2030', '1');
  await link.click();
  // CS2040 isn't in the fixture: the screen says so, for q=CS2040.
  await expect(page.locator('#q')).toHaveValue('CS2040');
  await expect(page.locator('#status')).toContainText('CS2040');
  await page.waitForTimeout(1000);
  // The open detail loaded CS3244's row before the edits, so they carry its year.
  expect(query(page)).toBe('q=CS2040&pick=CS3244.2&pick=CS2030.1&ay=2026-2027');
  // The entry left holds both edits: they landed before the push.
  await page.goBack();
  await expect.poll(() => query(page)).toBe('q=CS3244&open=CS3244&pick=CS3244.2&pick=CS2030.1&ay=2026-2027');
});

test('open a detail, edit, Escape: no open=, the list kept; Forward re-opens the detail with the list', async ({ page }) => {
  await hooks(page);
  await page.goto('/?q=CS3244');
  await toggle(page, 'CS3244').click();
  await expect.poll(() => query(page)).toBe('q=CS3244&open=CS3244');
  // The detail's row is loaded, so the edit carries its year.
  await expect(page.locator('#results .detail a[data-search]').first()).toBeVisible();
  await edit(page, 'add', 'CS3244', '2');
  expect(query(page)).toBe('q=CS3244&open=CS3244&pick=CS3244.2&ay=2026-2027');
  await page.keyboard.press('Escape');
  await expect.poll(() => query(page)).toBe('q=CS3244&pick=CS3244.2&ay=2026-2027');
  await expect(toggle(page, 'CS3244')).toHaveAttribute('aria-expanded', 'false');
  await page.goForward();
  await expect(toggle(page, 'CS3244')).toHaveAttribute('aria-expanded', 'true');
  expect(query(page)).toBe('q=CS3244&open=CS3244&pick=CS3244.2&ay=2026-2027');
});

test('two edits within 300 ms then a reload: both survive (edits are written at once)', async ({ page }) => {
  await hooks(page);
  await page.goto('/?q=networks');
  await resultsFor(page, 'networks');
  await edit(page, 'add', 'CS2105', '1');
  await edit(page, 'move', 'CS2105', 1);
  await edit(page, 'add', 'CS3103', '2');
  await page.reload();
  await resultsFor(page, 'networks');
  expect(listPart(page)).toBe('pick=CS2105.1&pick=CS3103.2');
});

test('a refused push is retried, and an edit made meanwhile folds into it: one entry, holding the edit', async ({ page }) => {
  await hooks(page);
  // The next pushState throws, as WebKit's does past 100 writes in 10 s.
  await page.addInitScript(() => {
    const g = /** @type {any} */ (globalThis);
    g.refusePush = 0;
    const push = History.prototype.pushState;
    History.prototype.pushState = function (/** @type {any[]} */ ...a) {
      if (g.refusePush > 0) { g.refusePush -= 1; throw new DOMException('refused', 'SecurityError'); }
      return push.apply(this, /** @type {any} */ (a));
    };
  });
  await browse(page);
  await submit(page, 'networks');
  await resultsFor(page, 'networks');
  const before = await historyLength(page);
  await page.evaluate(() => { /** @type {any} */ (globalThis).refusePush = 1; });
  await submit(page, 'databases');
  await resultsFor(page, 'databases');
  expect(query(page)).toBe('q=networks');
  await edit(page, 'add', 'CS2102', '1');
  await expect.poll(() => query(page), { timeout: 5000 }).toBe('q=databases&pick=CS2102.1');
  expect(await historyLength(page)).toBe(before + 1);
  await page.goBack();
  await resultsFor(page, 'networks');
  await expect.poll(() => query(page)).toBe('q=networks&pick=CS2102.1');
});

test('150 edits in 5 s make no more history writes than the writer\'s budget, and the URL then equals the list', async ({ page }) => {
  await hooks(page);
  await page.addInitScript(() => {
    const g = /** @type {any} */ (globalThis);
    g.writes = 0;
    for (const name of /** @type {const} */ (['pushState', 'replaceState'])) {
      const real = History.prototype[name];
      History.prototype[name] = function (/** @type {any[]} */ ...a) { g.writes += 1; return real.apply(this, /** @type {any} */ (a)); };
    }
  });
  await page.goto('/?q=networks');
  await resultsFor(page, 'networks');
  const start = await page.evaluate(() => /** @type {any} */ (globalThis).writes);
  await page.evaluate(async () => {
    const g = /** @type {any} */ (globalThis);
    for (let i = 0; i < 150; i += 1) {
      g.vnmTest.edit.add(`AB${1000 + (i % 30)}`, '');
      if (i % 30 === 29) for (let j = 0; j < 30; j += 1) g.vnmTest.edit.remove(`AB${1000 + j}`);
      await new Promise((r) => setTimeout(r, 33));
    }
  });
  const during = await page.evaluate(() => /** @type {any} */ (globalThis).writes) - start;
  expect(during).toBeLessThanOrEqual(81);
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.pending())).toBe(false);
  const listNow = await page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.list());
  expect(new URL(page.url()).searchParams.getAll('pick')).toEqual(listNow.pick.map((/** @type {any} */ e) => e.code));
});

test('ay: never written on load; Copy link carries it once a row has loaded, and the first edit writes it', async ({ page }) => {
  await hooks(page);
  // The page loads the list's rows on load: held here, so "before a row loads" can be seen.
  /** @type {import('@playwright/test').Route[]} */
  const held = [];
  await page.route('**/module/CS2030', (route) => { held.push(route); });
  await page.goto('/?q=networks&ng=1&study=ug2&pick=CS2030.1');
  await resultsFor(page, 'networks');
  expect(query(page)).toBe('q=networks&ng=1&study=ug2&pick=CS2030.1');
  const link = () => page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.shortlistLink());
  // Copy link never waits: before a row loads, no ay.
  await expect.poll(() => held.length).toBe(1);
  expect(new URL(await link()).search).toBe('?ng=1&study=ug2&pick=CS2030.1&view=shortlist');
  await held[0].continue();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.rowYear())).toBe('2026-2027');
  expect(new URL(await link()).search).toBe('?ng=1&study=ug2&pick=CS2030.1&ay=2026-2027&view=shortlist');
  expect(query(page)).toBe('q=networks&ng=1&study=ug2&pick=CS2030.1');
  await edit(page, 'setSem', 'CS2030', '2');
  expect(query(page)).toBe('q=networks&ng=1&study=ug2&pick=CS2030.2&ay=2026-2027');
});

test('ay comes from a row loaded before its code joined the list', async ({ page }) => {
  await hooks(page);
  await page.goto('/?q=CS3244&open=CS3244');
  await expect(page.locator('#results .detail a[data-search]').first()).toBeVisible();
  await edit(page, 'add', 'CS3244', '2');
  expect(query(page)).toBe('q=CS3244&open=CS3244&pick=CS3244.2&ay=2026-2027');
});

test('the device keeps the last list this student edited; opening someone else\'s link never overwrites it', async ({ page }) => {
  await hooks(page);
  await page.goto('/?q=networks');
  await resultsFor(page, 'networks');
  await edit(page, 'add', 'CS2105', '1');
  const saved = () => page.evaluate(() => localStorage.getItem('vnm.shortlist'));
  expect(await saved()).toBe('pick=CS2105.1');
  await page.goto('/?q=databases&pick=CS2102.2&alt=CS3223.1');
  await resultsFor(page, 'databases');
  expect(await saved()).toBe('pick=CS2105.1');
  // A link with a list: nothing to offer. A link without one: the device's list.
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.restoreOffer())).toBeNull();
  await page.goto('/?q=databases');
  await resultsFor(page, 'databases');
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.restoreOffer()?.pick)).toEqual([{ code: 'CS2105', sem: '1' }]);
  await page.evaluate(() => /** @type {any} */ (globalThis).vnmTest.forget());
  expect(await saved()).toBeNull();
  expect(query(page)).toBe('q=databases');
});

test('the links the page renders carry no list: a new tab starts without one', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244&pick=CS3244.2&inv=biz');
  const link = page.locator('#results .detail a[data-search="CS2040"]').first();
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toBe('/?q=CS2040');
});
