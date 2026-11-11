// @ts-check
// Screenshots of direction D's five mockup states from the real page (Phase 5
// 5D), at 1280×800 and 390×664, in both themes, for comparing with
// docs/design/phase5-direction-d.html. Not a check: it runs only when asked,
// in Chromium, and writes docs/evidence/phase5/shots/ (and Phase 6 6C's to
// docs/evidence/phase6/ui/).
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

// Phase 6 6C: the shortlist mockup's states the page builds
// (docs/design/phase6-shortlist/a/, states 1 to 3; state 4, the print page, is
// 6D's), plus the export question in browse mode, at both sizes and in both
// themes, to docs/evidence/phase6/ui/.
const OUT6 = 'docs/evidence/phase6/ui';
const Q6 = 'ACC1701XB+CS2113+CS2030';
/** @type {[string, string, (page: import('@playwright/test').Page) => Promise<void>][]} */
const STATES6 = [
  ['results', `/?q=${Q6}&ng=1&study=ug2&pick=ACC1701XB.1&pick=CS2113.2&pick=GE2101.1`, async (page) => {
    await expect(page.locator('.sl-open:visible small')).toHaveText('Sem 1: 8 · Sem 2: 4 units picked');
  }],
  ['view', `/?q=${Q6}&sem=1&ng=1&study=ug2&pick=CS2113.1&pick=GE2101.1&pick=PC3270.1&pick=ACC1701XA.1&alt=CS3244.1&alt=EE4407.1&view=shortlist`, async (page) => {
    await expect(page.locator('#slView .sl-ehead .title', { hasText: 'Loading…' })).toHaveCount(0);
  }],
  ['fullyear', `/?q=${Q6}&sem=1&ng=1&study=ug2&pick=CS2030.1&pick=CS3244.2&pick=GE2101.1&pick=HY1101E&pick=ACC1701XA.1&pick=EN3264.1&pick=PS3251.2&pick=MA3220.1&pick=ST2137.2&pick=GES1034.1&pick=LSM2212.1&alt=CS2113.1&alt=CM3267.1&alt=PC3232.1&alt=GESS1007.1&alt=PC4262.1&alt=TS2239.2&view=shortlist`, async (page) => {
    await expect(page.locator('#slView .sl-ehead .title', { hasText: 'Loading…' })).toHaveCount(0);
    // As the mockup: Sem changed to 2 in the view.
    if (await page.locator('#semSegOptions').isVisible()) await page.locator('#semSegOptions').getByText('Sem 2', { exact: true }).click();
    else {
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.locator('dialog #semSegOptions').getByText('Sem 2', { exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('#live')).toHaveText(/^Sem 2 first/);
    await page.evaluate(() => window.scrollTo(0, 0));
  }],
  ['ask', '/?pick=CS5562&pick=CS2113.1&view=shortlist', async (page) => {
    await expect(page.locator('#slAsk')).toBeVisible();
  }],
];

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  for (const [size, width, height] of SIZES) {
    for (const [state, path, prepare] of STATES6) {
      test(`shot 6C: ${state}, ${size}, ${scheme}`, async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'Chromium only');
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        await prepare(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${OUT6}/${state}-${size}-${scheme}.png`, fullPage: state !== 'results' });
      });
    }
  }
}
