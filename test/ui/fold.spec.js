// @ts-check
// The fold check (Phase 5 5D, SC8's mobile item; plan §2 and 5C's deferral):
// at 390×664, on the Sem 1 and the both-semesters results with ACC1701XB among
// them, the header with "unofficial", the collapsed search bar, and the first
// entry's code, title and exchange status are all in view without scrolling.
// After a shared-link load and after a search typed on the first screen, at
// 390×664 in each project's browser (Chromium and WebKit), and the same eight
// emulating an iPhone 13 (390×664, touch, 3× pixels; SC8's WebKit case, 5E). ACC1701XB is the densest entry: three
// notes in Sem 1. "introductory accounting" shows it as ACC1701XA's "Also as".
import { devices } from '@playwright/test';
import { expect, test } from '@playwright/test';

/** @type {[string, string, string, number][]} label, query, sem ('' for both), stamps */
const CASES = [
  ['Sem 1, ACC1701XB first', 'ACC1701XB', '1', 1],
  ['both semesters, ACC1701XB first', 'ACC1701XB', '', 2],
  ['Sem 1, introductory accounting', 'introductory accounting', '1', 1],
  ['both semesters, introductory accounting', 'introductory accounting', '', 2],
];

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} stamps how many semester stamps the first entry shows
 */
async function foldHolds(page, stamps) {
  await expect(page.locator('#results > li.card').first()).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1.getByText('(unofficial)')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#q')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#go')).toBeInViewport({ ratio: 1 });
  const first = page.locator('#results > li.card').first();
  await expect(first.locator('.code')).toBeInViewport({ ratio: 1 });
  await expect(first.locator('.title')).toBeInViewport({ ratio: 1 });
  const status = first.locator('.exchange-status');
  await expect(status).toHaveCount(stamps);
  for (let i = 0; i < stamps; i++) await expect(status.nth(i)).toBeInViewport({ ratio: 1 });
}

/** @param {string} q @param {string} sem */
const link = (q, sem) => `/?q=${encodeURIComponent(q).replace(/%20/g, '+')}${sem ? `&sem=${sem}` : ''}&ng=1&study=ug2`;

/** @param {import('@playwright/test').Page} page @param {string} q @param {string} sem */
async function typed(page, q, sem) {
  await page.goto('/');
  await page.getByRole('radio', { name: sem ? new RegExp(`^Sem ${sem}`) : /^Both semesters/ }).check();
  await page.getByRole('radio', { name: '2nd year' }).check();
  await page.getByLabel('What do you want to study?').fill(q);
  await page.getByLabel('What do you want to study?').press('Enter');
  await expect.poll(() => new URL(page.url()).search).toBe(link(q, sem).slice(1));
}

test.describe('at 390×664', () => {
  test.use({ viewport: { width: 390, height: 664 } });
  for (const [label, q, sem, stamps] of CASES) {
    test(`fold: ${label}, shared link`, async ({ page }) => {
      await page.goto(link(q, sem));
      await foldHolds(page, stamps);
    });
    test(`fold: ${label}, typed on the first screen`, async ({ page }) => {
      await typed(page, q, sem);
      await foldHolds(page, stamps);
    });
  }
});

test.describe('emulating an iPhone 13', () => {
  // The device's viewport, scale, touch and user agent; the project picks the browser.
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13'];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });
  for (const [label, q, sem, stamps] of CASES) {
    test(`fold, iPhone 13: ${label}, shared link`, async ({ page }) => {
      await page.goto(link(q, sem));
      await foldHolds(page, stamps);
    });
    test(`fold, iPhone 13: ${label}, typed on the first screen`, async ({ page }) => {
      await typed(page, q, sem);
      await foldHolds(page, stamps);
    });
  }
});

// Phase 6 6C (plan 6C "Tests first"; A-11, A2-10, A9-m2): the fold holds with the
// shortlist on the page: the cards' toggles, the phone's shortlist button under
// the form carrying the longest label it can show (two semesters with half
// units: the fixture has no half-unit course, so the label is set to it), and
// G3's restore offer above the list (the device keeps a list, the link has none).
/** The longest label the shortlist button shows. */
const LONGEST = 'Sem 1: 22.5 · Sem 2: 21.5 units picked';

/** @param {import('@playwright/test').Page} page @param {string} url */
async function withShortlist(page, url) {
  // The device keeps a list once one is edited.
  await page.goto('/?q=CS2113&ng=1&study=ug2&sem=1');
  await page.getByRole('button', { name: 'Shortlist, CS2113', exact: true }).click();
  await expect.poll(() => new URL(page.url()).search).toContain('pick=CS2113.1');
  await page.goto(url);
  await expect(page.locator('#slRestore')).toBeVisible();
  await expect(page.locator('#results > li.card').first()).toBeVisible();
  await page.locator('#slOpenPhone small').evaluate((el, t) => { el.textContent = t; }, LONGEST);
  await expect(page.locator('#slOpenPhone')).toBeVisible();
  await expect(page.locator('#results > li.card').first().locator('.sl-toggle')).toBeVisible();
}

test.describe('at 390×664, with the shortlist', () => {
  test.use({ viewport: { width: 390, height: 664 } });
  for (const [label, q, sem, stamps] of CASES) {
    test(`[6C] fold: ${label}, with toggles, the longest shortlist label and the restore offer`, async ({ page }) => {
      await withShortlist(page, link(q, sem));
      await foldHolds(page, stamps);
    });
  }
});
