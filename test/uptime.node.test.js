// @ts-check
// The uptime check (scripts/uptime-check.mjs, ADR 0012 and 0019), its CLI (scripts/uptime.mjs) and
// the Worker that runs it every 15 minutes (workers/uptime/). Each run GETs /health, one /module/<code> and one /search that
// must be a cache miss and not degraded; a failure is checked again 90 s later; a pass pings
// healthchecks.io's HC_UPTIME_URL, two failures ping HC_UPTIME_URL/fail with a one-line reason.
// A fake site, clock and pinger: nothing here sends a request.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODULE_CODE_RE } from '../scripts/lib.mjs';
import { CODE_RE } from '../scripts/uptime-check.mjs';
import {
  GAP_MS, PERIOD_MS, QUERIES, RETRY_MS, SCHEDULE, TRIES, moduleCodes, queryIndex, siteUrl, uptime,
} from '../scripts/uptime.mjs';
import { run as workerRun } from '../workers/uptime/index.mjs';

const BASE = 'https://site.example';
const PING = 'https://hc-ping.example/5ec2e7-uuid-never-logged';
const SECRET_PART = '5ec2e7-uuid-never-logged';
const CODES = ['AA1001', 'BB2002', 'CC3003'];
/** The period the fake clock starts in, and 7 s into it (a cron run starts just after the boundary). */
const PERIOD = 2_000_000;
const START = PERIOD * PERIOD_MS + 7000;

/**
 * @typedef {{ status?: number, body?: unknown, cache?: 'hit' | 'miss', throws?: Error }} Answer
 * @typedef {{ health?: Answer, module?: Answer, search?: Answer }} Attempt
 */

/**
 * The site, answering each attempt's routes as told (the last attempt repeats), on a fake clock
 * that sleep() and each request advance.
 * @param {Attempt[]} attempts
 * @param {{ searchAnswers?: Answer[] }} [o] per-/search answers in order, overriding the attempts'
 */
function fakeSite(attempts = [{}], o = {}) {
  let clock = START;
  let attempt = -1;
  let searches = 0;
  /** @type {{ path: string, q: string | null, at: number, answeredAt: number }[]} */
  const sent = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === '/health') attempt += 1;
    const a = attempts[Math.min(attempt, attempts.length - 1)] ?? {};
    const entry = { path: u.pathname, q: u.searchParams.get('q'), at: clock, answeredAt: 0 };
    sent.push(entry);
    clock += 300;
    entry.answeredAt = clock;
    /** @type {Answer} */
    let answer;
    if (u.pathname === '/health') answer = a.health ?? { body: { ok: true, versionTag: 'abc1234', vectors: { corpus: 'production' } } };
    else if (u.pathname.startsWith('/module/')) answer = a.module ?? { body: { code: decodeURIComponent(u.pathname.slice(8)), title: 'T' } };
    else if (u.pathname === '/search') {
      answer = o.searchAnswers?.[searches] ?? a.search ?? { body: { results: [{ code: 'AA1001' }] } };
      searches += 1;
    } else answer = { status: 404, body: { error: 'not_found' } };
    if (answer.throws) throw answer.throws;
    /** @type {Record<string, string>} */
    const headers = u.pathname === '/search' ? { 'server-timing': `cache;desc=${answer.cache ?? 'miss'}, total;dur=200` } : {};
    return Response.json(answer.body ?? {}, { status: answer.status ?? 200, headers });
  };
  const sleep = async (/** @type {number} */ ms) => { clock += ms; };
  return { fetchImpl, sleep, now: () => clock, sent };
}

/** A pinger that records each ping. @param {{ fail?: boolean, throwWith?: string }} [o] */
function fakePinger(o = {}) {
  /** @type {{ url: string, body: string | undefined }[]} */
  const pings = [];
  /** @type {(url: string, body?: string) => Promise<{ ok: boolean, status: number }>} */
  const ping = async (url, body) => {
    pings.push({ url, body });
    if (o.throwWith) throw new Error(o.throwWith);
    return { ok: !o.fail, status: o.fail ? 500 : 200 };
  };
  return { ping, pings };
}

/**
 * Runs the check against the fake site.
 * @param {ReturnType<typeof fakeSite>} site
 * @param {ReturnType<typeof fakePinger>} pinger
 * @param {{ argv?: string[], env?: Record<string, string | undefined> }} [o]
 */
async function run(site, pinger, o = {}) {
  /** @type {string[]} */
  const lines = [];
  const code = await uptime({
    argv: o.argv ?? ['--url', BASE], env: o.env ?? { HC_UPTIME_URL: PING },
    fetchImpl: site.fetchImpl, sleep: site.sleep, now: site.now, ping: pinger.ping,
    log: (m) => lines.push(m), error: (m) => lines.push(m), codes: () => CODES,
  });
  return { code, lines, out: lines.join('\n') };
}

describe('the uptime check', () => {
  it('a pass pings the base URL once, after /health, one /module and one /search', async () => {
    const site = fakeSite();
    const pinger = fakePinger();
    const { code } = await run(site, pinger);
    expect(code).toBe(0);
    expect(pinger.pings).toEqual([{ url: PING, body: undefined }]);
    expect(site.sent.map((s) => s.path)).toEqual(['/health', `/module/${CODES[PERIOD % CODES.length]}`, '/search']);
    expect(site.sent[2].q).toBe(QUERIES[queryIndex(PERIOD)]);
  });

  it('one failure then a pass pings the base URL once, after 90 s', async () => {
    const site = fakeSite([{ health: { status: 503 } }, {}]);
    const pinger = fakePinger();
    const { code, out } = await run(site, pinger);
    expect(code).toBe(0);
    expect(pinger.pings).toEqual([{ url: PING, body: undefined }]);
    expect(site.sent.map((s) => s.path)).toEqual(['/health', '/health', expect.stringMatching(/^\/module\//), '/search']);
    expect(site.sent[1].at - site.sent[0].answeredAt).toBeGreaterThanOrEqual(RETRY_MS);
    expect(out).toMatch(/\/health HTTP 503/);
  });

  it('two failures ping /fail with a one-line reason: the status and the route, no query', async () => {
    const site = fakeSite([{ search: { status: 502, body: { error: 'upstream' } } }]);
    const pinger = fakePinger();
    const { code } = await run(site, pinger);
    expect(code).toBe(0);
    expect(pinger.pings).toHaveLength(1);
    expect(pinger.pings[0].url).toBe(`${PING}/fail`);
    const body = /** @type {string} */ (pinger.pings[0].body);
    expect(body).not.toContain('\n');
    expect(body).toMatch(/\/search HTTP 502/);
    for (const q of QUERIES) expect(body).not.toContain(q);
    expect(body.length).toBeLessThanOrEqual(300);
  });

  it('a 200 that is degraded is a failure', async () => {
    const site = fakeSite([{ search: { body: { results: [{ code: 'AA1001' }], degraded: { source: 'embed', reason: 'timeout' } } } }]);
    const pinger = fakePinger();
    await run(site, pinger);
    expect(pinger.pings.map((p) => p.url)).toEqual([`${PING}/fail`]);
    expect(pinger.pings[0].body).toMatch(/\/search degraded \(embed-timeout\)/);
  });

  it('a 200 with no results, a body that is not JSON, and a thrown fetch are failures', async () => {
    for (const search of [{ body: { results: [] } }, { body: 'not json' }, { throws: new TypeError('fetch failed') }]) {
      const pinger = fakePinger();
      await run(fakeSite([{ search: /** @type {Answer} */ (search) }]), pinger);
      expect(pinger.pings.map((p) => p.url)).toEqual([`${PING}/fail`]);
    }
  });

  it('a /module answer that is not the code asked for is a failure', async () => {
    const pinger = fakePinger();
    await run(fakeSite([{ module: { status: 404, body: { error: 'not_found' } } }]), pinger);
    expect(pinger.pings[0]).toEqual({ url: `${PING}/fail`, body: expect.stringMatching(/\/module\/[A-Z]{2}\d{4} HTTP 404/) });
  });

  it('a /module 404 that names its kind of miss passes: D1 answered, and main may be ahead of the deploy', async () => {
    for (const kind of ['unknown', 'catalogue-only', 'ng-listed']) {
      const site = fakeSite([{ module: { status: 404, body: { error: 'not_found', kind, message: 'm' } } }]);
      const pinger = fakePinger();
      const { code, out } = await run(site, pinger);
      expect(code).toBe(0);
      expect(pinger.pings).toEqual([{ url: PING, body: undefined }]);
      expect(site.sent.map((s) => s.path)).toEqual(['/health', expect.stringMatching(/^\/module\//), '/search']);
      expect(out).toMatch(/not in the live corpus/);
    }
  });

  it('a /module 404 with another kind, or none (a missing route), is a failure', async () => {
    for (const body of [{ error: 'not_found', kind: 'other' }, { error: 'not_found', message: 'No route for /module/X.' }]) {
      const pinger = fakePinger();
      await run(fakeSite([{ module: { status: 404, body } }]), pinger);
      expect(pinger.pings.map((p) => p.url)).toEqual([`${PING}/fail`]);
    }
  });

  it('a cache hit moves to the next query; the hit is no failure', async () => {
    const site = fakeSite([{}], { searchAnswers: [{ cache: 'hit', body: { results: [{ code: 'X' }] } }, { cache: 'miss', body: { results: [{ code: 'X' }] } }] });
    const pinger = fakePinger();
    const { code } = await run(site, pinger);
    expect(code).toBe(0);
    const qs = site.sent.filter((s) => s.path === '/search').map((s) => s.q);
    const i = queryIndex(PERIOD);
    expect(qs).toEqual([QUERIES[i], QUERIES[(i + 1) % QUERIES.length]]);
    expect(pinger.pings).toEqual([{ url: PING, body: undefined }]);
  });

  it(`${TRIES} cache hits in a row are a failure, and the retry takes queries not yet sent`, async () => {
    const site = fakeSite([{ search: { cache: 'hit', body: { results: [{ code: 'X' }] } } }]);
    const pinger = fakePinger();
    await run(site, pinger);
    const qs = site.sent.filter((s) => s.path === '/search').map((s) => s.q);
    expect(qs).toHaveLength(2 * TRIES);
    expect(new Set(qs).size).toBe(2 * TRIES);
    expect(pinger.pings[0]).toEqual({ url: `${PING}/fail`, body: expect.stringMatching(/\/search .*cache hit/) });
  });

  it(`spaces its own requests at least ${GAP_MS / 1000} s apart`, async () => {
    const site = fakeSite([{ search: { cache: 'hit', body: { results: [{ code: 'X' }] } } }]);
    await run(site, fakePinger());
    for (let i = 1; i < site.sent.length; i += 1) {
      expect(site.sent[i].at - site.sent[i - 1].answeredAt).toBeGreaterThanOrEqual(GAP_MS);
    }
  });

  it('never logs the ping URL, on a pass, a failure, a refused ping or a ping that throws with it', async () => {
    const cases = [
      { site: fakeSite(), pinger: fakePinger() },
      { site: fakeSite([{ health: { status: 500 } }]), pinger: fakePinger() },
      { site: fakeSite(), pinger: fakePinger({ fail: true }) },
      { site: fakeSite(), pinger: fakePinger({ throwWith: `connect ECONNREFUSED ${PING}` }) },
      { site: fakeSite([{ health: { status: 500 } }]), pinger: fakePinger({ throwWith: `bad ${PING}/fail` }) },
    ];
    for (const { site, pinger } of cases) {
      const { out } = await run(site, pinger);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toContain(SECRET_PART);
      expect(out).not.toContain('hc-ping.example');
    }
  });

  it('exits 1 when the ping is refused or throws, so the run shows red', async () => {
    expect((await run(fakeSite(), fakePinger({ fail: true }))).code).toBe(1);
    expect((await run(fakeSite(), fakePinger({ throwWith: 'boom' }))).code).toBe(1);
  });

  it('refuses to run with no HC_UPTIME_URL, or one that is not https, before any request, without echoing it', async () => {
    for (const env of [{}, { HC_UPTIME_URL: '' }, { HC_UPTIME_URL: 'http://hc-ping.example/5ec2e7-uuid-never-logged' }, { HC_UPTIME_URL: '5ec2e7-uuid-never-logged' }]) {
      const site = fakeSite();
      const pinger = fakePinger();
      const { code, out } = await run(site, pinger, { env });
      expect(code).toBe(2);
      expect(site.sent).toEqual([]);
      expect(pinger.pings).toEqual([]);
      expect(out).toMatch(/HC_UPTIME_URL/);
      expect(out).not.toContain(SECRET_PART);
    }
  });

  it('--dry-run checks the site, pings nothing and prints what it would ping, the URL redacted', async () => {
    for (const env of [{ HC_UPTIME_URL: PING }, {}]) {
      const down = fakePinger();
      const failed = await run(fakeSite([{ health: { status: 500 } }]), down, { argv: ['--url', BASE, '--dry-run'], env });
      expect(failed.code).toBe(0);
      expect(down.pings).toEqual([]);
      expect(failed.out).toMatch(/would ping <HC_UPTIME_URL>\/fail with "[^"\n]*\/health HTTP 500[^"\n]*"/);
      expect(failed.out).not.toContain(SECRET_PART);
      const up = fakePinger();
      const passed = await run(fakeSite(), up, { argv: ['--dry-run', '--url', BASE], env });
      expect(passed.code).toBe(0);
      expect(up.pings).toEqual([]);
      expect(passed.out).toMatch(/would ping <HC_UPTIME_URL>(?!\/fail)/);
    }
  });

  it('refuses an unknown flag, and ports 8787 and 8799', async () => {
    for (const argv of [['--nope'], ['--url'], ['--url', 'http://127.0.0.1:8787'], ['--url', 'http://localhost:8799/']]) {
      const site = fakeSite();
      const { code } = await run(site, fakePinger(), { argv });
      expect(code).toBe(2);
      expect(site.sent).toEqual([]);
    }
  });
});

describe('what the check asks for', () => {
  it('takes the site from wrangler.jsonc\'s Custom Domain', () => {
    expect(siteUrl('{\n  // c\n  "routes": [{ "pattern": "a.example.org", "custom_domain": true }]\n}\n')).toBe('https://a.example.org');
    expect(siteUrl('{}')).toBeNull();
    expect(siteUrl(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });

  it('draws /module\'s code from the bundled groups file: every one is course-code shaped', () => {
    const codes = moduleCodes(JSON.parse(readFileSync(new URL('../data/groups.json', import.meta.url), 'utf8')));
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(c).toMatch(MODULE_CODE_RE);
    expect([...codes].sort()).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('matches scripts/lib.mjs\'s course-code pattern', () => {
    expect(CODE_RE.source).toBe(MODULE_CODE_RE.source);
    expect(CODE_RE.flags).toBe(MODULE_CODE_RE.flags);
  });

  it('rotates the query by the period, with no first query repeated within 4 h or reused by the next period\'s run', () => {
    expect(new Set(QUERIES).size).toBe(QUERIES.length);
    for (const q of QUERIES) {
      expect(q).toMatch(/^[a-z][a-z ]+[a-z]$/);
      expect(q.split(' ').length).toBeGreaterThanOrEqual(2);
    }
    const fourHours = (4 * 3_600_000) / PERIOD_MS;
    for (let p = PERIOD - 100; p < PERIOD + 100; p += 1) {
      const window = Array.from({ length: fourHours }, (_, k) => queryIndex(p + k));
      expect(new Set(window).size).toBe(fourHours);
      const thisRun = Array.from({ length: 2 * TRIES }, (_, k) => (queryIndex(p) + k) % QUERIES.length);
      expect(thisRun).not.toContain(queryIndex(p + 1));
    }
  });
});

describe('the uptime Worker', () => {
  const config = readFileSync(new URL('../workers/uptime/wrangler.jsonc', import.meta.url), 'utf8');
  /** The config without its comments. */
  const code = config.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('runs on the check\'s schedule, every 15 minutes, with no address and no bindings', () => {
    const crons = JSON.parse(/"crons"\s*:\s*(\[[^\]]*\])/.exec(code)?.[1] ?? 'null');
    expect(crons).toEqual([SCHEDULE]);
    expect(SCHEDULE).toBe(`*/${PERIOD_MS / 60_000} * * * *`);
    expect(code).toMatch(/"workers_dev"\s*:\s*false/);
    expect(code).toMatch(/"preview_urls"\s*:\s*false/);
    expect(code).not.toMatch(/"(routes|route|d1_databases|ai|vectorize|kv_namespaces|r2_buckets|services|ratelimits|assets)"/);
  });

  it('checks the root wrangler.jsonc\'s Custom Domain, and keeps the ping URL out of its config', () => {
    const site = /"SITE"\s*:\s*"([^"]+)"/.exec(code)?.[1];
    expect(site).toBe(siteUrl(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));
    expect(config).not.toMatch(/hc-ping\.com|healthchecks\.io\/ping/);
  });

  it('a run checks SITE and pings HC_UPTIME_URL', async () => {
    const site = fakeSite();
    const pinger = fakePinger();
    /** @type {string[]} */
    const lines = [];
    await workerRun({ SITE: `${BASE}/`, HC_UPTIME_URL: PING }, {
      fetchImpl: site.fetchImpl, sleep: site.sleep, now: site.now, ping: pinger.ping, log: (m) => lines.push(m), error: (m) => lines.push(m),
    });
    expect(site.sent.map((s) => s.path)).toEqual(['/health', expect.stringMatching(/^\/module\//), '/search']);
    expect(pinger.pings).toEqual([{ url: PING, body: undefined }]);
    expect(lines.join('\n')).not.toContain(SECRET_PART);
  });

  it('a run that cannot report throws, so Workers Logs mark it failed; a down site does not', async () => {
    const deps = (/** @type {ReturnType<typeof fakePinger>} */ pinger, /** @type {Attempt[]} */ attempts = [{}]) => {
      const site = fakeSite(attempts);
      return { fetchImpl: site.fetchImpl, sleep: site.sleep, now: site.now, ping: pinger.ping, log: () => {}, error: () => {} };
    };
    await expect(workerRun({ SITE: BASE, HC_UPTIME_URL: PING }, deps(fakePinger({ fail: true })))).rejects.toThrow(/exit 1/);
    await expect(workerRun({ SITE: BASE }, deps(fakePinger()))).rejects.toThrow(/exit 2/);
    await expect(workerRun({ SITE: 'http://x.example', HC_UPTIME_URL: PING }, deps(fakePinger()))).rejects.toThrow(/SITE/);
    const down = fakePinger();
    await workerRun({ SITE: BASE, HC_UPTIME_URL: PING }, deps(down, [{ health: { status: 503 } }]));
    expect(down.pings.map((p) => p.url)).toEqual([`${PING}/fail`]);
  });

  it('bundles the check, which imports nothing a Worker lacks', () => {
    const check = readFileSync(new URL('../scripts/uptime-check.mjs', import.meta.url), 'utf8');
    expect(check).not.toMatch(/^\s*import\s/m);
    expect(check).not.toMatch(/process\.|require\(/);
  });
});
