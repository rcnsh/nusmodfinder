#!/usr/bin/env node
// @ts-check
// Phase 6 6-0: the mockup's rendered checks (docs/plans/phase6.md §2), offline
// in Playwright's Chromium (and WebKit for the screenshots' sake when asked):
// - axe (WCAG 2.x A and AA tags, every rule, colour contrast included) over
//   each state at 1280×800 and 390×664 in both themes;
// - the 390×664 fold: state 1 with ACC1701XB first, both its stamps, its
//   toggle, and the shortlist button showing the longest label, all in view;
// - a full-page PNG of every state, width and theme;
// - the print page as a tagged and an untagged PDF (page.pdf), with whether
//   each holds a structure tree (StructTreeRoot) and selectable text.
// No network: every request outside the mockup's folder is refused.
//
//   node docs/design/phase6-shortlist/check.mjs [--out docs/evidence/phase6/mockup]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DIR = fileURLToPath(new URL('./a/', import.meta.url));
const at = process.argv.indexOf('--out');
const OUT = `${ROOT}${at > 0 ? process.argv[at + 1] : 'docs/evidence/phase6/mockup'}`;
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(`${ROOT}node_modules/axe-core/axe.min.js`, 'utf8');
const URL0 = pathToFileURL(`${DIR}index.html`).href;
const STATES = ['results', 'view', 'fullyear', 'print'];
const SIZES = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 664 } };
const LONGEST = 'Sem 1: 22.5 · Sem 2: 21.5 units picked';

const browser = await chromium.launch();
const report = { axe: [], fold: [], pdf: {} };

/** @param {import('playwright-core').BrowserContext} ctx */
async function offline(ctx) {
  await ctx.route('**/*', (r) => (r.request().url().startsWith('file://') ? r.continue() : r.abort()));
}

for (const state of STATES) {
  for (const [w, viewport] of Object.entries(SIZES)) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport, colorScheme: /** @type {'light'|'dark'} */ (theme), deviceScaleFactor: 1 });
      await offline(ctx);
      const page = await ctx.newPage();
      await page.goto(`${URL0}#solo-${state}-${w}-${theme}`);
      await page.evaluate(() => document.fonts.ready);
      await page.addScriptTag({ content: AXE });
      const axe = await page.evaluate(async () => {
        // @ts-ignore axe is injected above
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
        return { violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + n.failureSummary) })), incomplete: r.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })) };
      });
      report.axe.push({ state, w, theme, ...axe });
      await page.screenshot({ path: `${OUT}/${state}-${w}-${theme}.png`, fullPage: true });

      if (state === 'results' && w === 'phone') {
        // The fold (§2): the longest shortlist button label, then everything in view at scroll 0.
        await page.evaluate((label) => { for (const s of document.querySelectorAll('.sl-open-n')) s.textContent = label; }, LONGEST);
        const fold = await page.evaluate(() => {
          const H = innerHeight;
          const box = (/** @type {Element | null} */ el) => (el ? el.getBoundingClientRect() : null);
          const first = document.querySelector('.entries > li');
          const visible = (/** @type {Element} */ el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const shown = [...document.querySelectorAll('.sl-open')].find(visible) ?? null;
          const parts = {
            unofficial: box(document.querySelector('.unofficial')), search: box(document.querySelector('#q')), go: box(document.querySelector('#go')),
            shortlistButton: box(shown), code: box(first?.querySelector('.code') ?? null), title: box(first?.querySelector('.title') ?? null),
            toggle: box(first?.querySelector('.sl-toggle') ?? null),
            stamp1: box(first?.querySelectorAll('.exchange-status')[0] ?? null), stamp2: box(first?.querySelectorAll('.exchange-status')[1] ?? null),
          };
          const out = Object.fromEntries(Object.entries(parts).map(([k, r]) => [k, r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.top >= 0 && r.bottom <= H && r.left >= 0 && r.right <= innerWidth } : null]));
          return { scrollY, height: H, firstCode: first?.querySelector('.code')?.textContent, label: shown?.textContent?.trim(), stamps: first?.querySelectorAll('.exchange-status').length, parts: out, docWidth: document.documentElement.scrollWidth };
        });
        report.fold.push({ theme, ...fold });
        await page.screenshot({ path: `${OUT}/fold-results-phone-${theme}.png` });
      }
      await ctx.close();
    }
  }
}

// The print page as Chromium saves it (page.pdf prints under print media).
const ctx = await browser.newContext({ colorScheme: 'dark' });
await offline(ctx);
const page = await ctx.newPage();
await page.goto(`${URL0}#solo-print-desktop-dark`);
await page.evaluate(() => document.fonts.ready);
for (const tagged of [true, false]) {
  const file = `${OUT}/print-${tagged ? 'tagged' : 'untagged'}.pdf`;
  await page.pdf({ path: file, format: 'A4', margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }, tagged, printBackground: true });
  const bytes = readFileSync(file);
  // StructTreeRoot may sit in a compressed object stream: inflate every stream and look there too.
  const raw = bytes.toString('latin1');
  let inStreams = false;
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf('endstream', start);
    try { if (inflateSync(bytes.subarray(start, end)).toString('latin1').includes('StructTreeRoot')) { inStreams = true; break; } } catch { /* not deflate */ }
  }
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
  const pages = Number((execFileSync('pdfinfo', [file]).toString().match(/Pages:\s+(\d+)/) ?? [])[1]);
  report.pdf[tagged ? 'tagged' : 'untagged'] = {
    file: file.replace(ROOT, ''), pages, bytes: bytes.length,
    structTreeRoot: raw.includes('StructTreeRoot') || inStreams, markInfo: /\/Marked\s+true/.test(raw) || raw.includes('MarkInfo'),
    textChars: text.replace(/\s+/g, '').length,
    startsWith: text.trim().split('\n')[0].trim(),
    hasDescription: text.replace(/\s+/g, ' ').includes('The course provides an introduction to accounting from a user perspective'),
    hasLink: text.replace(/\s+/g, '').includes('nusmodfinder.rcn.sh/?pick=CS2113.1'),
    hasPageBreakBeforeForm: null,
  };
  if (tagged) {
    // Which page the form order starts on, and that the head is page one.
    const perPage = text.split('\f');
    report.pdf.tagged.formOrderPage = perPage.findIndex((p) => p.includes('NUS’s application form order')) + 1;
    report.pdf.tagged.firstPageHead = perPage[0].includes('Courses planned for Sem 1');
    writeFileSync(`${OUT}/print-tagged.txt`, text);
  }
}
await ctx.close();
await browser.close();

writeFileSync(`${OUT}/check.json`, `${JSON.stringify(report, null, 1)}\n`);
let bad = 0;
for (const a of report.axe) {
  const n = a.violations.length;
  bad += n;
  console.log(`axe ${a.state.padEnd(8)} ${a.w.padEnd(7)} ${a.theme.padEnd(5)} ${n ? `FAIL ${a.violations.map((v) => `${v.id}×${v.nodes}`).join(', ')}` : 'pass'}${a.incomplete.length ? `  (needs review: ${a.incomplete.map((v) => `${v.id}×${v.nodes}`).join(', ')})` : ''}`);
}
for (const f of report.fold) {
  const out = Object.entries(f.parts).filter(([, p]) => !p || !p.inView).map(([k]) => k);
  if (out.length || f.scrollY !== 0 || f.firstCode !== 'ACC1701XB' || f.stamps !== 2) bad++;
  console.log(`fold ${f.theme}: first ${f.firstCode}, ${f.stamps} stamps, label "${f.label}", lowest ${Math.max(...Object.values(f.parts).map((p) => p?.bottom ?? 9999))} px of ${f.height}; ${out.length ? `OUT OF VIEW: ${out.join(', ')}` : 'all in view'}; page width ${f.docWidth}`);
}
for (const [k, p] of Object.entries(report.pdf)) console.log(`pdf ${k}: ${p.pages} pages, StructTreeRoot ${p.structTreeRoot}, text ${p.textChars} chars (selectable), description ${p.hasDescription}, link ${p.hasLink}${p.formOrderPage ? `, form order on page ${p.formOrderPage}, head on page 1 ${p.firstPageHead}` : ''}`);
process.exit(bad ? 1 : 0);
