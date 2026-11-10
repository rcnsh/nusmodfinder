// @ts-check
// axe-core on the 5B page (Phase 5 5B). SC8's zero-violation run, with every
// rule, is 5E's; until then this pins the baseline: every rule runs, and the
// only rules that fail are the ones F5 (no <main>, content outside landmarks)
// and F6 (contrast) already record, so the move to static ES modules and DOM
// rendering added none.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const KNOWN = ['color-contrast', 'landmark-one-main', 'region'];

for (const [state, path] of [['first screen', '/'], ['results', '/?q=networks'], ['exchange results', '/?q=networks&ng=1&study=ug2&sem=1'], ['no match', '/?q=CS1001']]) {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    test(`axe, every rule: ${state}, ${scheme}: no violation beyond F5 and F6`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(path);
      await expect(page.locator('#status')).not.toHaveText('Searching…');
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => v.id).filter((id) => !KNOWN.includes(id))).toEqual([]);
    });
  }
}
