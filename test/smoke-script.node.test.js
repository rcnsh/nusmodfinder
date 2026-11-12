// @ts-check
// `npm run smoke -- [--expect <sha>]` (scripts/smoke.mjs), five requests each at
// least 4 s after the last: /health (the tag, the data version, the production bundle), / (200
// with the CSP header), /module/<code> for an ungrouped, uniquely titled code of the expected
// commit's corpus, /search for that title (a cache miss, not degraded, the code in the top 5)
// and /facets. The data version, groups and bundle come from that commit's files (`git show
// <sha>:…`). A fake site, git and clock: nothing here sends a request.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR as Y } from '../scripts/lib.mjs';
import { SMOKE_GAP_MS, smoke } from '../scripts/smoke.mjs';

const SHA = 'b75ac19016a2073e77d37c2c44485c9a5d8c99a2';
const OTHER = '8e24b21ddfcacc5cc67edf4a7cd07c41aaa5a690';
/** @type {Record<string, string>} */
const DVS = { [SHA]: 'd820d578cf81', [OTHER]: '0123456789ab' };
const URL_BASE = 'https://nusmodfinder.rcn.sh';
const PRODUCTION_ENTRY = { corpus: 'production', release: 'vec-production-x', asset: 'vec-production-x.bin', sha256: 'abc', count: 5 };
/** The corpus: CS1010 is grouped, CS2030/CS2040 share a title, CS3230 is unique, CS9999 is not in the bundle. */
const CORPUS = [
  { code: 'CS1010', title: 'Programming Methodology' },
  { code: 'CS1010E', title: 'Programming Methodology II' },
  { code: 'CS2030', title: 'Software Engineering' },
  { code: 'CS2040', title: 'Software Engineering' },
  { code: 'CS3230', title: 'Design and Analysis of Algorithms' },
  { code: 'CS9999', title: 'A Title Nobody Else Has' },
];
const BUNDLE_CODES = ['CS1010', 'CS1010E', 'CS2030', 'CS2040', 'CS3230'];
/** The expected commit's corpus manifest: its `current` is the corpus titles come from. */
const CORPUS_ENTRY = { year: Y, release: `prod-${Y}-29991231`, asset: `${Y}-moduleInfo.json.gz`, sha256: 'c'.repeat(64), bytes: 1, fetchedAt: '2999-12-31T00:00:00Z' };
const CORPUS_MANIFEST = { schema: 'vnm-corpus-manifest/1', current: CORPUS_ENTRY.release, corpora: { [CORPUS_ENTRY.release]: CORPUS_ENTRY } };
const GROUPS = { schema: 'vnm-groups/1', groups: [['CS1010', 'CS1010E']] };

/** @param {string} sha @param {{ manifest?: boolean }} [o] */
function fakeExec(sha = SHA, o = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    if (key === `git rev-parse --verify ${sha}^{commit}` || key === 'git rev-parse --verify HEAD^{commit}') return { code: 0, stdout: `${sha}\n` };
    if (key === `git show ${sha}:src/data-version.json`) return { code: 0, stdout: JSON.stringify({ version: DVS[sha] }) };
    if (key === `git show ${sha}:data/groups.json`) return { code: 0, stdout: JSON.stringify(GROUPS) };
    if (key === `git show ${sha}:data/corpus.json`) return o.manifest === false ? { code: 128, stdout: '' } : { code: 0, stdout: JSON.stringify(CORPUS_MANIFEST) };
    if (key === `git show ${sha}:data/vectors.json`) return { code: 0, stdout: JSON.stringify({ bundles: { production: PRODUCTION_ENTRY } }) };
    if (key === `git show ${sha}:wrangler.jsonc`) return { code: 0, stdout: '{\n  // c\n  "routes": [{ "pattern": "nusmodfinder.rcn.sh", "custom_domain": true }]\n}\n' };
    throw new Error(`unexpected command: ${key}`);
  };
  return { exec, calls };
}

/**
 * The live site, healthy unless told otherwise; a fake clock that sleep() advances.
 * @param {{ sha?: string, tag?: string, dataVersion?: string, corpus?: string, cache?: string, degraded?: boolean, csp?: boolean,
 *   top?: (code: string) => string[], moduleStatus?: number }} [o]
 */
function fakeSite(o = {}) {
  let clock = 0;
  /** @type {{ path: string, at: number }[]} */
  const sent = [];
  const sha = o.sha ?? SHA;
  /** @type {typeof fetch} */
  const fetchImpl = async (input) => {
    const u = new URL(String(input));
    sent.push({ path: u.pathname + u.search, at: clock });
    clock += 250; // each request takes a while
    if (u.pathname === '/health') {
      return Response.json({ ok: true, versionId: 'v', versionTag: o.tag ?? sha.slice(0, 7), dataVersion: o.dataVersion ?? DVS[sha], vectors: { corpus: o.corpus ?? 'production', count: 5, dataVersion: o.dataVersion ?? DVS[sha] } });
    }
    if (u.pathname === '/') return new Response('<!doctype html>', { headers: o.csp === false ? {} : { 'content-security-policy': "default-src 'none'" } });
    if (u.pathname.startsWith('/module/')) {
      const code = u.pathname.slice('/module/'.length);
      const m = CORPUS.find((x) => x.code === code);
      return Response.json({ code, title: m?.title }, { status: o.moduleStatus ?? 200 });
    }
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q') ?? '';
      const code = CORPUS.find((x) => x.title === q)?.code ?? '';
      const codes = o.top ? o.top(code) : [code, 'MA1521'];
      return Response.json({ query: q, count: codes.length, results: codes.map((c) => ({ code: c })), ...(o.degraded ? { degraded: { source: 'workers-ai', reason: 'timeout' } } : {}) },
        { headers: { 'server-timing': `cache;desc=${o.cache ?? 'miss'}, total;dur=40` } });
    }
    if (u.pathname === '/facets') return Response.json({ faculties: [] });
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, sent, sleep: async (/** @type {number} */ ms) => { clock += ms; }, now: () => clock };
}

/** @type {string} */
let runsDir;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'vnm-smoke-runs-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });
const records = () => readdirSync(runsDir).sort().map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')));

/** @param {ReturnType<typeof fakeSite>} site @param {{ argv?: string[], sha?: string, random?: () => number, manifest?: boolean }} [o] */
async function run(site, o = {}) {
  const { exec, calls } = fakeExec(o.sha ?? SHA, { manifest: o.manifest });
  /** @type {string[]} */
  const out = [];
  /** @type {any[]} */
  const entries = [];
  /** @type {any[]} */
  const corpora = [];
  const code = await smoke({
    argv: o.argv ?? [], exec, fetchImpl: site.fetchImpl, sleep: site.sleep, now: site.now, random: o.random ?? (() => 0.5),
    log: (m) => out.push(m), error: (m) => out.push(m), runsDir,
    bundleCodes: async (entry) => { entries.push(entry); return BUNDLE_CODES; }, corpus: async (entry) => { corpora.push(entry); return CORPUS; },
  });
  return { code, out: out.join('\n'), calls, entries, corpora };
}

describe('npm run smoke', () => {
  it('passes on a healthy site: five requests in order, each at least 4 s after the last, with a record', async () => {
    const site = fakeSite();
    const { code } = await run(site);
    expect(code).toBe(0);
    expect(site.sent.map((s) => s.path)).toEqual(['/health', '/', '/module/CS3230', `/search?q=${encodeURIComponent('Design and Analysis of Algorithms').replaceAll('%20', '+')}`, '/facets']);
    for (let i = 1; i < site.sent.length; i++) expect(site.sent[i].at - site.sent[i - 1].at).toBeGreaterThanOrEqual(SMOKE_GAP_MS);
    expect(SMOKE_GAP_MS).toBeGreaterThanOrEqual(4000);
    expect(records()).toEqual([expect.objectContaining({ script: 'smoke', outcome: 'ok', target: URL_BASE, requests: { '/health': 1, '/': 1, '/module/CS3230': 1, '/search': 1, '/facets': 1 } })]);
  });

  it('fails on a tag mismatch, a wrong data version, a non-production bundle, a missing CSP, a cache hit, a degraded answer or the code outside the top 5', async () => {
    /** @type {[Parameters<typeof fakeSite>[0], RegExp][]} */
    const cases = [
      [{ tag: 'feedfac' }, /tag/],
      [{ dataVersion: 'ffffffffffff' }, /data version/],
      [{ corpus: 'fixture' }, /production/],
      [{ csp: false }, /content-security-policy/i],
      [{ cache: 'hit' }, /cache/],
      [{ degraded: true }, /degraded/],
      [{ top: (c) => ['A1', 'A2', 'A3', 'A4', 'A5', c] }, /top 5/],
      [{ moduleStatus: 404 }, /module/],
    ];
    for (const [over, msg] of cases) {
      const site = fakeSite(over);
      const { code, out } = await run(site);
      expect(code, JSON.stringify(over)).toBe(1);
      expect(out).toMatch(msg);
      expect(site.sent.length).toBeLessThanOrEqual(5);
    }
    expect(records().every((r) => r.outcome === 'failed')).toBe(true);
  });

  it('--expect reads that commit\'s files and expects its tag and data version', async () => {
    const site = fakeSite({ sha: OTHER });
    const { code, calls, entries } = await run(site, { argv: ['--expect', OTHER], sha: OTHER });
    expect(code).toBe(0);
    for (const f of ['src/data-version.json', 'data/groups.json', 'data/vectors.json']) expect(calls).toContainEqual(['git', 'show', `${OTHER}:${f}`]);
    expect(entries).toEqual([PRODUCTION_ENTRY]);
  });

  it('draws only ungrouped codes whose title is unique in the corpus and which the bundle holds', async () => {
    for (const r of [0, 0.2, 0.5, 0.8, 0.99]) {
      const site = fakeSite();
      expect((await run(site, { random: () => r })).code).toBe(0);
      expect(site.sent[2].path).toBe('/module/CS3230');
    }
  });
});

describe('smoke\'s corpus', () => {
  it('draws from the expected commit\'s data/corpus.json `current`, not the Mac\'s download cache', async () => {
    const r = await run(fakeSite());
    expect(r.code).toBe(0);
    expect(r.corpora).toEqual([CORPUS_ENTRY]);
    expect(r.calls).toContainEqual(['git', 'show', `${SHA}:data/corpus.json`]);
  });

  it('a commit from before the manifest draws from the working tree\'s current, and says so', async () => {
    const r = await run(fakeSite(), { manifest: false });
    expect(r.code).toBe(0);
    const here = JSON.parse(readFileSync(new URL('../data/corpus.json', import.meta.url), 'utf8'));
    expect(r.corpora).toEqual([here.corpora[here.current]]);
    expect(r.out).toMatch(new RegExp(`predates data/corpus.json; drawing from the working tree's current \\(${here.current}\\)`));
  });
});
