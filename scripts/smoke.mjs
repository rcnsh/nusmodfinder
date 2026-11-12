#!/usr/bin/env node
// @ts-check
// `npm run smoke -- [--expect <sha>] [--url <url>]` (Phase 7 7B): five requests to the live site,
// one at a time, each sent at least 4 s after the last answered:
//
//   /health          versionTag is a prefix of the expected commit, its data version is the
//                    commit's src/data-version.json, and the bundle is `production`
//   /                200, with the Content-Security-Policy header
//   /module/<code>   200, for a code in no group whose title is unique in that commit's corpus
//   /search?q=<title from /module>   `cache;desc=miss`, not degraded, the code in the top 5
//   /facets          200
//
// The expected commit (default HEAD; after a rollback, the target's) supplies the data version,
// the groups and the production bundle's code list (`git show <sha>:…`; the bundle from its
// release asset, sha-checked), so a rolled-back site is checked against its own data. Titles
// come from the production corpus (the Mac's .data/cache today; 7D's manifest replaces it). The
// draw is random, so the search is a cache miss. The URL is wrangler.jsonc's Custom Domain at
// that commit unless --url is given. Writes a run record.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { run } from './deploy.mjs';
import { startRun } from './run-record.mjs';

/** The least time between one answer and the next request. */
export const SMOKE_GAP_MS = 4000;
const TOP = 5;

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 * @typedef {import('./vectors-manifest.mjs').ManifestEntry} ManifestEntry
 * @typedef {{ name: string, pass: boolean, detail: string }} Outcome
 */

/**
 * The codes in a commit's production bundle: its release asset, downloaded if absent, sha-checked.
 * @param {ManifestEntry} entry
 * @returns {Promise<string[]>}
 */
async function bundleCodesOf(entry) {
  const { ghDownload, loadCheckedBundle, localPath } = await import('./vectors-manifest.mjs');
  const path = localPath(entry);
  if (!existsSync(path)) ghDownload(entry);
  const { bundle } = await loadCheckedBundle(entry, path);
  return bundle.codes;
}

/**
 * The production corpus's offered modules (code and title): .data/cache's moduleInfo for the
 * default year, as ingest read it. 7D's corpus manifest replaces this.
 * @returns {Promise<{ code: string, title: string }[]>}
 */
async function productionTitles() {
  const { DEFAULT_ACAD_YEAR, fetchAcadYearFile } = await import('./lib.mjs');
  const { data } = await fetchAcadYearFile(DEFAULT_ACAD_YEAR, 'moduleInfo.json', { offline: true });
  return /** @type {any[]} */ (data).filter((r) => (r.semesterData ?? []).length > 0).map((r) => ({ code: String(r.moduleCode), title: String(r.title) }));
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @param {string} flag */
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const known = new Set(['--expect', '--url']);
  const bad = argv.some((a, i) => (a.startsWith('--') ? !known.has(a) || !argv[i + 1] : !known.has(argv[i - 1])));
  return { expect: val('--expect') ?? 'HEAD', url: val('--url'), bad };
}

/**
 * Codes the smoke may draw: in the bundle, in no group, with a title no other offered module has.
 * @param {{ codes: string[], groups: string[][], corpus: { code: string, title: string }[] }} o
 */
export function candidates({ codes, groups, corpus }) {
  const inBundle = new Set(codes);
  const grouped = new Set(groups.flat());
  /** @type {Map<string, number>} */
  const titles = new Map();
  for (const m of corpus) titles.set(m.title.trim().toLowerCase(), (titles.get(m.title.trim().toLowerCase()) ?? 0) + 1);
  return corpus.filter((m) => inBundle.has(m.code) && !grouped.has(m.code) && titles.get(m.title.trim().toLowerCase()) === 1)
    .sort((a, b) => (a.code < b.code ? -1 : 1));
}

/**
 * @param {{ argv?: string[], exec?: Exec, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   random?: () => number, log?: (m: string) => void, error?: (m: string) => void, runsDir?: string,
 *   bundleCodes?: (entry: ManifestEntry) => Promise<string[]>, corpus?: () => Promise<{ code: string, title: string }[]> }} [o]
 * @returns {Promise<number>}
 */
export async function smoke({
  argv = process.argv.slice(2), exec = run, fetchImpl = fetch, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), now = Date.now,
  random = Math.random, log = console.log, error = console.error, runsDir, bundleCodes = bundleCodesOf, corpus = productionTitles,
} = {}) {
  const args = parseArgs(argv);
  if (args.bad) { error('usage: npm run smoke -- [--expect <sha>] [--url <url>]'); return 2; }
  const resolved = await exec('git', ['rev-parse', '--verify', `${args.expect}^{commit}`]);
  if (resolved.code !== 0) { error(`smoke: ${args.expect} is not a commit here (git fetch first?).`); return 2; }
  const sha = resolved.stdout.trim();
  /** @param {string} path */
  const show = async (path) => {
    const r = await exec('git', ['show', `${sha}:${path}`]);
    if (r.code !== 0) throw new Error(`git show ${sha.slice(0, 7)}:${path} failed`);
    return r.stdout;
  };
  /** @type {string} */
  let base;
  /** @type {string} */
  let dataVersion;
  /** @type {{ code: string, title: string }} */
  let pick;
  try {
    dataVersion = String(JSON.parse(await show('src/data-version.json')).version);
    const groups = /** @type {string[][]} */ (JSON.parse(await show('data/groups.json')).groups ?? []);
    const entry = JSON.parse(await show('data/vectors.json')).bundles?.production;
    if (!entry) throw new Error(`${sha.slice(0, 7)}'s data/vectors.json has no production bundle`);
    const pattern = args.url ? null : /"pattern"\s*:\s*"([^"]+)"/.exec(await show('wrangler.jsonc'))?.[1];
    if (!args.url && !pattern) throw new Error('no --url, and wrangler.jsonc names no route pattern');
    base = (args.url ?? `https://${pattern}`).replace(/\/+$/, '');
    const pool = candidates({ codes: await bundleCodes(entry), groups, corpus: await corpus() });
    if (!pool.length) throw new Error('no ungrouped, uniquely titled code in that commit\'s corpus and bundle');
    pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  } catch (err) {
    error(`smoke: ${/** @type {Error} */ (err).message}. Nothing was sent.`);
    return 1;
  }

  const record = startRun('smoke', { target: base, args: argv, dir: runsDir });
  const unguard = record.guardExit();
  const counted = record.countingFetch(fetchImpl);
  /** @type {number | null} */
  let lastAnswered = null;
  /** One request, sent at least SMOKE_GAP_MS after the last answer. @param {string} path */
  const send = async (path) => {
    if (lastAnswered !== null) {
      const wait = lastAnswered + SMOKE_GAP_MS - now();
      if (wait > 0) await sleep(wait);
    }
    try {
      const res = await counted(`${base}${path}`, { headers: { 'user-agent': 'nusmodfinder-smoke' } });
      const text = await res.text();
      return { res, text };
    } finally {
      lastAnswered = now();
    }
  };
  /** @param {string} text */
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  /** @type {Outcome[]} */
  const outcomes = [];
  /** @param {string} name @param {string[]} problems @param {string} ok */
  const note = (name, problems, ok) => {
    outcomes.push({ name, pass: problems.length === 0, detail: problems.length ? problems.join('; ') : ok });
    (problems.length ? error : log)(`smoke: ${name}: ${problems.length ? `FAIL ${problems.join('; ')}` : `ok (${ok})`}`);
  };
  try {
    log(`smoke: ${base}, expecting ${sha.slice(0, 7)} at data version ${dataVersion}; drew ${pick.code}`);
    {
      const { res, text } = await send('/health');
      const h = parse(text);
      const p = [];
      if (res.status !== 200 || !h) p.push(`HTTP ${res.status}`);
      else {
        if (!h.versionTag || !sha.startsWith(String(h.versionTag))) p.push(`the version tag ${h.versionTag ?? '(none)'} is not a prefix of ${sha.slice(0, 12)}`);
        if (h.dataVersion !== dataVersion) p.push(`data version ${h.dataVersion}, expected ${dataVersion}`);
        if (h.vectors?.corpus !== 'production') p.push(`bundle corpus ${h.vectors?.corpus ?? 'none'}, expected production`);
        else if (h.vectors?.dataVersion !== dataVersion) p.push(`bundle data version ${h.vectors?.dataVersion}, expected ${dataVersion}`);
        record.version('versionId', h.versionId ?? null);
        record.version('tag', h.versionTag ?? null);
      }
      note('/health', p, `tag ${h?.versionTag}, data version ${h?.dataVersion}, production bundle`);
    }
    {
      const { res } = await send('/');
      const p = [];
      if (res.status !== 200) p.push(`HTTP ${res.status}`);
      if (!res.headers.get('content-security-policy')) p.push('no Content-Security-Policy header');
      note('/', p, '200 with the CSP header');
    }
    /** @type {string | null} */
    let title = null;
    {
      const { res, text } = await send(`/module/${encodeURIComponent(pick.code)}`);
      const m = parse(text);
      const p = [];
      if (res.status !== 200 || !m) p.push(`/module/${pick.code} answered HTTP ${res.status}`);
      else if (m.code !== pick.code || typeof m.title !== 'string') p.push(`/module/${pick.code} answered code ${m.code}, title ${typeof m.title}`);
      else if (m.title.trim().toLowerCase() !== pick.title.trim().toLowerCase()) p.push(`/module/${pick.code}'s title "${m.title}" is not the corpus's "${pick.title}", so its uniqueness is unproven (a stale corpus?)`);
      else title = m.title;
      note(`/module/${pick.code}`, p, `"${title}"`);
    }
    if (title !== null) {
      const { res, text } = await send(`/search?${new URLSearchParams({ q: title })}`);
      const s = parse(text);
      const p = [];
      const timing = res.headers.get('server-timing') ?? '';
      if (res.status !== 200 || !s) p.push(`HTTP ${res.status}`);
      else {
        if (!/(^|,)\s*cache;desc=miss\b/.test(timing)) p.push(`not a cache miss (Server-Timing: ${timing || 'none'})`);
        if (s.degraded) p.push(`degraded (${s.degraded.source}-${s.degraded.reason})`);
        const top = (Array.isArray(s.results) ? s.results : []).slice(0, TOP).map((/** @type {any} */ r) => r.code);
        if (!top.includes(pick.code)) p.push(`${pick.code} is not in the top ${TOP} (${top.join(', ') || 'none'})`);
      }
      note('/search', p, `${pick.code} in the top ${TOP}, a cache miss, not degraded`);
    } else {
      note('/search', ['not sent: /module gave no title to search for'], '');
    }
    {
      const { res } = await send('/facets');
      note('/facets', res.status === 200 ? [] : [`HTTP ${res.status}`], '200');
    }
    const failed = outcomes.filter((o) => !o.pass);
    record.detail('checks', outcomes);
    record.detail('expect', sha);
    record.finish(failed.length ? 'failed' : 'ok', { exitCode: failed.length ? 1 : 0, message: `${outcomes.length - failed.length} of ${outcomes.length} checks pass` });
    (failed.length ? error : log)(`smoke: ${outcomes.length - failed.length} of ${outcomes.length} checks pass; run record ${record.path}`);
    return failed.length ? 1 : 0;
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    unguard();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await smoke();
}
