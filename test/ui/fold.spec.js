// @ts-check
import { devices } from '@playwright/test';
import { expect, test } from '@playwright/test';

/** @type {[string, string, string, number][]} */
const CASES = [
  ['Sem 1, ACC1701XB first', 'ACC1701XB', '1', 1],
  ['both semesters, ACC1701XB first', 'ACC1701XB', '', 2],
  ['Sem 1, introductory accounting', 'introductory accounting', '1', 1],
  ['both semesters, introductory accounting', 'introductory accounting', '', 2],
];

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} stamps
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
  await page.getByRole('radio', { name: /^Exchange student/ }).check();
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

const LONGEST = 'Sem 1: 22.5 · Sem 2: 21.5 units picked';

/** @param {import('@playwright/test').Page} page @param {string} url */
async function withShortlist(page, url) {
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
    test(`fold: ${label}, with toggles, the longest shortlist label and the restore offer`, async ({ page }) => {
      await withShortlist(page, link(q, sem));
      await foldHolds(page, stamps);
    });
  }
});
