#!/usr/bin/env node
// @ts-check
// Phase 5 red team: one persona's browser on the live page, driven by
// act.mjs. The lead starts it before the persona runs and stops it after; the
// persona only ever talks to it through act.mjs.
//
//   node docs/evidence/phase5/redteam/session.mjs <persona-id> --kit <K> --state <S> [--origin URL]
//
// Requests (the brief's live-traffic limits, enforced here):
// - every request the browser makes to the live host waits for one gate
//   shared by every session process (a lock directory and a `last` file in
//   <S>), and starts at least GAP_MS after the previous one, whichever
//   persona sent it; requests the page waits on (/search, /module, /facets,
//   /health) take the next slot before the page's files;
// - the page's files (any path the Worker doesn't answer) are fetched once
//   for all personas and served from <S>/cache after that, as a browser cache
//   would; an API answer with `Cache-Control: max-age=N` is served from
//   <S>/cache for N seconds, as the browser would;
// - at most TOTAL_MAX requests reach the site over all sessions (the count
//   lives in <S>/sent), and at most p.maxRequests (default PERSONA_MAX) for
//   this persona; past that the page gets a failed request;
// - anything not to the live host, and any non-GET, is refused;
// - every request, sent, served from cache or refused, is a line in
//   docs/evidence/phase5/redteam/requests-<persona>.jsonl.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, devices, webkit } from '@playwright/test';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
/** The live site; `--origin` points a dry run at a local `npm run dev` instead. */
export const LIVE = arg('--origin') ?? 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
export const GAP_MS = 4_000;
export const TOTAL_MAX = 400;
const PERSONA_MAX = 120;
const HERE = new URL('.', import.meta.url);

const id = process.argv[2];
const K = arg('--kit');
const S = arg('--state');
const personas = JSON.parse(readFileSync(new URL('personas.json', HERE), 'utf8'));
const p = personas[id];
if (!p || !K || !S) { console.error('usage: session.mjs <persona-id> --kit <K> --state <S>'); process.exit(2); }
const MAX = p.maxRequests ?? PERSONA_MAX;
mkdirSync(`${S}/cache`, { recursive: true });
mkdirSync(`${K}/${id}/shots`, { recursive: true });
const LOG = arg('--origin') ? `${S}/requests-dry-${id}.jsonl` : new URL(`requests-${id}.jsonl`, HERE);
const ACTIONS = `${K}/${id}/actions.jsonl`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
let mine = 0;
/** @param {Record<string, unknown>} row */
const log = (row) => appendFileSync(LOG, `${JSON.stringify({ persona: id, n: ++n, at: new Date().toISOString(), ...row })}\n`);

/** Paths the Worker answers; the rest are the page's files. @param {string} path */
const isApi = (path) => path === '/search' || path === '/facets' || path === '/health' || path.startsWith('/module/') || path.startsWith('/admin');

// ---------- the cross-process gate ----------
async function lock() {
  for (;;) {
    try { mkdirSync(`${S}/lock`); return; } catch { /* held */ }
    try { if (Date.now() - Number(readFileSync(`${S}/lock-at`, 'utf8')) > 120_000) rmSync(`${S}/lock`, { recursive: true, force: true }); } catch { /* none */ }
    await sleep(50);
  }
}
const unlock = () => rmSync(`${S}/lock`, { recursive: true, force: true });
const readNum = (f) => { try { return Number(readFileSync(f, 'utf8')) || 0; } catch { return 0; } };

// In-process: one request at a time to the gate, API before files.
/** @type {{ api: (() => void)[], asset: (() => void)[] }} */
const waiting = { api: [], asset: [] };
let busy = false;
function pump() {
  if (busy) return;
  const next = waiting.api.shift() ?? waiting.asset.shift();
  if (next) { busy = true; next(); }
}
/** @param {'api' | 'asset'} kind */
const turn = (kind) => new Promise((resolve) => { waiting[kind].push(() => resolve(undefined)); pump(); });
const done = () => { busy = false; pump(); };

/**
 * Sends one request through the gate. Returns null when a budget refuses it.
 * @param {() => Promise<{ status: number, headers: Record<string, string>, body: Buffer }>} send
 * @param {string} path
 */
async function gated(send, path) {
  await turn(isApi(new URL(path, LIVE).pathname) ? 'api' : 'asset');
  try {
    await lock();
    writeFileSync(`${S}/lock-at`, String(Date.now()));
    try {
      const sent = readNum(`${S}/sent`);
      if (sent >= TOTAL_MAX || mine >= MAX) { log({ path, source: 'refused', why: sent >= TOTAL_MAX ? 'total budget' : 'persona budget' }); return null; }
      const wait = readNum(`${S}/last`) + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const started = Date.now();
      writeFileSync(`${S}/last`, String(started));
      writeFileSync(`${S}/sent`, String(sent + 1));
      mine++;
      try {
        const res = await send();
        writeFileSync(`${S}/last`, String(Math.max(started, readNum(`${S}/last`))));
        log({ at: new Date(started).toISOString(), path, source: 'network', status: res.status, ms: Date.now() - started, cache: res.headers['cf-cache-status'] ?? null, version: res.headers['x-app-version'] ?? null, total: sent + 1 });
        return res;
      } catch (err) {
        log({ at: new Date(started).toISOString(), path, source: 'network', status: null, ms: Date.now() - started, error: String(/** @type {Error} */ (err).message).split('\n')[0], total: sent + 1 });
        throw err;
      }
    } finally { unlock(); }
  } finally { done(); }
}

// ---------- the shared cache ----------
const keyFile = (key) => `${S}/cache/${createHash('sha1').update(key).digest('hex')}.json`;
/** @param {string} key */
function cached(key) {
  const f = keyFile(key);
  if (!existsSync(f)) return null;
  const c = JSON.parse(readFileSync(f, 'utf8'));
  if (c.expires && c.expires < Date.now()) return null;
  return { status: c.status, headers: c.headers, body: Buffer.from(c.body, 'base64') };
}
/** @param {string} key @param {{ status: number, headers: Record<string, string>, body: Buffer }} res @param {number | null} expires */
const store = (key, res, expires) => writeFileSync(keyFile(key), JSON.stringify({ status: res.status, headers: res.headers, body: res.body.toString('base64'), expires }));

/** @param {Record<string, string>} h */
const clean = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())));

// ---------- the browser ----------
const engine = p.browser === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const context = await browser.newContext({ ...devices[p.device], ...(p.mode === 'phone' ? {} : { viewport: { width: 1280, height: 800 } }) });
let pending = 0;
let lastActivity = Date.now();
await context.route('**/*', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const path = u.pathname + u.search;
  if (u.origin !== LIVE || req.method() !== 'GET') {
    log({ path: req.url(), source: 'refused', method: req.method(), why: 'not a GET to the live host' });
    await route.abort('blockedbyclient').catch(() => {});
    return;
  }
  pending++;
  try {
    const api = isApi(u.pathname);
    const key = api ? path : u.pathname;
    let res = cached(key);
    if (res) log({ path, source: 'cache', status: res.status });
    else {
      try {
        res = await gated(async () => {
          const r = await route.fetch({ maxRedirects: 0, timeout: 60_000 });
          return { status: r.status(), headers: r.headers(), body: await r.body() };
        }, path);
      } catch { res = null; }
      if (!res) { await route.abort('failed').catch(() => {}); return; }
      const cc = res.headers['cache-control'] ?? '';
      const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 0);
      if (!api && res.status === 200) store(key, res, null);
      else if (api && maxAge > 0 && !/no-store/.test(cc) && (res.status === 200 || res.status === 404)) store(key, res, Date.now() + maxAge * 1000);
    }
    await route.fulfill({ status: res.status, headers: clean(res.headers), body: res.body }).catch(() => {});
  } finally { pending--; lastActivity = Date.now(); }
});
const page = await context.newPage();

/** Waits until no routed request is pending and nothing new for `quiet` ms (at most 90 s). */
async function settle(quiet = 1200) {
  const until = Date.now() + 90_000;
  await sleep(150);
  while (Date.now() < until) {
    if (pending === 0 && Date.now() - lastActivity >= quiet) return;
    await sleep(100);
  }
}

const describeFocus = async () => {
  const f = page.locator('*:focus');
  if (!(await f.count())) return 'focus: (the page itself, nothing focused)';
  const snap = await f.first().ariaSnapshot().catch(() => '');
  return `focus:\n${snap.length > 1500 ? `${snap.slice(0, 1500)}\n… (truncated)` : snap}`;
};

let shotN = 0;
const ALLOWED = {
  keyboard: ['goto', 'key', 'type', 'focus', 'read', 'shot', 'url', 'wait'],
  ax: ['goto', 'key', 'type', 'focus', 'tree', 'url', 'wait'],
  phone: ['goto', 'tap', 'fill', 'select', 'scroll', 'read', 'shot', 'url', 'wait', 'key', 'type', 'back'],
}[p.mode];

/** @param {string} cmd @param {string[]} a */
async function run(cmd, a) {
  if (!ALLOWED.includes(cmd)) return `"${cmd}" isn't available to you. You can use: ${ALLOWED.join(', ')}.`;
  switch (cmd) {
    case 'goto': {
      const path = a[0] ?? '/';
      if (!path.startsWith('/')) return 'goto takes a path on the site, starting with "/".';
      await page.goto(LIVE + path, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      await settle();
      return `loaded ${page.url()}`;
    }
    case 'key': {
      const times = Math.min(Number(a[1] ?? 1) || 1, 40);
      for (let i = 0; i < times; i++) { await page.keyboard.press(a[0]); await sleep(60); }
      await settle();
      return describeFocus();
    }
    case 'type': await page.keyboard.type(a.join(' '), { delay: 20 }); await settle(); return describeFocus();
    case 'focus': return describeFocus();
    case 'tree': return page.locator('body').ariaSnapshot();
    case 'read': return page.locator('body').innerText();
    case 'shot': {
      const file = `${K}/${id}/shots/${String(++shotN).padStart(3, '0')}.png`;
      await page.screenshot({ path: file, fullPage: a[0] === 'full' });
      return `screenshot saved: ${file}`;
    }
    case 'url': return page.url();
    case 'wait': await settle(Math.min(Number(a[0] ?? 2) * 1000, 30_000)); return 'waited';
    case 'tap': case 'fill': {
      const [role, name, ...rest] = a;
      const loc = page.getByRole(/** @type {any} */ (role), { name, exact: false });
      const nth = cmd === 'tap' && rest[0] ? Number(rest[0]) : 0;
      const count = await loc.count();
      if (!count) return `nothing with role "${role}" and name containing "${name}" is on the page.`;
      if (cmd === 'tap') await loc.nth(nth).tap({ timeout: 10_000 });
      else await loc.first().fill(rest.join(' '), { timeout: 10_000 });
      await settle();
      return `${cmd === 'tap' ? 'tapped' : 'filled'} ${role} "${name}"${count > 1 ? ` (${count} matches; used #${nth})` : ''}; now at ${page.url()}`;
    }
    case 'select': {
      const [label, option] = a;
      await page.getByLabel(label).first().selectOption({ label: option }, { timeout: 10_000 });
      await settle();
      return `selected "${option}"`;
    }
    case 'scroll': {
      const dir = a[0] ?? 'down';
      await page.evaluate((d) => {
        if (d === 'top') window.scrollTo(0, 0);
        else if (d === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        else window.scrollBy(0, (d === 'up' ? -1 : 1) * window.innerHeight * 0.8);
      }, dir);
      await sleep(300);
      return `scrolled ${dir}; at y=${await page.evaluate(() => Math.round(window.scrollY))} of ${await page.evaluate(() => document.body.scrollHeight)}`;
    }
    case 'back': await page.goBack({ timeout: 120_000 }).catch(() => {}); await settle(); return `now at ${page.url()}`;
    default: return `unknown command ${cmd}`;
  }
}

let queue = Promise.resolve();
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    queue = queue.then(async () => {
      let out;
      try {
        const { cmd, args } = JSON.parse(body);
        if (cmd === '__stop') { out = 'stopping'; setTimeout(async () => { await browser.close(); server.close(); process.exit(0); }, 100); }
        else out = await run(String(cmd), Array.isArray(args) ? args.map(String) : []);
        appendFileSync(ACTIONS, `${JSON.stringify({ at: new Date().toISOString(), cmd, args, out: String(out).slice(0, 400) })}\n`);
      } catch (err) { out = `error: ${String(/** @type {Error} */ (err).message).split('\n')[0]}`; }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(out));
    });
  });
});
server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  writeFileSync(`${K}/.port`, String(port));
  console.log(`session ${id} (${p.mode}, ${p.browser} ${p.device}) on 127.0.0.1:${port}`);
});
