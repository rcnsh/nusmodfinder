// @ts-check
// axe-core with every rule (no tag filter) on the page's states, in both
// themes, at 1280 and at 390×664. 5B and 5C allowed F5's `landmark-one-main`
// and `region` and F6's `color-contrast`; 5D's layout (a <main>, the rail an
// <aside>, the header and footer landmarks) and its tokens (scripts/contrast.mjs)
// fixed all three, so no violation is allowed. SC8's full gate (every state
// × theme × width, the keyboard and screen-reader flows) is 5E's.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { browse } from './support.mjs';

/** @type {[string, string | ((page: import('@playwright/test').Page) => Promise<void>)][]} */
const STATES = [
  ['first screen (the exchange set-up)', '/'],
  ['empty search (browse all)', browse],
  ['results', '/?q=networks'], ['exchange results', '/?q=networks&ng=1&study=ug2&sem=1'], ['no match', '/?q=CS1001'],
  ['exchange results, both semesters', '/?q=ACC1701XB&ng=1&study=ug2'],
  ['detail open, exchange mode', '/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB'],
  ['detail open, all years table', '/?q=CS3244&open=CS3244'],
  ['hidden codes', '/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1'],
  ['partial code with the other semester', '/?q=CG32&ng=1&study=ug2&sem=1'],
  ['filters, removable chips', '/?q=databases&level=2&credits=4&faculty=Computing'],
];
const WIDTHS = /** @type {const} */ ([['1280', 1280, 800], ['390×664', 390, 664]]);

for (const [state, open] of STATES) {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    for (const [label, width, height] of WIDTHS) {
      test(`axe, every rule: ${state}, ${scheme}, ${label}: no violation`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        if (typeof open === 'string') await page.goto(open);
        else await open(page);
        const path = typeof open === 'string' ? open : '';
        await expect(page.locator('#status')).not.toHaveText('Searching…');
        // The asynchronous parts have settled: a detail's content, each hidden code's reason, the other-semester check.
        await expect(page.locator('#results .detail-loading')).toHaveCount(0);
        if (path.includes('open=')) await expect(page.locator('#results .detail:not([hidden]) .detail-close')).toHaveCount(1);
        if (path.includes('CG32')) await expect(page.locator('#status .see-other')).toHaveCount(1);
        if (path.includes('AR5801')) await expect(page.locator('#status .hidden-codes .why').last()).toContainText('NG restrictions');
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      });
    }
  }
}

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  test(`axe, every rule: the filters dialog open at 390×664, ${scheme}: no violation`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto('/?q=networks&ng=1&study=ug2&sem=1&level=2');
    await page.getByRole('button', { name: 'Filters (4)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
}
