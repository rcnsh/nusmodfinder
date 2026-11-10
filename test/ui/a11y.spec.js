// @ts-check
// axe-core on the 5B page (Phase 5 5B), and 5C's states. SC8's zero-violation run, with every
// rule, is 5E's; until then this pins the baseline: every rule runs, and the
// only rules that fail are the ones F5 (no <main>, content outside landmarks)
// and F6 (contrast) already record, so the move to static ES modules and DOM
// rendering added none.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const KNOWN = ['color-contrast', 'landmark-one-main', 'region'];

const STATES = [
  ['first screen', '/'], ['results', '/?q=networks'], ['exchange results', '/?q=networks&ng=1&study=ug2&sem=1'], ['no match', '/?q=CS1001'],
  // 5C's states.
  ['exchange results, both semesters', '/?q=ACC1701XB&ng=1&study=ug2'],
  ['detail open, exchange mode', '/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB'],
  ['detail open, all years table', '/?q=CS3244&open=CS3244'],
  ['hidden codes', '/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1'],
  ['partial code with the other semester', '/?q=CG32&ng=1&study=ug2&sem=1'],
];
for (const [state, path] of STATES) {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    test(`axe, every rule: ${state}, ${scheme}: no violation beyond F5 and F6`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await expect(page.locator('#status')).not.toHaveText('Searching…');
      // The asynchronous parts have settled: a detail's content, each hidden code's reason, the other-semester check.
      await expect(page.locator('#results .detail-loading')).toHaveCount(0);
      if (path.includes('open=')) await expect(page.locator('#results .detail:not([hidden]) .detail-close')).toHaveCount(1);
      if (path.includes('CG32')) await expect(page.locator('#status .see-other')).toHaveCount(1);
      if (path.includes('AR5801')) await expect(page.locator('#status .hidden-codes li').last()).toContainText('NG restrictions');
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => v.id).filter((id) => !KNOWN.includes(id))).toEqual([]);
    });
  }
}
