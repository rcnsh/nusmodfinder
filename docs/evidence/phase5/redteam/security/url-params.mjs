#!/usr/bin/env node
// Security red team (5G): crafted page URLs against the local stack.
//
//   node docs/evidence/phase5/redteam/security/url-params.mjs http://127.0.0.1:N
//
// Loads the page with markup, script-URL, prototype-pollution, huge, repeated
// and malformed values in every parameter state.js reads, in Chromium and
// WebKit, opens a detail where the state allows, and checks after each load:
// no payload ran (window.__pwned, dialogs), no element or attribute came from
// the payload (img/script/iframe/object/embed, any on* attribute), every link
// is same-origin-relative or https with rel=noopener on target=_blank,
// Object.prototype is clean, and the URL the page settled on. Prints one line
// per case and exits 1 on any failure.
import { chromium, webkit } from 'playwright';

const base = process.argv[2];
if (!base) { console.error('usage: url-params.mjs <local ui-server url>'); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(base)) { console.error('local ui-server URLs only'); process.exit(2); }

const P = '"><img src=x onerror="window.__pwned=1"><svg onload="window.__pwned=1">';
const J = 'javascript:window.__pwned=1';
const enc = encodeURIComponent;

/** [name, query string] */
const CASES = [
  ['q markup', `q=${enc(P)}`],
  ['q markup, exchange', `q=${enc(P)}&ng=1&study=ug1&sem=1`],
  ['q javascript:', `q=${enc(J)}`],
  ['faculty markup', `q=accounting&faculty=${enc(P)}`],
  ['faculty javascript:', `q=accounting&faculty=${enc(J)}`],
  ['study/sem/level/credits markup', `q=accounting&ng=1&study=${enc(P)}&sem=${enc(P)}&level=${enc(P)}&credits=${enc(P)}`],
  ['open/from markup', `q=CS2030&open=${enc(P)}&from=${enc(P)}`],
  ['open valid, from markup', `q=CS2030&open=CS2030&from=${enc(P)}`],
  ['ignore markup', `q=accounting&ignore=${enc(P)},exam,__proto__`],
  ['pick/alt markup', `q=accounting&pick=${enc(P)}&alt=${enc(J)}&pick=${enc(P)}`],
  ['proto: __proto__[x]', 'q=accounting&__proto__[polluted]=1&__proto__.polluted=1'],
  ['proto: constructor[prototype]', 'q=accounting&constructor[prototype][polluted]=1&constructor.prototype.polluted=1'],
  ['proto: values', 'q=__proto__&faculty=__proto__&study=__proto__&ng=1&sem=constructor&open=__PROTO__&ignore=__proto__,constructor'],
  ['repeated params', 'q=accounting&q=biology&sem=1&sem=2&ng=0&ng=1&study=ug1&study=grad&open=CS1010&open=CS2030'],
  ['malformed %', 'q=%E0%A4%A&faculty=%ZZ&open=%&ng=%FF'],
  ['NUL and controls', `q=${enc('acc\u0000ount\u0008ing‮')}&faculty=${enc('\u0000‮A')}`],
  ['huge q (5000)', `q=${'a'.repeat(5000)}`],
  ['huge faculty (6000)', `q=accounting&faculty=${'F'.repeat(6000)}`],
  ['many pick (2000)', `q=accounting&${Array.from({ length: 2000 }, (_, i) => `pick=${i}`).join('&')}`],
  ['hash markup', `q=accounting#${enc(P)}`],
  ['hash javascript:', `q=accounting#${J}`],
];

/** @param {import('playwright').Page} page */
async function inspect(page) {
  return page.evaluate(() => {
    const bad = [];
    if (/** @type {any} */ (window).__pwned) bad.push('payload ran');
    for (const tag of ['img', 'script:not([src])', 'iframe', 'object', 'embed', 'foreignObject']) {
      const n = document.querySelectorAll(`body ${tag}`).length;
      if (n) bad.push(`${n} <${tag}>`);
    }
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) bad.push(`${el.tagName} ${a.name}`);
        if (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*(javascript|data|vbscript):/i.test(a.value)) bad.push(`${el.tagName} ${a.name}=${a.value.slice(0, 40)}`);
      }
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') ?? '';
      const ok = href.startsWith('/?') || href === '/' || href.startsWith('#') || /^https:\/\//.test(href);
      if (!ok) bad.push(`link ${href.slice(0, 60)}`);
      if (href.startsWith('//')) bad.push(`protocol-relative link ${href.slice(0, 60)}`);
      if (a.getAttribute('target') === '_blank' && !/\bnoopener\b/.test(a.getAttribute('rel') ?? '')) bad.push(`_blank without noopener ${href}`);
    }
    if (/** @type {any} */ ({}).polluted !== undefined || Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')) bad.push('Object.prototype polluted');
    return {
      bad,
      url: location.pathname + location.search.slice(0, 160) + (location.search.length > 160 ? `…(${location.search.length})` : ''),
      status: (document.getElementById('status')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
      chips: [...document.querySelectorAll('#chips li')].map((l) => (l.textContent ?? '').slice(0, 50)),
      cards: document.querySelectorAll('#results .card').length,
      detail: !!document.querySelector('.detail:not([hidden]) .dhead'),
    };
  });
}

let failed = 0;
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.dismiss(); });
  // Nothing may leave the machine: every request to another origin is refused and counted.
  let offsite = 0;
  await page.route('**/*', (route) => (route.request().url().startsWith(base.replace(/\/$/, '')) ? route.continue() : (offsite++, route.abort())));
  for (const [name, qs] of CASES) {
    await page.goto(`${base.replace(/\/$/, '')}/?${qs}`);
    await page.waitForFunction(() => document.getElementById('results')?.getAttribute('aria-busy') === 'false' && !/Searching/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 15_000 }).catch(() => {});
    // Open the first card's detail too, so the detail's links and text are checked.
    const toggle = page.locator('#results .card-toggle').first();
    if (await toggle.count()) {
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await page.locator('.detail:not([hidden]) .dhead').waitFor({ timeout: 10_000 }).catch(() => {});
    }
    const r = await inspect(page);
    if (dialogs) r.bad.push(`${dialogs} dialog(s)`);
    if (r.bad.length) failed++;
    console.log(`${engine.name()} | ${r.bad.length ? 'FAIL' : 'ok  '} | ${name} | settled ${r.url} | cards ${r.cards}${r.detail ? ' +detail' : ''} | chips ${JSON.stringify(r.chips)} | ${r.bad.join('; ') || r.status}`);
  }
  console.log(`${engine.name()} | off-origin requests refused: ${offsite}`);
  await browser.close();
}
console.log(failed ? `${failed} case(s) failed` : 'all cases clean');
process.exit(failed ? 1 : 0);
