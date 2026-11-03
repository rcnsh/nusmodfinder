import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';

const BASE = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const out = {};
const reqs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
await ctx.route('**/favicon.ico', (r) => r.abort());
const page = await ctx.newPage();
page.on('request', (r) => { if (r.url().startsWith(BASE)) reqs.push({ t: Date.now(), url: r.url().slice(BASE.length) }); });
page.on('response', (r) => { if (r.url().includes('/search')) out.searchResponses = [...(out.searchResponses ?? []), { url: r.url().slice(BASE.length), status: r.status(), cache: r.headers()['cf-cache-status'] ?? null }]; });

const waitResults = () => page.waitForFunction(() => /result/.test(document.getElementById('status').textContent) && !document.querySelector('#results .skeleton'), null, { timeout: 30000 });

await page.goto(`${BASE}/?q=machine+learning`);
await waitResults();
out.statusText = await page.textContent('#status');

const shot = (n) => page.screenshot({ path: `/tmp/vnm-repro/shots/${n}.png` });
await shot('1280x800-light');
await page.screenshot({ path: '/tmp/vnm-repro/shots/1280x800-light-full.png', fullPage: true });
const axeLight = await new AxeBuilder({ page }).analyze();
fs.writeFileSync('/tmp/vnm-repro/axe-1280-light.json', JSON.stringify(axeLight.violations, null, 2));

await page.emulateMedia({ colorScheme: 'dark' });
await shot('1280x800-dark');
const axeDark = await new AxeBuilder({ page }).analyze();
fs.writeFileSync('/tmp/vnm-repro/axe-1280-dark.json', JSON.stringify(axeDark.violations, null, 2));

await page.setViewportSize({ width: 390, height: 844 });
await shot('390x844-dark');
await page.emulateMedia({ colorScheme: 'light' });
await shot('390x844-light');

out.mobile = await page.evaluate(() => {
  const li = document.querySelector('#results li');
  const r = li.getBoundingClientRect();
  return {
    firstResultTopY: Math.round(r.top + scrollY),
    firstResultVisibleAboveFold: r.top < innerHeight,
    inputFontSize: getComputedStyle(document.getElementById('q')).fontSize,
    docScrollWidth: document.documentElement.scrollWidth,
  };
});

out.dom = await page.evaluate(() => {
  const s = document.getElementById('status');
  const lis = [...document.querySelectorAll('#results li')];
  return {
    statusAriaLive: s.getAttribute('aria-live'), statusRole: s.getAttribute('role'),
    resultsAriaLive: document.getElementById('results').getAttribute('aria-live'),
    mainCount: document.querySelectorAll('main, [role=main]').length,
    roleSearchCount: document.querySelectorAll('[role=search], search').length,
    headingCount: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    resultCount: lis.length,
    resultsWithTabIndex: lis.filter((l) => l.tabIndex >= 0 || l.hasAttribute('tabindex')).length,
    linksInResults: document.querySelectorAll('#results a').length,
    focusableInResults: document.querySelectorAll('#results a, #results button, #results [tabindex]').length,
    selectsWithLabel: [...document.querySelectorAll('select')].map((x) => ({ id: x.id, label: x.labels?.[0]?.textContent.trim().split('\n')[0] })),
  };
});

// Click Search with the existing query: same URL as the initial load (search #2).
await sleep(2100);
await page.click('#go');
out.focusDuringSearch = await page.evaluate(() => ({ active: document.activeElement?.id || document.activeElement?.tagName, goDisabled: document.getElementById('go').disabled }));
await waitResults();
out.focusAfterSearch = await page.evaluate(() => ({ active: document.activeElement?.id || document.activeElement?.tagName, goDisabled: document.getElementById('go').disabled }));
out.historyAfterSearch1and2 = await page.evaluate(() => ({ length: history.length, url: location.href }));

// A second, different search via the input (search #3).
await sleep(2100);
await page.fill('#q', 'data structures');
await page.press('#q', 'Enter');
await waitResults();
out.historyAfterSearch3 = await page.evaluate(() => ({ length: history.length, url: location.href }));
await page.goBack().catch((e) => { out.goBackError = e.message; });
await sleep(500);
out.afterBack = { url: page.url() };

out.requests = reqs;
fs.writeFileSync('/tmp/vnm-repro/fe-results.json', JSON.stringify(out, null, 2));

const contrast = (v) => (v.find((x) => x.id === 'color-contrast')?.nodes ?? []).map((n) => ({ target: n.target.join(' '), ratio: n.any[0]?.data?.contrastRatio, fg: n.any[0]?.data?.fgColor, bg: n.any[0]?.data?.bgColor, expected: n.any[0]?.data?.expectedContrastRatio }));
const summary = (v) => v.map((x) => `${x.id} (${x.impact}) x${x.nodes.length}`);
console.log(JSON.stringify({ ...out, axeLight: summary(axeLight.violations), axeDark: summary(axeDark.violations), contrastLight: contrast(axeLight.violations), contrastDark: contrast(axeDark.violations) }, null, 2));
await browser.close();
