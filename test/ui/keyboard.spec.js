// @ts-check
// SC8's keyboard item (Phase 5 5E; plan §3 5E): the whole task, keyboard only,
// at 1280 and at 390×664, in Chromium and WebKit: the skip link, the exchange
// set-up on the first screen, a search, a filter and the set-up changed in the
// rail (in the Filters dialog on a phone), a detail opened, a course code in it
// followed, Back, and Escape. Every stop is asserted in order, and at every
// stop the focused control (or, for a radio drawn as a tile, pill or segment,
// its shape) has a computed outline at least 2px wide in a visible colour, is
// on screen, and is not covered (the sticky header included).
//
// Which key is Tab: Safari on a Mac moves only between text fields and lists
// on Tab unless "Press Tab to highlight each item" is on; Option+Tab reaches
// everything. Playwright's WebKit on macOS behaves the same, so each test asks
// the page which key reaches a button and uses that one (Tab in Chromium and
// on Linux, Option+Tab in WebKit on a Mac).
import { expect, test } from '@playwright/test';
import { live, query, settled } from './support.mjs';

/** @param {import('@playwright/test').Page} page @returns {Promise<string>} the key that moves focus to every control */
async function tabKey(page) {
  await page.goto('/');
  await page.locator('#setupQ').focus();
  await page.keyboard.press('Tab');
  const reachesButtons = await page.evaluate(() => document.activeElement?.tagName === 'BUTTON');
  return reachesButtons ? 'Tab' : 'Alt+Tab';
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string>} the focused element, as the tests name it */
const here = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'body';
  if (a instanceof HTMLInputElement && a.type === 'radio') return `radio ${a.name}=${a.value}`;
  if (a.id && !/^card-\d+$/.test(a.id)) return `#${a.id}`;
  const name = (a.getAttribute('aria-label') ?? a.textContent ?? '').replace(/\s+/g, ' ').trim();
  return `${a.tagName.toLowerCase()} "${name}"`;
});

/**
 * Whether the focused control shows a focus ring: 'ok', or what is wrong.
 * A radio drawn as a tile, pill or segment is invisible itself (it covers its
 * label), so its shape carries the ring. A <main> the skip link focused is a
 * landing point, not a control.
 * @param {import('@playwright/test').Page} page
 */
const ring = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'focus on the page';
  if (a.tagName === 'MAIN') return 'ok';
  const el = a instanceof HTMLInputElement && a.type === 'radio' ? a.closest('.tile, .pill, .seg-opt') ?? a : a;
  const cs = getComputedStyle(el);
  const transparent = /^transparent$|rgba\([^)]*,\s*0\)$/.test(cs.outlineColor);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && !transparent;
  if (!outline && cs.boxShadow === 'none') return `no ring: outline ${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
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
 * Keyboard helpers bound to one page: each move records where focus lands and
 * checks its ring. The check polls: WebKit scrolls a newly focused control
 * into view a moment after the key, so a first look can find it off screen.
 * @param {import('@playwright/test').Page} page
 * @param {string} TAB
 */
function keys(page, TAB) {
  const back = TAB === 'Tab' ? 'Shift+Tab' : 'Alt+Shift+Tab';
  /** @param {string} key @param {number} n @returns {Promise<string[]>} */
  const move = async (key, n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(key);
      const at = await here(page);
      await expect.poll(() => ring(page), { message: `focus ring on ${at}` }).toBe('ok');
      seen.push(at);
    }
    return seen;
  };
  return {
    /** @param {number} [n] */ tab: (n = 1) => move(TAB, n),
    /** @param {number} [n] */ shiftTab: (n = 1) => move(back, n),
    /** @param {string} key */
    press: async (key) => {
      await page.keyboard.press(key);
      const at = await here(page);
      await expect.poll(() => ring(page), { message: `focus ring on ${at} after ${key}` }).toBe('ok');
      return at;
    },
  };
}

const CARD = 'button "CS2104 Programming Language Concepts"';
const URL_SEARCH = 'q=CS2104&sem=1&ng=1&study=ug2';
const URL_FILTERED = 'q=CS2104&sem=1&level=2&ng=1&study=ug2';

/**
 * The first screen by keyboard: skip link, Sem 1, 2nd year, "CS2104", Enter.
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof keys>} k
 */
async function firstScreen(page, k) {
  await page.goto('/');
  await settled(page);
  expect(await k.tab()).toEqual(['#skip']);
  await expect(page.locator('#skip')).toBeInViewport({ ratio: 1 });
  expect(await k.press('Enter')).toBe('#setup');
  expect(await k.tab()).toEqual(['radio setupSem=1']);
  await page.keyboard.press('Space');
  await expect(page.getByRole('radio', { name: /^Sem 1/ })).toBeChecked();
  expect(await k.tab()).toEqual(['radio setupStudy=ug1']);
  expect(await k.press('ArrowRight')).toBe('radio setupStudy=ug2');
  await expect(page.getByRole('radio', { name: '2nd year' })).toBeChecked();
  expect(await k.tab()).toEqual(['#setupQ']);
  await page.keyboard.type('CS2104');
  await page.keyboard.press('Enter');
  await expect.poll(() => query(page)).toBe(URL_SEARCH);
  await expect(page.locator('#q')).toBeFocused();
  await settled(page);
  await expect(live(page)).toHaveText(/^\d+ courses match “CS2104”\.$/);
  await expect(page.locator('#results .card-toggle').first()).toHaveAttribute('data-code', 'CS2104');
}

/**
 * Open the CS2104 detail from its button, follow the CS2030 link in its
 * prerequisites, go Back, and close the detail with Escape.
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof keys>} k
 */
async function detailLinkBackEscape(page, k) {
  const button = page.locator('#results button.card-toggle[data-code="CS2104"]');
  expect(await k.press('Enter')).toBe(CARD);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => query(page)).toBe(`${URL_FILTERED}&open=CS2104`);
  await settled(page);
  // Into the detail: Close first, then "can you take it" (its sources, the
  // NUSMods link), then the course facts, whose prerequisites link CS2030.
  /** @type {string[]} */
  const inside = [];
  for (let i = 0; i < 12 && !inside.includes('a "CS2030"'); i++) inside.push(...await k.tab());
  expect(inside[0]).toBe('button "Close details"');
  expect(inside).toContain('a "Class times and timetable on NUSMods"');
  expect(inside.indexOf('a "Class times and timetable on NUSMods"')).toBeLessThan(inside.indexOf('a "CS2030"'));
  expect(inside.at(-1)).toBe('a "CS2030"');
  // Follow it: a search for CS2030 with the same set-up and filter.
  await page.keyboard.press('Enter');
  await expect.poll(() => query(page)).toBe('q=CS2030&sem=1&level=2&ng=1&study=ug2');
  await expect(page.locator('#q')).toBeFocused();
  await settled(page);
  await expect(live(page)).toHaveText(/^\d+ courses? match(es)? “CS2030”\.$/);
  // Back: the CS2104 results with its detail open, focus on its button.
  await page.goBack();
  await expect.poll(() => query(page)).toBe(`${URL_FILTERED}&open=CS2104`);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => ring(page)).toBe('ok');
  await settled(page);
  // Escape closes it; focus stays on (returns to) its button.
  await page.keyboard.press('Escape');
  await expect.poll(() => query(page)).toBe(URL_FILTERED);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  await expect.poll(() => ring(page)).toBe('ok');
}

test.describe('at 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('[F5] [SC8] keyboard only at 1280: set-up, search, filter, rail set-up, detail, a link, Back, Escape; focus order and a visible ring at every stop', async ({ page }) => {
    const k = keys(page, await tabKey(page));
    await firstScreen(page, k);
    // Forward from the query: Search, the chips, the first entry.
    expect(await k.tab(4)).toEqual(['#go', 'button "Remove filter: Sem 1"', 'button "Remove filter: Exchange students"', CARD]);
    // Back into the rail, which sits before the results.
    expect(await k.shiftTab(7)).toEqual([
      'button "Remove filter: Exchange students"', 'button "Remove filter: Sem 1"', '#go', '#q', '#faculty', '#credits', '#level',
    ]);
    // A filter: Level 2000, by type-ahead on the closed list: L twice is the
    // second option starting with L (a space ends WebKit's type-ahead, so not "Level 2").
    await page.keyboard.type('LL');
    await expect.poll(() => query(page)).toBe(URL_FILTERED);
    await expect(page.locator('#level')).toBeFocused();
    await settled(page);
    await expect(live(page)).toHaveText(/^\d+ courses match “CS2104”\.$/);
    // The exchange set-up in the rail: the semester segment by arrow keys.
    expect(await k.shiftTab(2)).toEqual(['#study', 'radio xsem=1']);
    expect(await k.press('ArrowRight')).toBe('radio xsem=2');
    await expect.poll(() => query(page)).toBe('q=CS2104&sem=2&level=2&ng=1&study=ug2');
    expect(await k.press('ArrowLeft')).toBe('radio xsem=1');
    await expect.poll(() => query(page)).toBe(URL_FILTERED);
    await settled(page);
    // On to the entry.
    expect(await k.tab(9)).toEqual([
      '#study', '#level', '#credits', '#faculty', '#q', '#go',
      'button "Remove filter: Sem 1"', 'button "Remove filter: Exchange students"', 'button "Remove filter: Level 2000"',
    ]);
    expect(await k.tab()).toEqual([CARD]);
    await detailLinkBackEscape(page, k);
  });

  test('[F5] the skip link on the results goes past the header and the rail: the next stop is the search box', async ({ page }) => {
    const k = keys(page, await tabKey(page));
    await page.goto('/?q=networks');
    await settled(page);
    expect(await k.tab()).toEqual(['#skip']);
    await expect(page.locator('#skip')).toHaveText('Skip to main content');
    expect(await k.press('Enter')).toBe('#main');
    expect(await k.tab()).toEqual(['#q']);
    // No fragment in the URL, so no history entry: Back leaves the page's state as it was.
    expect(page.url()).not.toContain('#');
  });
});

test.describe('at 390×664', () => {
  test.use({ viewport: { width: 390, height: 664 } });

  test('[F5] [SC8] keyboard only at 390×664: set-up, search, filter and set-up in the Filters dialog, detail, a link, Back, Escape; focus order and a visible ring at every stop', async ({ page }) => {
    const k = keys(page, await tabKey(page));
    await firstScreen(page, k);
    // Forward from the query: Search, then Filters (the rail is behind it on a phone).
    expect(await k.tab(2)).toEqual(['#go', '#filtersBtn']);
    await expect(page.locator('#filtersBtn')).toHaveText('Filters (3)');
    expect(await k.press('Enter')).toBe('#ng');
    await expect(page.getByRole('dialog', { name: 'Your exchange and filters' })).toBeVisible();
    expect(await k.tab(3)).toEqual(['radio xsem=1', '#study', '#level']);
    await page.keyboard.type('LL');
    await expect.poll(() => query(page)).toBe(URL_FILTERED);
    await expect(page.locator('#level')).toBeFocused();
    // The exchange set-up in the dialog: the semester segment by arrow keys.
    expect(await k.shiftTab(2)).toEqual(['#study', 'radio xsem=1']);
    expect(await k.press('ArrowRight')).toBe('radio xsem=2');
    await expect.poll(() => query(page)).toBe('q=CS2104&sem=2&level=2&ng=1&study=ug2');
    expect(await k.press('ArrowLeft')).toBe('radio xsem=1');
    await expect.poll(() => query(page)).toBe(URL_FILTERED);
    // Escape closes the dialog; focus returns to its button, now counting four.
    expect(await k.press('Escape')).toBe('#filtersBtn');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.locator('#filtersBtn')).toHaveText('Filters (4)');
    await settled(page);
    await expect(live(page)).toHaveText(/^\d+ courses match “CS2104”\.$/);
    expect(await k.tab(4)).toEqual([
      'button "Remove filter: Sem 1"', 'button "Remove filter: Exchange students"', 'button "Remove filter: Level 2000"', CARD,
    ]);
    await detailLinkBackEscape(page, k);
  });
});

test('[F5] Escape in the search box with a detail open closes the detail and keeps the typed query', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244');
  await settled(page);
  await page.locator('#q').focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => query(page)).toBe('q=CS3244');
  await expect(page.locator('#q')).toHaveValue('CS3244');
  await expect(page.locator('#results button[data-code="CS3244"]')).toBeFocused();
});

test('[F5] Back to another answer, after focus was on a card of this one: focus is on the results <main>, and Tab reaches the search box', async ({ page }) => {
  await page.goto('/?q=networks');
  await settled(page);
  await page.locator('#q').fill('compilers');
  await page.locator('#q').press('Enter');
  await expect.poll(() => query(page)).toBe('q=compilers');
  await settled(page);
  await page.locator('#results button.card-toggle').nth(2).focus();
  await page.goBack();
  await expect.poll(() => query(page)).toBe('q=networks');
  await settled(page);
  await expect(page.locator('#main')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press('Tab');
  await expect(page.locator('#q')).toBeFocused();
});
