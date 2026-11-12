// @ts-check
// Phase 8 8C (G4 in ADR 0012): the hourly uptime check (scripts/uptime.mjs) and its workflow
// (.github/workflows/uptime.yml). Each run GETs /health, one /module/<code> and one /search that
// must be a cache miss and not degraded; a failure is checked again 90 s later; a pass pings
// healthchecks.io's HC_UPTIME_URL, two failures ping HC_UPTIME_URL/fail with a one-line reason.
// A fake site, clock and pinger: nothing here sends a request.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODULE_CODE_RE } from '../scripts/lib.mjs';
import {
  GAP_MS, QUERIES, RETRY_MS, SCHEDULE, TRIES, moduleCodes, queryIndex, siteUrl, uptime,
} from '../scripts/uptime.mjs';

const BASE = 'https://site.example';
const PING = 'https://hc-ping.example/5ec2e7-uuid-never-logged';
const SECRET_PART = '5ec2e7-uuid-never-logged';
const CODES = ['AA1001', 'BB2002', 'CC3003'];
const HOUR = 3_600_000;
/** 37 minutes into hour 500,000 since the epoch. */
const START = 500_000 * HOUR + 37 * 60_000;

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
    expect(site.sent.map((s) => s.path)).toEqual(['/health', `/module/${CODES[500_000 % CODES.length]}`, '/search']);
    expect(site.sent[2].q).toBe(QUERIES[queryIndex(500_000)]);
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

  it('a cache hit moves to the next query; the hit is no failure', async () => {
    const site = fakeSite([{}], { searchAnswers: [{ cache: 'hit', body: { results: [{ code: 'X' }] } }, { cache: 'miss', body: { results: [{ code: 'X' }] } }] });
    const pinger = fakePinger();
    const { code } = await run(site, pinger);
    expect(code).toBe(0);
    const qs = site.sent.filter((s) => s.path === '/search').map((s) => s.q);
    const i = queryIndex(500_000);
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

  it('rotates the query by the hour, with no query repeated within a day or reused by the next hour\'s run', () => {
    expect(new Set(QUERIES).size).toBe(QUERIES.length);
    for (const q of QUERIES) {
      expect(q).toMatch(/^[a-z][a-z ]+[a-z]$/);
      expect(q.split(' ').length).toBeGreaterThanOrEqual(2);
    }
    for (let h = START / HOUR - 100; h < START / HOUR + 100; h += 1) {
      const day = Array.from({ length: 24 }, (_, k) => queryIndex(h + k));
      expect(new Set(day).size).toBe(24);
      const thisRun = Array.from({ length: 2 * TRIES }, (_, k) => (queryIndex(h) + k) % QUERIES.length);
      expect(thisRun).not.toContain(queryIndex(h + 1));
    }
  });
});

describe('.github/workflows/uptime.yml', () => {
  const workflow = readFileSync(new URL('../.github/workflows/uptime.yml', import.meta.url), 'utf8');
  /** The workflow without its comments. */
  const code = workflow.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');

  it('runs hourly at the script\'s odd minute, and by hand', () => {
    const crons = [...code.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
    expect(crons).toEqual([SCHEDULE]);
    const [minute, ...rest] = SCHEDULE.split(' ');
    expect(rest).toEqual(['*', '*', '*', '*']);
    expect(Number(minute) % 5).not.toBe(0);
    expect(code).toMatch(/^ {2}workflow_dispatch:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|workflow_run):/m);
  });

  it('has exactly contents: read, at the top and nowhere else', () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read\n(?! {2}\S)/m);
    expect(code.match(/permissions:/g)).toHaveLength(1);
  });

  it('uses no secret but HC_UPTIME_URL, only in the check\'s env, and never echoes it', () => {
    const secrets = [...code.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(secrets).toEqual(['HC_UPTIME_URL']);
    expect(code.split('\n').filter((l) => l.includes('HC_UPTIME_URL'))).toEqual(['          HC_UPTIME_URL: ${{ secrets.HC_UPTIME_URL }}']);
    expect(code).toMatch(/run: node scripts\/uptime\.mjs\n/);
    expect(code).not.toMatch(/github\.token|GITHUB_TOKEN|issues:|CLOUDFLARE_|wrangler|npm run (deploy|remote|ingest|verify|rollback)/);
  });

  it('does not keep the checkout\'s token, and is bounded in time', () => {
    expect(code).toMatch(/uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/);
    expect(code).toMatch(/timeout-minutes: \d+/);
  });
});
