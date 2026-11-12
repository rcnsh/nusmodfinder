#!/usr/bin/env node
// @ts-check
// The shortlist ship's live checks (Phase 6 6E, docs/plans/phase6.md §3 6E
// "Live checks"), run by the lead after the deploy. Built like p5-live.mjs.
//
// First it fetches every answer the check needs, from Node, one call in
// flight and each starting at least 4 s after the one before: /facets, the
// shortlist's 8 /module answers and the 3 404 codes'. Then Playwright loads
// the page in Chromium and WebKit and fulfils every /module and /facets call
// the page makes from that memory, shared by both, so the page's 10 s timeout
// never fires and no call is made twice. The page's files (HTML, JS, CSS,
// fonts) come from the network through the same queue, each fetched once and
// then served from memory, and count in the total. An API call the page makes
// that wasn't fetched first is refused, and fails the run.
//
// The checks, on a link with 6 picks and 2 backups drawn with a fixed seed
// from the corpus's modules (scripts/p6-live-plan.mjs: over Sem 1 and Sem 2,
// with a counted, a to-confirm, a Business and a closed entry; each entry's
// standing from the independent reference, test/web/shortlist-reference.node.mjs,
// and its status from the SC1 oracle):
// - the view's rows: each entry in its list and rank, with its title and its
//   stamp's status as the oracle gives it;
// - the view's totals equal the reference over the corpus's rows, and the
//   downloaded CSV's equal the view's;
// - the CSV downloads (BOM, RFC 4180, one row per entry);
// - Chromium's tagged PDF (page.pdf) holds every entry's description
//   (test/ui/pdf-text.mjs);
// - axe (every rule but AAA's 7:1: test/ui/support.mjs) on the view, light
//   and dark, in Chromium and WebKit;
// - the 390×664 fold on the view (the header, the search bar, the view's
//   heading and its export buttons), in Chromium and as an iPhone 13 in WebKit;
// - one 404 code of each kind /module answers (`ng-listed`, `catalogue-only`,
//   `unknown`), each answering its kind.
//
// Each request, sent or served from memory, is a line in the JSONL log (time,
// path, status; `source` network, memory or refused), for
// docs/evidence/requests.tsv, and the run ends with a summary line. A 429 is
// waited out (Retry-After, at least 4 s) and re-sent, twice at most.
//
//   node scripts/p6-live.mjs [--url URL] [--log FILE] [--corpus production|fixture] [--seed N] [--plan]
//
// --url     the site (default: production, https://nusmodfinder.rcn.sh)
// --log     the JSONL log (default docs/evidence/phase6/p6-live.jsonl), appended to
// --corpus  the modules drawn from and the reference runs over: `production`
//           (`current` in data/corpus.json normalised as ingest does, data/'s groups and
//           NG-listed codes with no classes) or `fixture` (the local UI server's,
//           `npm run dev`); default: fixture for a localhost URL, else production
// --seed    the draw's seed (default 6)
// --plan    print the draw and the calls it would make, and send nothing
//
// Exit 0 when every check passes, 1 when one fails, 2 on a usage error. Against
// a live URL (not localhost) each run writes a run record with every request
// sent, by path (scripts/run-record.mjs, Phase 7 7C).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from '@playwright/test';
import { hasStructTree, pdfPages, squash } from '../test/ui/pdf-text.mjs';
import { axeViolations } from '../test/ui/support.mjs';
import { parseCsv } from '../test/web/rfc4180.node.mjs';
import { GAP_MS, STUDY, csvTotals, loadData, makePlan, parseArgs, readTotals, totalsProblems } from './p6-live-plan.mjs';
import { recordedLiveRun } from './run-record.mjs';

const UA = devices['Desktop Chrome'].userAgent;
/** How long one page may take to show what a check waits for, its files queued 4 s apart. */
const PAGE_TIMEOUT_MS = 180_000;
/** Response headers that describe the bytes on the wire, not the decoded body served from memory. */
const WIRE = ['content-encoding', 'content-length', 'transfer-encoding'];

/** Paths the Worker answers (the rest are the page's static files). @param {string} path */
const isApi = (path) => path === '/search' || path === '/facets' || path === '/health' || path.startsWith('/module/') || path.startsWith('/admin');

/** @param {unknown} err */
const firstLine = (err) => String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0];

// ---------- requests: one in flight, paced, logged, fetched once ----------

/**
 * @typedef {{ status: number, headers: Record<string, string>, body: Buffer }} Answer
 */

/**
 * @param {{ url: string, log: string, onSend?: (path: string) => void }} opts
 *   `onSend`: each request sent to the network, by path (the run record, Phase 7 7C)
 */
function createSite(opts) {
  /** @type {Map<string, Answer>} */
  const memory = new Map();
  /** In-flight fetches, so a path asked for twice at once is still sent once. @type {Map<string, Promise<Answer>>} */
  const pending = new Map();
  /** Every path the browsers asked the API for that wasn't fetched first. @type {string[]} */
  const unplanned = [];
  /** @type {{ path: string, status: number | null }[]} */
  const network = [];
  let n = 0;
  let last = 0;
  /** The queue: each call waits for the one before to finish. @type {Promise<unknown>} */
  let queue = Promise.resolve();
  mkdirSync(dirname(opts.log), { recursive: true });
  /** One line per request, and the summary. @param {Record<string, unknown>} row */
  const log = (row) => appendFileSync(opts.log, `${JSON.stringify({ n: ++n, at: new Date().toISOString(), ...row })}\n`);

  /**
   * Runs `send` once the call before it has finished and at least GAP_MS
   * after it started.
   * @template T @param {(started: number) => Promise<T>} send @returns {Promise<T>}
   */
  function paced(send) {
    const run = queue.then(async () => {
      // A timer may fire a millisecond early: never start before its time.
      while (Date.now() - last < GAP_MS) await new Promise((r) => setTimeout(r, last + GAP_MS - Date.now()));
      last = Date.now();
      return send(last);
    });
    queue = run.catch(() => {});
    return run;
  }

  /**
   * GET a path on the site: from memory if this run already has it, else
   * paced, with a 429 waited out and re-sent.
   * @param {string} pathAndQuery
   * @param {{ check: string, engine: string, send: () => Promise<Answer> }} how
   * @returns {Promise<Answer>}
   */
  async function get(pathAndQuery, { check, engine, send }) {
    const remembered = memory.get(pathAndQuery);
    if (remembered) {
      log({ check, engine, path: pathAndQuery, source: 'memory', status: remembered.status });
      return remembered;
    }
    const inFlight = pending.get(pathAndQuery);
    if (inFlight) {
      const res = await inFlight;
      log({ check, engine, path: pathAndQuery, source: 'memory', status: res.status });
      return res;
    }
    const fetching = (async () => {
      for (let attempt = 1; ; attempt++) {
        const res = await paced(async (started) => {
          opts.onSend?.(new URL(pathAndQuery, opts.url).pathname);
          try {
            const r = await send();
            // `at` is when the call was sent, so the log shows the 4 s spacing itself.
            log({ at: new Date(started).toISOString(), check, engine, path: pathAndQuery, source: 'network', status: r.status, ms: Date.now() - started, cache: r.headers['cf-cache-status'] ?? null, version: r.headers['x-app-version'] ?? null, attempt });
            network.push({ path: pathAndQuery, status: r.status });
            console.log(`  sent ${String(network.length).padStart(2)}  ${new Date(started).toISOString()}  GET ${pathAndQuery}  ${r.status}`);
            return r;
          } catch (err) {
            // Sent, but no answer (a reset, a timeout): logged all the same.
            log({ at: new Date(started).toISOString(), check, engine, path: pathAndQuery, source: 'network', status: null, ms: Date.now() - started, error: firstLine(err), attempt });
            network.push({ path: pathAndQuery, status: null });
            throw err;
          }
        });
        if (res.status === 429 && attempt < 3) {
          const after = Number(res.headers['retry-after']);
          await new Promise((r) => setTimeout(r, Math.max(GAP_MS, Number.isFinite(after) ? after * 1000 : 0)));
          continue;
        }
        // Every answer is kept, a 404 included: nothing is fetched twice.
        if (res.status !== 429) memory.set(pathAndQuery, res);
        return res;
      }
    })();
    pending.set(pathAndQuery, fetching);
    try {
      return await fetching;
    } finally {
      pending.delete(pathAndQuery);
    }
  }

  return {
    get, log, memory, unplanned, network,
    /**
     * GET a path from Node (the fetch-first phase).
     * @param {string} path @param {string} check
     */
    fetch: (path, check) => get(path, {
      check, engine: 'node',
      send: async () => {
        const x = await fetch(`${opts.url}${path}`, { headers: { 'user-agent': UA }, redirect: 'manual' });
        return { status: x.status, headers: Object.fromEntries(x.headers), body: Buffer.from(await x.arrayBuffer()) };
      },
    }),
    /**
     * Routes a browser context's requests: an API call from memory only (one
     * not fetched first is refused and noted), a page file through `get`.
     * Anything not a GET on the site is refused and logged.
     * @param {import('@playwright/test').BrowserContext} context
     * @param {string} engine
     * @param {() => string} check the check running now
     */
    async route(context, engine, check) {
      await context.route('**/*', async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        const path = u.pathname + u.search;
        if (u.origin !== opts.url || req.method() !== 'GET') {
          log({ check: check(), engine, path: req.url(), source: 'refused', method: req.method() });
          await route.abort('blockedbyclient');
          return;
        }
        if (isApi(u.pathname) && !memory.has(path)) {
          unplanned.push(`${engine} ${path}`);
          log({ check: check(), engine, path, source: 'refused', why: 'not fetched first' });
          await route.abort('blockedbyclient');
          return;
        }
        let res;
        try {
          res = await get(path, {
            check: check(), engine,
            send: async () => {
              const r = await route.fetch({ maxRedirects: 0 });
              return { status: r.status(), headers: r.headers(), body: await r.body() };
            },
          });
        } catch {
          // No answer (logged by get): the page sees a failed request, as a browser would.
          await route.abort('failed').catch(() => {});
          return;
        }
        const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => !WIRE.includes(k.toLowerCase())));
        await route.fulfill({ status: res.status, headers, body: res.body }).catch(() => {});
      });
    },
  };
}

// ---------- the page ----------

/** The view is shown and every row has loaded or failed. @param {import('@playwright/test').Page} page */
async function rowsIn(page) {
  await page.locator('#slView').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#slView .sl-ehead .title').length > 0
    && ![...document.querySelectorAll('#slView .sl-ehead .title')].some((t) => t.textContent === 'Loading…'));
}

/**
 * The view's rows, in each list's order: code, title, the stamp's status.
 * @param {import('@playwright/test').Page} page
 */
const viewRows = (page) => page.evaluate(() => ['slPickList', 'slAltList'].flatMap((id) => [...document.querySelectorAll(`#${id} > li.sl-entry`)].map((li) => ({
  which: id === 'slPickList' ? 'pick' : 'alt',
  code: li.getAttribute('data-code') ?? '',
  title: li.querySelector('.sl-ehead .title')?.textContent ?? '',
  status: li.querySelector('.stamps .st')?.getAttribute('data-status') ?? null,
}))));

/**
 * Each semester's totals card in the view, read as text.
 * @param {import('@playwright/test').Page} page
 */
async function viewTotals(page) {
  const cards = await page.evaluate(() => [...document.querySelectorAll('#slTotals .sl-total')].map((c) => ({
    heading: c.querySelector('h4')?.textContent ?? '', sum: [...(c.querySelector('.sl-sum')?.children ?? [])].map((s) => s.textContent ?? ''),
  })));
  /** @type {Record<string, import('./p6-live-plan.mjs').ReadTotals | null>} */
  const out = {};
  for (const c of cards) out[/^Sem ([12]) picks$/.exec(c.heading)?.[1] ?? c.heading] = readTotals(c.sum);
  return out;
}

/**
 * Presses Download CSV by keyboard (as export.spec.js does) and reads the
 * file back strictly: its name, its entry rows, and the rows after them.
 * @param {import('@playwright/test').Page} page
 */
async function downloadCsv(page) {
  const button = page.locator('.sl-actions').getByRole('button', { name: 'Download CSV', exact: true });
  await button.focus();
  const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  const text = readFileSync(/** @type {string} */ (await file.path()), 'utf8');
  const problems = [];
  if (text.charCodeAt(0) !== 0xFEFF) problems.push('no byte-order mark');
  const records = parseCsv(text.slice(text.charCodeAt(0) === 0xFEFF ? 1 : 0));
  const [header, ...rest] = records;
  if (records.some((r) => r.length !== header.length)) problems.push('a row with another field count than the header');
  const sep = rest.findIndex((r) => r.every((f) => f === ''));
  const rows = rest.slice(0, sep).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  return { name: file.suggestedFilename(), rows, tail: rest.slice(sep + 1), problems };
}

/**
 * Whether the view's fold holds at 390×664 (6C's layout: on a phone the
 * view's head and its export actions come before the list): no scroll either
 * way, and the header's "unofficial", the search box and Search, the view's
 * heading, "Back to results", and Copy link, Download CSV and Print or save
 * as PDF wholly in view.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} what is out of view; [] when it holds
 */
const viewFoldProblems = (page) => page.evaluate(async () => {
  await document.fonts.ready;
  const out = [];
  if (window.scrollY !== 0) out.push(`scrolled to ${window.scrollY}`);
  if (document.documentElement.scrollWidth > window.innerWidth) out.push(`${document.documentElement.scrollWidth} px wide, the viewport ${window.innerWidth}`);
  const unofficial = document.querySelector('h1 .unofficial');
  if (!/\(?unofficial\)?/.test(unofficial?.textContent ?? '')) out.push('the header doesn\'t say "unofficial"');
  const actions = [...document.querySelectorAll('#slView .sl-actions button')];
  /** @param {string} name */
  const action = (name) => actions.find((b) => b.textContent?.trim() === name);
  /** @type {[string, Element | null | undefined][]} */
  const parts = [['"unofficial"', unofficial], ['the search box', document.getElementById('q')], ['Search', document.getElementById('go')],
    ['the view\'s heading', document.getElementById('slTitle')], ['Back to results', document.querySelector('#slView .sl-close')],
    ...['Copy link', 'Download CSV', 'Print or save as PDF'].map((n) => /** @type {[string, Element | undefined]} */ ([n, action(n)]))];
  for (const [name, el] of parts) {
    const r = el?.getBoundingClientRect();
    if (!r || r.width === 0 || r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) out.push(`${name} not wholly in view`);
  }
  return out;
});

// ---------- the run ----------

/** @typedef {{ check: string, pass: boolean, detail: string }} Outcome */

/**
 * @param {ReturnType<typeof parseArgs> & { onSend?: (path: string) => void }} opts
 * @returns {Promise<Outcome[]>}
 */
async function run(opts) {
  const data = await loadData(opts.corpus);
  const plan = makePlan(data, opts.seed);
  console.log(`p6-live: ${opts.url}, ${opts.corpus} modules (${data.modules.length}), seed ${opts.seed}, study ${STUDY}`);
  console.log('the shortlist (rank order; standing by the reference, status by the SC1 oracle):');
  for (const e of plan.entries) console.log(`  ${e.which === 'pick' ? 'pick  ' : 'backup'} ${e.code.padEnd(10)} Sem ${e.sem}  ${String(e.credits).padStart(2)} units  ${e.standing.padEnd(7)} ${e.status.padEnd(6)}  ${e.faculty ?? ''}`);
  console.log(`the reference's totals: Sem 1 ${JSON.stringify(plan.totals[1])}, Sem 2 ${JSON.stringify(plan.totals[2])}`);
  console.log(`the 404 codes: ${plan.missing.map((m) => `${m.code} (${m.kind})`).join(', ')}`);
  console.log(`the link: ${opts.url}/?${plan.link}`);
  console.log(`the calls fetched first (${plan.calls.length}, one in flight, at least ${GAP_MS / 1000} s apart):`);
  plan.calls.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}  GET ${c}`));
  console.log('then the page\'s files (HTML, JS, CSS, fonts), each fetched once; the total is the summary\'s `sent`');
  if (opts.plan) return [];

  const site = createSite(opts);
  /** @type {Outcome[]} */
  const out = [];
  /** @param {string} check @param {string[]} problems @param {string} [ok] */
  const record = (check, problems, ok = 'ok') => {
    const o = { check, pass: problems.length === 0, detail: problems.length ? problems.join('; ') : ok };
    out.push(o);
    console.log(`${o.pass ? 'PASS' : 'FAIL'}  ${check}: ${o.detail}`);
  };
  let now = 'start';

  // Every check, then the summary, even if one throws: the log always ends
  // with what passed and what didn't.
  try {
    // 1. Every answer the check needs, first.
    now = 'fetch';
    const fetched = [];
    for (const path of plan.calls) {
      try {
        const res = await site.fetch(path, now);
        fetched.push({ path, status: res.status });
      } catch (err) {
        fetched.push({ path, status: null, error: firstLine(err) });
      }
    }
    const shortlistPaths = ['/facets', ...plan.entries.map((e) => `/module/${e.code}`)];
    record(`fetch first: /facets and the shortlist's ${plan.entries.length} /module answers`,
      fetched.filter((f) => shortlistPaths.includes(f.path) && f.status !== 200).map((f) => `${f.path}: ${f.status ?? f.error}`), 'every one 200');

    // 2. The 404s, one of each kind.
    for (const m of plan.missing) {
      now = `404 ${m.kind}`;
      const res = site.memory.get(`/module/${m.code}`);
      const problems = [];
      if (!res) problems.push('no answer');
      else {
        if (res.status !== 404) problems.push(`HTTP ${res.status}`);
        let body = null;
        try { body = JSON.parse(res.body.toString('utf8')); } catch { problems.push('not JSON'); }
        if (body && body.kind !== m.kind) problems.push(`kind ${JSON.stringify(body.kind)}`);
        if (body && body.error !== 'not_found') problems.push(`error ${JSON.stringify(body.error)}`);
      }
      record(`404 ${m.code} answers kind ${m.kind}`, problems, `404, kind ${m.kind}`);
    }

    /** @type {Map<string, any>} */
    const bodies = new Map(plan.entries.map((e) => [e.code, JSON.parse(site.memory.get(`/module/${e.code}`)?.body.toString('utf8') ?? 'null')]));
    const pickAlt = [...plan.entries.filter((e) => e.which === 'pick'), ...plan.entries.filter((e) => e.which === 'alt')];

    // 3. The view, in each engine at 1280×800: rows, totals, CSV, (PDF), axe.
    for (const [engine, launcher] of /** @type {const} */ ([['chromium', chromium], ['webkit', webkit]])) {
      const browser = await launcher.launch();
      try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(engine === 'chromium' ? { userAgent: UA } : {}), acceptDownloads: true });
        await site.route(ctx, engine, () => now);
        const page = await ctx.newPage();
        page.setDefaultTimeout(PAGE_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
        now = `view ${engine}`;
        let loaded = false;
        try {
          await page.goto(`${opts.url}/?${plan.link}`);
          await rowsIn(page);
          loaded = true;
        } catch (err) {
          record(`the view loads (${engine})`, [firstLine(err)]);
        }
        if (loaded) {
          // The rows: each entry in its list and place, its title, its stamp as the oracle says.
          const rows = await viewRows(page);
          const problems = [];
          if (rows.map((r) => `${r.which} ${r.code}`).join(', ') !== pickAlt.map((e) => `${e.which} ${e.code}`).join(', ')) {
            problems.push(`rows ${rows.map((r) => `${r.which} ${r.code}`).join(', ')}`);
          }
          for (const e of pickAlt) {
            const r = rows.find((x) => x.code === e.code);
            if (!r) continue;
            if (r.title !== e.title) problems.push(`${e.code} title "${r.title}"`);
            if (r.status !== e.status) problems.push(`${e.code} stamp ${r.status}, the oracle ${e.status}`);
          }
          record(`the view's rows (${engine})`, problems, `${rows.length} rows, each title and stamp as expected`);

          now = `totals ${engine}`;
          const shown = await viewTotals(page);
          record(`the view's totals equal the reference (${engine})`, totalsProblems('the view', plan.totals, shown),
            `Sem 1 ${plan.totals[1].counted} counted + ${plan.totals[1].confirm} to confirm + ${plan.totals[1].invite} if invited; Sem 2 ${plan.totals[2].counted} + ${plan.totals[2].confirm} + ${plan.totals[2].invite}`);

          now = `csv ${engine}`;
          try {
            const csv = await downloadCsv(page);
            const problems = [...csv.problems];
            if (!/^exchange-shortlist-.*\.csv$/.test(csv.name)) problems.push(`file name ${csv.name}`);
            const codes = csv.rows.map((r) => r.Code).sort();
            if (codes.join() !== plan.entries.map((e) => e.code).sort().join()) problems.push(`entries ${codes.join(', ')}`);
            record(`the CSV downloads (${engine})`, problems, `${csv.name}, ${csv.rows.length} entries, read back strictly`);
            const fromCsv = csvTotals(csv.tail);
            const match = totalsProblems('the CSV', plan.totals, fromCsv);
            for (const s of ['1', '2']) if (JSON.stringify(fromCsv[s]) !== JSON.stringify(shown[s])) match.push(`Sem ${s}: the CSV ${JSON.stringify(fromCsv[s])}, the view ${JSON.stringify(shown[s])}`);
            record(`the CSV's totals match the view's and the reference (${engine})`, match, 'both semesters');
          } catch (err) {
            record(`the CSV downloads (${engine})`, [firstLine(err)]);
          }

          if (engine === 'chromium') {
            now = 'pdf';
            const problems = [];
            try {
              await page.waitForFunction(() => document.documentElement.classList.contains('print-shortlist'));
              await page.evaluate(() => document.fonts.ready);
              const pdf = await page.pdf({ format: 'A4', margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }, tagged: true });
              // As export.spec.js: a system font may map U+2010 and U+2011 to "-" in the text layer.
              const fold = (/** @type {string} */ s) => squash(s).replace(/[‐‑]/g, '-');
              const pages = pdfPages(pdf);
              const all = fold(pages.join(''));
              if (!hasStructTree(pdf)) problems.push('not tagged (no structure tree)');
              for (const e of plan.entries) {
                const d = bodies.get(e.code)?.description;
                if (typeof d !== 'string' || !d) problems.push(`${e.code}: no description in /module's answer`);
                else if (!all.includes(fold(d))) problems.push(`${e.code}'s description missing`);
              }
              record('Chromium\'s tagged PDF holds every description', problems, `${pages.length} pages, ${plan.entries.length} descriptions`);
            } catch (err) {
              record('Chromium\'s tagged PDF holds every description', [firstLine(err)]);
            }
          }

          now = `axe ${engine}`;
          const axeProblems = [];
          for (const scheme of /** @type {const} */ (['light', 'dark'])) {
            await page.emulateMedia({ colorScheme: scheme });
            for (const v of await axeViolations(page)) axeProblems.push(`${scheme}: ${v}`);
          }
          await page.emulateMedia({ colorScheme: 'light' });
          record(`axe, every rule but AAA's 7:1, on the view, light and dark (${engine})`, axeProblems, 'zero violations');
        }
        await ctx.close();

        // 4. The fold on the view at 390×664: Chromium, and WebKit as an iPhone 13.
        const label = engine === 'chromium' ? 'chromium 390×664' : 'webkit iPhone 13';
        now = `fold ${label}`;
        const foldCtx = await browser.newContext(engine === 'chromium'
          ? { viewport: { width: 390, height: 664 }, userAgent: UA }
          : (() => { const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']; return { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent }; })());
        await site.route(foldCtx, engine, () => now);
        const p = await foldCtx.newPage();
        p.setDefaultTimeout(PAGE_TIMEOUT_MS);
        p.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
        let problems;
        try {
          await p.goto(`${opts.url}/?${plan.link}`);
          await rowsIn(p);
          problems = await viewFoldProblems(p);
        } catch (err) {
          problems = [firstLine(err)];
        }
        record(`fold on the view, ${label}`, problems, 'the header, the search bar, the view\'s heading, Back to results and the export buttons in view, no scroll');
        await foldCtx.close();
      } finally {
        await browser.close();
      }
    }
  } catch (err) {
    record(`the run (stopped at ${now})`, [firstLine(err)]);
  }

  // 5. Every call fetched first, none twice.
  /** @type {Map<string, number>} */
  const times = new Map();
  for (const c of site.network) times.set(c.path, (times.get(c.path) ?? 0) + 1);
  const twice = [...times].filter(([, k]) => k > 1).map(([path, k]) => `${path} ×${k}`);
  const apiSent = site.network.filter((c) => isApi(new URL(c.path, opts.url).pathname)).length;
  record('every API call fetched first, and no call sent twice', [
    ...site.unplanned.map((u) => `the page asked for ${u}, not fetched first`), ...twice.map((t) => `sent twice: ${t}`),
    ...(apiSent === plan.calls.length ? [] : [`${apiSent} API calls sent, ${plan.calls.length} planned`]),
  ], `${apiSent} API calls and ${site.network.length - apiSent} page files sent`);

  const failed = out.filter((o) => !o.pass).length;
  site.log({ check: 'summary', url: opts.url, corpus: opts.corpus, seed: opts.seed, sent: site.network.length, api: apiSent, files: site.network.length - apiSent, pass: out.length - failed, fail: failed, failures: out.filter((o) => !o.pass) });
  console.log(`\np6-live: ${out.length - failed} of ${out.length} checks pass, ${failed} fail; ${site.network.length} requests sent (${apiSent} API, ${site.network.length - apiSent} page files), one at a time, at least ${GAP_MS / 1000} s apart; log ${opts.log}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`p6-live: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  // Phase 7 7C: a run against a live URL leaves a run record (scripts/run-record.mjs), whatever the result.
  const outcomes = opts.plan ? await run(opts) : await recordedLiveRun('p6-live', opts, run);
  process.exit(outcomes.some((o) => !o.pass) ? 1 : 0);
}
