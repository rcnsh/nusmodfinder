#!/usr/bin/env node
// @ts-check
// The page ship's live checks (Phase 5 5G, docs/plans/phase5.md §3 5G), run by
// the lead after the deploy:
// - SC2 on 20 codes drawn with a fixed seed, 4 from each stratum of the
//   production-normalised modules: exams in two semesters, a cohort-only
//   prerequisite, no workload, two or more notes, plain. `?q=CODE&open=CODE`
//   must show each field or its "not listed" text (test/ui/sc2-fields.mjs, as
//   CI's test/ui/sc2.spec.js does for every fixture code);
// - axe, every rule but WCAG AAA's 7:1 (test/ui/support.mjs), on the first
//   screen, an open detail and the hidden codes, light and dark;
// - the 390×664 fold check, in Chromium and as an iPhone 13 in WebKit;
// - the hidden-code explanation for 3 drawn closed codes (one off the NG list,
//   one listed for the other semester only, one closed by a restriction), each
//   line, stamp and "Switch" button as the page's own rules say from the
//   code's /module answer; and 1 drawn partial code that exchange mode empties;
// - /health traces the commit: versionTag is HEAD's short sha (as
//   scripts/deploy.mjs tags it), the data version is src/data-version.json's,
//   and the bundle is the production one.
//
// Requests: every request the script or its browsers send to the site starts
// at least 4 s after the one before (the Worker's per-IP limiter, as Phase 4's
// sc1-live.mjs). The page's files, /facets, and any /search or /module answer
// already fetched are fetched once per run and then served to the browsers
// from memory. Each request, sent or served from memory, is a line in the
// JSONL log, and the run ends with a summary line. A 429 is waited out
// (Retry-After, at least 4 s) and re-sent, twice at most.
//
//   node scripts/p5-live.mjs [--url URL] [--log FILE] [--corpus production|fixture]
//                            [--expect-commit SHA|none] [--seed N] [--dry-run]
//
// --url            the site (default: production, docs/REFERENCE.md's Live URL)
// --log            the JSONL log (default docs/evidence/phase5/p5-live.jsonl), appended to
// --corpus         the modules drawn from: `production` (.data/cache's moduleInfo,
//                  normalised as ingest does) or `fixture` (test/fixtures/corpus.json,
//                  for the local UI server, `npm run dev`); default: fixture for a
//                  localhost URL, else production
// --expect-commit  the versionTag /health must give: a sha (default `git rev-parse
//                  HEAD`, compared by its prefix), or `none` for a local server, which
//                  has no version metadata; default: none for localhost
// --seed           the draw's seed (default 5)
// --dry-run        print the draw and send nothing
//
// Exit 0 when every check passes, 1 when one fails, 2 on a usage error. Against
// a live URL (not localhost) each run writes a run record with every request
// sent, by path (scripts/run-record.mjs, Phase 7 7C).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from '@playwright/test';
import { hiddenCodeLine, hiddenCodeStamp, partialCodeLine } from '../public/explain.js';
import { semLabel } from '../public/format.js';
import { readSc2, sc2Expected, sc2Problems } from '../test/ui/sc2-fields.mjs';
import { axeViolations } from '../test/ui/support.mjs';
import { CLOSED_KINDS, GAP_MS, drawHidden, drawSc2, loadModules, parseArgs, rng } from './p5-live-plan.mjs';
import { recordedLiveRun } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UA = devices['Desktop Chrome'].userAgent;
/** How long one page may take to show what a check waits for, its requests queued 4 s apart. */
const PAGE_TIMEOUT_MS = 180_000;

// ---------- requests: paced, logged, fetched once ----------

/**
 * One queue for every request to the site: each starts at least GAP_MS after
 * the last. Requests the page waits on (/search, /module, /facets, /health)
 * go before its files, so none waits past the page's 10 s fetch timeout.
 */
function createPacer() {
  /** @type {{ api: ((at: number) => void)[], asset: ((at: number) => void)[] }} */
  const waiting = { api: [], asset: [] };
  let last = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const pump = () => {
    if (timer || (!waiting.api.length && !waiting.asset.length)) return;
    timer = setTimeout(() => {
      timer = null;
      // A timer may fire a millisecond early: never grant a slot before its time.
      if (Date.now() - last >= GAP_MS) {
        const next = waiting.api.shift() ?? waiting.asset.shift();
        if (next) { last = Date.now(); next(last); }
      }
      pump();
    }, Math.max(0, last + GAP_MS - Date.now()));
  };
  /** Resolves with the time the slot was granted. @param {'api' | 'asset'} kind @returns {Promise<number>} */
  return (kind) => new Promise((resolve) => { waiting[kind].push(resolve); pump(); });
}

/** Paths the Worker answers (the rest are the page's static files). @param {string} path */
const isApi = (path) => path === '/search' || path === '/facets' || path === '/health' || path.startsWith('/module/') || path.startsWith('/admin');

/**
 * @param {{ url: string, log: string, onSend?: (path: string) => void }} opts
 *   `onSend`: each request sent to the network, by path (the run record, Phase 7 7C)
 */
function createSite(opts) {
  const slot = createPacer();
  /** @type {Map<string, { status: number, headers: Record<string, string>, body: Buffer }>} */
  const memory = new Map();
  let n = 0;
  let sent = 0;
  mkdirSync(dirname(opts.log), { recursive: true });
  /** One line per request (`source`: network, memory or refused), and the summary. @param {Record<string, unknown>} row */
  const log = (row) => appendFileSync(opts.log, `${JSON.stringify({ n: ++n, at: new Date().toISOString(), ...row })}\n`);

  /**
   * GET a path on the site: from memory if this run already has it, else
   * paced, with a 429 waited out and re-sent.
   * @param {string} pathAndQuery
   * @param {{ check: string, engine: string, send: () => Promise<{ status: number, headers: Record<string, string>, body: Buffer }>, keep?: boolean }} how
   */
  async function get(pathAndQuery, { check, engine, send, keep = true }) {
    const path = new URL(pathAndQuery, opts.url).pathname;
    const remembered = memory.get(pathAndQuery);
    if (remembered) {
      log({ check, engine, path: pathAndQuery, source: 'memory', status: remembered.status });
      return remembered;
    }
    for (let attempt = 1; ; attempt++) {
      const started = await slot(isApi(path) ? 'api' : 'asset');
      sent++;
      opts.onSend?.(path);
      let res;
      try {
        res = await send();
      } catch (err) {
        // Sent, but no answer (a reset, a timeout, the page gone): logged all the same.
        log({ at: new Date(started).toISOString(), check, engine, path: pathAndQuery, source: 'network', status: null, ms: Date.now() - started, error: String(/** @type {Error} */ (err).message).split('\n')[0], attempt });
        throw err;
      }
      // `at` is when the request was sent, so the log shows the 4 s spacing itself.
      log({
        at: new Date(started).toISOString(), check, engine, path: pathAndQuery, source: 'network', status: res.status, ms: Date.now() - started,
        cache: res.headers['cf-cache-status'] ?? null, version: res.headers['x-app-version'] ?? null, attempt,
      });
      if (res.status === 429 && attempt < 3) {
        const after = Number(res.headers['retry-after']);
        await new Promise((r) => setTimeout(r, Math.max(GAP_MS, Number.isFinite(after) ? after * 1000 : 0)));
        continue;
      }
      if (keep && res.status === 200) memory.set(pathAndQuery, res);
      return res;
    }
  }

  return {
    get, log, memory,
    /** @returns {number} requests sent over the network */
    sent: () => sent,
    /**
     * Routes a browser context's requests through `get`. Anything not on the
     * site is refused and logged (the page loads nothing from elsewhere).
     * @param {import('@playwright/test').BrowserContext} context
     * @param {string} engine
     * @param {() => string} check the check running now
     */
    async route(context, engine, check) {
      await context.route('**/*', async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.origin !== opts.url || req.method() !== 'GET') {
          log({ check: check(), engine, path: req.url(), source: 'refused', method: req.method() });
          await route.abort('blockedbyclient');
          return;
        }
        let res;
        try {
          res = await get(u.pathname + u.search, {
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
        // The page may have moved on (a superseded search) while this waited its turn.
        await route.fulfill({ status: res.status, headers: res.headers, body: res.body }).catch(() => {});
      });
    },
  };
}

// ---------- the checks ----------

/** @typedef {{ check: string, pass: boolean, detail: string }} Outcome */

/**
 * Whether the fold holds at the viewport: no scroll, the header's
 * "unofficial", the search bar, and the first entry's code, title and each
 * semester's status wholly in view (test/ui/fold.spec.js).
 * @param {import('@playwright/test').Page} page
 * @param {number} stamps
 * @returns {Promise<string[]>} what is out of view; [] when it holds
 */
async function foldProblems(page, stamps) {
  await page.locator('#results > li.card').first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  return page.evaluate(async (want) => {
    await document.fonts.ready;
    const out = [];
    if (window.scrollY !== 0) out.push(`scrolled to ${window.scrollY}`);
    const first = document.querySelector('#results > li.card');
    const unofficial = document.querySelector('h1 .unofficial');
    if (!/\(?unofficial\)?/.test(unofficial?.textContent ?? '')) out.push('the header doesn\'t say "unofficial"');
    const status = [...(first?.querySelectorAll('.exchange-status') ?? [])];
    if (status.length !== want) out.push(`${status.length} status stamps, expected ${want}`);
    /** @type {[string, Element | null | undefined][]} */
    const parts = [['"unofficial"', unofficial], ['the search box', document.getElementById('q')], ['Search', document.getElementById('go')],
      ['the first code', first?.querySelector('.code')], ['the first title', first?.querySelector('.title')], ...status.map((s, i) => /** @type {[string, Element]} */ ([`status ${i + 1}`, s]))];
    for (const [name, el] of parts) {
      const r = el?.getBoundingClientRect();
      if (!r || r.width === 0 || r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) out.push(`${name} not wholly in view`);
    }
    return out;
  }, stamps);
}

/**
 * @param {ReturnType<typeof parseArgs> & { onSend?: (path: string) => void }} opts
 * @returns {Promise<Outcome[]>}
 */
async function run(opts) {
  const modules = await loadModules(opts.corpus);
  const r = rng(opts.seed);
  const sc2 = drawSc2(modules, r);
  const hidden = drawHidden(modules, r);
  console.log(`p5-live: ${opts.url}, ${opts.corpus} modules (${modules.length}), seed ${opts.seed}`);
  console.log(`SC2 draw: ${sc2.map((d) => `${d.m.code} (${d.stratum})`).join(', ')}`);
  console.log(`hidden draw: ${hidden.closed.map((c) => `${c.m.code} (${c.kind}, Sem ${c.sem}, ${c.study})`).join(', ')}; partial ${hidden.partial ? `${hidden.partial.prefix} (Sem ${hidden.partial.sem}, ${hidden.partial.study})` : 'none'}`);
  if (opts.dryRun) return [];

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

  // Every check, then the summary, even if one throws (the site unreachable,
  // a browser crash): the log always ends with what passed and what didn't.
  try {
    // /health traces the commit.
    now = 'health';
    {
      const problems = [];
      /** @type {any} */
      let h = null;
      try {
        const res = await site.get('/health', {
          check: now, engine: 'node', keep: false,
          send: async () => {
            const x = await fetch(`${opts.url}/health`, { headers: { 'user-agent': UA } });
            return { status: x.status, headers: Object.fromEntries(x.headers), body: Buffer.from(await x.arrayBuffer()) };
          },
        });
        try { h = JSON.parse(res.body.toString('utf8')); } catch { problems.push(`not JSON (HTTP ${res.status})`); }
      } catch (err) {
        problems.push(`no answer: ${String(/** @type {Error} */ (err).message).split('\n')[0]}`);
      }
      if (h) {
        const dataVersion = JSON.parse(readFileSync(`${ROOT}src/data-version.json`, 'utf8')).version;
        const head = opts.expectCommit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
        if (h.ok !== true) problems.push('ok is not true');
        if (opts.expectCommit === 'none') { if (h.versionTag !== null) problems.push(`versionTag ${h.versionTag}, expected none`); }
        else if (typeof h.versionTag !== 'string' || h.versionTag.length < 7 || !head.startsWith(h.versionTag)) problems.push(`versionTag ${h.versionTag}, expected a prefix of ${head}`);
        if (h.dataVersion !== dataVersion) problems.push(`dataVersion ${h.dataVersion}, expected ${dataVersion}`);
        if (h.vectors?.corpus !== opts.corpus) problems.push(`vectors.corpus ${h.vectors?.corpus}, expected ${opts.corpus}`);
      }
      record('/health traces the commit', problems, h ? `versionTag ${h.versionTag}, versionId ${h.versionId}, dataVersion ${h.dataVersion}, ${h.vectors?.corpus} bundle` : '');
    }

    const browser = await chromium.launch();
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: UA });
    await site.route(desk, 'chromium', () => now);
    const page = await desk.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
    /** axe in light and dark at the widths given, without reloading. @param {string} name @param {[number, number][]} sizes */
    const axeHere = async (name, sizes) => {
      const problems = [];
      for (const scheme of /** @type {const} */ (['light', 'dark'])) {
        for (const [width, height] of sizes) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height });
          for (const v of await axeViolations(page)) problems.push(`${scheme} ${width}: ${v}`);
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1280, height: 800 });
      record(`axe, every rule: ${name}, light and dark`, problems, 'zero violations');
    };

    try {
      // The first screen: its files are fetched once here; then axe on it.
      now = 'first screen';
      await page.goto(`${opts.url}/`);
      await page.locator('#setupSources td').nth(1).filter({ hasNotText: '…' }).waitFor();
      await axeHere('the first screen', [[1280, 800], [390, 664]]);

      // SC2 on the 20 drawn codes.
      for (const { stratum, m } of sc2) {
        now = `SC2 ${m.code}`;
        let problems;
        try {
          await page.goto(`${opts.url}/?q=${encodeURIComponent(m.code)}&open=${encodeURIComponent(m.code)}`);
          problems = sc2Problems(await readSc2(page, m.code, PAGE_TIMEOUT_MS), sc2Expected(m));
        } catch (err) {
          problems = [String(/** @type {Error} */ (err).message).split('\n')[0]];
        }
        record(`SC2 ${m.code} (${stratum})`, problems, 'every field');
      }
      now = 'axe detail';
      await axeHere(`an open detail (${sc2.at(-1)?.m.code})`, [[1280, 800], [390, 664]]);

      // The hidden-code explanations: each line, stamp and switch as the page's
      // rules give them from the code's own /module answer and /facets' sources.
      const facets = JSON.parse(site.memory.get('/facets')?.body.toString('utf8') ?? 'null');
      for (const c of hidden.closed) {
        now = `hidden ${c.m.code}`;
        const problems = [];
        try {
          await page.goto(`${opts.url}/?q=${c.m.code}&sem=${c.sem}&ng=1&study=${c.study}`);
          const li = page.locator(`#status .hidden-codes li[data-code="${c.m.code}"]`);
          await li.locator('.hc-stamp .st').waitFor();
          const body = JSON.parse(site.memory.get(`/module/${c.m.code}`)?.body.toString('utf8') ?? 'null');
          const filters = { sem: c.sem, ng: true, study: c.study };
          const line = hiddenCodeLine({ code: c.m.code, sem: String(c.sem), study: c.study, exchange: body?.exchange, sources: facets?.ngSources ?? null, module: body, filters });
          const stamp = hiddenCodeStamp({ sem: String(c.sem), study: c.study, exchange: body?.exchange });
          const got = await li.evaluate((el) => ({
            why: el.querySelector('.why')?.textContent ?? '', stamp: el.querySelector('.hc-stamp')?.textContent ?? '',
            button: el.querySelector('.switch-sem')?.textContent ?? null,
          }));
          // The page's rules, from the code's own /module answer and /facets' sources...
          if (got.why !== line) problems.push(`line "${got.why}", expected "${line}"`);
          if (got.stamp !== stamp.text) problems.push(`stamp "${got.stamp}", expected "${stamp.text}"`);
          // ...and what the drawn kind and the oracle say, independent of that answer.
          if (got.stamp !== c.stamp) problems.push(`stamp "${got.stamp}", expected "${c.stamp}" for a code ${c.kind}`);
          const wantButton = c.otherOpen ? `Switch to ${semLabel(c.sem === 1 ? 2 : 1)} to see ${c.m.code}` : null;
          if (got.button !== wantButton) problems.push(`switch ${JSON.stringify(got.button)}, expected ${JSON.stringify(wantButton)}`);
          // Never a result (SC1): not an entry, not another entry's "Also as".
          if (await page.locator(`#results [data-code="${c.m.code}"], #results [data-variant="${c.m.code}"]`).count()) problems.push('shown as a result');
        } catch (err) {
          problems.push(String(/** @type {Error} */ (err).message).split('\n')[0]);
        }
        record(`hidden code ${c.m.code} (${c.kind}; Sem ${c.sem}, ${c.study})`, problems, 'its own reasons, stamp and switch');
      }
      now = 'axe hidden';
      if (hidden.closed.length) await axeHere(`a hidden code (${hidden.closed.at(-1)?.m.code})`, [[1280, 800], [390, 664]]);
      if (hidden.closed.length < CLOSED_KINDS.length) record('hidden codes drawn', [`${hidden.closed.length} of ${CLOSED_KINDS.length} kinds found`]);

      if (hidden.partial) {
        const p = hidden.partial;
        now = `partial ${p.prefix}`;
        const problems = [];
        try {
          await page.goto(`${opts.url}/?q=${p.prefix}&sem=${p.sem}&ng=1&study=${p.study}`);
          const want = partialCodeLine({ prefix: p.prefix, sem: String(p.sem), study: p.study, otherHasResults: p.otherHasResults });
          const wantButton = p.otherHasResults ? `See ${semLabel(p.sem === 1 ? 2 : 1)} courses` : null;
          // Settled: the other semester checked (a button, or the either-semester line).
          await page.waitForFunction(() => !!document.querySelector('#status .see-other') || /either semester/.test(document.querySelector('#status .partial')?.textContent ?? ''));
          const got = await page.evaluate(() => ({ line: document.querySelector('#status .partial')?.textContent ?? null, button: document.querySelector('#status .see-other')?.textContent ?? null, cards: document.querySelectorAll('#results > li.card').length }));
          if (got.line !== want) problems.push(`line ${JSON.stringify(got.line)}, expected "${want}"`);
          if (got.button !== wantButton) problems.push(`button ${JSON.stringify(got.button)}, expected ${JSON.stringify(wantButton)}`);
          if (got.cards) problems.push(`${got.cards} results shown`);
        } catch (err) {
          problems.push(String(/** @type {Error} */ (err).message).split('\n')[0]);
        }
        record(`partial code ${p.prefix} (Sem ${p.sem}, ${p.study})`, problems, 'the line and the button');
      } else {
        record('partial code drawn', ['no prefix is emptied at any drawn semester and year']);
      }

      // The fold at 390×664: Chromium, then WebKit as an iPhone 13 (SC8).
      const FOLD = /** @type {const} */ ([['Sem 1', `/?q=ACC1701XB&sem=1&ng=1&study=ug2`, 1], ['both semesters', `/?q=ACC1701XB&ng=1&study=ug2`, 2]]);
      for (const [engine, launch, ctxOpts] of /** @type {const} */ ([
        ['chromium 390×664', null, { viewport: { width: 390, height: 664 }, userAgent: UA }],
        ['webkit iPhone 13', webkit, (() => { const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['iPhone 13']; return { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent }; })()],
      ])) {
        const b = launch ? await launch.launch() : browser;
        try {
          const ctx = await b.newContext(ctxOpts);
          await site.route(ctx, engine.split(' ')[0], () => now);
          const p = await ctx.newPage();
          p.setDefaultTimeout(PAGE_TIMEOUT_MS);
          p.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
          for (const [label, path, stamps] of FOLD) {
            now = `fold ${engine} ${label}`;
            let problems;
            try {
              await p.goto(`${opts.url}${path}`);
              problems = await foldProblems(p, stamps);
            } catch (err) {
              problems = [String(/** @type {Error} */ (err).message).split('\n')[0]];
            }
            record(`fold, ${engine}: ACC1701XB, ${label}`, problems, 'the header, the bar and the first entry in view');
          }
          await ctx.close();
        } finally {
          if (launch) await b.close();
        }
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    record(`the run (stopped at ${now})`, [String(/** @type {Error} */ (err).message).split('\n')[0]]);
  }
  const failed = out.filter((o) => !o.pass).length;
  site.log({ check: 'summary', url: opts.url, corpus: opts.corpus, seed: opts.seed, sent: site.sent(), pass: out.length - failed, fail: failed, failures: out.filter((o) => !o.pass) });
  console.log(`\np5-live: ${out.length - failed} of ${out.length} checks pass, ${failed} fail; ${site.sent()} requests sent, at least ${GAP_MS / 1000} s apart; log ${opts.log}`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`p5-live: ${/** @type {Error} */ (err).message}`);
    process.exit(2);
  }
  // Phase 7 7C: a run against a live URL leaves a run record (scripts/run-record.mjs), whatever the result.
  const outcomes = opts.dryRun ? await run(opts) : await recordedLiveRun('p5-live', opts, run);
  process.exit(outcomes.some((o) => !o.pass) ? 1 : 0);
}
