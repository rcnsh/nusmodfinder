// @ts-check
// Phase 8 8B (docs/plans/phase8.md §2 "8B", as §5's answers adjust it): what a visitor sees on
// the local stack. The no-JavaScript sentence on the first screen at 390×664; the year line, with
// its clause for applicants, at 390, 768 and 1024 px in the set-up, results and shortlist views;
// the footer's restrictions and privacy links; /favicon.ico from assets; and the 404 page and the
// privacy note under axe in both themes.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DEFAULT_ACAD_YEAR } from '../../public/year.js';
import { axeViolations, settled } from './support.mjs';

/** 'YYYY-YYYY' → 'YYYY/YY'. @param {string} ay */
const label = (ay) => `${ay.slice(0, 4)}/${ay.slice(7, 9)}`;
const NEXT = `${Number(DEFAULT_ACAD_YEAR.slice(0, 4)) + 1}-${Number(DEFAULT_ACAD_YEAR.slice(5, 9)) + 1}`;
const RESTRICTIONS = JSON.parse(readFileSync(new URL(`../../data/ng-sources-${DEFAULT_ACAD_YEAR}.json`, import.meta.url), 'utf8'))
  .revisions.at(-1).documents.find((/** @type {{ id: string }} */ d) => d.id === 'restrictions').url;

test.describe('without JavaScript, at 390×664', () => {
  test.use({ viewport: { width: 390, height: 664 }, javaScriptEnabled: false });
  for (const url of ['/', '/?q=accounting&ng=1&sem=1&study=ug2&pick=CS2113.1&view=shortlist']) {
    test(`one sentence says the site needs JavaScript, on the first screen: ${url}`, async ({ page }) => {
      await page.goto(url);
      const note = page.locator('noscript p, .noscript');
      await expect(note).toHaveCount(1);
      await expect(note).toContainText('JavaScript');
      await expect(note).toBeInViewport({ ratio: 1 });
    });
  }
});

/** @type {[string, string, (page: import('@playwright/test').Page) => Promise<void>][]} */
const VIEWS = [
  ['set-up', '/', (page) => expect(page.locator('#setupForm')).toBeVisible()],
  ['results', '/?q=networks&ng=1&study=ug2&sem=1', (page) => settled(page)],
  ['shortlist', '/?ng=1&study=ug2&sem=1&pick=CS2113.1&view=shortlist', (page) => expect(page.locator('#slView')).toBeVisible()],
];

for (const width of [390, 768, 1024]) {
  for (const [view, url, ready] of VIEWS) {
    test(`the year line shows at ${width} px in the ${view} view, with its clause for applicants`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(url);
      await ready(page);
      const line = page.locator('#yearLine');
      await expect(line).toBeVisible();
      await expect(line).toContainText(`NUS's ${label(DEFAULT_ACAD_YEAR)}`);
      await expect(line).toContainText(`Applying for ${label(NEXT)}?`);
    });
  }
}

test('the footer links the restrictions document at its own address, and the privacy note', async ({ page }) => {
  await page.goto('/');
  const footer = page.locator('footer');
  await expect(footer.getByRole('link', { name: 'Course restrictions for exchange (NG) students' })).toHaveAttribute('href', RESTRICTIONS);
  await footer.getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Privacy');
});

test('/favicon.ico is a static file: an icon, with no x-app-version (the Worker never ran)', async ({ request }) => {
  const res = await request.get('/favicon.ico');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/image\/(?:x-icon|vnd\.microsoft\.icon)/);
  expect(res.headers()['x-app-version']).toBeUndefined();
});

test('a mistyped address shows the 404 page, with the page\'s security headers and a way home', async ({ page }) => {
  const res = await page.goto('/no-such-page');
  expect(res?.status()).toBe(404);
  const h = res?.headers() ?? {};
  expect(h['content-type']).toContain('text/html');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toContain("default-src 'none'");
  await expect(page.getByRole('heading', { level: 1 })).toContainText('NUS Mod Finder');
  await expect(page.getByText('unofficial').first()).toBeVisible();
  await page.getByRole('link', { name: /search/i }).first().click();
  await expect(page.locator('#setupForm')).toBeVisible();
});

for (const [name, url] of [['the 404 page', '/no-such-page'], ['the privacy note', '/privacy']]) {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    for (const [w, h] of [[1280, 800], [390, 664]]) {
      test(`[SC8] axe, every rule: ${name}, ${scheme}, ${w}: no violation`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: w, height: h });
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
}
