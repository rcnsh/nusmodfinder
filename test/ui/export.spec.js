// @ts-check
// The exports (Phase 6 6D; docs/plans/phase6.md 6D "Tests first"): the CSV
// downloaded and read back by a strict RFC 4180 reader (test/web/
// rfc4180.node.mjs), over every fixture NG code and the fixture's NG-listed
// codes with no classes, at ug2 and at grad; Print with window.print stubbed;
// a press before the rows are in; Ctrl+P before and after the export
// question; the print page under print media (only it shows, full width,
// light on paper even in dark mode, axe clean); and Chromium's tagged PDF,
// its text read back (pdf-text.mjs). Every flow runs under the production CSP
// (public/_headers on the local stack). Set VNM_EVIDENCE to a directory to
// keep the files (docs/evidence/phase6/export/).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseCsv } from '../web/rfc4180.node.mjs';
import { hasStructTree, pdfFonts, pdfPages, squash } from './pdf-text.mjs';
import { axeViolations, live, query } from './support.mjs';

/** @type {{ modules: { code: string, ng: boolean, ngSemesters: number[] }[] }} */
const corpus = JSON.parse(readFileSync(new URL('../fixtures/corpus.json', import.meta.url), 'utf8'));
/** @type {{ modules: { code: string, ngSemesters: number[] }[] }} */
const unscheduled = JSON.parse(readFileSync(new URL('../fixtures/ng-unscheduled.json', import.meta.url), 'utf8'));
const EVIDENCE = process.env.VNM_EVIDENCE ?? '';
const CLOSED = 'Closed, or not on NUS\'s exchange list, in that semester';
const DESCRIPTION = 'Course description (NUS, via NUSMods)';

/** @param {string} qs */
const at = (qs) => `/?${qs}`;
/** @param {import('@playwright/test').Page} page @param {string} name */
const button = (page, name) => page.locator('.sl-actions').getByRole('button', { name, exact: true });
/** Enter on a control, as the keyboard user does (WebKit doesn't focus a clicked button). @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} el */
async function activate(page, el) {
  await el.focus();
  const radio = await el.evaluate((x) => x instanceof HTMLInputElement && (x.type === 'radio' || x.type === 'checkbox'));
  await page.keyboard.press(radio ? 'Space' : 'Enter');
}
/** The view is shown and every row has loaded or failed. @param {import('@playwright/test').Page} page */
async function rowsIn(page) {
  await expect(page.locator('#slView')).toBeVisible();
  await expect(page.locator('#slView .sl-ehead .title', { hasText: 'Loading…' })).toHaveCount(0);
}
/** Whether the page's print class is on. @param {import('@playwright/test').Page} page */
const printClass = (page) => page.evaluate(() => document.documentElement.classList.contains('print-shortlist'));
/** window.print stubbed: each call records the title and what the print page holds then. @param {import('@playwright/test').Page} page */
async function stubPrint(page) {
  await page.addInitScript(() => {
    /** @type {any} */ (globalThis).prints = [];
    window.print = () => {
      /** @type {any} */ (globalThis).prints.push({
        title: document.title,
        on: document.documentElement.classList.contains('print-shortlist'),
        descriptions: [...document.querySelectorAll('#slPrint .pp-desc')].map((p) => p.textContent),
        codes: [...document.querySelectorAll('#slPrint .pp-course')].map((a) => a.getAttribute('data-code')),
      });
    };
  });
}
/** @param {import('@playwright/test').Page} page @returns {Promise<{ title: string, on: boolean, descriptions: string[], codes: string[] }[]>} */
const prints = (page) => page.evaluate(() => /** @type {any} */ (globalThis).prints);

/**
 * Presses Download CSV and reads the file back: its name, and its rows as
 * objects keyed by the header (the entries), strictly (RFC 4180).
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} [el]
 */
async function download(page, el = button(page, 'Download CSV')) {
  const [file] = await Promise.all([page.waitForEvent('download'), activate(page, el)]);
  const text = readFileSync(/** @type {string} */ (await file.path()), 'utf8');
  expect(text.charCodeAt(0)).toBe(0xFEFF);
  const records = parseCsv(text.slice(1));
  const [header, ...rest] = records;
  for (const r of records) expect(r).toHaveLength(header.length);
  const sep = rest.findIndex((r) => r.every((f) => f === ''));
  const rows = rest.slice(0, sep).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  return { name: file.suggestedFilename(), text, rows, tail: rest.slice(sep + 1) };
}

/**
 * /module/:code's answer, as the page receives it: the row, or a 404's detail.
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} code
 */
async function moduleAnswer(request, code) {
  const res = await request.get(`/module/${code}`);
  return { status: res.status(), body: await res.json() };
}
/** NUSMods' workload as the export writes it, worked out here from /module's answer. @param {any} w */
function workloadExpected(w) {
  if (!w) return 'Not listed';
  if ('raw' in w) return `As NUS lists it: ${w.raw}`;
  const n = (/** @type {number} */ x) => String(Math.round(x * 100) / 100);
  return `Lecture ${n(w.lecture)}, tutorial ${n(w.tutorial)}, lab ${n(w.lab)}, project ${n(w.project)}, preparation ${n(w.prep)} hours a week (${n(w.total)} in all)`;
}

/**
 * Links over every fixture NG code and the fixture's NG-listed codes with no
 * classes, each tagged with its first NG semester, at most 20 to a semester in
 * each link (6B's cap); every third a backup.
 */
function coverageLinks() {
  const codes = [...corpus.modules.filter((m) => m.ng), ...unscheduled.modules].map((m) => ({ code: m.code, sem: m.ngSemesters[0] ?? 1 }));
  /** @type {{ code: string, sem: number }[][]} */
  const links = [];
  for (const c of codes) {
    let link = links.find((l) => l.filter((x) => x.sem === c.sem).length < 20);
    if (!link) { link = []; links.push(link); }
    link.push(c);
  }
  return links.map((l) => l.map((c, i) => `${i % 3 === 2 ? 'alt' : 'pick'}=${c.code}.${c.sem}`).join('&'));
}

/**
 * A known 40-entry list for the PDF: every third fixture NG code, 20 tagged
 * Sem 1 as picks and 20 tagged Sem 2 as backups, with EN3264 and LL4407
 * (characters outside the Plex subsets: U+2010, U+2015) in it.
 */
function fortyLink() {
  const ng = corpus.modules.filter((m) => m.ng);
  const third = ng.filter((_, i) => i % 3 === 0);
  const s1 = [...new Set(['EN3264', ...third.filter((m) => m.ngSemesters.includes(1)).map((m) => m.code)])].slice(0, 20);
  const s2 = [...new Set(['LL4407', ...ng.filter((m) => m.ngSemesters.includes(2) && !s1.includes(m.code)).filter((_, i) => i % 2 === 0).map((m) => m.code)])].slice(0, 20);
  return { codes: [...s1, ...s2], qs: [...s1.map((c) => `pick=${c}.1`), ...s2.map((c) => `alt=${c}.2`)].join('&') };
}

test.describe('[6D] Download CSV', () => {
  test('[6D] downloads the file, read back strictly: its name, Sem 1\'s picks and backups, then the closed entry; the URL now holds ay', async ({ page }) => {
    await page.goto(at('ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1&alt=CS3244.1&alt=EE4407.1&view=shortlist'));
    await rowsIn(page);
    expect(query(page)).not.toContain('ay=');
    const { name, rows } = await download(page);
    expect(name).toBe('exchange-shortlist-sem1-2026-27-courses.csv');
    expect(rows.map((r) => [r.Section, r.Code])).toEqual([['Sem 1', 'CS2113'], ['Sem 1', 'GE2101'], ['Sem 1', 'EE4407'], [CLOSED, 'CS3244']]);
    expect(rows[0][DESCRIPTION]).toMatch(/^This course introduces the necessary skills/);
    await expect(live(page)).toHaveText('Downloading exchange-shortlist-sem1-2026-27-courses.csv');
    await expect.poll(() => query(page)).toContain('ay=2026-2027');
  });

  test('[6D] every fixture NG code and NG-listed code with no classes: its description and workload as /module answers them, each closed one its reasons, at ug2 and at grad', async ({ page, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'one browser covers the codes; both download in the test above');
    test.setTimeout(240_000);
    /** @type {Map<string, { status: number, body: any }>} */
    const answers = new Map();
    const links = coverageLinks();
    expect(links.length).toBeLessThanOrEqual(7);
    let checked = 0;
    for (const study of ['ug2', 'grad']) {
      for (const link of links) {
        await page.goto(at(`ng=1&study=${study}&${link}&view=shortlist`));
        await rowsIn(page);
        const { rows } = await download(page);
        const params = new URLSearchParams(link);
        expect(rows).toHaveLength([...params.getAll('pick'), ...params.getAll('alt')].length);
        for (const r of rows) {
          if (!answers.has(r.Code)) answers.set(r.Code, await moduleAnswer(request, r.Code));
          const { body } = /** @type {{ body: any }} */ (answers.get(r.Code));
          expect(r[DESCRIPTION], r.Code).toBe(body.description);
          expect(r['Workload (NUSMods)'].replace(/\. NUSMods lists no lecture, tutorial or lab hours$/, ''), r.Code).toBe(workloadExpected(body.workload));
          const sem = Number(r.Semester.replace('Sem ', ''));
          const x = (body.exchange ?? []).find((/** @type {any} */ e) => e.sem === sem && e.study === study);
          if (body.ngSemesters && !body.ngSemesters.includes(sem)) continue;
          if (x?.status === 'closed') {
            expect(r.Section, r.Code).toBe(CLOSED);
            expect(r.Counts, r.Code).toMatch(/^Not counted: ./);
            for (const reason of x.reasons) {
              if (reason.kind === 'semester' || reason.id === 'ng-list:not-in-semester') continue;
              expect(r['Exchange notes'], `${r.Code} ${reason.id}`).toContain(String(reason.text).replace(/\.$/, ''));
            }
          }
          checked += 1;
        }
      }
    }
    expect(new Set([...answers.keys()]).size).toBe(132);
    expect(checked).toBeGreaterThanOrEqual(2 * 126);
  });
});

test.describe('[6D] Print or save as PDF', () => {
  test('[6D] window.print on the click, with every description on the print page and the file name as the title; afterprint restores it', async ({ page, request }) => {
    await stubPrint(page);
    const codes = ['CS2113', 'GE2101', 'CS2030', 'EE4407'];
    await page.goto(at(`ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1&pick=CS2030.2&alt=EE4407.1&view=shortlist`));
    await rowsIn(page);
    await expect.poll(() => printClass(page)).toBe(true);
    await activate(page, button(page, 'Print or save as PDF'));
    await expect.poll(() => prints(page)).toHaveLength(1);
    const [p] = await prints(page);
    expect(p).toMatchObject({ title: 'exchange-shortlist-sem1-sem2-2026-27-courses', on: true });
    expect(p.codes).toEqual(['CS2113', 'GE2101', 'EE4407', 'CS2030']);
    for (const code of codes) expect(p.descriptions).toContain((await moduleAnswer(request, code)).body.description);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page).toHaveTitle('NUS Mod Finder (unofficial)');
  });

  test('[6D] a press before every row is in: the button keeps its name, its line says "Loading", then "Ready: press again"; the second press downloads, or prints', async ({ page }) => {
    await stubPrint(page);
    let downloads = 0;
    page.on('download', () => { downloads += 1; });
    /** @type {import('@playwright/test').Route[]} */
    const held = [];
    await page.route(/\/module\/CS2113$/, (route) => { held.push(route); });
    await page.goto(at('ng=1&study=ug2&sem=1&pick=GE2101.1&pick=CS2113.1&view=shortlist'));
    await expect.poll(() => held.length).toBe(1);
    await expect(page.locator('#slView .sl-entry[data-code="GE2101"] .title')).not.toHaveText('Loading…');
    const csv = button(page, 'Download CSV');
    await expect(csv).toHaveAttribute('aria-describedby', 'slExportStatus');
    await activate(page, csv);
    await expect(page.locator('#slExportStatus')).toHaveText('Loading 1 of 2 courses');
    await expect(live(page)).toHaveText('Loading 1 of 2 courses');
    await expect(csv).toHaveAccessibleName('Download CSV');
    expect(await printClass(page)).toBe(false);
    await held[0].continue();
    await expect(page.locator('#slExportStatus')).toHaveText('Ready: press again to download');
    await expect(live(page)).toHaveText('Ready: press again to download');
    await expect(csv).toHaveAccessibleDescription('Ready: press again to download');
    expect(downloads).toBe(0);
    const { name } = await download(page, csv);
    expect(name).toBe('exchange-shortlist-sem1-2026-27-courses.csv');

    // Print, the same way.
    await page.unroute(/\/module\/CS2113$/);
    held.length = 0;
    await page.route(/\/module\/CS3244$/, (route) => { held.push(route); });
    await page.goto(at('ng=1&study=ug2&sem=1&pick=GE2101.1&pick=CS3244.1&view=shortlist'));
    await expect.poll(() => held.length).toBe(1);
    const print = button(page, 'Print or save as PDF');
    await activate(page, print);
    await expect(page.locator('#slExportStatus')).toHaveText('Loading 1 of 2 courses');
    expect(await prints(page)).toHaveLength(0);
    await held[0].continue();
    await expect(page.locator('#slExportStatus')).toHaveText('Ready: press again to print');
    expect(await prints(page)).toHaveLength(0);
    await activate(page, print);
    await expect.poll(() => prints(page)).toHaveLength(1);
    expect((await prints(page))[0]).toMatchObject({ on: true, codes: ['GE2101', 'CS3244'] });
  });

  test('[6D] Ctrl+P: before the export question is answered the screen prints; once it is, the shortlist, with the file name as the title', async ({ page }) => {
    await page.goto(at('pick=CS5562.2&view=shortlist'));
    await rowsIn(page);
    await expect(page.locator('#slAsk')).toBeVisible();
    expect(await printClass(page)).toBe(false);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#slView')).toBeVisible();
    await expect(page.locator('#slPrint')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page).toHaveTitle('NUS Mod Finder (unofficial)');
    await page.emulateMedia({ media: 'screen' });
    await activate(page, page.getByRole('radio', { name: '2nd year' }));
    await expect.poll(() => printClass(page)).toBe(true);
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#slPrint')).toBeVisible();
    await expect(page.locator('#slView')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page).toHaveTitle('exchange-shortlist-sem2-2026-27-courses');
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page).toHaveTitle('NUS Mod Finder (unofficial)');
    // Leaving the view turns the class off: Ctrl+P on the results prints the screen.
    await page.emulateMedia({ media: 'screen' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#slView')).toBeHidden();
    expect(await printClass(page)).toBe(false);
  });
});

/**
 * Under print media: every box with a size that is outside #slPrint (the
 * section's ancestors aside), the section's width against the page's, and
 * every visible text's colour against white paper (4.5:1).
 * @param {import('@playwright/test').Page} page
 */
const printLayout = (page) => page.evaluate(() => {
  const section = /** @type {HTMLElement} */ (document.getElementById('slPrint'));
  /** @param {string} c */
  const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  /** @param {number[]} c */
  const lum = (c) => {
    const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const outside = [];
  const lowContrast = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden') continue;
    if (!section.contains(el) && !el.contains(section)) outside.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className}`);
    const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
    if (text) {
      const ratio = 1.05 / (lum(rgb(style.color)) + 0.05);
      if (ratio < 4.5) lowContrast.push(`${el.tagName.toLowerCase()}.${el.className} ${style.color} ${ratio.toFixed(2)}`);
    }
  }
  return { outside, lowContrast, width: section.getBoundingClientRect().width, page: document.documentElement.clientWidth };
});

test.describe('[6D] the print page under print media', () => {
  test('[6D] only the print section shows, at the page\'s full width; light on paper in a dark theme, AA; axe clean; the breaks set', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 718, height: 1000 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(at('ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1&pick=PC3270.1&pick=ACC1701XA.1&alt=CS3244.1&alt=EE4407.1&view=shortlist'));
    await rowsIn(page);
    await expect.poll(() => printClass(page)).toBe(true);
    await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
    const layout = await printLayout(page);
    expect(layout.outside).toEqual([]);
    expect(layout.width).toBeGreaterThanOrEqual(0.95 * layout.page);
    expect(layout.lowContrast).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    const breaks = await page.evaluate(() => {
      const s = (/** @type {string} */ sel) => getComputedStyle(/** @type {Element} */ (document.querySelector(sel)));
      return { form: s('#slPrint .pp-form').breakBefore, headInside: s('#slPrint .pp-ch').breakInside, headAfter: s('#slPrint .pp-ch').breakAfter, h2: s('#slPrint h2').breakAfter };
    });
    expect(breaks).toEqual({ form: 'page', headInside: 'avoid', headAfter: 'avoid', h2: 'avoid' });
    if (EVIDENCE && browserName === 'webkit') {
      mkdirSync(EVIDENCE, { recursive: true });
      await page.screenshot({ path: join(EVIDENCE, 'print-media-webkit-dark.png'), fullPage: true });
    }
    // Without the class (Ctrl+P on the results): the screen prints, light on paper too.
    await page.emulateMedia({ media: 'screen', colorScheme: 'dark' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#slView')).toBeHidden();
    expect(await printClass(page)).toBe(false);
    await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
    await expect(page.locator('#slPrint')).toBeHidden();
    expect((await printLayout(page)).lowContrast).toEqual([]);
  });
});

test.describe('[6D] the PDF', () => {
  test('[6D] Chromium\'s tagged PDF of a 40-entry list: a structure tree, selectable text holding every description, workload, status and the link, starting with the head; the form order starts a page; at most 16 pages', async ({ page, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'page.pdf() is Chromium\'s');
    test.setTimeout(120_000);
    const { codes, qs } = fortyLink();
    expect(codes).toHaveLength(40);
    expect(codes).toEqual(expect.arrayContaining(['EN3264', 'LL4407']));
    await page.goto(at(`ng=1&study=ug2&sem=1&${qs}&view=shortlist`));
    await rowsIn(page);
    await expect.poll(() => printClass(page)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ format: 'A4', margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }, tagged: true });
    const pages = pdfPages(pdf);
    // U+2010 and U+2011 (EN3264, LL4407) aren't in the Plex subsets; the system font that draws
    // them may map them to "-" in the text layer (Helvetica Neue on macOS does), so both sides fold them.
    const fold = (/** @type {string} */ s) => squash(s).replace(/[\u2010\u2011]/g, '-');
    const all = fold(pages.join(''));
    expect(hasStructTree(pdf)).toBe(true);
    expect(pages.length).toBeLessThanOrEqual(20);
    const shown = await page.evaluate(() => ({
      head: document.querySelector('#slPrint .pp-site')?.textContent ?? '',
      title: document.querySelector('#slPrint h1')?.textContent ?? '',
      link: document.querySelector('#slPrint .pp-link')?.textContent ?? '',
      stamps: [...document.querySelectorAll('#slPrint .pp-course .st')].map((s) => s.textContent ?? ''),
    }));
    expect(all.toUpperCase().startsWith(fold(shown.head + shown.title).toUpperCase())).toBe(true);
    expect(shown.link).toMatch(/^https:\/\/nusmodfinder\.rcn\.sh\/\?/);
    expect(all).toContain(fold(shown.link));
    expect(shown.stamps).toHaveLength(40);
    for (const s of shown.stamps) expect(all).toContain(fold(s));
    for (const code of codes) {
      const { body } = await moduleAnswer(request, code);
      expect(all, `${code}'s description`).toContain(fold(body.description));
      expect(all, `${code}'s workload`).toContain(fold(workloadExpected(body.workload)));
    }
    // The forced break: the foot's form order starts a page.
    expect(pages.findIndex((p) => fold(p).startsWith(fold('NUS\'s application form order')))).toBeGreaterThan(0);
    // The text is Plex, and a system font draws what the Plex subsets lack (recorded in the evidence).
    const fonts = pdfFonts(pdf);
    expect(fonts.some((f) => /IBMPlexSans/.test(f))).toBe(true);
    expect(fonts.some((f) => !/IBMPlex/.test(f))).toBe(true);
    if (EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, 'shortlist-40-tagged.pdf'), pdf);
      writeFileSync(join(EVIDENCE, 'shortlist-40-tagged.json'), `${JSON.stringify({ pages: pages.length, structTree: hasStructTree(pdf), characters: all.length, fonts }, null, 2)}\n`);
    }
  });
});
