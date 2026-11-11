// @ts-check
// SC8's screen-reader items that a test can measure (Phase 5 5E, F5): the one
// polite live region says each answer in a sentence (the count, no match,
// hidden codes, errors and 429), the list is aria-busy while a search runs,
// the Search button is never disabled (it keeps focus; a second search aborts
// the first), and every control has an accessible name. The VoiceOver
// walkthrough itself is docs/evidence/phase5/voiceover-checklist.md.
import { expect, test } from '@playwright/test';
import { body, live, liveLog, query, recordLive, settled } from './support.mjs';

/** Every live region on the page: there must be one. @param {import('@playwright/test').Page} page */
const liveRegions = (page) => page.locator('[aria-live], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], output');

test('[F5] one polite live region, in the header, present in every view', async ({ page }) => {
  for (const path of ['/', '/?q=networks', '/?q=CS3244&open=CS3244']) {
    await page.goto(path);
    await settled(page);
    await expect(liveRegions(page)).toHaveCount(1);
    await expect(live(page)).toHaveAttribute('aria-live', 'polite');
    await expect(live(page)).toHaveAttribute('role', 'status');
    await expect(live(page)).toHaveAttribute('aria-atomic', 'true');
    expect(await live(page).evaluate((el) => !!el.closest('header'))).toBe(true);
  }
});

test('[F5] after a search the live region says the count and the query', async ({ page }) => {
  await page.goto('/?q=machine+learning');
  await expect(live(page)).toHaveText('20 courses match “machine learning”.');
  await page.locator('#q').fill('CS3244');
  await page.locator('#q').press('Enter');
  await expect(live(page)).toHaveText(/^\d+ courses shown: CS3244, then \d+ other matches\.$/);
});

test('[F5] one result: "1 course matches", on screen and in the live region', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ json: body() }));
  await page.goto('/?q=networks');
  await expect(live(page)).toHaveText('1 course matches “networks”.');
  await expect(page.locator('#status .count')).toHaveText('1 course matches “networks”');
});

test('[F5] no match: the live region says why, and the next step', async ({ page }) => {
  await page.goto('/?q=qwzx+vbnm');
  await expect(live(page)).toHaveText('Nothing in the catalogue matches “qwzx vbnm”. Try other words for the topic.');
  await page.goto('/?q=CS1001');
  await expect(live(page)).toHaveText("CS1001 (External Course) isn't offered this academic year. Related courses offered this year: DMX1401CT, DMA1401L01, DBA5102, DMR1201GEQA, FSC4206.");
  await page.route('**/search?**', (route) => route.fulfill({ json: { query: 'networks', filters: { level: 6 }, count: 0, results: [], interpreted: {}, hiddenPins: [], notOffered: [] } }));
  await page.goto('/?q=networks&level=6');
  await expect(live(page)).toHaveText('No courses match “networks”. Remove a filter above to see more courses, or try other words.');
});

test('[F5] hidden codes: the live region says how many typed codes aren\'t shown, and which', async ({ page }) => {
  await page.goto('/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1');
  await expect(live(page)).toHaveText(/^\d+ courses shown: CS2030, then \d+ other matches\. 3 of the 4 codes you typed aren't shown: CS3244, CS5562, AR5801\.$/);
  await page.goto('/?q=CS2030+CS1001');
  await expect(live(page)).toHaveText(/^\d+ courses shown: CS2030, then \d+ other matches\. 1 of the 2 codes you typed isn't shown: CS1001\.$/);
  await page.route('**/search?**', (route) => route.fulfill({ json: body({ query: 'CS3244', filters: { sem: 1, ng: true, study: 'ug2' }, count: 0, results: [], hiddenPins: ['CS3244'], notOffered: [] }) }));
  await page.goto('/?q=CS3244&ng=1&study=ug2&sem=1');
  await expect(live(page)).toHaveText("No results for “CS3244”. The code you typed isn't shown: CS3244.");
});

test('[F5] a partial code: the live region says the semester, then that a button shows the other', async ({ page }) => {
  await page.goto('/?q=CG32&ng=1&study=ug2&sem=1');
  await expect(live(page)).toHaveText('No CG32xx course is open to 2nd-year exchange students in Sem 1. The “See Sem 2 courses” button shows them.');
  await page.goto('/?q=AI52&ng=1&study=ug2&sem=1');
  await expect(live(page)).toHaveText('No AI52xx course is open to 2nd-year exchange students in either semester.');
});

test('[F5] errors and 429: the live region says the same sentence the page shows', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ status: 502, json: { error: 'upstream_failure', message: 'D1_ERROR' } }));
  await page.goto('/?q=x');
  await expect(live(page)).toHaveText('The search service could not reach its course data. Try again in a moment.');
  await page.unroute('**/search?**');
  await page.route('**/search?**', (route) => route.fulfill({ status: 429, headers: { 'retry-after': '30' }, json: { error: 'rate_limited' } }));
  await page.goto('/?q=y');
  await expect(live(page)).toHaveText('Too many searches from your connection. Try again in 30 seconds.');
  await expect(page.locator('#status')).toHaveText('Too many searches from your connection. Try again in 30 seconds.');
  await page.unroute('**/search?**');
  await page.route('**/search?**', (route) => route.abort('internetdisconnected'));
  await page.goto('/?q=z');
  await expect(live(page)).toHaveText('Could not reach the search service. Check your connection and try again.');
});

test('[F5] keyword-only, the phrase chips, and a missing year of study are said too', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ json: body({ degraded: { source: 'workers-ai', reason: 'timeout' } }) }));
  await page.goto('/?q=networks');
  await expect(live(page)).toHaveText('1 course matches “networks”. Search is in a simpler mode right now: it finds only courses that contain the words you typed. Try the course name or code, or search again later.');
  await page.unroute('**/search?**');
  await page.route('**/search?**', (route) => route.fulfill({ json: body({ query: 'history no final exam', interpreted: { exam: 0, hoursBelow: 10 } }) }));
  await page.goto('/?q=history+no+final+exam+under+10+hours');
  await expect(live(page)).toHaveText('1 course matches “history no final exam under 10 hours”. Read from your query: No final exam, Under 10 h a week.');
  await page.unroute('**/search?**');
  await page.goto('/?q=networks&ng=1&sem=1');
  await expect(live(page)).toHaveText('Choose your year of study to see the courses open to you as an exchange student.');
});

test('[F5] the first screen\'s questions left unanswered are said in the live region as focus moves to them', async ({ page }) => {
  await page.goto('/');
  await page.locator('#setupForm').getByRole('button', { name: 'Search' }).click();
  await expect(live(page)).toHaveText('Choose the semester you will study at NUS.');
  await expect(page.getByRole('radio', { name: /^Sem 1/ })).toBeFocused();
});

test('[F5] a detail that fails to load is said in the live region', async ({ page }) => {
  await page.route('**/module/CS3244', (route) => route.fulfill({ status: 502, json: { error: 'upstream_failure' } }));
  await page.goto('/?q=CS3244');
  await page.locator('#results button[data-code="CS3244"]').click();
  await expect(live(page)).toHaveText('The details of CS3244 could not be loaded. The search service could not reach its course data. Try again in a moment.');
});

test('[F5] the same sentence again is said again: the region clears, then repeats it', async ({ page }) => {
  await page.goto('/?q=CS2104&sem=1&ng=1&study=ug2');
  await settled(page);
  const said = await live(page).textContent();
  expect(said).toMatch(/^\d+ courses shown: CS2104, then \d+ other matches\.$/);
  // Record every text the region holds from here on.
  await live(page).evaluate((el) => {
    /** @type {any} */ (globalThis).liveLog = [];
    new MutationObserver(() => /** @type {any} */ (globalThis).liveLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  // Level 2000 keeps the same count and query; then Back to no level (from memory, no fetch).
  await page.locator('#level').selectOption('2');
  await expect.poll(() => query(page)).toBe('q=CS2104&sem=1&level=2&ng=1&study=ug2');
  await expect(live(page)).toHaveText(/** @type {string} */ (said));
  await page.locator('#level').selectOption('');
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (globalThis).liveLog.length)).toBe(4);
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).liveLog)).toEqual(['', said, '', said]);
});

test('[F5] the list is aria-busy while a search runs, and not after', async ({ page }) => {
  /** @type {import('@playwright/test').Route[]} */
  const held = [];
  await page.route('**/search?**', (route) => { held.push(route); });
  await page.goto('/?q=networks');
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'true');
  await expect(live(page)).toHaveText('');
  await held[0].fulfill({ json: body() });
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
  await expect(live(page)).toHaveText('1 course matches “networks”.');
  // An error ends the busy state too.
  await page.locator('#q').fill('other');
  await page.locator('#q').press('Enter');
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'true');
  await held[1].fulfill({ status: 500, json: { error: 'internal' } });
  await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
});

test('[F5] the Search button is never disabled: it keeps focus while a search runs, and a second press aborts the first', async ({ page }) => {
  /** @type {import('@playwright/test').Route[]} */
  const held = [];
  await page.goto('/?q=networks');
  await settled(page);
  await page.route('**/search?**', (route) => { held.push(route); });
  await page.locator('#q').fill('compilers');
  const go = page.locator('#go');
  await go.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#status')).toHaveText('Searching…');
  await expect(go).toBeEnabled();
  await expect(go).toBeFocused();
  expect(await go.evaluate((el) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')).toBe(false);
  // The second press: the first request is aborted, and only the second's answer shows.
  const aborted = page.waitForEvent('requestfailed', (r) => r.url().includes('q=compilers'));
  await page.keyboard.press('Enter');
  await aborted;
  expect(held).toHaveLength(2);
  await expect(go).toBeFocused();
  await held[1].fulfill({ json: body({ query: 'compilers', results: [{ code: 'CS4212', title: 'Compiler Design', credits: 4, semesters: [1] }] }) });
  await held[0].fulfill({ json: body({ query: 'compilers' }) }).catch(() => { /* already aborted */ });
  await expect(live(page)).toHaveText('1 course matches “compilers”.');
  await expect(page.locator('#results button.card-toggle')).toHaveAttribute('data-code', 'CS4212');
  await expect(go).toBeFocused();
});

/**
 * Every control on the page as its accessibility-tree line ("button
 * \"Search\""), with the ones that have no name.
 * @param {import('@playwright/test').Page} page
 */
async function controls(page) {
  const all = page.locator('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])');
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const nameless = [];
  for (const el of await all.all()) {
    // Not rendered (another view, the rail on a phone, a closed dialog): not in the accessibility tree.
    if (!(await el.isVisible())) continue;
    const first = (await el.ariaSnapshot()).split('\n')[0];
    lines.push(first);
    // A role then a quoted, non-empty name (YAML quotes the whole key when the name holds a quote or a colon):
    // `- button "Search"`, `- 'button "Remove filter: Sem 1"': Sem 1`. Playwright gives <summary> no role,
    // so its name is its text (`- text: As NUS states it`).
    const named = /^- '?[a-z]+ "\s*[^"\s]/.test(first) || (await el.evaluate((e) => e.tagName === 'SUMMARY' && !!e.textContent?.trim()));
    if (!named) nameless.push(`${first} (${await el.evaluate((e) => e.outerHTML.slice(0, 80))})`);
  }
  return { lines, nameless };
}

/** @type {[string, string, number, ((page: import('@playwright/test').Page) => Promise<void>)?][]} */
const NAMED = [
  ['first screen', '/', 1280],
  ['first screen', '/', 390],
  ['exchange results', '/?q=networks&ng=1&study=ug2&sem=1', 1280],
  ['exchange results', '/?q=networks&ng=1&study=ug2&sem=1', 390],
  ['detail open, exchange mode', '/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB', 1280],
  ['detail open, all years', '/?q=CS3244&open=CS3244', 390],
  ['hidden codes and filters', '/?q=CS2030+CS3244+CS1001&level=2&credits=4', 1280],
  ['partial code', '/?q=CG32&ng=1&study=ug2&sem=1', 390],
  ['filters dialog', '/?q=networks&ng=1&study=ug2&sem=1', 390, async (page) => {
    await page.getByRole('button', { name: 'Filters (3)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }],
];

for (const [name, path, width, then] of NAMED) {
  test(`[F5] every control has an accessible name: ${name} at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 664 : 800 });
    await page.goto(path);
    await settled(page);
    await then?.(page);
    const { lines, nameless } = await controls(page);
    expect(lines.length).toBeGreaterThan(5);
    expect(nameless).toEqual([]);
  });
}

test('[F5] the controls are named as a screen reader should say them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1&level=2');
  await settled(page);
  for (const [role, name] of /** @type {const} */ ([
    ['link', 'Skip to main content'], ['searchbox', 'Search courses'], ['button', 'Search'],
    ['checkbox', 'Only courses open to exchange students'], ['radio', 'Sem 1'], ['radio', 'Sem 2'], ['radio', 'Both'],
    ['combobox', 'Year of study at home'], ['combobox', 'Level'], ['combobox', 'Units'], ['combobox', 'Faculty'],
    ['button', 'Remove filter: Sem 1'], ['button', 'Remove filter: Exchange students'], ['button', 'Remove filter: Level 2000'],
    ['list', 'Filters applied'], ['list', 'Results'], ['search', 'Search courses'], ['main', 'Search and results'],
    ['complementary', 'Your exchange and filters'], ['banner', ''], ['contentinfo', ''],
  ])) {
    await expect(page.getByRole(role, name ? { name, exact: true } : {}).first(), `${role} "${name}"`).toBeAttached();
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Exchange Course Finder (unofficial, for NUS)');
  await expect(page.getByRole('main')).toHaveCount(1);
});

test('[F5] the live region stays in the accessibility tree while the filters dialog is open, and goes back to the header after', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/?q=networks&ng=1&study=ug2&sem=1');
  await settled(page);
  /** Chromium only: whether the accessibility tree ignores #live (a modal dialog makes the rest of the page inert). */
  const ignored = async () => {
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#live' });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    await cdp.detach();
    return nodes[0].ignored;
  };
  await page.getByRole('button', { name: 'Filters (3)' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await live(page).evaluate((el) => !!el.closest('dialog[open]'))).toBe(true);
  if (browserName === 'chromium') expect(await ignored()).toBe(false);
  await dialog.locator('#level').selectOption('2');
  await expect.poll(() => query(page)).toBe('q=networks&sem=1&level=2&ng=1&study=ug2');
  await expect(live(page)).toHaveText(/^\d+ courses match “networks”\.$/);
  await expect(dialog.getByRole('status')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // The region goes home in the dialog's close event, a task after the dialog hides: wait for it.
  await expect.poll(() => live(page).evaluate((el) => !!el.closest('header'))).toBe(true);
  if (browserName === 'chromium') expect(await ignored()).toBe(false);
  await expect(liveRegions(page)).toHaveCount(1);
});

test('[F5] each answer is said once: a failed other-semester check and a late /facets say nothing again', async ({ page }) => {
  await recordLive(page);
  // The partial code's other-semester check fails (429): the line doesn't change, so nothing more is said.
  await page.route('**/search?**sem=2**', (route) => route.fulfill({ status: 429, headers: { 'retry-after': '30' }, json: { error: 'rate_limited' } }));
  const checked = page.waitForResponse((r) => r.url().includes('sem=2'));
  await page.goto('/?q=CG32&ng=1&study=ug2&sem=1');
  await checked;
  await page.waitForTimeout(400); // past announce()'s 150 ms repeat
  expect(await liveLog(page)).toEqual(['No CG32xx course is open to 2nd-year exchange students in Sem 1.']);
});

test('[F5] a failed detail is said once, even when /facets answers after it and the detail is filled again', async ({ page }) => {
  await recordLive(page);
  await page.route('**/module/CS3244', (route) => route.fulfill({ status: 502, json: { error: 'upstream_failure' } }));
  /** @type {(() => void) | null} */
  let release = null;
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  await page.route('**/facets', async (route) => { await held; await route.continue(); });
  await page.goto('/?q=CS3244&open=CS3244');
  const said = 'The details of CS3244 could not be loaded. The search service could not reach its course data. Try again in a moment.';
  await expect(live(page)).toHaveText(said);
  const facets = page.waitForResponse((r) => new URL(r.url()).pathname === '/facets');
  /** @type {any} */ (release)();
  await facets;
  await expect(page.locator('#setupSources td').nth(1)).not.toHaveText('…');
  await page.waitForTimeout(400);
  expect((await liveLog(page)).filter((t) => t === said)).toHaveLength(1);
  await expect(live(page)).toHaveText(said);
});

test('[F5] pressing Search again on the answer already shown says it again', async ({ page }) => {
  await page.goto('/?q=networks');
  await settled(page);
  const said = /** @type {string} */ (await live(page).textContent());
  expect(said).toMatch(/^\d+ courses match “networks”\.$/);
  await live(page).evaluate((el) => {
    /** @type {any} */ (globalThis).liveLog = [];
    new MutationObserver(() => /** @type {any} */ (globalThis).liveLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#go').click();
  await expect.poll(() => liveLog(page)).toEqual(['', said]);
});
