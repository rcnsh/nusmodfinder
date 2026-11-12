// @ts-check
// The monthly usage report (Phase 7 7F, docs/plans/phase7.md §2 7F), from Cloudflare's GraphQL
// Analytics API. Run on the Mac by hand, monthly and after a ship that changes the search path:
//
//   npm run ops:report -- [--month <yyyy-mm>]      (default: the current UTC month)
//
// It writes docs/evidence/ops/<month>.md and a run record. Two GraphQL calls, one combined query
// for the month and one for the month before (for growth), at least 4 s apart.
//
// - Account-wide, each against its Workers Paid allowance: Worker requests and CPU, D1 rows read
//   and written, Workers AI neurons on the busiest day.
// - This Worker's share: requests, CPU, CPU per request p50 and p99, exceptions, requests by
//   HTTP status, and its D1 database's rows.
// - Flags: anything above 25% of its allowance, and anything that grew on the month before (a
//   month in progress is projected over the whole month first).
//
// A dataset GraphQL couldn't answer is reported as missing, never as zero; the run then exits 1.
//
// The token: CLOUDFLARE_API_TOKEN, else the last line of `npx wrangler auth token`. It goes only
// into the Authorization header: never into the report, the run record, a log line or an error.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startRun } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUT_DIR = join(ROOT, 'docs/evidence/ops');
export const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
/** The account (docs/evidence/phase7/measure.md); CLOUDFLARE_ACCOUNT_ID overrides it. */
export const DEFAULT_ACCOUNT_ID = '31e51704ff7169c03d7014c3a1e5f110';
export const WORKER = 'nusmodfinder';
export const DATABASE_NAME = 'nusmods-apac';
export const MIN_SPACING_MS = 4000;
/** A share of an allowance above this is flagged. */
export const FLAG_SHARE = 0.25;

/**
 * What Workers Paid includes, account-wide:
 * - Workers: 10 million requests and 30 million CPU milliseconds a month
 *   (https://developers.cloudflare.com/workers/platform/pricing/);
 * - D1: 25 billion rows read and 50 million rows written a month
 *   (https://developers.cloudflare.com/d1/platform/pricing/);
 * - Workers AI: 10,000 neurons a day (https://developers.cloudflare.com/workers-ai/platform/pricing/).
 */
export const ALLOWANCES = Object.freeze({
  workerRequests: 10_000_000,
  workerCpuMs: 30_000_000,
  d1RowsRead: 25_000_000_000,
  d1RowsWritten: 50_000_000,
  neuronsPerDay: 10_000,
});

/**
 * One month's usage in one call. Workers filter on datetime and D1 and Workers AI on date, the
 * fields 7-0 confirmed by introspection. `worker` has no dimension but the script, so its
 * quantiles cover the whole month.
 */
export const USAGE_QUERY = `query Usage($accountTag: string!, $from: Time!, $to: Time!, $dateFrom: Date!, $dateTo: Date!, $script: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersAccount: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }) {
        dimensions { scriptName }
        sum { requests errors cpuTimeUs }
      }
      worker: workersInvocationsAdaptive(limit: 10, filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $script }) {
        dimensions { scriptName }
        sum { requests errors cpuTimeUs }
        quantiles { cpuTimeP50 cpuTimeP99 }
      }
      workerStatus: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $from, datetime_leq: $to, scriptName: $script }) {
        dimensions { httpResponseStatus }
        sum { requests }
      }
      d1: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $dateFrom, date_leq: $dateTo }) {
        dimensions { databaseId }
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
      ai: aiInferenceAdaptiveGroups(limit: 10000, filter: { date_geq: $dateFrom, date_leq: $dateTo }) {
        dimensions { date }
        sum { totalNeurons }
      }
    }
  }
}`;

/** The aliased datasets USAGE_QUERY asks for. */
export const DATASETS = /** @type {const} */ (['workersAccount', 'worker', 'workerStatus', 'd1', 'ai']);

/**
 * @typedef {{ missing: string }} Missing
 * @typedef {{
 *   workersAccount: { requests: number, errors: number, cpuMs: number } | Missing,
 *   worker: { requests: number, errors: number, cpuMs: number, p50Ms: number | null, p99Ms: number | null } | Missing,
 *   workerStatus: { status: number, requests: number }[] | Missing,
 *   d1: { rowsRead: number, rowsWritten: number, db: { rowsRead: number, rowsWritten: number } } | Missing,
 *   ai: { total: number, busiest: { date: string | null, neurons: number } } | Missing,
 * }} Usage
 * @typedef {{ month: string, from: string, to: string, dateFrom: string, dateTo: string, complete: boolean, elapsed: number }} MonthWindow
 */

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const isoSeconds = (/** @type {Date} */ d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * A calendar month in UTC: from its first second to its last, or to `now` while it runs.
 * `elapsed` is the share of the month that has passed (1 when complete).
 * @param {string} month yyyy-mm
 * @param {Date} now
 * @returns {MonthWindow}
 */
export function monthWindow(month, now) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`--month must be yyyy-mm, not "${month}"`);
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  const end = Date.UTC(Number(m[1]), Number(m[2]), 1);
  if (start > now.getTime()) throw new Error(`${month} is in the future`);
  const complete = end <= now.getTime();
  const to = complete ? new Date(end - 1000) : now;
  return {
    month,
    from: isoSeconds(new Date(start)),
    to: isoSeconds(to),
    dateFrom: new Date(start).toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
    complete,
    elapsed: complete ? 1 : (now.getTime() - start) / (end - start),
  };
}

/** @param {string} month yyyy-mm */
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** The current UTC month. @param {Date} now */
export const currentMonth = (now) => `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;

/**
 * The API token: CLOUDFLARE_API_TOKEN, else the last line `npx wrangler auth token` prints. A
 * failure says how to fix it and never repeats what wrangler printed (it may be the token).
 * @param {{ env: Record<string, string | undefined>, exec: (cmd: string, args: string[]) => string }} o
 */
export function resolveToken({ env, exec }) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const fix = 'Set CLOUDFLARE_API_TOKEN, or run `npx wrangler login` and retry.';
  /** @type {string} */
  let out;
  try {
    out = exec('npx', ['wrangler', 'auth', 'token']);
  } catch (err) {
    const code = /** @type {{ status?: number }} */ (err).status;
    throw new Error(`\`npx wrangler auth token\` failed${code == null ? '' : ` (exit ${code})`}. ${fix}`);
  }
  const token = String(out).split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  if (!token || /\s/.test(token)) throw new Error(`\`npx wrangler auth token\` printed no token on its last line. ${fix}`);
  return token;
}

/** Replaces every copy of the token in a text (anything shorter than 8 characters is no API token). @param {string} text @param {string} token */
export const redact = (text, token) => (token && token.length >= 8 ? text.split(token).join('[redacted]') : text);

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One month's answer as Usage. A dataset GraphQL answered null (with an error naming its path)
 * is missing; an empty list is zero.
 * @param {{ ok: boolean, status: number, json: any, text: string }} res
 * @param {{ databaseId: string, token: string }} o
 * @returns {Usage}
 */
export function parseUsage(res, { databaseId, token }) {
  /** @param {string} why @returns {Missing} */
  const missing = (why) => ({ missing: redact(why, token).replace(/\s+/g, ' ').trim().slice(0, 200) });
  const firstError = (/** @type {any} */ j) => (Array.isArray(j?.errors) && j.errors[0]?.message ? String(j.errors[0].message) : null);
  /** @type {Missing | null} */
  let all = null;
  if (!res.ok) all = missing(`HTTP ${res.status}${firstError(res.json) ? `: ${firstError(res.json)}` : res.text ? `: ${res.text}` : ''}`);
  const account = res.json?.data?.viewer?.accounts?.[0];
  if (!all && !account) all = missing(firstError(res.json) ?? 'no account in the answer (check CLOUDFLARE_ACCOUNT_ID)');
  if (all) return { workersAccount: all, worker: all, workerStatus: all, d1: all, ai: all };

  /** @param {string} key @returns {any[] | Missing} */
  const dataset = (key) => {
    const rows = account[key];
    if (Array.isArray(rows)) return rows;
    const err = (res.json?.errors ?? []).find((/** @type {any} */ e) => Array.isArray(e?.path) && e.path.includes(key));
    return missing(err?.message ? String(err.message) : firstError(res.json) ?? `${key} was not in the answer`);
  };
  const isMissing = (/** @type {unknown} */ x) => !Array.isArray(x);

  const wa = dataset('workersAccount');
  const w = dataset('worker');
  const ws = dataset('workerStatus');
  const d1 = dataset('d1');
  const ai = dataset('ai');
  /** @param {any[]} rows @param {(r: any) => number} f */
  const total = (rows, f) => rows.reduce((s, r) => s + f(r), 0);

  return {
    workersAccount: isMissing(wa) ? /** @type {Missing} */ (wa) : {
      requests: total(/** @type {any[]} */ (wa), (r) => num(r.sum?.requests)),
      errors: total(/** @type {any[]} */ (wa), (r) => num(r.sum?.errors)),
      cpuMs: total(/** @type {any[]} */ (wa), (r) => num(r.sum?.cpuTimeUs)) / 1000,
    },
    worker: isMissing(w) ? /** @type {Missing} */ (w) : (() => {
      const rows = /** @type {any[]} */ (w);
      // One group (the script) holds the month's quantiles; more groups can't be combined.
      const q = rows.length === 1 ? rows[0].quantiles ?? {} : {};
      return {
        requests: total(rows, (r) => num(r.sum?.requests)),
        errors: total(rows, (r) => num(r.sum?.errors)),
        cpuMs: total(rows, (r) => num(r.sum?.cpuTimeUs)) / 1000,
        p50Ms: typeof q.cpuTimeP50 === 'number' ? q.cpuTimeP50 / 1000 : null,
        p99Ms: typeof q.cpuTimeP99 === 'number' ? q.cpuTimeP99 / 1000 : null,
      };
    })(),
    workerStatus: isMissing(ws) ? /** @type {Missing} */ (ws) : (() => {
      /** @type {Map<number, number>} */
      const by = new Map();
      for (const r of /** @type {any[]} */ (ws)) {
        const s = num(r.dimensions?.httpResponseStatus);
        by.set(s, (by.get(s) ?? 0) + num(r.sum?.requests));
      }
      return [...by].sort(([a], [b]) => a - b).map(([status, requests]) => ({ status, requests }));
    })(),
    d1: isMissing(d1) ? /** @type {Missing} */ (d1) : (() => {
      const rows = /** @type {any[]} */ (d1);
      const mine = rows.filter((r) => r.dimensions?.databaseId === databaseId);
      return {
        rowsRead: total(rows, (r) => num(r.sum?.rowsRead)),
        rowsWritten: total(rows, (r) => num(r.sum?.rowsWritten)),
        db: { rowsRead: total(mine, (r) => num(r.sum?.rowsRead)), rowsWritten: total(mine, (r) => num(r.sum?.rowsWritten)) },
      };
    })(),
    ai: isMissing(ai) ? /** @type {Missing} */ (ai) : (() => {
      /** @type {Map<string, number>} */
      const byDay = new Map();
      for (const r of /** @type {any[]} */ (ai)) {
        const d = String(r.dimensions?.date ?? '');
        byDay.set(d, (byDay.get(d) ?? 0) + num(r.sum?.totalNeurons));
      }
      let busiest = { date: /** @type {string | null} */ (null), neurons: 0 };
      for (const [date, neurons] of byDay) if (neurons > busiest.neurons) busiest = { date, neurons };
      return { total: [...byDay.values()].reduce((a, b) => a + b, 0), busiest };
    })(),
  };
}

// ---- The report ----

/** @param {number} n @param {number} [digits] */
const fmt = (n, digits = 0) => n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
/** A share as a percentage: one decimal, two below 0.1%, and <0.01% below that. @param {number} share */
const pct = (share) => {
  const p = share * 100;
  if (p > 0 && p < 0.01) return '<0.01%';
  return `${p === 0 || p >= 0.1 ? p.toFixed(1) : p.toFixed(2)}%`;
};
/** @param {unknown} x @returns {x is Missing} */
const isMissingValue = (x) => typeof x === 'object' && x !== null && 'missing' in x;

/**
 * The measures the report flags and compares, each read from a Usage.
 * @type {{ key: string, label: string, unit: string, allowance: number | null, per: string, digits: number, get: (u: Usage) => number | Missing }[]}
 */
const MEASURES = [
  { key: 'workerRequests', label: 'Worker requests', unit: '', allowance: ALLOWANCES.workerRequests, per: 'a month', digits: 0,
    get: (u) => (isMissingValue(u.workersAccount) ? u.workersAccount : u.workersAccount.requests) },
  { key: 'workerCpuMs', label: 'Worker CPU', unit: ' ms', allowance: ALLOWANCES.workerCpuMs, per: 'a month', digits: 0,
    get: (u) => (isMissingValue(u.workersAccount) ? u.workersAccount : u.workersAccount.cpuMs) },
  { key: 'd1RowsRead', label: 'D1 rows read', unit: '', allowance: ALLOWANCES.d1RowsRead, per: 'a month', digits: 0,
    get: (u) => (isMissingValue(u.d1) ? u.d1 : u.d1.rowsRead) },
  { key: 'd1RowsWritten', label: 'D1 rows written', unit: '', allowance: ALLOWANCES.d1RowsWritten, per: 'a month', digits: 0,
    get: (u) => (isMissingValue(u.d1) ? u.d1 : u.d1.rowsWritten) },
  { key: 'neuronsPerDay', label: 'Workers AI neurons, busiest day', unit: '', allowance: ALLOWANCES.neuronsPerDay, per: 'a day', digits: 1,
    get: (u) => (isMissingValue(u.ai) ? u.ai : u.ai.busiest.neurons) },
  { key: 'thisWorkerRequests', label: `${WORKER}'s requests`, unit: '', allowance: null, per: '', digits: 0,
    get: (u) => (isMissingValue(u.worker) ? u.worker : u.worker.requests) },
  { key: 'thisWorkerCpuMs', label: `${WORKER}'s CPU`, unit: ' ms', allowance: null, per: '', digits: 0,
    get: (u) => (isMissingValue(u.worker) ? u.worker : u.worker.cpuMs) },
  { key: 'dbRowsRead', label: `\`${DATABASE_NAME}\` rows read`, unit: '', allowance: null, per: '', digits: 0,
    get: (u) => (isMissingValue(u.d1) ? u.d1 : u.d1.db.rowsRead) },
  { key: 'dbRowsWritten', label: `\`${DATABASE_NAME}\` rows written`, unit: '', allowance: null, per: '', digits: 0,
    get: (u) => (isMissingValue(u.d1) ? u.d1 : u.d1.db.rowsWritten) },
];

/**
 * The flags: shares above FLAG_SHARE, and growth on the month before. A busiest day is not
 * projected (it is a day, not a total); every other measure in a month in progress is.
 * @param {MonthWindow} window @param {Usage} current @param {Usage} previous
 * @returns {string[]}
 */
export function flagsFor(window, current, previous) {
  /** @type {string[]} */
  const flags = [];
  for (const m of MEASURES) {
    const v = m.get(current);
    if (isMissingValue(v) || m.allowance === null) continue;
    const share = v / m.allowance;
    if (share > FLAG_SHARE) flags.push(`${m.label} is at ${(share * 100).toFixed(1)}% of its allowance (above ${FLAG_SHARE * 100}%).`);
  }
  const prev = previousMonth(window.month);
  for (const m of MEASURES) {
    const v = m.get(current);
    const p = m.get(previous);
    if (isMissingValue(v) || isMissingValue(p)) continue;
    const projected = window.complete || m.key === 'neuronsPerDay' ? v : v / window.elapsed;
    if (!(projected > p)) continue;
    const growth = p === 0 ? 'from zero' : `${Math.round((projected / p - 1) * 100)}%`;
    const how = projected === v ? '' : ', projected over the whole month';
    flags.push(`${m.label} grew ${growth} on ${prev}${how} (${fmt(p, m.digits)}${m.unit} → ${fmt(projected, m.digits)}${m.unit}).`);
  }
  return flags;
}

/**
 * The report's markdown.
 * @param {{ window: MonthWindow, current: Usage, previous: Usage, generatedAt: Date, commit: string | null }} o
 * @returns {{ markdown: string, flags: string[], missing: string[] }}
 */
export function buildReport({ window, current, previous, generatedAt, commit }) {
  const prev = previousMonth(window.month);
  const lines = [];
  const missing = DATASETS.filter((k) => isMissingValue(current[k]));
  const period = window.complete
    ? `${window.dateFrom} to ${window.dateTo} (UTC), the whole month`
    : `${window.dateFrom} to ${window.to.slice(0, 10)} ${window.to.slice(11, 16)} (UTC), month to date`;
  lines.push(`# Usage report: ${window.month}`, '');
  lines.push(`- **Period:** ${period}.`);
  lines.push(`- **Generated:** ${isoSeconds(generatedAt)} by \`npm run ops:report\`${commit ? ` at \`${commit.slice(0, 7)}\`` : ''}, from Cloudflare's GraphQL Analytics API.`);
  lines.push('- **The month is the calendar month.** Workers Paid bills by the subscription\'s month, which starts on its renewal date; that date isn\'t readable with these API scopes, so a billing month may straddle two of these reports.');
  lines.push('', '## Account-wide, against Workers Paid\'s allowances', '');
  lines.push('| Measure | Used | Included | Share |', '|---|---|---|---|');
  for (const m of MEASURES.filter((x) => x.allowance !== null)) {
    const v = m.get(current);
    const included = `${fmt(/** @type {number} */ (m.allowance))}${m.unit} ${m.per}`;
    if (isMissingValue(v)) { lines.push(`| ${m.label} | missing: ${v.missing} | ${included} | — |`); continue; }
    const day = m.key === 'neuronsPerDay' && !isMissingValue(current.ai) && current.ai.busiest.date ? ` (${current.ai.busiest.date})` : '';
    lines.push(`| ${m.label} | ${fmt(v, m.digits)}${m.unit}${day} | ${included} | ${pct(v / /** @type {number} */ (m.allowance))} |`);
  }
  if (!isMissingValue(current.ai)) lines.push('', `Workers AI used ${fmt(current.ai.total, 1)} neurons in the period in all.`);

  lines.push('', `## This Worker (\`${WORKER}\`)`, '');
  lines.push('| Measure | Value | Share |', '|---|---|---|');
  const w = current.worker;
  const wa = current.workersAccount;
  /** @param {number} part @param {number} whole */
  const shareOf = (part, whole) => (whole > 0 ? `${pct(part / whole)} of the account's` : '');
  if (isMissingValue(w)) {
    lines.push(`| Requests | missing: ${w.missing} | |`);
  } else {
    lines.push(`| Requests | ${fmt(w.requests)} | ${isMissingValue(wa) ? '' : shareOf(w.requests, wa.requests)} |`);
    lines.push(`| CPU | ${fmt(w.cpuMs)} ms | ${isMissingValue(wa) ? '' : shareOf(w.cpuMs, wa.cpuMs)} |`);
    const q = (/** @type {number | null} */ v) => (v === null ? 'missing' : `${v.toFixed(1)} ms`);
    lines.push(`| CPU per request, p50 / p99 | ${q(w.p50Ms)} / ${q(w.p99Ms)} | |`);
    lines.push(`| Errors (exceptions) | ${fmt(w.errors)} | |`);
  }
  const d1 = current.d1;
  if (isMissingValue(d1)) {
    lines.push(`| \`${DATABASE_NAME}\` rows | missing: ${d1.missing} | |`);
  } else {
    lines.push(`| \`${DATABASE_NAME}\` rows read | ${fmt(d1.db.rowsRead)} | ${shareOf(d1.db.rowsRead, d1.rowsRead)} |`);
    lines.push(`| \`${DATABASE_NAME}\` rows written | ${fmt(d1.db.rowsWritten)} | ${shareOf(d1.db.rowsWritten, d1.rowsWritten)} |`);
  }
  lines.push('', 'Requests by HTTP status:', '');
  const ws = current.workerStatus;
  if (isMissingValue(ws)) {
    lines.push(`Missing: ${ws.missing}`);
  } else if (!ws.length) {
    lines.push('None in the period.');
  } else {
    lines.push('| Status | Requests |', '|---|---|');
    for (const s of ws) lines.push(`| ${s.status} | ${fmt(s.requests)} |`);
  }

  const flags = flagsFor(window, current, previous);
  lines.push('', '## Flags', '');
  if (flags.length) for (const f of flags) lines.push(`- ${f}`);
  else lines.push(`None: nothing is above ${FLAG_SHARE * 100}% of its allowance, and nothing grew on ${prev}.`);
  const prevMissing = DATASETS.filter((k) => isMissingValue(previous[k]));
  if (prevMissing.length) lines.push('', `${prev} could not be read for ${prevMissing.join(', ')}, so those measures are not compared.`);
  if (missing.length) lines.push('', `**Missing for ${window.month}:** ${missing.join(', ')}. A missing dataset is not zero; rerun once the cause above is fixed.`);
  return { markdown: `${lines.join('\n')}\n`, flags, missing };
}

// ---- The run ----

/** The D1 database id from wrangler.jsonc. */
export function readDatabaseId() {
  const text = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const m = new RegExp(`"database_name":\\s*"${DATABASE_NAME}",\\s*"database_id":\\s*"([^"]+)"`).exec(text);
  if (!m) throw new Error(`wrangler.jsonc has no database_id for ${DATABASE_NAME}`);
  return m[1];
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: Record<string, string | undefined>, exec?: (cmd: string, args: string[]) => string, fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>, now?: () => Date, log?: (line: string) => void, outDir?: string,
 *   runsDir?: string, databaseId?: string, commit?: import('./run-record.mjs').CommitState,
 * }} [deps]
 * @returns {Promise<{ exitCode: number, path: string | null, flags: string[] }>}
 */
export async function opsReport(argv, deps = {}) {
  const {
    env = process.env, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(),
    log = console.log, outDir = OUT_DIR, runsDir, commit,
    exec = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  } = deps;
  /** @type {{ month?: string }} */
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { month: { type: 'string' } }, strict: true }));
  } catch (err) {
    log(`ops:report: ${/** @type {Error} */ (err).message.split('\n')[0]}. Usage: npm run ops:report -- [--month <yyyy-mm>]`);
    return { exitCode: 2, path: null, flags: [] };
  }
  const started = now();
  /** @type {MonthWindow} */
  let window;
  /** @type {MonthWindow} */
  let prevWindow;
  try {
    window = monthWindow(values.month ?? currentMonth(started), started);
    prevWindow = monthWindow(previousMonth(window.month), started);
  } catch (err) {
    log(`ops:report: ${/** @type {Error} */ (err).message}`);
    return { exitCode: 2, path: null, flags: [] };
  }
  const databaseId = deps.databaseId ?? readDatabaseId();
  const accountTag = env.CLOUDFLARE_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;

  const run = startRun('ops:report', { target: 'Cloudflare GraphQL Analytics API', args: argv, dir: runsDir, now, ...(commit ? { commit } : {}) });
  const unguard = run.guardExit();
  let token = '';
  try {
    token = resolveToken({ env, exec });
    const counted = run.countingFetch(fetchImpl);
    let last = -Infinity;
    /** @param {MonthWindow} w @returns {Promise<Usage>} */
    const usageFor = async (w) => {
      const wait = last + MIN_SPACING_MS - now().getTime();
      if (wait > 0) await sleep(wait);
      last = now().getTime();
      const variables = { accountTag, from: w.from, to: w.to, dateFrom: w.dateFrom, dateTo: w.dateTo, script: WORKER };
      /** @type {{ ok: boolean, status: number, json: any, text: string }} */
      let res;
      try {
        const r = await counted(GRAPHQL_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: USAGE_QUERY, variables }),
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON: reported by status and text */ }
        res = { ok: r.ok, status: r.status, json, text: json ? '' : text };
      } catch (err) {
        res = { ok: false, status: 0, json: null, text: `the request failed: ${/** @type {Error} */ (err).message}` };
      }
      return parseUsage(res, { databaseId, token });
    };
    const current = await usageFor(window);
    const previous = await usageFor(prevWindow);
    run.read('GraphQL Analytics queries', { estimate: 2, actual: 2 });

    const { markdown, flags, missing } = buildReport({ window, current, previous, generatedAt: started, commit: run.data.commit.sha });
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, `${window.month}.md`);
    writeFileSync(path, redact(markdown, token));
    const rel = relative(ROOT, path);
    run.detail('month', window.month).detail('report', rel.startsWith('..') || isAbsolute(rel) ? path : rel)
      .detail('flags', flags.length).detail('missing', missing);
    log(`ops:report: wrote ${rel.startsWith('..') ? path : rel} (${flags.length} flag${flags.length === 1 ? '' : 's'}${missing.length ? `; missing: ${missing.join(', ')}` : ''})`);
    for (const f of flags) log(`  flag: ${redact(f, token)}`);
    const exitCode = missing.length ? 1 : 0;
    run.finish(missing.length ? 'failed' : 'ok', { exitCode, message: missing.length ? `missing for ${window.month}: ${missing.join(', ')}` : `${flags.length} flags` });
    return { exitCode, path, flags };
  } catch (err) {
    const message = redact(String(/** @type {Error} */ (err)?.message ?? err), token).split('\n')[0];
    log(`ops:report: ${message}`);
    run.finish('failed', { exitCode: 1, message });
    return { exitCode: 1, path: null, flags: [] };
  } finally {
    unguard();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode } = await opsReport(process.argv.slice(2));
  process.exitCode = exitCode;
}
