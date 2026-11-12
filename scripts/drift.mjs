// @ts-check
// The NUSMods drift check and the monthly reminder (Phase 7 7F, G3 (a) in ADR 0011), run by
// .github/workflows/drift.yml. It reads NUSMods' public API and writes GitHub issues, and talks
// to nothing else: not the hosting platform, not the live site. Refreshing stays a command run
// on the Mac.
//
//   node scripts/drift.mjs weekly  [--cache-dir <dir>] [--dry-run]
//   node scripts/drift.mjs monthly [--dry-run]
//   node scripts/drift.mjs failure            (a step before the check failed)
//
// With no check named, the schedule in $SCHEDULE picks it (CHECK_FOR_SCHEDULE).
//
// Weekly:
// - fetch this year's moduleInfo.json (a conditional GET with the ETag kept in --cache-dir, which
//   the workflow keeps with actions/cache) and next year's moduleList.json;
// - compute the data version offline with corpusDataVersion (scripts/corpus-manifest.mjs: the
//   function 7D's CI checks src/data-version.json with, offeredModules over HEAD's NG files,
//   rowHash, dataVersion), and compare it with src/data-version.json, production's;
// - keep one "pending refresh" issue updated while they differ, with what changed in each check
//   by D1 column, and close it once they match;
// - open a separate issue when next year appears, which it never closes;
// - open an issue on its own failure (a NUSMods shape change, an HTTP error), and close it after
//   the next good run.
// Monthly: one reminder issue a month to check the Registrar's and YST's pages and to run the
// usage report, with a warning when the last commit is more than 45 days old. The weekly run also
// opens that warning as its own issue, once per quiet stretch, since a monthly run can miss the
// window between day 45 and day 60.
//
// Issues are found by label and a hidden marker in the body, never by title.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ACAD_YEAR, assertExpectedShape, catalogueOnlyRecords, fetchAcadYearFile, loadNgCourses, offeredModules } from './lib.mjs';
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
  /** @param {string} month yyyy-mm */
  reminder: (month) => `<!-- vnm-drift:reminder ${month} -->`,
  /** One per quiet stretch, keyed by the last commit. @param {string} sha */
  quiet: (sha) => `<!-- vnm-drift:quiet ${sha} -->`,
});
const STATE_RE = /<!-- vnm-drift:state (.*?) -->/;

/** The workflow's two crons (drift.yml), and the check each one runs. */
export const SCHEDULES = Object.freeze({ weekly: '17 1 * * 1', monthly: '41 1 1 * *' });
/** @type {Readonly<Record<string, 'weekly' | 'monthly'>>} */
export const CHECK_FOR_SCHEDULE = Object.freeze({ [SCHEDULES.weekly]: 'weekly', [SCHEDULES.monthly]: 'monthly' });

/** The last commit's age at which the reminder warns, and the age at which GitHub stops schedules. */
export const QUIET_WARN_DAYS = 45;
export const QUIET_STOP_DAYS = 60;
/** How many checks the pending issue keeps rows for, and how many codes a row names. */
const HISTORY_ROWS = 26;
const CODES_SHOWN = 20;
const DAY_MS = 86_400_000;

/** The D1 columns a module row binds, after the key (the comparison's fields). */
const FIELDS = ROW_COLUMNS.slice(1);

/** @param {string} acadYear yyyy-yyyy */
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
 *   offered: { added: number, removed: number, changed: number, byField: Record<string, number>, addedCodes: string[], removedCodes: string[] },
 *   catalogue: { added: number, removed: number, changed: number },
 * }} CompactComparison
 * @typedef {{ date: string, dataVersion: string, comparison: Comparison | CompactComparison | null, unchanged?: boolean }} HistoryEntry
 */

/**
 * What ingest would write from these records: the offered modules' D1 rows (boundTuple) and the
 * catalogue-only codes, and the data version, computed as ingest computes it.
 * @param {any[]} records moduleInfo.json
 * @param {string} acadYear
 * @param {Awaited<ReturnType<typeof loadNgCourses>>} ngCourses
 * @returns {Promise<Summary>}
 */
export async function summarise(records, acadYear, ngCourses) {
  const { modules, skipped } = offeredModules(records, acadYear, ngCourses);
  // The data version by the function 7D's CI checks src/data-version.json with.
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
 * Codes added, removed and changed between two summaries, and for offered modules how many
 * changed in each D1 column.
 * @param {Summary} before @param {Summary} after
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

/** A comparison as the pending issue keeps it: counts, and the first codes only. @param {Comparison | CompactComparison} c @returns {CompactComparison} */
function compact(c) {
  const n = (/** @type {string[] | number} */ v) => (Array.isArray(v) ? v.length : v);
  const o = /** @type {any} */ (c.offered);
  return {
    offered: {
      added: n(o.added), removed: n(o.removed), changed: o.changed, byField: { ...o.byField },
      addedCodes: (Array.isArray(o.added) ? o.added : o.addedCodes ?? []).slice(0, CODES_SHOWN),
      removedCodes: (Array.isArray(o.removed) ? o.removed : o.removedCodes ?? []).slice(0, CODES_SHOWN),
    },
    catalogue: { added: n(c.catalogue.added), removed: n(c.catalogue.removed), changed: c.catalogue.changed },
  };
}

/** @param {Date} d */
const day = (d) => d.toISOString().slice(0, 10);
/** @param {Date} d */
const minute = (d) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
/** @param {number} n */
const fmt = (n) => n.toLocaleString('en-US');

/** The history a pending issue carries in its hidden marker. @param {string} body @returns {{ history: HistoryEntry[] }} */
export function parseState(body) {
  const m = STATE_RE.exec(body ?? '');
  if (!m) return { history: [] };
  try {
    const s = JSON.parse(m[1]);
    return { history: Array.isArray(s?.history) ? s.history : [] };
  } catch {
    return { history: [] };
  }
}

/**
 * The pending-refresh issue.
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
  const named = (what, codes, total) => (total ? `${what}: ${codes.join(', ')}${total > codes.length ? ` and ${fmt(total - codes.length)} more` : ''}.` : null);
  const latestCodes = latest
    ? [named('Added', latest.offered.addedCodes, latest.offered.added), named('Removed', latest.offered.removedCodes, latest.offered.removed)].filter(Boolean)
    : [];
  const state = JSON.stringify({ history: kept }).replace(/>/g, '\\u003e');
  const body = [
    MARKERS.pending,
    `NUSMods' data for ${acadYear} no longer matches what production was loaded from.`,
    '',
    `- Production's data version is \`${production.dataVersion}\` (\`src/data-version.json\`${production.sha ? ` at \`${production.sha.slice(0, 7)}\`` : ''}).`,
    `- NUSMods' data for ${acadYear} now gives \`${nusmods.dataVersion}\`: ${fmt(nusmods.counts.offered)} offered courses (the rows ingest would write), ${fmt(nusmods.counts.catalogueOnly)} catalogue-only.`,
    '',
    'A refresh runs on the Mac: `npm run corpus -- fetch`, then `npm run corpus -- publish`, then the rest of the runbook in `docs/REFERENCE.md`, '
      + '"Re-ingesting for a new acad year" (it covers every corpus change). '
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
    'The switch follows G2 in ADR 0011 (`docs/decisions/0011-phase7-ops-and-architecture-plan.md`): switch once NUSMods has the new year '
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

/** Whole days from `then` to `now`. @param {Date} then @param {Date} now */
export const daysBetween = (then, now) => Math.floor((now.getTime() - then.getTime()) / DAY_MS);

/**
 * The warning for a quiet repo: GitHub disables a public repo's scheduled workflows after 60
 * days without activity. Null at 45 days or fewer.
 * @param {Date} lastCommit @param {Date} today
 * @returns {string | null}
 */
export function quietNote(lastCommit, today) {
  const days = daysBetween(lastCommit, today);
  // "More than 45 days" by the clock, not by whole days: 45 days and an hour is more.
  if (lastCommit.getTime() + QUIET_WARN_DAYS * DAY_MS >= today.getTime()) return null;
  const by = day(new Date(lastCommit.getTime() + QUIET_STOP_DAYS * DAY_MS));
  return `**The repo has had no commit for ${days} days** (the last on ${day(lastCommit)}). GitHub stops a public repo's scheduled workflows after `
    + `${QUIET_STOP_DAYS} days with no repository activity (https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow), `
    + `and these checks would stop with them. Commit something ${by > day(today) ? `before ${by}` : 'now'}, such as last month's usage report, to keep them running.`;
}

/** The month before a yyyy-mm. @param {string} month */
const monthBefore = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
/** @param {Date} d */
const monthOf = (d) => d.toISOString().slice(0, 7);

/**
 * The month's reminder.
 * @param {{ month: string, today: Date, lastCommit: { sha: string | null, date: Date }, ngUpdatedAsAt: string | null, acadYear?: string }} o
 */
export function reminderIssue({ month, today, lastCommit, ngUpdatedAsAt, acadYear = DEFAULT_ACAD_YEAR }) {
  const report = monthBefore(month);
  const note = quietNote(lastCommit.date, today);
  const body = [
    MARKERS.reminder(month),
    'The monthly check (G3). NUS blocks scripted downloads, so these pages are checked by hand.',
    '',
    `- [ ] The Registrar's list of courses offered to Non-Graduating (NG) students: is its "updated as at" later than ${ngUpdatedAsAt ?? 'the one recorded'} (\`data/ng-courses-${acadYear}.json\`), or is a new semester's list out?`,
    '- [ ] The Registrar\'s course restrictions for NG students: a revision later than the one in `docs/evidence/phase4/sources.md`?',
    '- [ ] YST\'s pages of courses for NUS non-music majors: a new semester\'s page?',
    `- [ ] Last month's usage report, on the Mac: \`npm run ops:report -- --month ${report}\`, then commit \`docs/evidence/ops/${report}.md\` and its run record.`,
    '',
    'A changed source is a revision: `docs/REFERENCE.md`, "When a source changes". The weekly check covers NUSMods.',
    ...(note ? ['', note] : []),
  ].join('\n');
  return { title: `Monthly check, ${month}: NUS's exchange pages and the usage report`, body, labels: [LABELS.reminder] };
}

/**
 * The weekly run's own warning for a quiet repo. The monthly reminder alone could miss the window:
 * a last commit 31 to 45 days before the 1st reaches 60 days before the next reminder.
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

// ---- GitHub ----

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
 * The issue with this label whose body carries this marker.
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
 * GitHub's REST API for one repo's issues, with the run's token in the header only.
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
      try { why = String(/** @type {any} */ (await res.json())?.message ?? ''); } catch { /* no JSON */ }
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
 * A GitHub that changes nothing and logs what it would do (--dry-run): it sees no issues.
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

/** Opens the failure issue, or comments on the open one. @param {GitHub} github @param {{ error: unknown, runUrl: string | null, checkedAt: Date, check?: string }} o */
export async function reportFailure(github, o) {
  const open = await findIssue(github, { label: LABELS.failure, marker: MARKERS.failure, state: 'open' });
  if (open) { await github.comment(open.number, failureComment(o)); return open.number; }
  const issue = failureIssue(o);
  await github.ensureLabels(issue.labels);
  return (await github.createIssue(issue)).number;
}

/** Closes an open failure issue after a good run. @param {GitHub} github @param {Date} checkedAt @param {string} check */
async function recovered(github, checkedAt, check) {
  const open = await findIssue(github, { label: LABELS.failure, marker: MARKERS.failure, state: 'open' });
  if (!open) return;
  await github.comment(open.number, `The ${check} check passed again on ${minute(checkedAt)}. Closing.`);
  await github.updateIssue(open.number, { state: 'closed' });
}

// ---- The checks ----

/**
 * Next year's moduleList.json: its course count, or null while NUSMods answers 404. Anything else
 * is an error.
 * @param {string} year @param {typeof fetch} fetchImpl
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

/** The moduleInfo.json the last check cached, if it parses. @param {string} cacheDir @param {string} acadYear */
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
 * The weekly check.
 * @param {{ acadYear?: string, cacheDir: string, fetchImpl?: typeof fetch, github: GitHub, now?: () => Date,
 *   ngCourses?: Awaited<ReturnType<typeof loadNgCourses>>, committed: { dataVersion: string, sha: string | null },
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
 * The monthly reminder: one issue a month.
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

// ---- The command ----

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
