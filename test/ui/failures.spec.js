// @ts-check
// Failure states by request interception: a hung
// search, 429, an HTML error page, the network gone, /facets down or slow, and
// a keyword-only answer. The page shows a plain sentence, never a raw code.
import { expect, test } from '@playwright/test';
import { body, matchFor, searches, pill, facultyOptions, openFaculty } from './support.mjs';

const RAW = /rate_limited|upstream_failure|not_json|bad_request|internal|SyntaxError|\b5\d\d\b|\b429\b/;

test('a search that never answers gives up after 10 s with a sentence; the button stays enabled throughout', async ({ page }) => {
  await page.clock.install();
  await page.route('**/search?**', () => { /* never answers */ });
  await page.goto('/?q=slow');
  await expect(page.locator('#status')).toHaveText('Searching…');
  await expect(page.locator('#go')).toBeEnabled();
  await page.clock.fastForward(9_000);
  await expect(page.locator('#status')).toHaveText('Searching…');
  await page.clock.fastForward(1_000);
  await expect(page.locator('#status')).toHaveText('The search took too long to answer. Try again, or try a shorter query.');
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('#go')).toBeEnabled();
});

test('a newer search aborts the one in flight, whose answer is never shown', async ({ page }) => {
  /** @type {import('@playwright/test').Route[]} */
  const held = [];
  await page.route('**/search?q=first**', (route) => { held.push(route); });
  await page.goto('/?q=first');
  await expect(page.locator('#status')).toHaveText('Searching…');
  const failed = page.waitForEvent('requestfailed', (r) => r.url().includes('q=first'));
  await page.locator('#q').fill('networks');
  await page.locator('#q').press('Enter');
  await failed;
  await expect(page.locator('#status')).toContainText(matchFor('networks'));
  await held[0].fulfill({ json: body({ query: 'first' }) }).catch(() => { /* the page already aborted it */ });
  await page.waitForTimeout(200);
  await expect(page.locator('#status')).toContainText(matchFor('networks'));
});

test('429 says when to try again, from Retry-After', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({
    status: 429, headers: { 'retry-after': '30' }, json: { error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' },
  }));
  await page.goto('/?q=x');
  await expect(page.locator('#status')).toHaveText('Too many searches from your connection. Try again in 30 seconds.');
  await expect(page.locator('#status')).not.toHaveText(RAW);
});

test('an HTML error page is an answer from the service, not "could not reach"', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({
    status: 502, contentType: 'text/html', body: '<!doctype html><title>502</title><h1>Bad gateway</h1>',
  }));
  await page.goto('/?q=x');
  await expect(page.locator('#status')).toHaveText('The search service answered with an error page. Try again in a moment.');
});

test('a JSON error shows its sentence, never its code or message', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({
    status: 502, json: { error: 'upstream_failure', source: 'd1', message: 'D1_ERROR: database is locked' },
  }));
  await page.goto('/?q=x');
  await expect(page.locator('#status')).toHaveText('The search service could not reach its course data. Try again in a moment.');
  await expect(page.locator('#status')).not.toHaveText(/D1_ERROR|upstream/);
});

test('the network gone says the service could not be reached', async ({ page }) => {
  await page.route('**/search?**', (route) => route.abort('internetdisconnected'));
  await page.goto('/?q=x');
  await expect(page.locator('#status')).toHaveText('Could not reach the search service. Check your connection and try again.');
});

test('/facets down: a shared link keeps every filter, faculty included, and searches with them', async ({ page }) => {
  await page.route('**/facets', (route) => route.abort('failed'));
  const sent = searches(page);
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/search');
  await page.goto('/?q=databases&level=2&credits=10&faculty=Computing');
  await answered;
  await expect(pill(page, 'level', '2')).toBeChecked();
  await expect(pill(page, 'credits', '10')).toBeChecked();
  await expect(page.locator('#faculty')).toHaveAttribute('data-value', 'Computing');
  expect(sent).toEqual(['q=databases&level=2&credits=10&faculty=Computing']);
});

test('the first search starts before /facets answers, and the faculty list fills in later around the chosen one', async ({ page }) => {
  /** @type {(() => void) | null} */
  let release = null;
  const facetsHeld = new Promise((resolve) => { release = () => resolve(undefined); });
  await page.route('**/facets', async (route) => { await facetsHeld; await route.continue(); });
  await page.goto('/?q=databases&faculty=Computing');
  await expect(page.locator('#status')).toContainText(matchFor('databases'));
  // Quoted until /facets lists it: until then it is only the link's text.
  await openFaculty(page);
  await expect(facultyOptions(page)).toHaveText(['Any faculty', '“Computing”']);
  /** @type {any} */ (release)();
  await expect(page.locator('#faculty-list [data-value="Computing"]')).toHaveText(/^Computing, \d+$/);
  await expect(page.locator('#faculty')).toHaveAttribute('data-value', 'Computing');
  expect(await facultyOptions(page).count()).toBeGreaterThan(5);
});

test('a keyword-only (degraded) answer says so, with no source or reason code', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ json: body({ degraded: { source: 'workers-ai', reason: 'timeout' } }) }));
  await page.goto('/?q=networks');
  await expect(page.locator('#status')).toContainText('Search is in a simpler mode right now: it finds only courses that contain the words you typed. Try the course name or code, or search again later.');
  await expect(page.locator('#status')).not.toContainText('workers-ai');
  await expect(page.locator('#results > li')).toHaveCount(1);
});
