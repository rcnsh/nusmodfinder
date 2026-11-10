// @ts-check
// Screenshots of direction D's five mockup states from the real page (Phase 5
// 5D), at 1280×800 and 390×664, in both themes, for comparing with
// docs/design/phase5-direction-d.html. Not a check: it runs only when asked,
// in Chromium, and writes docs/evidence/phase5/shots/.
//
//   VNM_SHOTS=1 npx playwright test shots --project chromium
import { expect, test } from '@playwright/test';

test.skip(!process.env.VNM_SHOTS, 'screenshots only when VNM_SHOTS=1');

const OUT = 'docs/evidence/phase5/shots';
const SIZES = /** @type {const} */ ([['desktop', 1280, 800], ['phone', 390, 664]]);
const ACC = 'introductory+accounting';

/** @type {[string, string, (page: import('@playwright/test').Page) => Promise<void>][]} */
const STATES = [
  ['setup', '/', async (page) => {
    await page.getByRole('radio', { name: /^Sem 1/ }).check();
    await page.getByRole('radio', { name: '2nd year' }).check();
    await page.mouse.click(1, 1);
    await page.evaluate(() => window.scrollTo(0, 0));
  }],
  ['sem1', `/?q=${ACC}&sem=1&ng=1&study=ug2`, async () => {}],
  ['both', `/?q=${ACC}&ng=1&study=ug2`, async () => {}],
  ['detail', '/?q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB', async (page) => {
    const region = page.locator('#results .detail:not([hidden])');
    await expect(region.locator('.detail-close')).toBeVisible();
    // As the mockup: scrolled so the opened entry sits under the header.
    await page.evaluate(() => {
      const open = document.querySelector('#results button[aria-expanded="true"]');
      const entry = open?.closest('li');
      const hdr = document.querySelector('.hdr');
      const top = (entry?.getBoundingClientRect().top ?? 0) + window.scrollY;
      const sticky = hdr && getComputedStyle(hdr).position === 'sticky' ? hdr.getBoundingClientRect().height : 0;
      window.scrollTo(0, top - sticky - 14);
    });
  }],
  ['hidden', '/?q=CS2030+CS3244+CS5562+AR5801&sem=1&ng=1&study=ug2', async (page) => {
    await expect(page.locator('#status .hidden-codes .why').last()).toContainText('NG restrictions, updated');
  }],
];

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  for (const [size, width, height] of SIZES) {
    for (const [state, path, prepare] of STATES) {
      test(`shot: ${state}, ${size}, ${scheme}`, async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'Chromium only');
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        if (path.includes('q=')) await expect(page.locator('#status')).not.toHaveText('Searching…');
        await prepare(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${OUT}/${state}-${size}-${scheme}.png` });
      });
    }
  }
}
