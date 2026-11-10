// @ts-check
// The fold check (Phase 5 5D, SC8's mobile item; plan §2 and 5C's deferral):
// at 390×664, on the Sem 1 and the both-semesters results with ACC1701XB among
// them, the header with "unofficial", the collapsed search bar, and the first
// entry's code, title and exchange status are all in view without scrolling.
// After a shared-link load and after a search typed on the first screen; at
// 390×664 in each project's browser (Chromium and WebKit), and emulating an
// iPhone 13 (390×664, touch, 3× pixels). ACC1701XB is the densest entry: three
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
  await expect(h1.getByText('unofficial, for NUS')).toBeInViewport({ ratio: 1 });
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
  for (const [label, q, sem, stamps] of CASES.slice(0, 2)) {
    test(`fold, iPhone 13: ${label}, shared link`, async ({ page }) => {
      await page.goto(link(q, sem));
      await foldHolds(page, stamps);
    });
  }
});
