// @ts-check
// P3 (Phase 5 5C): the page says it is unofficial, in the title and the
// visible header at every width, with NUS not the brand (D3), and its footer
// links the sources: NUSMods, the NG list, the restrictions and the
// Registrar's vacancy report.
import { expect, test } from '@playwright/test';

test('[P3] "unofficial" is in the title, and in view at 390×664, on the first screen and after a search', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  for (const path of ['/', '/?q=ACC1701XB&ng=1&study=ug2&sem=1']) {
    await page.goto(path);
    await expect(page).toHaveTitle('NUS Mod Finder (unofficial)');
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toHaveText('NUS Mod Finder (unofficial)');
    await expect(h1.getByText('(unofficial)')).toBeInViewport({ ratio: 1 });
  }
});

test('[P3] "unofficial" stays in view at 1280', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).getByText('(unofficial)')).toBeInViewport({ ratio: 1 });
});

test('[P3] the footer says the site is unofficial and links NUSMods, the NG list, the restrictions and the vacancy report, then the privacy note (8B)', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer).toContainText('An unofficial site, not run by NUS or NUSMods.');
  const links = footer.getByRole('link');
  await expect(links).toHaveText(['NUSMods', 'Courses offered to exchange (NG) students', 'Course restrictions for exchange (NG) students', "The Registrar's course vacancy report", 'Privacy']);
  await expect(links.last()).toHaveAttribute('href', '/privacy');
  for (const a of (await links.all()).slice(0, -1)) {
    await expect(a).toHaveAttribute('href', /^https:\/\/(?:nusmods\.com|www\.nus\.edu\.sg|nus\.edu\.sg)\//);
    await expect(a).toHaveAttribute('rel', 'noopener');
  }
});
