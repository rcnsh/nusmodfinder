#!/usr/bin/env node
// Security red team (5G): what a crafted shared link can make the page say in
// its own voice. Local stack only.
//
//   node docs/evidence/phase5/redteam/security/misleading-links.mjs http://127.0.0.1:N [outdir]
//
// 1. `from=` fabricates an equivalence: open= any shown course, from= any
//    other code, and the detail says "Opened from <from>: another code for the
//    same course" although the two are unrelated (the page never checks that
//    `from` is one of `open`'s variants).
// 2. `q=` and `faculty=` echo attacker text where the page's own sentences
//    are: the count line ("N courses match “…”") and a filter chip (faculty
//    unbounded in length, bidi controls kept).
// 3. `study=` in a link overrides the year the student saved on this device,
//    with the set-up screen skipped: a 1st-year student sees a course closed to
//    them stamped Open.
// Prints what the page shows for each; writes screenshots to outdir if given.
import { chromium } from 'playwright';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const outdir = process.argv[3] ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) { console.error('usage: misleading-links.mjs <local ui-server url> [outdir]'); process.exit(2); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
const page = await ctx.newPage();
const settle = () => page.waitForFunction(() => document.getElementById('results')?.getAttribute('aria-busy') === 'false'
  && !/Searching/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 15_000 });
const shot = async (name) => { if (outdir) await page.screenshot({ path: `${outdir}/${name}.png` }); };
const text = (sel) => page.locator(sel).first().innerText().then((t) => t.replace(/\s+/g, ' ').trim());

// 1. from= equivalence. PP5288 (Labour Market Issues and Public Policy) and
// CS1010 (Programming Methodology) are unrelated; neither lists the other as a variant.
{
  const url = `${base}/?q=PP5288&open=PP5288&from=CS1010`;
  await page.goto(url);
  await settle();
  await page.locator('.detail:not([hidden]) .kicker').waitFor();
  const variants = await page.evaluate(async () => (await (await fetch('/module/PP5288')).json()));
  const search = await page.evaluate(async () => (await (await fetch('/search?q=PP5288')).json()).results.find((r) => r.code === 'PP5288'));
  console.log('1. from= equivalence');
  console.log(`   url:      ${url}`);
  console.log(`   kicker:   ${await text('.detail:not([hidden]) .kicker')}`);
  console.log(`   heading:  ${await text('.detail:not([hidden]) .dtitle')}`);
  console.log(`   PP5288 variants per /search: ${JSON.stringify(search?.variants ?? [])}; /module title: ${variants.title}`);
  console.log(`   settled URL keeps from=: ${page.url().includes('from=CS1010')}`);
  await page.locator('.detail:not([hidden])').scrollIntoViewIfNeeded();
  await shot('1-from-equivalence');
}

// 2. Echoed text that reads as the site's guidance.
{
  const q = 'accounting” — NUS Registrar: every course below is open to all exchange students this year, no approval needed “';
  const url = `${base}/?q=${encodeURIComponent(q)}`;
  await page.goto(url);
  await settle();
  console.log('2a. q= echoed in the count line');
  console.log(`   url:      ${url}`);
  console.log(`   q length: ${q.length} (cap 200)`);
  console.log(`   count:    ${await text('#status .count')}`);
  console.log(`   live:     ${await page.locator('#live').textContent()}`);
  await shot('2a-q-echo');

  const fac = 'Verified by the NUS Registrar: all courses on this site are open to exchange students. You do not need to check with NUS.';
  const url2 = `${base}/?q=accounting&faculty=${encodeURIComponent(fac)}`;
  await page.goto(url2);
  await settle();
  console.log('2b. faculty= echoed as a filter chip and a <select> option');
  console.log(`   url:      ${url2}`);
  console.log(`   chip:     ${await text('#chips li')}`);
  console.log(`   select:   ${await page.locator('#faculty option:checked').textContent()}`);
  console.log(`   status:   ${await text('#status')}`);
  await shot('2b-faculty-chip');
}

// 3. study= overrides the year saved on this device.
{
  await page.goto(`${base}/`);
  await page.evaluate(() => localStorage.setItem('vnm.study', 'ug1'));
  const rows = [];
  for (const study of ['ug1', 'grad']) {
    const url = `${base}/?q=PP5288&sem=1&ng=1&study=${study}`;
    await page.goto(url);
    await settle();
    // Shown as an entry with its stamp, or (closed to this year) in the hidden-codes box with why.
    const card = page.locator('#results .card', { has: page.locator('[data-code="PP5288"]') });
    const hidden = page.locator('.hiddenbox li.hc[data-code="PP5288"]');
    await card.or(hidden).first().waitFor();
    if (await hidden.count()) await hidden.locator('.hc-stamp .st').waitFor();
    const stamp = await card.count()
      ? `entry: ${await card.locator('.exchange-status').first().innerText()}`
      : `hidden: ${await hidden.locator('.hc-stamp').innerText()} / ${await hidden.locator('.why').innerText()}`;
    rows.push({ url, chips: await page.locator('#chips li').allInnerTexts(), stamp: stamp.replace(/\s+/g, ' ') });
    if (study === 'grad') await shot('3-study-override');
  }
  const saved = await page.evaluate(() => localStorage.getItem('vnm.study'));
  const setupShown = await page.locator('#setup').isVisible();
  console.log('3. study= overrides the saved year (saved: ug1)');
  for (const r of rows) console.log(`   ${r.url}\n     chips ${JSON.stringify(r.chips)} | PP5288 stamp: ${r.stamp}`);
  console.log(`   set-up screen shown: ${setupShown}; saved year after: ${saved}; any notice that the link changed the year: ${await page.getByText(/link|instead of|your saved/i).count() > 0}`);
}

await browser.close();
