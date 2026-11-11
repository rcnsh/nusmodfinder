#!/usr/bin/env node
// Security red team (5G): the response headers the page and the API are served
// with, and what their absence allows here. Local stack only.
//
//   node docs/evidence/phase5/redteam/security/headers.mjs http://127.0.0.1:N
//
// 1. Prints the security headers on the page, a script, and each API route.
// 2. From another origin (http://localhost:<same port>/__attacker, a different
//    site from 127.0.0.1, answered by Playwright's router so it never reaches the
//    server; a public made-up host would trip Chromium's Private Network Access
//    block on loopback, which the live site doesn't have): whether the page can be framed,
//    and whether the frame then takes a click on its controls (the year of
//    study, which the page saves to localStorage); and whether API JSON loaded
//    as a <script> or a stylesheet does anything.
import { chromium, webkit } from 'playwright';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) { console.error('usage: headers.mjs <local ui-server url>'); process.exit(2); }

const WANT = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'strict-transport-security', 'access-control-allow-origin', 'content-type'];
console.log('1. headers');
for (const p of ['/', '/app.js', '/search?q=accounting', '/module/CS2030', '/module/%3Cx%3E', '/facets', '/health', '/nope']) {
  const res = await fetch(base + p, { redirect: 'manual' });
  const got = WANT.map((h) => `${h}=${res.headers.get(h) ?? '-'}`).filter((s) => !s.endsWith('=-') || !s.startsWith('strict') );
  console.log(`   ${res.status} ${p}\n     ${got.join('\n     ')}`);
}

const ATTACKER = `${base.replace('127.0.0.1', 'localhost')}/__attacker`;
if (ATTACKER.startsWith(base)) { console.error('pass the 127.0.0.1 URL'); process.exit(2); }
const html = `<!doctype html><meta charset=utf-8><title>attacker</title>
<iframe id=f src="${base}/?q=accounting&ng=1&sem=1&study=ug1" width=1280 height=900 style="opacity:0.0001;position:absolute;top:0;left:0"></iframe>
<script>window.__ran = [];</script>
<script src="${base}/search?q=x" onerror="window.__ran.push('search:error')" onload="window.__ran.push('search:load')"></script>
<script src="${base}/module/%3Cx%3E" onerror="window.__ran.push('module400:error')" onload="window.__ran.push('module400:load')"></script>
<link rel=stylesheet href="${base}/search?q=x" onload="window.__ran.push('css:load')" onerror="window.__ran.push('css:error')">
<script>window.addEventListener('error', (e) => window.__ran.push('onerror:' + e.message));</script>`;

console.log(`2. from ${ATTACKER}`);
for (const engine of [chromium, webkit]) {
  // Chromium's Local Network Access check stops any page reaching loopback without a
  // permission prompt; the live site is not on loopback, so it is turned off here.
  const browser = await engine.launch(engine === chromium ? { args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'] } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u === ATTACKER) return route.fulfill({ contentType: 'text/html', body: html });
    if (u.startsWith(base)) return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)); });
  await page.goto(ATTACKER);
  const frame = page.frames().find((f) => f.url().startsWith(base));
  let framed = false;
  let clickChanged = 'n/a';
  if (frame) {
    await frame.waitForSelector('#results .card', { timeout: 15_000 }).then(() => { framed = true; }, () => {});
    if (framed) {
      // A click the user believes lands on the attacker's page, at the year-of-study select's spot.
      const before = await frame.evaluate(() => localStorage.getItem('vnm.study'));
      await frame.locator('#study').selectOption('grad');
      const after = await frame.evaluate(() => [localStorage.getItem('vnm.study'), location.search]);
      clickChanged = `vnm.study ${before} -> ${after[0]}; frame URL ${after[1]}`;
    }
  }
  const ran = await page.evaluate(() => /** @type {any} */ (window).__ran);
  console.log(`   ${engine.name()}: framed and rendered results: ${framed}; input through the frame: ${clickChanged}`);
  console.log(`   ${engine.name()}: JSON as <script>/<link>: ${JSON.stringify(ran)}`);
  if (consoleErrors.length) console.log(`   ${engine.name()}: console errors: ${JSON.stringify(consoleErrors)}`);
  await browser.close();
}
