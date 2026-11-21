// @ts-check
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ACAD_YEAR, MODULE_CODE_RE, assertExpectedShape, catalogueOnlyRecords, fetchAcadYearFile, loadNgCourses, offeredModules } from './lib.mjs';
import { ROW_COLUMNS, boundTuple } from '../src/rowhash.js';
import { corpusDataVersion } from './corpus-manifest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NUSMODS = 'https://api.nusmods.com/v2';
export const DEFAULT_CACHE_DIR = resolve(ROOT, '.data/drift-cache');

export const LABELS = Object.freeze({
  pending: 'drift:pending',
  nextYear: 'drift:next-year',
  failure: 'drift:failure',
  reminder: 'drift:reminder',
});
export const MARKERS = Object.freeze({
  pending: '<!-- vnm-drift:pending -->',
  failure: '<!-- vnm-drift:failure -->',
  /** @param {string} year */
  nextYear: (year) => `<!-- vnm-drift:next-year ${year} -->`,
  /** @param {string} month */
  reminder: (month) => `<!-- vnm-drift:reminder ${month} -->`,
  /** @param {string} sha */
  quiet: (sha) => `<!-- vnm-drift:quiet ${sha} -->`,
});
const STATE_RE = /<!-- vnm-drift:state (.*?) -->/g;

export const SCHEDULES = Object.freeze({ weekly: '17 1 * * 1', monthly: '41 1 1 * *' });
/** @type {Readonly<Record<string, 'weekly' | 'monthly'>>} */
export const CHECK_FOR_SCHEDULE = Object.freeze({ [SCHEDULES.weekly]: 'weekly', [SCHEDULES.monthly]: 'monthly' });

export const QUIET_WARN_DAYS = 45;
export const QUIET_STOP_DAYS = 60;
const HISTORY_ROWS = 26;
const CODES_SHOWN = 20;
const DAY_MS = 86_400_000;

const FIELDS = ROW_COLUMNS.slice(1);

/** @param {string} acadYear */
export function nextAcadYear(acadYear) {
  const m = /^(\d{4})-(\d{4})$/.exec(acadYear);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) throw new Error(`"${acadYear}" is not an acad year (yyyy-yyyy)`);
  return `${Number(m[1]) + 1}-${Number(m[2]) + 1}`;
}

/**
 * @typedef {{
 *   acadYear: string, dataVersion: string,
 *   offered: Map<string, (string | number | null)[]>, catalogue: Map<string, string>,
 *   counts: { offered: number, catalogueOnly: number, skipped: number },
 * }} Summary
 * @typedef {{
 *   offered: { added: string[], removed: string[], changed: number, byField: Record<string, number> },
 *   catalogue: { added: string[], removed: string[], changed: number },
 * }} Comparison
 * @typedef {{
 *   offered: { added: number, removed: number, changed: number, byField: Record<string, number>, addedCodes: string[], removedCodes: string[],
 *     oddCodes?: number },
 *   catalogue: { added: number, removed: number, changed: number },
 * }} CompactComparison
 * @typedef {{ date: string, dataVersion: string, comparison: Comparison | CompactComparison | null, unchanged?: boolean }} HistoryEntry
 */

/**
 * @param {any[]} records
 * @param {string} acadYear
 * @param {import('./lib.mjs').NgCourses} ngCourses
 * @returns {Promise<Summary>}
 */
export async function summarise(records, acadYear, ngCourses) {
  const { modules, skipped } = offeredModules(records, acadYear, ngCourses);
  const version = await corpusDataVersion(records, acadYear, ngCourses);
  const catalogue = new Map(catalogueOnlyRecords(records).map((r) => [r.code, JSON.stringify([r.title, r.description])]));
  return {
    acadYear,
    dataVersion: version,
    offered: new Map(modules.map((m) => [m.code, boundTuple(m)])),
    catalogue,
    counts: { offered: modules.length, catalogueOnly: catalogue.size, skipped: skipped.length },
  };
}

/**
 * @param {Summary} before
 * @param {Summary} after
 * @returns {Comparison}
 */
export function compareSummaries(before, after) {
  const sorted = (/** @type {Iterable<string>} */ codes) => [...codes].sort();
  /** @type {Record<string, number>} */
  const byField = {};
  let changed = 0;
  for (const [code, tuple] of after.offered) {
    const old = before.offered.get(code);
    if (!old) continue;
    let any = false;
    tuple.forEach((v, i) => {
      if (i === 0 || v === old[i]) return;
      const field = FIELDS[i - 1];
      byField[field] = (byField[field] ?? 0) + 1;
      any = true;
    });
    if (any) changed += 1;
  }
  let catChanged = 0;
  for (const [code, v] of after.catalogue) if (before.catalogue.has(code) && before.catalogue.get(code) !== v) catChanged += 1;
  return {
    offered: {
      added: sorted([...after.offered.keys()].filter((c) => !before.offered.has(c))),
      removed: sorted([...before.offered.keys()].filter((c) => !after.offered.has(c))),
      changed,
      byField,
    },
    catalogue: {
      added: sorted([...after.catalogue.keys()].filter((c) => !before.catalogue.has(c))),
      removed: sorted([...before.catalogue.keys()].filter((c) => !after.catalogue.has(c))),
      changed: catChanged,
    },
  };
}

/** @param {unknown} c */
export const showableCode = (c) => typeof c === 'string' && MODULE_CODE_RE.test(c);
/** @param {unknown} v */
const count = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * @param {Comparison | CompactComparison} c
 * @returns {CompactComparison}
 */
function compact(c) {
  const n = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.length : count(v));
  const o = /** @type {any} */ (c?.offered ?? {});
  const cat = /** @type {any} */ (c?.catalogue ?? {});
  /** @param {unknown} full @param {unknown} kept */
  const codes = (full, kept) => /** @type {unknown[]} */ (Array.isArray(full) ? full : Array.isArray(kept) ? kept : []);
  const added = codes(o.added, o.addedCodes);
  const removed = codes(o.removed, o.removedCodes);
  const odd = Array.isArray(o.added) || Array.isArray(o.removed)
    ? [...added, ...removed].filter((x) => !showableCode(x)).length
    : count(o.oddCodes);
  /** @type {Record<string, number>} */
  const byField = {};
  for (const [f, v] of Object.entries(o.byField ?? {})) if (FIELDS.includes(f)) byField[f] = count(v);
  return {
    offered: {
      added: n(o.added), removed: n(o.removed), changed: count(o.changed), byField,
      addedCodes: /** @type {string[]} */ (added.filter(showableCode).slice(0, CODES_SHOWN)),
      removedCodes: /** @type {string[]} */ (removed.filter(showableCode).slice(0, CODES_SHOWN)),
      ...(odd ? { oddCodes: odd } : {}),
    },
    catalogue: { added: n(cat.added), removed: n(cat.removed), changed: count(cat.changed) },
  };
}

/** @param {Date} d */
const day = (d) => d.toISOString().slice(0, 10);
/** @param {Date} d */
const minute = (d) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
/** @param {number} n */
const fmt = (n) => n.toLocaleString('en-US');

/**
 * @param {string} body
 * @returns {{ history: HistoryEntry[] }}
 */
export function parseState(body) {
  const m = [...String(body ?? '').matchAll(STATE_RE)].at(-1);
  if (!m) return { history: [] };
  /** @type {any} */
  let s;
  try { s = JSON.parse(m[1]); } catch { return { history: [] }; }
  if (!Array.isArray(s?.history)) return { history: [] };
  /** @type {HistoryEntry[]} */
  const history = [];
  for (const h of s.history) {
    if (typeof h?.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(h.date) || typeof h.dataVersion !== 'string' || !/^[0-9a-f]{12}$/.test(h.dataVersion)) continue;
    if (h.comparison !== null && (typeof h.comparison !== 'object' || typeof h.comparison.offered !== 'object' || h.comparison.offered === null)) continue;
    history.push({ date: h.date, dataVersion: h.dataVersion, comparison: h.comparison === null ? null : compact(h.comparison), ...(h.unchanged === true ? { unchanged: true } : {}) });
  }
  return { history };
}

/**
 * @param {{ acadYear: string, production: { dataVersion: string, sha: string | null }, nusmods: { dataVersion: string, counts: Summary['counts'] },
 *   checkedAt: Date, history: HistoryEntry[] }} o
 */
export function pendingIssue({ acadYear, production, nusmods, checkedAt, history }) {
  const kept = history.slice(-HISTORY_ROWS).map((h) => ({ ...h, comparison: h.comparison ? compact(h.comparison) : null }));
  const rows = kept.map((h) => {
    const head = `| ${h.date} | \`${h.dataVersion}\` |`;
    if (!h.comparison) return `${head} ${h.unchanged ? 'unchanged since the check before' : 'no earlier copy was cached to compare with'} | | |`;
    const { offered: o, catalogue: c } = h.comparison;
    const fields = Object.entries(o.byField).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, n]) => `${f} ${fmt(n)}`).join(', ') || '—';
    return `${head} +${fmt(o.added)} −${fmt(o.removed)} ~${fmt(o.changed)} | ${fields} | +${fmt(c.added)} −${fmt(c.removed)} ~${fmt(c.changed)} |`;
  });
  const latest = kept.at(-1)?.comparison;
  /** @param {string} what @param {string[]} codes @param {number} total */
  const named = (what, codes, total) => (total && codes.length ? `${what}: ${codes.join(', ')}${total > codes.length ? ` and ${fmt(total - codes.length)} more` : ''}.` : null);
  const odd = latest?.offered.oddCodes ?? 0;
  const latestCodes = latest
    ? [
      named('Added', latest.offered.addedCodes, latest.offered.added), named('Removed', latest.offered.removedCodes, latest.offered.removed),
      odd ? `${fmt(odd)} code${odd === 1 ? '' : 's'} not in the course-code shape (not shown).` : null,
    ].filter(Boolean)
    : [];
  const state = JSON.stringify({ history: kept }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const body = [
    MARKERS.pending,
    `NUSMods' data for ${acadYear} no longer matches what production was loaded from.`,
    '',
    `- Production's data version is \`${production.dataVersion}\` (\`src/data-version.json\`${production.sha ? ` at \`${production.sha.slice(0, 7)}\`` : ''}).`,
    `- NUSMods' data for ${acadYear} now gives \`${nusmods.dataVersion}\`: ${fmt(nusmods.counts.offered)} offered courses (the rows ingest would write), ${fmt(nusmods.counts.catalogueOnly)} catalogue-only.`,
    '',
    'A refresh runs on the Mac: "A corpus-only refresh" in `docs/year-refresh/README.md`, from `npm run corpus -- fetch` to the standby '
      + '(no NUS document changed, so no sources key and no `year check --full`). '
      + 'The check closes this issue once production\'s data version matches NUSMods again.',
    '',
    '### What changed, check by check',
    '',
    'Each row compares NUSMods with the copy the check before it saw: offered courses added (+), removed (−) and changed (~), the D1 columns that changed and in how many courses, and the same counts for catalogue-only codes.',
    '',
    '| Checked | NUSMods data version | Offered | Changed columns | Catalogue-only |',
    '|---|---|---|---|---|',
    ...rows,
    ...(latestCodes.length ? ['', `Latest check. ${latestCodes.join(' ')}`] : []),
    '',
    `Last checked ${minute(checkedAt)}.`,
    '',
    `<!-- vnm-drift:state ${state} -->`,
  ].join('\n');
  return { title: `NUSMods data for ${acadYear} differs from production`, body, labels: [LABELS.pending] };
}

/** @param {{ acadYear: string, dataVersion: string, checkedAt: Date }} o */
export function resolvedComment({ acadYear, dataVersion: version, checkedAt }) {
  return `NUSMods' data for ${acadYear} gives \`${version}\`, production's data version (\`src/data-version.json\`), as of the check on ${minute(checkedAt)}. Closing: no refresh is pending.`;
}

/** @param {{ nextYear: string, count: number, checkedAt: Date }} o */
export function nextYearIssue({ nextYear, count, checkedAt }) {
  const body = [
    MARKERS.nextYear(nextYear),
    `NUSMods now publishes ${nextYear}: its \`moduleList.json\` lists ${fmt(count)} courses (weekly check, ${day(checkedAt)}).`,
    '',
    'The switch follows ADR 0015: switch once NUSMods has the new year '
      + 'and NUS\'s Sem 1 exchange list is out (about July). Until NUS publishes the Sem 2 list, Sem 2 shows last year\'s, labelled, and counted "to confirm".',
    '',
    'The check never closes this issue, and opens no second one for this year. Close it when the switch is done.',
  ].join('\n');
  return { title: `NUSMods has ${nextYear}`, body, labels: [LABELS.nextYear] };
}

/** @param {unknown} error */
const errorText = (error) => String(/** @type {Error} */ (error)?.message ?? error).split('\n').slice(0, 20).join('\n').replace(/```/g, "'''");

/** @param {{ error: unknown, runUrl: string | null, checkedAt: Date, check?: string }} o */
export function failureIssue({ error, runUrl, checkedAt, check = 'weekly' }) {
  const body = [
    MARKERS.failure,
    `The drift check (\`.github/workflows/drift.yml\`, \`scripts/drift.mjs ${check}\`) failed on ${minute(checkedAt)}:`,
    '',
    '```',
    errorText(error),
    '```',
    '',
    ...(runUrl ? [`Run: ${runUrl}`, ''] : []),
    'Until it is fixed the check cannot tell whether a refresh is due. A NUSMods shape change needs `scripts/lib.mjs` (and ingest) to follow it; '
      + 'an HTTP error that persists may mean NUSMods moved. The check closes this issue after its next good run.',
  ].join('\n');
  return { title: 'The NUSMods drift check failed', body, labels: [LABELS.failure] };
}

/** @param {{ error: unknown, runUrl: string | null, checkedAt: Date }} o */
const failureComment = ({ error, runUrl, checkedAt }) => [`Failed again on ${minute(checkedAt)}:`, '', '```', errorText(error), '```', ...(runUrl ? ['', `Run: ${runUrl}`] : [])].join('\n');

/**
 * @param {Date} then
 * @param {Date} now
 */
export const daysBetween = (then, now) => Math.floor((now.getTime() - then.getTime()) / DAY_MS);

/**
 * @param {Date} lastCommit
 * @param {Date} today
 * @returns {string | null}
 */
export function quietNote(lastCommit, today) {
  const days = daysBetween(lastCommit, today);
  if (lastCommit.getTime() + QUIET_WARN_DAYS * DAY_MS >= today.getTime()) return null;
  const by = day(new Date(lastCommit.getTime() + QUIET_STOP_DAYS * DAY_MS));
  return `**The repo has had no commit for ${days} days** (the last on ${day(lastCommit)}). GitHub stops a public repo's scheduled workflows after `
    + `${QUIET_STOP_DAYS} days with no repository activity (https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow), `
    + `and these checks would stop with them. Commit something ${by > day(today) ? `before ${by}` : 'now'}, such as last month's usage report, to keep them running.`;
}

/** @param {string} month */
const monthBefore = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
/** @param {Date} d */
const monthOf = (d) => d.toISOString().slice(0, 7);

/** @param {{ month: string, today: Date, lastCommit: { sha: string | null, date: Date }, ngUpdatedAsAt: string | null, acadYear?: string }} o */
export function reminderIssue({ month, today, lastCommit, ngUpdatedAsAt, acadYear = DEFAULT_ACAD_YEAR }) {
  const report = monthBefore(month);
  const note = quietNote(lastCommit.date, today);
  const body = [
    MARKERS.reminder(month),
    'The monthly check. NUS blocks scripted downloads, so these pages are checked by hand.',
    '',
    `- [ ] The Registrar's list of courses offered to Non-Graduating (NG) students: is its "updated as at" later than ${ngUpdatedAsAt ?? 'the one recorded'} (\`data/ng-courses-${acadYear}.json\`), or is a new semester's list out?`,
    `- [ ] The Registrar's course restrictions for NG students: a revision later than the one in \`data/ng-sources-${acadYear}.json\`?`,
    '- [ ] YST\'s pages of courses for NUS non-music majors: a new semester\'s page?',
    `- [ ] Last month's usage report, on the Mac: \`npm run ops:report -- --month ${report}\`, then commit \`ops/reports/${report}.md\` and its run record.`,
    '',
    'A changed source is a revision: "A mid-year revision" in `docs/year-refresh/README.md`. The weekly check covers NUSMods.',
    ...(note ? ['', note] : []),
  ].join('\n');
  return { title: `Monthly check, ${month}: NUS's exchange pages and the usage report`, body, labels: [LABELS.reminder] };
}

/**
 * @param {{ today: Date, lastCommit: { sha: string, date: Date } }} o
 * @returns {{ title: string, body: string, labels: string[] } | null}
 */
export function quietIssue({ today, lastCommit }) {
  const note = quietNote(lastCommit.date, today);
  if (!note) return null;
  return {
    title: `No commit for ${daysBetween(lastCommit.date, today)} days: the scheduled checks stop at ${QUIET_STOP_DAYS}`,
    body: [MARKERS.quiet(lastCommit.sha), note].join('\n'),
    labels: [LABELS.reminder],
  };
}

/**
 * @typedef {{ number: number, title: string, body: string, state: string, labels: string[] }} Issue
 * @typedef {{
 *   listIssues: (q: { label: string, state: 'open' | 'all' }) => Promise<Issue[]>,
 *   createIssue: (i: { title: string, body: string, labels: string[] }) => Promise<{ number: number }>,
 *   updateIssue: (n: number, patch: { body?: string, state?: 'open' | 'closed' }) => Promise<unknown>,
 *   comment: (n: number, body: string) => Promise<unknown>,
 *   ensureLabels: (labels: string[]) => Promise<unknown>,
 * }} GitHub
 */

/**
 * @param {Pick<GitHub, 'listIssues'>} github
 * @param {{ label: string, marker: string, state: 'open' | 'all' }} q
 */
export async function findIssue(github, { label, marker, state }) {
  const issues = await github.listIssues({ label, state });
  return issues.filter((i) => (i.body ?? '').includes(marker)).sort((a, b) => a.number - b.number)[0] ?? null;
}

/** @type {Record<string, string>} */
const LABEL_COLOURS = { [LABELS.pending]: 'fbca04', [LABELS.nextYear]: '0e8a16', [LABELS.failure]: 'b60205', [LABELS.reminder]: '1d76db' };

/**
 * @param {{ repo: string, token: string, fetchImpl?: typeof fetch }} o
 * @returns {GitHub}
 */
export function githubRest({ repo, token, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repo}`;
  /** @param {string} method @param {string} path @param {unknown} [body] @param {{ allow404?: boolean }} [o] */
  const call = async (method, path, body, { allow404 = false } = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'drift-check',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      let why = '';
      try { why = String(/** @type {any} */ (await res.json())?.message ?? ''); } catch {}
      throw new Error(`GitHub ${method} /repos/${repo}${path.split('?')[0]} -> HTTP ${res.status}${why ? `: ${why}` : ''}`);
    }
    return res.status === 204 ? null : res.json();
  };
  return {
    async listIssues({ label, state }) {
      /** @type {Issue[]} */
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const q = new URLSearchParams({ labels: label, state, per_page: '100', page: String(page) });
        const items = /** @type {any[]} */ (await call('GET', `/issues?${q}`));
        for (const i of items) {
          if (i.pull_request) continue;
          out.push({ number: i.number, title: i.title, body: i.body ?? '', state: i.state, labels: (i.labels ?? []).map((/** @type {any} */ l) => (typeof l === 'string' ? l : l.name)) });
        }
        if (items.length < 100) break;
      }
      return out;
    },
    async createIssue({ title, body, labels }) {
      const i = /** @type {any} */ (await call('POST', '/issues', { title, body, labels }));
      return { number: i.number };
    },
    updateIssue: (n, patch) => call('PATCH', `/issues/${n}`, patch),
    comment: (n, body) => call('POST', `/issues/${n}/comments`, { body }),
    async ensureLabels(labels) {
      for (const name of labels) {
        if (await call('GET', `/labels/${encodeURIComponent(name)}`, undefined, { allow404: true })) continue;
        await call('POST', '/labels', { name, color: LABEL_COLOURS[name] ?? 'ededed', description: 'Opened by the drift check (scripts/drift.mjs)' });
      }
    },
  };
}

/**
 * @param {(line: string) => void} log
 * @returns {GitHub}
 */
export function dryRunGitHub(log) {
  let n = 0;
  return {
    listIssues: async () => [],
    createIssue: async ({ title, body, labels }) => { log(`would open "${title}" [${labels.join(', ')}]:\n${body}\n`); return { number: ++n }; },
    updateIssue: async (num, patch) => { log(`would update #${num}: ${JSON.stringify(patch).slice(0, 200)}`); },
    comment: async (num, body) => { log(`would comment on #${num}: ${body}`); },
    ensureLabels: async () => {},
  };
}

/**
 * @param {GitHub} github
 * @param {{ error: unknown, runUrl: string | null, checkedAt: Date, check?: string }} o
 */
export async function reportFailure(github, o) {
  const open = await findIssue(github, { label: LABELS.failure, marker: MARKERS.failure, state: 'open' });
  if (open) { await github.comment(open.number, failureComment(o)); return open.number; }
  const issue = failureIssue(o);
  await github.ensureLabels(issue.labels);
  return (await github.createIssue(issue)).number;
}

/**
 * @param {GitHub} github
 * @param {Date} checkedAt
 * @param {string} check
 */
async function recovered(github, checkedAt, check) {
  const open = await findIssue(github, { label: LABELS.failure, marker: MARKERS.failure, state: 'open' });
  if (!open) return;
  await github.comment(open.number, `The ${check} check passed again on ${minute(checkedAt)}. Closing.`);
  await github.updateIssue(open.number, { state: 'closed' });
}

/**
 * @param {string} year
 * @param {typeof fetch} fetchImpl
 */
async function nextYearCount(year, fetchImpl) {
  const url = `${NUSMODS}/${year}/moduleList.json`;
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`NUSMods returned HTTP ${res.status} for ${url}`);
  /** @type {unknown} */
  let list;
  try { list = await res.json(); } catch { throw new Error(`${url} is not JSON`); }
  if (!Array.isArray(list)) throw new Error(`${url} is not a list of courses: the NUSMods v2 shape has changed`);
  return list.length ? list.length : null;
}

/**
 * @param {string} cacheDir
 * @param {string} acadYear
 */
async function cachedRecords(cacheDir, acadYear) {
  try {
    const records = JSON.parse(await readFile(resolve(cacheDir, `${acadYear}-moduleInfo.json`), 'utf8'));
    assertExpectedShape(records);
    return /** @type {any[]} */ (records);
  } catch {
    return null;
  }
}

/**
 * @param {{ acadYear?: string, cacheDir: string, fetchImpl?: typeof fetch, github: GitHub, now?: () => Date,
 *   ngCourses?: import('./lib.mjs').NgCourses, committed: { dataVersion: string, sha: string | null },
 *   lastCommit?: { sha: string | null, date: Date }, runUrl: string | null, log?: (line: string) => void }} o
 * @returns {Promise<{ exitCode: number, dataVersion?: string, pending?: boolean, nextYear?: number | null }>}
 */
export async function weeklyCheck(o) {
  const { acadYear = DEFAULT_ACAD_YEAR, cacheDir, fetchImpl = fetch, github, now = () => new Date(), committed, runUrl, log = console.log } = o;
  const checkedAt = now();
  try {
    const previous = await cachedRecords(cacheDir, acadYear);
    await mkdir(cacheDir, { recursive: true });
    const info = await fetchAcadYearFile(acadYear, 'moduleInfo.json', {
      cacheDir: pathToFileURL(`${resolve(cacheDir)}/`), fetchImpl, maxAgeMs: 0, now: () => checkedAt.getTime(),
    });
    assertExpectedShape(info.data);
    const unchanged = info.cached && info.revalidated;
    const ng = o.ngCourses ?? await loadNgCourses(acadYear);
    const current = await summarise(info.data, acadYear, ng);
    const comparison = !unchanged && previous ? compareSummaries(await summarise(previous, acadYear, ng), current) : null;
    log(`NUSMods ${acadYear}: ${unchanged ? 'unchanged (304)' : `fetched, ${fmt(info.bytes)} B`}; data version ${current.dataVersion}, production ${committed.dataVersion}`);
    const next = nextAcadYear(acadYear);
    const nextCount = await nextYearCount(next, fetchImpl);
    log(`NUSMods ${next}: ${nextCount === null ? 'not published' : `${fmt(nextCount)} courses`}`);

    const open = await findIssue(github, { label: LABELS.pending, marker: MARKERS.pending, state: 'open' });
    const pending = current.dataVersion !== committed.dataVersion;
    if (!pending && open) {
      await github.comment(open.number, resolvedComment({ acadYear, dataVersion: current.dataVersion, checkedAt }));
      await github.updateIssue(open.number, { state: 'closed' });
      log(`closed #${open.number}: production matches NUSMods`);
    } else if (pending) {
      const history = open ? parseState(open.body).history : [];
      const today = day(checkedAt);
      if (!unchanged || !history.length) {
        /** @type {HistoryEntry} */
        const entry = { date: today, dataVersion: current.dataVersion, comparison, ...(unchanged ? { unchanged: true } : {}) };
        if (history.at(-1)?.date === today) history[history.length - 1] = entry;
        else history.push(entry);
      }
      const issue = pendingIssue({ acadYear, production: committed, nusmods: current, checkedAt, history });
      if (open) {
        await github.updateIssue(open.number, { body: issue.body });
        log(`updated #${open.number}`);
      } else {
        await github.ensureLabels(issue.labels);
        log(`opened #${(await github.createIssue(issue)).number}: a refresh is pending`);
      }
    }

    if (nextCount !== null) {
      const seen = await findIssue(github, { label: LABELS.nextYear, marker: MARKERS.nextYear(next), state: 'all' });
      if (!seen) {
        const issue = nextYearIssue({ nextYear: next, count: nextCount, checkedAt });
        await github.ensureLabels(issue.labels);
        log(`opened #${(await github.createIssue(issue)).number}: NUSMods has ${next}`);
      }
    }
    if (o.lastCommit?.sha) {
      const quiet = quietIssue({ today: checkedAt, lastCommit: /** @type {{ sha: string, date: Date }} */ (o.lastCommit) });
      if (quiet && !(await findIssue(github, { label: LABELS.reminder, marker: MARKERS.quiet(o.lastCommit.sha), state: 'all' }))) {
        await github.ensureLabels(quiet.labels);
        log(`opened #${(await github.createIssue(quiet)).number}: no commit for ${daysBetween(o.lastCommit.date, checkedAt)} days`);
      }
    }
    await recovered(github, checkedAt, 'weekly');
    return { exitCode: 0, dataVersion: current.dataVersion, pending, nextYear: nextCount };
  } catch (error) {
    log(`the weekly check failed: ${errorText(error)}`);
    const n = await reportFailure(github, { error, runUrl, checkedAt, check: 'weekly' });
    log(`reported in #${n}`);
    return { exitCode: 1 };
  }
}

/**
 * @param {{ github: GitHub, now?: () => Date, lastCommit: { sha: string | null, date: Date }, ngUpdatedAsAt: string | null,
 *   acadYear?: string, log?: (line: string) => void }} o
 */
export async function monthlyCheck({ github, now = () => new Date(), lastCommit, ngUpdatedAsAt, acadYear = DEFAULT_ACAD_YEAR, log = console.log }) {
  const today = now();
  const month = monthOf(today);
  const seen = await findIssue(github, { label: LABELS.reminder, marker: MARKERS.reminder(month), state: 'all' });
  if (seen) { log(`the reminder for ${month} is #${seen.number}`); return { exitCode: 0 }; }
  const issue = reminderIssue({ month, today, lastCommit, ngUpdatedAsAt, acadYear });
  await github.ensureLabels(issue.labels);
  log(`opened #${(await github.createIssue(issue)).number}: the reminder for ${month}`);
  return { exitCode: 0 };
}

/** @param {string[]} args */
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, log?: (line: string) => void }} [deps]
 */
export async function main(argv, { env = process.env, log = console.log } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'cache-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } }, strict: true });
  const check = positionals[0] || (env.SCHEDULE ? CHECK_FOR_SCHEDULE[env.SCHEDULE] : undefined);
  if (check !== 'weekly' && check !== 'monthly' && check !== 'failure') {
    log(`drift: name a check (weekly, monthly or failure)${env.SCHEDULE ? `; schedule "${env.SCHEDULE}" is not one of drift.yml's` : ''}`);
    return 2;
  }
  /** @type {GitHub} */
  let github;
  if (values['dry-run']) {
    github = dryRunGitHub(log);
  } else {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) { log('drift: GITHUB_TOKEN and GITHUB_REPOSITORY must be set (or pass --dry-run)'); return 2; }
    github = githubRest({ repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN });
  }
  const runUrl = env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const checkedAt = new Date();

  if (check === 'failure') {
    const n = await reportFailure(github, { error: new Error('A step of the drift workflow failed before the check ran; see the run.'), runUrl, checkedAt, check: 'setup' });
    log(`reported in #${n}`);
    return 1;
  }
  const [lastSha, lastDate] = git(['log', '-1', '--format=%H%n%cI']).split('\n');
  const lastCommit = { sha: lastSha, date: new Date(lastDate) };
  if (check === 'monthly') {
    const ng = JSON.parse(readFileSync(resolve(ROOT, `data/ng-courses-${DEFAULT_ACAD_YEAR}.json`), 'utf8'));
    try {
      return (await monthlyCheck({ github, lastCommit, ngUpdatedAsAt: ng.updatedAsAt ?? null, log })).exitCode;
    } catch (error) {
      log(`the monthly check failed: ${errorText(error)}`);
      await reportFailure(github, { error, runUrl, checkedAt, check: 'monthly' });
      return 1;
    }
  }
  const committed = { dataVersion: String(JSON.parse(readFileSync(resolve(ROOT, 'src/data-version.json'), 'utf8')).version), sha: lastSha };
  const cacheDir = resolve(values['cache-dir'] ?? DEFAULT_CACHE_DIR);
  return (await weeklyCheck({ cacheDir, github, committed, lastCommit, runUrl, log })).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
