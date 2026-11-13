// @ts-check
// The page's response headers, from
// public/_headers on the local `wrangler dev` stack, the same Workers Static
// Assets that serve it live. No other origin may frame the page, and the CSP
// lets it run only its own files: every flow below runs with no CSP violation.
import { expect, test } from '@playwright/test';

// Chromium's Local Network Access check stops a page on one loopback origin
// framing another at all, which would pass the framing test for the wrong
// reason; the live site isn't on loopback, so the test turns it off.
test.use({
  launchOptions: async ({ browserName }, use) => use(browserName === 'chromium'
    ? { args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'] }
    : {}),
});

/**
 * Records every CSP violation the page reports, from before its first script.
 * Every report fails: the page has no native <select> (WebKit reported
 * `style-src-attr` against each one's own control styling).
 * @param {import('@playwright/test').Page} page
 */
async function watchCsp(page) {
  await page.addInitScript(() => {
    /** @type {any} */ (globalThis).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      /** @type {any} */ (globalThis).__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, file: e.sourceFile, line: e.lineNumber });
    });
  });
  return async () => {
    /** @type {{ directive: string, blocked: string, file: string, line: number }[]} */
    return page.evaluate(() => /** @type {any} */ (globalThis).__csp);
  };
}

test('the page and its files are sent with the framing, sniffing and content policies', async ({ request }) => {
  for (const path of ['/', '/?q=networks', '/app.js', '/styles.css', '/fonts/IBMPlexSans-Regular-Latin1.woff2']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy'], path).toContain("default-src 'none'");
  }
  // The rules file itself is not served.
  const rules = await request.get('/_headers');
  expect(rules.status()).toBe(404);
  expect(await rules.text()).not.toContain('Content-Security-Policy');
});

test('another origin can\'t frame the page: the frame stays empty, while an unprotected response beside it loads', async ({ page, baseURL }) => {
  const base = /** @type {string} */ (baseURL);
  // A second origin: the same server by another host name, answered by the router.
  const attacker = base.replace('127.0.0.1', 'localhost');
  expect(attacker).not.toBe(base);
  await page.route(`${attacker}/__attacker`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>x</title>
      <iframe id="page" src="${base}/?q=accounting&ng=1&sem=1&study=ug1" width="800" height="400"></iframe>
      <iframe id="control" src="${base}/health" width="400" height="200"></iframe>`,
  }));
  await page.goto(`${attacker}/__attacker`);
  // The control: a Worker JSON answer has no frame policy, so it loads; framing works here at all.
  await expect(page.frameLocator('#control').locator('body')).toContainText('"vectors"');
  await page.waitForTimeout(1000);
  const framed = page.frames().find((f) => f.url().includes('q=accounting'));
  const rendered = framed ? await framed.locator('#q').count().catch(() => 0) : 0;
  expect(rendered).toBe(0);
});

test('no CSP violation: the first screen, a search, a detail, the filters dialog, dark mode', async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto('/');
  await expect(page.locator('#setupForm')).toBeVisible();
  await page.goto('/?q=machine+learning&ng=1&sem=1&study=ug3');
  await expect(page.locator('#status .count')).toBeVisible();
  const first = page.locator('#results button.card-toggle').first();
  await first.click();
  await expect(page.locator('#results .detail:not([hidden])')).toContainText('Prerequisites');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 664 });
  await page.locator('#filtersBtn').click();
  await expect(page.locator('dialog[open]')).toBeVisible();
  await page.keyboard.press('Escape');
  // The inline script ran (it is hashed): a link with state opened on the results view.
  expect(await page.evaluate(() => document.documentElement.dataset.view ?? 'removed by app.js')).toBe('removed by app.js');
  expect(await violations()).toEqual([]);
});

test('the inline view script runs under the CSP: a link with state never flashes the first screen', async ({ page }) => {
  const violations = await watchCsp(page);
  // Hold app.js so only the inline script has run.
  /** @type {(() => void) | null} */
  let release = null;
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  await page.route('**/app.js', async (route) => { await held; await route.continue(); });
  const loaded = page.goto('/?q=networks');
  await expect(page.locator('html')).toHaveAttribute('data-view', 'results');
  /** @type {any} */ (release)();
  await loaded;
  await expect(page.locator('#status .count')).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('no CSP violation in the shortlist: a toggle, the view, a row, Copy link\'s field, the export question, Restore, dark mode', async ({ page }) => {
  const violations = await watchCsp(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('no')) } });
  });
  await page.goto('/?q=CS2113&ng=1&study=ug2&sem=1');
  await expect(page.locator('#status .count')).toBeVisible();
  await page.getByRole('button', { name: 'Shortlist, CS2113', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Shortlist, CS2113', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.sl-open:visible').click();
  await expect(page.locator('#slView li.sl-entry[data-code="CS2113"] .title')).toHaveText(/Software Engineering/);
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByLabel('Shortlist link')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?pick=CS5562&view=shortlist');
  await expect(page.locator('#slAsk')).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore your last shortlist', exact: true }).click();
  await expect(page.locator('#slView')).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('no CSP violation in the exports: Download CSV (a blob URL), the print page under print media, print() called', async ({ page }) => {
  const violations = await watchCsp(page);
  await page.addInitScript(() => { window.print = () => { /** @type {any} */ (globalThis).printed = true; }; });
  await page.goto('/?ng=1&study=ug2&sem=1&pick=CS2113.1&alt=EE4407.1&view=shortlist');
  await expect(page.locator('#slView .sl-entry[data-code="EE4407"] .title')).toHaveText('Analog Electronics');
  const csv = page.locator('.sl-actions').getByRole('button', { name: 'Download CSV', exact: true });
  await csv.focus();
  const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(file.suggestedFilename()).toBe('exchange-shortlist-sem1-2026-27-courses.csv');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#slPrint')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await page.locator('.sl-actions').getByRole('button', { name: 'Print or save as PDF', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (globalThis).printed)).toBe(true);
  expect(await violations()).toEqual([]);
});
