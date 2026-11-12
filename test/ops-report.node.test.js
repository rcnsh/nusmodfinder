// @ts-check
// Phase 7 7F: `npm run ops:report -- --month <yyyy-mm>`, the monthly usage report from Cloudflare's
// GraphQL Analytics API (docs/plans/phase7.md §2 7F). Fixture GraphQL answers only: fetch, the
// token's source, the clock and the sleep are injected, and nothing here reaches Cloudflare.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWANCES, DEFAULT_ACCOUNT_ID, GRAPHQL_URL, MIN_SPACING_MS, monthWindow, opsReport, previousMonth, resolveToken,
} from '../scripts/ops-report.mjs';

const TOKEN = 'cf-test-token-0123456789abcdefSECRET';
const DB = 'de4527ff-19ec-4a5b-9c5c-4d1791078b25';
const COMMIT = { sha: 'a'.repeat(40), dirty: false, diffSha256: null };

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-opsreport-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * One month's GraphQL answer, the shape scripts/ops-report.mjs's query asks for. `over` replaces
 * datasets (null makes one missing, as GraphQL answers a dataset it couldn't read).
 * @param {{ scale?: number, over?: Record<string, unknown>, errors?: unknown[] }} [o]
 */
function answer({ scale = 1, over = {}, errors } = {}) {
  const s = (/** @type {number} */ n) => Math.round(n * scale);
  const account = {
    workersAccount: [
      { dimensions: { scriptName: 'nusmodfinder' }, sum: { requests: s(182), errors: 0, cpuTimeUs: s(2_900_000) } },
      { dimensions: { scriptName: 'other-worker' }, sum: { requests: s(374_288), errors: s(3), cpuTimeUs: s(4_361_911_000) } },
    ],
    worker: [{
      dimensions: { scriptName: 'nusmodfinder' },
      sum: { requests: s(182), errors: 0, cpuTimeUs: s(2_900_000) },
      quantiles: { cpuTimeP50: 9145, cpuTimeP99: 34152 },
    }],
    workerStatus: [
      { dimensions: { httpResponseStatus: 200 }, sum: { requests: s(159) } },
      { dimensions: { httpResponseStatus: 404 }, sum: { requests: s(23) } },
    ],
    d1: [
      { dimensions: { databaseId: DB }, sum: { rowsRead: s(926_418), rowsWritten: s(214_109), readQueries: s(5000), writeQueries: s(300) } },
      { dimensions: { databaseId: 'other-db' }, sum: { rowsRead: s(17_209_739), rowsWritten: s(365_188), readQueries: s(90_000), writeQueries: s(4000) } },
    ],
    ai: [
      { dimensions: { date: '2026-10-03' }, sum: { totalNeurons: 2394.7 * scale } },
      { dimensions: { date: '2026-10-04' }, sum: { totalNeurons: 70.2 * scale } },
    ],
    ...over,
  };
  return { data: { viewer: { accounts: [account] } }, ...(errors ? { errors } : {}) };
}

/**
 * A fake fetch that answers each GraphQL call from `answers` in turn and records the calls, on a
 * virtual clock that `sleep` advances.
 * @param {unknown[]} answers bodies (an object) or `{ status, body }`
 */
function fakeCloudflare(answers) {
  let t = Date.parse('2026-11-12T03:00:00Z');
  /** @type {{ url: string, init: RequestInit, at: number, body: any }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(input), init, at: t, body });
    const a = /** @type {any} */ (answers[Math.min(calls.length - 1, answers.length - 1)]);
    const { status, body: out } = a && typeof a.status === 'number' ? a : { status: 200, body: a };
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    fetchImpl,
    now: () => new Date(t),
    sleep: async (/** @type {number} */ ms) => { t += ms; },
  };
}

/**
 * Runs the report with fakes; returns what it wrote.
 * @param {string[]} argv
 * @param {ReturnType<typeof fakeCloudflare>} cf
 * @param {{ env?: Record<string, string | undefined>, exec?: (cmd: string, args: string[]) => string }} [o]
 */
async function run(argv, cf, { env = { CLOUDFLARE_API_TOKEN: TOKEN }, exec } = {}) {
  /** @type {string[]} */
  const logs = [];
  const result = await opsReport(argv, {
    env, exec: exec ?? (() => { throw new Error('exec must not run when the env has a token'); }),
    fetchImpl: cf.fetchImpl, sleep: cf.sleep, now: cf.now, log: (l) => logs.push(l),
    outDir: join(dir, 'ops'), runsDir: join(dir, 'runs'), databaseId: DB, commit: COMMIT,
  });
  const runs = readdirSync(join(dir, 'runs'));
  const record = runs.length === 1 ? readFileSync(join(dir, 'runs', runs[0]), 'utf8') : null;
  const report = result.path ? readFileSync(result.path, 'utf8') : null;
  return { result, logs, runs, record, report };
}

describe('the month', () => {
  it('a past month is complete, from its first second to its last', () => {
    expect(monthWindow('2026-10', new Date('2026-11-12T03:00:00Z'))).toMatchObject({
      month: '2026-10', from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z', dateFrom: '2026-10-01', dateTo: '2026-10-31', complete: true,
    });
  });

  it('the current month runs to now and is not complete', () => {
    const w = monthWindow('2026-11', new Date('2026-11-12T03:00:00Z'));
    expect(w).toMatchObject({ from: '2026-11-01T00:00:00Z', to: '2026-11-12T03:00:00Z', dateFrom: '2026-11-01', dateTo: '2026-11-12', complete: false });
    expect(w.elapsed).toBeCloseTo((11 * 24 + 3) / (30 * 24), 6);
  });

  it('refuses a future month and a malformed one', () => {
    expect(() => monthWindow('2026-12', new Date('2026-11-12T03:00:00Z'))).toThrow(/future/);
    expect(() => monthWindow('2026-13', new Date('2026-11-12T03:00:00Z'))).toThrow(/yyyy-mm/);
    expect(() => monthWindow('26-11', new Date('2026-11-12T03:00:00Z'))).toThrow(/yyyy-mm/);
  });

  it('the previous month crosses a year', () => {
    expect(previousMonth('2026-11')).toBe('2026-10');
    expect(previousMonth('2027-01')).toBe('2026-12');
  });
});

describe('the allowances', () => {
  it('are Workers Paid\'s included amounts, in one constant', () => {
    expect(ALLOWANCES).toEqual({
      workerRequests: 10_000_000, workerCpuMs: 30_000_000, d1RowsRead: 25_000_000_000, d1RowsWritten: 50_000_000, neuronsPerDay: 10_000,
    });
  });
});

describe('the report from fixture GraphQL answers', () => {
  it('gives the expected report: account-wide against the allowances, this Worker\'s share, D1, neurons', async () => {
    const cf = fakeCloudflare([answer(), answer({ scale: 0.5 })]);
    const { result, report, logs } = await run(['--month', '2026-10'], cf);
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe(join(dir, 'ops', '2026-10.md'));
    const r = /** @type {string} */ (report);
    expect(r).toMatch(/^# Usage report: 2026-10\n/);
    expect(r).toContain('2026-10-01 to 2026-10-31 (UTC), the whole month');
    // Account-wide, each against its allowance.
    expect(r).toMatch(/\| Worker requests \| 374,470 \| 10,000,000 a month \| 3\.7% \|/);
    expect(r).toMatch(/\| Worker CPU \| 4,364,811 ms \| 30,000,000 ms a month \| 14\.5% \|/);
    expect(r).toMatch(/\| D1 rows read \| 18,136,157 \| 25,000,000,000 a month \| 0\.07% \|/);
    expect(r).toMatch(/\| D1 rows written \| 579,297 \| 50,000,000 a month \| 1\.2% \|/);
    expect(r).toMatch(/\| Workers AI neurons, busiest day \| 2,394\.7 \(2026-10-03\) \| 10,000 a day \| 23\.9% \|/);
    // This Worker's share.
    expect(r).toMatch(/\| Requests \| 182 \| 0\.05% of the account's \|/);
    expect(r).toMatch(/\| CPU \| 2,900 ms \| 0\.07% of the account's \|/);
    expect(r).toMatch(/\| CPU per request, p50 \/ p99 \| 9\.1 ms \/ 34\.2 ms \|/);
    expect(r).toMatch(/\| Errors \(exceptions\) \| 0 \|/);
    expect(r).toMatch(/\| 200 \| 159 \|\n\| 404 \| 23 \|/);
    expect(r).toMatch(/\| `nusmods-apac` rows read \| 926,418 \| 5\.1% of the account's \|/);
    // The calendar month, and why.
    expect(r).toMatch(/calendar month/);
    expect(r).toMatch(/renewal date[^\n]*isn't readable/);
    // Month on month: everything doubled, so everything that has a value grew.
    expect(r).toMatch(/## Flags\n/);
    expect(r).toMatch(/- Worker requests grew 100% on 2026-09 \(187,235 → 374,470\)/);
    expect(logs.join('\n')).toContain('2026-10.md');
  });

  it('a missing dataset is reported as missing, not zero', async () => {
    const errors = [{ message: 'not authorized for d1AnalyticsAdaptiveGroups', path: ['viewer', 'accounts', 0, 'd1'] }];
    const cf = fakeCloudflare([answer({ over: { d1: null }, errors }), answer()]);
    const { result, report, record } = await run(['--month', '2026-10'], cf);
    const r = /** @type {string} */ (report);
    expect(r).toMatch(/\| D1 rows read \| missing: not authorized for d1AnalyticsAdaptiveGroups \|/);
    expect(r).toMatch(/\| D1 rows written \| missing/);
    expect(r).not.toMatch(/\| D1 rows read \| 0 \|/);
    // The other datasets still report.
    expect(r).toMatch(/\| Worker requests \| 374,470 \|/);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(/** @type {string} */ (record))).toMatchObject({ outcome: 'failed', details: { missing: ['d1'] } });
  });

  it('an empty dataset is zero, not missing', async () => {
    const cf = fakeCloudflare([answer({ over: { ai: [] } }), answer({ over: { ai: [] } })]);
    const { report } = await run(['--month', '2026-10'], cf);
    expect(report).toMatch(/\| Workers AI neurons, busiest day \| 0 \| 10,000 a day \| 0\.0% \|/);
  });

  it('a whole answer that fails leaves every dataset missing, and says why', async () => {
    const cf = fakeCloudflare([{ status: 500, body: 'upstream error' }, answer()]);
    const { result, report } = await run(['--month', '2026-10'], cf);
    expect(report).toMatch(/\| Worker requests \| missing: HTTP 500/);
    expect(report).toMatch(/\| D1 rows read \| missing: HTTP 500/);
    expect(result.exitCode).toBe(1);
  });

  it('flags anything above 25% of its allowance', async () => {
    // CPU at 9M ms of 30M (30%), and a 3,000-neuron day (30%); requests stay at 3.7%.
    const over = {
      workersAccount: [{ dimensions: { scriptName: 'x' }, sum: { requests: 374_470, errors: 0, cpuTimeUs: 9_000_000_000 } }],
      ai: [{ dimensions: { date: '2026-10-09' }, sum: { totalNeurons: 3000 } }],
    };
    const cf = fakeCloudflare([answer({ over }), answer({ over })]);
    const { report } = await run(['--month', '2026-10'], cf);
    const flags = /** @type {string} */ (report).split('## Flags\n')[1];
    expect(flags).toMatch(/- Worker CPU is at 30\.0% of its allowance \(above 25%\)/);
    expect(flags).toMatch(/- Workers AI neurons, busiest day is at 30\.0% of its allowance \(above 25%\)/);
    expect(flags).not.toMatch(/Worker requests is at/);
    expect(flags).not.toMatch(/grew/);
  });

  it('a month in progress is projected before it is compared', async () => {
    // 11 days 3 hours into November at the same totals as all of October: projected about 2.7×.
    const cf = fakeCloudflare([answer(), answer()]);
    const { report } = await run(['--month', '2026-11'], cf);
    expect(report).toContain('2026-11-01 to 2026-11-12 03:00 (UTC), month to date');
    expect(report).toMatch(/- Worker requests grew 170% on 2026-10, projected over the whole month \(374,470 → 1,009,807\)/);
  });

  it('no flags is said in words', async () => {
    const cf = fakeCloudflare([answer(), answer()]);
    const { report } = await run(['--month', '2026-10'], cf);
    expect(report).toMatch(/## Flags\n\nNone: nothing is above 25% of its allowance, and nothing grew on 2026-09\./);
  });
});

describe('the calls', () => {
  it('one combined query per month, this month and the last, at least 4 s apart, with the token only in the header', async () => {
    const cf = fakeCloudflare([answer(), answer()]);
    await run(['--month', '2026-10'], cf);
    expect(cf.calls).toHaveLength(2);
    expect(cf.calls.every((c) => c.url === GRAPHQL_URL && c.init.method === 'POST')).toBe(true);
    expect(cf.calls[1].at - cf.calls[0].at).toBeGreaterThanOrEqual(MIN_SPACING_MS);
    for (const c of cf.calls) {
      expect(new Headers(c.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(c.body)).not.toContain(TOKEN);
      expect(c.body.variables.accountTag).toBe(DEFAULT_ACCOUNT_ID);
      expect(c.body.variables.script).toBe('nusmodfinder');
    }
    expect(cf.calls[0].body.variables).toMatchObject({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z', dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    expect(cf.calls[1].body.variables).toMatchObject({ from: '2026-09-01T00:00:00Z', dateTo: '2026-09-30' });
    // The query reads the fields 7-0 confirmed by introspection.
    const q = cf.calls[0].body.query;
    for (const f of ['workersInvocationsAdaptive', 'cpuTimeUs', 'cpuTimeP50', 'cpuTimeP99', 'httpResponseStatus', 'd1AnalyticsAdaptiveGroups',
      'rowsRead', 'rowsWritten', 'databaseId', 'aiInferenceAdaptiveGroups', 'totalNeurons', 'date_geq', 'datetime_geq']) expect(q).toContain(f);
  });

  it('takes the account id from CLOUDFLARE_ACCOUNT_ID when it is set', async () => {
    const cf = fakeCloudflare([answer(), answer()]);
    await run(['--month', '2026-10'], cf, { env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32) } });
    expect(cf.calls[0].body.variables.accountTag).toBe('f'.repeat(32));
  });

  it('writes one run record, each GraphQL call a request, with no token and no account id', async () => {
    const cf = fakeCloudflare([answer(), answer()]);
    const { runs, record } = await run(['--month', '2026-10'], cf);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^\d{8}T\d{6}Z-ops-report-[0-9a-f]{4}\.json$/);
    const rec = JSON.parse(/** @type {string} */ (record));
    expect(rec).toMatchObject({ script: 'ops:report', args: ['--month', '2026-10'], requests: { '/client/v4/graphql': 2 }, outcome: 'ok', exitCode: 0 });
    expect(rec.details).toMatchObject({ month: '2026-10', report: expect.stringMatching(/2026-10\.md$/), flags: expect.any(Number) });
    expect(record).not.toContain(TOKEN);
    expect(record).not.toContain(DEFAULT_ACCOUNT_ID);
  });
});

describe('the token', () => {
  it('comes from CLOUDFLARE_API_TOKEN when it is set', () => {
    expect(resolveToken({ env: { CLOUDFLARE_API_TOKEN: TOKEN }, exec: () => { throw new Error('no'); } })).toBe(TOKEN);
  });

  it('otherwise from the last line of `npx wrangler auth token`', () => {
    /** @type {[string, string[]][]} */
    const ran = [];
    const exec = (/** @type {string} */ cmd, /** @type {string[]} */ args) => { ran.push([cmd, args]); return `\n ⛅️ wrangler 4.157.0\n───────────\n${TOKEN}\n`; };
    expect(resolveToken({ env: {}, exec })).toBe(TOKEN);
    expect(ran).toEqual([['npx', ['wrangler', 'auth', 'token']]]);
  });

  it('a failed wrangler names the fix and never prints what wrangler printed', () => {
    const exec = () => { const e = /** @type {any} */ (new Error(`Command failed\n${TOKEN}`)); e.stdout = TOKEN; e.status = 1; throw e; };
    expect(() => resolveToken({ env: {}, exec })).toThrow(/CLOUDFLARE_API_TOKEN|wrangler login/);
    try { resolveToken({ env: {}, exec }); } catch (err) { expect(String(/** @type {Error} */ (err).message)).not.toContain(TOKEN); }
  });

  it('is never printed, logged or written, even when the API echoes it back', async () => {
    const echo = { status: 400, body: { errors: [{ message: `bad token ${TOKEN}` }] } };
    const cf = fakeCloudflare([echo, echo]);
    const exec = () => `wrangler\n${TOKEN}\n`;
    const { report, record, logs } = await run(['--month', '2026-10'], cf, { env: {}, exec });
    for (const text of [report, record, logs.join('\n')]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(report).toContain('[redacted]');
  });

  it('refuses a --token flag rather than putting a token in the run record\'s args', async () => {
    const cf = fakeCloudflare([answer()]);
    await expect(opsReport(['--month', '2026-10', '--token', TOKEN], {
      env: {}, exec: () => TOKEN, fetchImpl: cf.fetchImpl, sleep: cf.sleep, now: cf.now, log: () => {},
      outDir: join(dir, 'ops'), runsDir: join(dir, 'runs'), databaseId: DB, commit: COMMIT,
    })).resolves.toMatchObject({ exitCode: 2 });
    expect(cf.calls).toHaveLength(0);
  });
});
