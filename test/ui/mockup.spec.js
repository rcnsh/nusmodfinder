// @ts-check
// What design D's mockup (docs/design/phase5-direction-d.html) has that 5D left
// out as new behaviour, built in 5G: a stamp on each typed code not shown and
// a "Switch to Sem 2" action where the other semester is open; "Also as" codes
// as links to their own entry, which then says where it was opened from; the
// detail's head repeating the code and title; and, for a query of course codes
// only, which of them the count shows.
import { expect, test } from '@playwright/test';
import { live, query } from './support.mjs';

/** @param {import('@playwright/test').Page} page @param {string} code */
const toggle = (page, code) => page.locator(`#results button.card-toggle[data-code="${code}"]`);
/** @param {import('@playwright/test').Page} page @param {string} code */
const card = (page, code) => page.locator('#results > li.card').filter({ has: page.locator(`button.card-toggle[data-code="${code}"]`) });
/** @param {import('@playwright/test').Page} page @param {string} code */
async function region(page, code) {
  return page.locator(`#${await toggle(page, code).getAttribute('aria-controls')}`);
}
/** @param {import('@playwright/test').Page} page @param {string} code */
const hidden = (page, code) => page.locator(`#status .hidden-codes li[data-code="${code}"]`);

test.describe('the hidden-codes box: a stamp per code and "Switch to Sem 2"', () => {
  test('each typed code not shown carries a stamp saying why, in a word', async ({ page }) => {
    await page.goto('/?q=CS2030+CS3244+CS5562+AR5801+CS1001&ng=1&study=ug2&sem=1');
    await expect(page.locator('#status .hidden-codes .hc-stamp')).toHaveText(['Not in Sem 1', 'Not offered', 'Not open in Sem 1', 'Not this year']);
    // Each stamp is the "not shown" shape and colour, beside the code and its title.
    await expect(hidden(page, 'CS3244').locator('.hc-stamp .st')).toHaveClass(/st-closed/);
    await expect(hidden(page, 'CS3244').locator('.hc-stamp svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(hidden(page, 'CS3244').locator('.hc-head')).toHaveText('CS3244 Machine Learning');
  });

  test('"Switch to Sem 2" only where the other semester is open; it switches and focuses the course', async ({ page }) => {
    await page.goto('/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1');
    const sw = page.locator('#status .switch-sem');
    await expect(sw).toHaveCount(1);
    await expect(hidden(page, 'CS3244').getByRole('button')).toHaveText('Switch to Sem 2 to see CS3244');
    await sw.click();
    await expect.poll(() => query(page)).toBe('q=CS2030+CS3244+CS5562+AR5801&sem=2&ng=1&study=ug2');
    await expect(page.locator('#sem')).toHaveValue('2');
    await expect(toggle(page, 'CS3244')).toBeFocused();
    await expect(hidden(page, 'CS3244')).toHaveCount(0);
  });

  test('no switch with both semesters chosen, for a code closed in both, or one another filter hides', async ({ page }) => {
    await page.goto('/?q=CS2030+PP5164&ng=1&study=ug2');
    await expect(hidden(page, 'PP5164').locator('.hc-stamp')).toHaveText('Not open in either semester');
    await expect(page.locator('#status .switch-sem')).toHaveCount(0);
    // CS3244 is open in Sem 2, but the level filter would still hide it there.
    await page.goto('/?q=CS2030+CS3244&level=2&ng=1&study=ug2&sem=1');
    await expect(hidden(page, 'CS3244').locator('.why')).not.toHaveText(/shown with these settings\.$/);
    await expect(page.locator('#status .switch-sem')).toHaveCount(0);
    await page.goto('/?q=CS2030+CS3244&level=3');
    await expect(hidden(page, 'CS2030').locator('.hc-stamp')).toHaveText('Outside your filters');
    await expect(page.locator('#status .switch-sem')).toHaveCount(0);
  });
});

test.describe('"Also as" codes are links to their own entry', () => {
  const LIST = 'q=introductory+accounting&sem=1&ng=1&study=ug2';

  test('a link per code; following one opens that code\'s entry, says where it came from, and Back returns', async ({ page }) => {
    await page.goto(`/?${LIST}`);
    const links = card(page, 'ACC1701XA').locator('.variants a');
    await expect(card(page, 'ACC1701XA').locator('.variants')).toHaveText('Also as ACC1701XB, ACC1701XC');
    await expect(links).toHaveText(['ACC1701XB', 'ACC1701XC']);
    await expect(links.first()).toHaveAttribute('href', '/?q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
    await links.first().click();
    await expect.poll(() => query(page)).toBe('q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
    await expect(page.locator('#q')).toHaveValue('ACC1701XB');
    const d = await region(page, 'ACC1701XB');
    await expect(d.locator('.kicker')).toHaveText('Opened from ACC1701XA: another code for the same course');
    await expect(toggle(page, 'ACC1701XB')).toBeFocused();
    await expect(toggle(page, 'ACC1701XB')).toHaveAttribute('aria-expanded', 'true');
    await page.goBack();
    await expect.poll(() => query(page)).toBe(LIST);
    await expect(toggle(page, 'ACC1701XA')).toBeVisible();
  });

  test('by keyboard: Enter on the link does the same', async ({ page }) => {
    await page.goto(`/?${LIST}`);
    await card(page, 'ACC1701XA').locator('.variants a').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => query(page)).toBe('q=ACC1701XC&sem=1&ng=1&study=ug2&open=ACC1701XC&from=ACC1701XA');
    await expect(toggle(page, 'ACC1701XC')).toBeFocused();
  });

  test('a slow answer doesn\'t take focus from where the student moved on to', async ({ page }) => {
    await page.goto(`/?${LIST}`);
    // The variant's search answers late; meanwhile the student changes a filter.
    await page.route('**/search?q=ACC1701XB**', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });
    await card(page, 'ACC1701XA').locator('.variants a').first().click();
    await page.locator('#level').focus();
    await page.locator('#level').selectOption('1');
    await expect.poll(() => query(page)).toBe('q=ACC1701XB&sem=1&level=1&ng=1&study=ug2');
    await expect(page.locator('#status .count')).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(page.locator('#level')).toBeFocused();
  });

  test('"Opened from" belongs to that detail: closing it, or opening another, drops it', async ({ page }) => {
    await page.goto('/?q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
    const d = await region(page, 'ACC1701XB');
    await expect(d.locator('.kicker')).toHaveText('Opened from ACC1701XA: another code for the same course');
    await d.getByRole('button', { name: 'Close details' }).click();
    await expect.poll(() => query(page)).toBe('q=ACC1701XB&sem=1&ng=1&study=ug2');
    await toggle(page, 'ACC1701XB').click();
    await expect.poll(() => query(page)).toBe('q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB');
    await expect(d.locator('.kicker')).toHaveText('Course details');
  });

  test('[S1] a from= that is not one of the open course\'s other codes says nothing, and the URL drops it', async ({ page }) => {
    // The red team's link: PP5288 has no other codes; CS1010 is an unrelated course.
    await page.goto('/?q=PP5288&open=PP5288&from=CS1010');
    const d = await region(page, 'PP5288');
    await expect(d.locator('.kicker')).toHaveText('Course details');
    await expect(d).not.toContainText('Opened from');
    await expect.poll(() => query(page)).toBe('q=PP5288&open=PP5288');
    // A real course shown on the same page, but not in the open course's group, is refused too.
    await page.goto('/?q=ACC1701XB+CS3244&sem=1&ng=1&study=ug2&open=ACC1701XB&from=CS3244');
    const x = await region(page, 'ACC1701XB');
    await expect(x.locator('.kicker')).toHaveText('Course details');
    await expect.poll(() => query(page)).toBe('q=ACC1701XB+CS3244&sem=1&ng=1&study=ug2&open=ACC1701XB');
    // Back to the real "Also as" link: it still says where it came from.
    await page.goto('/?q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
    await expect((await region(page, 'ACC1701XB')).locator('.kicker')).toHaveText('Opened from ACC1701XA: another code for the same course');
    await expect.poll(() => query(page)).toBe('q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
  });

  test('a variant link keeps the page in place: the href is a real URL, so a new tab opens the same', async ({ page }) => {
    await page.goto(`/?${LIST}`);
    const href = await card(page, 'ACC1701XA').locator('.variants a').first().getAttribute('href');
    await page.goto(String(href));
    await expect((await region(page, 'ACC1701XB')).locator('.kicker')).toHaveText('Opened from ACC1701XA: another code for the same course');
  });
});

test('the detail\'s head repeats the code and title, with units and department', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244');
  const d = await region(page, 'CS3244');
  // The code is part of the heading's name, so a screen reader hears both.
  await expect(d.getByRole('heading', { level: 3 })).toHaveText('CS3244 Machine Learning');
  await expect(d.locator('.dtitle .dcode')).toHaveText('CS3244');
  await expect(d.locator('.dmeta')).toHaveText('4 units · Computer Science, Computing');
  // The sections sit under it.
  await expect(d.getByRole('heading', { level: 4, name: 'Description' })).toBeVisible();
  await expect(d.locator('.kicker')).toHaveText('Course details');
});

test.describe('the count line for a query of course codes only', () => {
  test('"n courses shown:" the typed codes shown, then the other matches; said in the live region too', async ({ page }) => {
    await page.goto('/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1');
    await expect(page.locator('#status .count')).toBeVisible();
    const count = await page.locator('#results > li.card').count();
    expect(count).toBeGreaterThan(1);
    await expect(page.locator('#status .count')).toHaveText(`${count} courses shown: CS2030, then ${count - 1} other matches`);
    await expect(page.locator('#status .count strong')).toHaveText(`${count} courses`);
    await expect(live(page)).toHaveText(`${count} courses shown: CS2030, then ${count - 1} other matches. 3 of the 4 codes you typed aren't shown: CS3244, CS5562, AR5801.`);
  });

  test('a typed code shown as another entry\'s "Also as" is named; words in the query keep "match"', async ({ page }) => {
    await page.goto('/?q=ACC1701XA+ACC1701XB');
    await expect(page.locator('#status .count')).toHaveText(/^\d+ courses shown: ACC1701XA, ACC1701XB, then \d+ other matches$/);
    await page.goto('/?q=CS3244+machine+learning');
    await expect(page.locator('#status .count')).toHaveText(/^\d+ courses match “CS3244 machine learning”$/);
  });
});
