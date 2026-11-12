// @ts-check
// Phase 7 7F (G3 (a)): the weekly NUSMods data-change check and the monthly reminder
// (scripts/drift.mjs, run by .github/workflows/drift.yml). Fixture NUSMods records, a fake
// NUSMods and a fake GitHub: nothing here reaches the network or creates a real issue. The years
// here are fixture data (no NG file is read); the data version over HEAD's NG files is checked
// in test/drift-data-version.node.test.js.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LABELS, compareSummaries, daysBetween, failureIssue, findIssue, githubRest, monthlyCheck, nextAcadYear, nextYearIssue,
  pendingIssue, quietIssue, quietNote, reminderIssue, resolvedComment, summarise, weeklyCheck,
} from '../scripts/drift.mjs';

const YEAR = '2026-2027';
const NO_NG = { available: false, bySem: new Map(), updatedAsAt: null, source: null, total: 0, rules: null };
const NOW = new Date('2026-11-16T01:17:00Z');
const RUN_URL = 'https://github.com/o/r/actions/runs/1';

/** A NUSMods moduleInfo record. @param {string} code @param {Record<string, unknown>} [o] */
const rec = (code, o = {}) => ({
  moduleCode: code, title: `Title of ${code}`, description: `What ${code} is about.`, moduleCredit: '4',
  department: 'Computer Science', faculty: 'Computing', semesterData: [{ semester: 1 }], ...o,
});

// The fixture pair: before is what production holds, after is NUSMods a week later.
const BEFORE = [
  rec('CS1010'), rec('CS2030', { semesterData: [{ semester: 1 }, { semester: 2 }] }), rec('CS3230'), rec('CS4248'),
  rec('XX1000', { semesterData: [] }), rec('XX2000', { semesterData: [], title: 'Old catalogue title' }),
];
const AFTER = [
  rec('CS1010', { description: 'A new description.' }),                     // description (and the embedded text)
  rec('CS2030', { semesterData: [{ semester: 2 }] }),                       // semesters
  rec('CS3230', { moduleCredit: '6', prerequisite: 'CS2040' }),             // credits and prerequisite
  rec('CS5000'),                                                            // added
  rec('XX1000', { semesterData: [] }), rec('XX2000', { semesterData: [], title: 'New catalogue title' }),
  rec('XX3000', { semesterData: [] }),
  // CS4248 removed
];

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-drift-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the comparison over a fixture pair', () => {
  it('counts added, removed and changed modules, and each changed D1 column', async () => {
    const c = compareSummaries(await summarise(BEFORE, YEAR, NO_NG), await summarise(AFTER, YEAR, NO_NG));
    expect(c.offered.added).toEqual(['CS5000']);
    expect(c.offered.removed).toEqual(['CS4248']);
    expect(c.offered.changed).toBe(3);
    expect(c.offered.byField).toEqual({ description: 1, text_hash: 1, semesters: 1, credits: 1, prerequisite: 1, prereq_none: 1 });
    expect(c.catalogue).toEqual({ added: ['XX3000'], removed: [], changed: 1 });
  });

  it('an identical pair has no changes', async () => {
    const c = compareSummaries(await summarise(BEFORE, YEAR, NO_NG), await summarise(structuredClone(BEFORE), YEAR, NO_NG));
    expect(c).toEqual({ offered: { added: [], removed: [], changed: 0, byField: {} }, catalogue: { added: [], removed: [], changed: 0 } });
  });

  it('the next year follows the current one', () => {
    expect(nextAcadYear('2026-2027')).toBe('2027-2028');
    expect(() => nextAcadYear('2026')).toThrow();
  });
});

describe('the issue text', () => {
  it('pending refresh: both data versions, the counts, and what changed in each check', async () => {
    const before = await summarise(BEFORE, YEAR, NO_NG);
    const after = await summarise(AFTER, YEAR, NO_NG);
    const issue = pendingIssue({
      acadYear: YEAR, production: { dataVersion: before.dataVersion, sha: 'b'.repeat(40) }, nusmods: after, checkedAt: NOW,
      history: [{ date: '2026-11-16', dataVersion: after.dataVersion, comparison: compareSummaries(before, after) }],
    });
    expect(issue.labels).toEqual([LABELS.pending]);
    expect(issue.title).toBe('NUSMods data for 2026-2027 differs from production');
    expect(issue.body).toContain('<!-- vnm-drift:pending -->');
    expect(issue.body).toContain(`Production's data version is \`${before.dataVersion}\``);
    expect(issue.body).toContain(`NUSMods' data for 2026-2027 now gives \`${after.dataVersion}\``);
    expect(issue.body).toMatch(/4 offered courses .*, 3 catalogue-only/);
    expect(issue.body).toMatch(/\| 2026-11-16 \| `[0-9a-f]{12}` \| \+1 −1 ~3 \| credits 1, description 1, prereq_none 1, prerequisite 1, semesters 1, text_hash 1 \| \+1 −0 ~1 \|/);
    expect(issue.body).toContain('Added: CS5000');
    expect(issue.body).toContain('Removed: CS4248');
    expect(issue.body).toMatch(/Last checked 2026-11-16 01:17 UTC/);
    expect(issue.body).toMatch(/docs\/REFERENCE\.md.*Re-ingesting/);
  });

  it('pending refresh, with no earlier copy to compare: it says so instead of counting', async () => {
    const after = await summarise(AFTER, YEAR, NO_NG);
    const issue = pendingIssue({
      acadYear: YEAR, production: { dataVersion: '000000000000', sha: null }, nusmods: after, checkedAt: NOW,
      history: [{ date: '2026-11-16', dataVersion: after.dataVersion, comparison: null }],
    });
    expect(issue.body).toMatch(/\| 2026-11-16 \| `[0-9a-f]{12}` \| no earlier copy was cached to compare with \|/);
  });

  it('the pending issue carries its history in a hidden marker, so the next check can append to it', async () => {
    const after = await summarise(AFTER, YEAR, NO_NG);
    const history = [{ date: '2026-11-09', dataVersion: 'aaaaaaaaaaaa', comparison: null }];
    const issue = pendingIssue({ acadYear: YEAR, production: { dataVersion: 'x', sha: null }, nusmods: after, checkedAt: NOW, history });
    const m = /<!-- vnm-drift:state (.*?) -->/.exec(issue.body);
    expect(m && JSON.parse(m[1])).toEqual({ history });
  });

  it('resolved: production matches NUSMods again', () => {
    const text = resolvedComment({ acadYear: YEAR, dataVersion: 'c1cf88518972', checkedAt: NOW });
    expect(text).toMatch(/NUSMods' data for 2026-2027 gives `c1cf88518972`, production's data version/);
    expect(text).toMatch(/Closing/);
  });

  it('next year: its own issue, which the check never closes', () => {
    const issue = nextYearIssue({ nextYear: '2027-2028', count: 6120, checkedAt: NOW });
    expect(issue.labels).toEqual([LABELS.nextYear]);
    expect(issue.title).toBe('NUSMods has 2027-2028');
    expect(issue.body).toContain('<!-- vnm-drift:next-year 2027-2028 -->');
    expect(issue.body).toMatch(/6,120 courses/);
    expect(issue.body).toMatch(/never closes this issue/);
    expect(issue.body).toMatch(/Sem 1 exchange list/);
  });

  it('its own failure: the error, the run, and that the check needs fixing', () => {
    const issue = failureIssue({ error: new Error('None of the first 50 module records carry "semesterData"'), runUrl: RUN_URL, checkedAt: NOW });
    expect(issue.labels).toEqual([LABELS.failure]);
    expect(issue.title).toBe('The NUSMods drift check failed');
    expect(issue.body).toContain('<!-- vnm-drift:failure -->');
    expect(issue.body).toContain('None of the first 50 module records carry "semesterData"');
    expect(issue.body).toContain(RUN_URL);
  });

  it('the monthly reminder: the Registrar\'s and YST\'s pages, and the usage report', () => {
    const issue = reminderIssue({ month: '2026-11', today: NOW, lastCommit: { sha: 'c'.repeat(40), date: new Date('2026-11-12T00:00:00Z') }, ngUpdatedAsAt: '01 Sep 2026' });
    expect(issue.labels).toEqual([LABELS.reminder]);
    expect(issue.title).toBe('Monthly check, 2026-11: NUS\'s exchange pages and the usage report');
    expect(issue.body).toContain('<!-- vnm-drift:reminder 2026-11 -->');
    expect(issue.body).toMatch(/Non-Graduating/);
    expect(issue.body).toMatch(/restrictions/);
    expect(issue.body).toMatch(/YST/);
    expect(issue.body).toMatch(/01 Sep 2026/);
    expect(issue.body).toMatch(/npm run ops:report -- --month 2026-10/);
    expect(issue.body).not.toMatch(/60 days/);
  });
});

describe('the 45-day note', () => {
  it('appears when the last commit is more than 45 days old', () => {
    const today = new Date('2026-11-12T09:00:00Z');
    expect(daysBetween(new Date('2026-09-27T08:00:00Z'), today)).toBe(46);
    const note = quietNote(new Date('2026-09-27T08:00:00Z'), today);
    expect(note).toMatch(/46 days/);
    expect(note).toMatch(/GitHub stops a public repo's scheduled workflows after 60 days with no repository activity/);
    expect(note).toMatch(/before 2026-11-26/);
  });

  it('counts by the clock: 45 days and an hour is more than 45 days', () => {
    expect(quietNote(new Date('2026-09-28T08:00:00Z'), new Date('2026-11-12T09:00:00Z'))).toMatch(/45 days/);
  });

  it('does not at 45 days or fewer', () => {
    const today = new Date('2026-11-12T09:00:00Z');
    expect(quietNote(new Date('2026-09-28T09:00:00Z'), today)).toBeNull();
    expect(quietNote(new Date('2026-09-28T10:00:00Z'), today)).toBeNull();
    expect(quietNote(new Date('2026-11-11T08:00:00Z'), today)).toBeNull();
  });

  it('past 60 days (a run by hand), it says to commit now rather than give a date gone by', () => {
    expect(quietNote(new Date('2026-09-01T00:00:00Z'), new Date('2026-11-12T09:00:00Z'))).toMatch(/72 days.*Commit something now/s);
  });

  it('goes into the month\'s reminder', () => {
    const issue = reminderIssue({ month: '2026-11', today: new Date('2026-11-12T09:00:00Z'), lastCommit: { sha: 'c'.repeat(40), date: new Date('2026-09-20T00:00:00Z') }, ngUpdatedAsAt: '01 Sep 2026' });
    expect(issue.body).toMatch(/53 days/);
    expect(issue.body).toMatch(/after 60 days/);
  });
});

/** An in-memory GitHub with the client interface drift.mjs uses. */
function fakeGitHub() {
  /** @type {{ number: number, title: string, body: string, state: 'open' | 'closed', labels: string[], comments: string[] }[]} */
  const issues = [];
  /** @type {string[]} */
  const ensured = [];
  return {
    issues,
    ensured,
    /** @param {{ label: string, state: 'open' | 'all' }} q */
    async listIssues({ label, state }) {
      return issues.filter((i) => i.labels.includes(label) && (state === 'all' || i.state === state)).map((i) => ({ ...i }));
    },
    /** @param {{ title: string, body: string, labels: string[] }} i */
    async createIssue({ title, body, labels }) {
      const issue = { number: issues.length + 1, title, body, labels, state: /** @type {const} */ ('open'), comments: [] };
      issues.push(issue);
      return { number: issue.number };
    },
    /** @param {number} n @param {{ body?: string, state?: 'open' | 'closed' }} patch */
    async updateIssue(n, patch) { Object.assign(/** @type {any} */ (issues.find((i) => i.number === n)), patch); },
    /** @param {number} n @param {string} body */
    async comment(n, body) { /** @type {any} */ (issues.find((i) => i.number === n)).comments.push(body); },
    /** @param {string[]} labels */
    async ensureLabels(labels) { ensured.push(...labels); },
  };
}

/**
 * A fake api.nusmods.com: this year's moduleInfo.json with an ETag (304 on a match), next year's
 * moduleList.json, each settable per test.
 */
function fakeNusMods() {
  const state = {
    info: /** @type {{ status: number, body?: unknown, etag?: string }} */ ({ status: 200, body: BEFORE, etag: '"v1"' }),
    next: /** @type {{ status: number, body?: unknown }} */ ({ status: 404 }),
    /** @type {{ url: string, headers: Record<string, string> }[]} */
    calls: [],
  };
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    state.calls.push({ url, headers });
    if (url === `https://api.nusmods.com/v2/${YEAR}/moduleInfo.json`) {
      const { status, body, etag } = state.info;
      if (status === 200 && etag && headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(body === undefined ? 'error' : JSON.stringify(body), { status, headers: etag ? { etag } : {} });
    }
    if (url === 'https://api.nusmods.com/v2/2027-2028/moduleList.json') {
      return new Response(state.next.body === undefined ? 'Not Found' : JSON.stringify(state.next.body), { status: state.next.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { state, fetchImpl };
}

describe('the weekly check', () => {
  /** @param {ReturnType<typeof fakeNusMods>} nm @param {ReturnType<typeof fakeGitHub>} gh @param {{ now?: Date, production?: string, lastCommit?: { sha: string, date: Date } }} [o] */
  const weekly = async (nm, gh, { now = NOW, production, lastCommit } = {}) => weeklyCheck({
    lastCommit,
    acadYear: YEAR, cacheDir: join(dir, 'cache'), fetchImpl: nm.fetchImpl, github: gh, now: () => now, ngCourses: NO_NG, runUrl: RUN_URL,
    committed: { dataVersion: production ?? (await summarise(BEFORE, YEAR, NO_NG)).dataVersion, sha: 'b'.repeat(40) }, log: () => {},
  });

  it('opens no issue when NUSMods matches production, and sends the cached ETag next time', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 0 });
    expect(gh.issues).toHaveLength(0);
    await weekly(nm, gh);
    const infoCalls = nm.state.calls.filter((c) => c.url.endsWith('moduleInfo.json'));
    expect(infoCalls[0].headers['if-none-match']).toBeUndefined();
    expect(infoCalls[1].headers['if-none-match']).toBe('"v1"');
  });

  it('opens one pending issue when NUSMods changes, then keeps it updated, with field counts against the cached copy', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    await weekly(nm, gh, { now: new Date('2026-11-09T01:17:00Z') }); // caches BEFORE
    nm.state.info = { status: 200, body: AFTER, etag: '"v2"' };
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 0 });
    expect(gh.issues).toHaveLength(1);
    const [issue] = gh.issues;
    expect(issue.labels).toEqual([LABELS.pending]);
    expect(issue.body).toContain('<!-- vnm-drift:pending -->');
    expect(issue.body).toMatch(/\| 2026-11-16 \| `[0-9a-f]{12}` \| \+1 −1 ~3 \|/);
    expect(gh.ensured).toContain(LABELS.pending);

    // A week later NUSMods changes again: the same issue gains a row.
    nm.state.info = { status: 200, body: [...AFTER, rec('CS6000')], etag: '"v3"' };
    await weekly(nm, gh, { now: new Date('2026-11-23T01:17:00Z') });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].body).toMatch(/\| 2026-11-16 \|[^\n]*\n\| 2026-11-23 \| `[0-9a-f]{12}` \| \+1 −0 ~0 \|/);

    // Unchanged (304): no new row, only the last-checked line.
    await weekly(nm, gh, { now: new Date('2026-11-30T01:17:00Z') });
    expect(gh.issues[0].body).not.toMatch(/\| 2026-11-30 \|/);
    expect(gh.issues[0].body).toMatch(/Last checked 2026-11-30 01:17 UTC/);
  });

  it('closes the pending issue once production matches NUSMods again', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    nm.state.info = { status: 200, body: AFTER, etag: '"v2"' };
    await weekly(nm, gh);
    expect(gh.issues[0].state).toBe('open');
    // A refresh ships: src/data-version.json now holds AFTER's version.
    await weekly(nm, gh, { production: (await summarise(AFTER, YEAR, NO_NG)).dataVersion });
    expect(gh.issues[0].state).toBe('closed');
    expect(gh.issues[0].comments.at(-1)).toMatch(/Closing/);
  });

  it('finds its issue by label and hidden marker, never by title alone', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    nm.state.info = { status: 200, body: AFTER, etag: '"v2"' };
    // Same title and label, no marker (someone's own issue): not the check's.
    await gh.createIssue({ title: 'NUSMods data for 2026-2027 differs from production', body: 'my notes', labels: [LABELS.pending] });
    // Marker but no label: not found by the label query.
    await gh.createIssue({ title: 'x', body: '<!-- vnm-drift:pending -->', labels: [] });
    await weekly(nm, gh);
    expect(gh.issues).toHaveLength(3);
    expect(gh.issues[0].body).toBe('my notes');
    expect(await findIssue(gh, { label: LABELS.pending, marker: '<!-- vnm-drift:pending -->', state: 'open' })).toMatchObject({ number: 3 });
  });

  it('opens a next-year issue once when next year appears, and never closes it', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    nm.state.next = { status: 200, body: [{ moduleCode: 'CS1010' }, { moduleCode: 'CS2030' }] };
    await weekly(nm, gh);
    const ny = gh.issues.filter((i) => i.labels.includes(LABELS.nextYear));
    expect(ny).toHaveLength(1);
    expect(ny[0].body).toContain('<!-- vnm-drift:next-year 2027-2028 -->');
    // Jacob closes it; the next check opens no second one and reopens nothing.
    await gh.updateIssue(ny[0].number, { state: 'closed' });
    await weekly(nm, gh);
    expect(gh.issues.filter((i) => i.labels.includes(LABELS.nextYear))).toHaveLength(1);
    expect(gh.issues[ny[0].number - 1].state).toBe('closed');
  });

  it('a next year that is still 404 opens nothing', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    await weekly(nm, gh);
    expect(nm.state.calls.some((c) => c.url.endsWith('2027-2028/moduleList.json'))).toBe(true);
    expect(gh.issues).toHaveLength(0);
  });

  it('a NUSMods shape change opens a failure issue and fails the run; a repeat comments on the same issue', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    nm.state.info = { status: 200, body: [{ code: 'CS1010', name: 'renamed fields' }], etag: '"v9"' };
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 1 });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]).toMatchObject({ labels: [LABELS.failure], state: 'open' });
    expect(gh.issues[0].body).toMatch(/NUSMods v2 shape has changed/);
    await weekly(nm, gh);
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].comments).toHaveLength(1);
  });

  it('an HTTP error opens a failure issue, and the next good run closes it', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    nm.state.info = { status: 503 };
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 1 });
    expect(gh.issues[0].body).toMatch(/HTTP 503/);
    nm.state.next = { status: 500 };
    nm.state.info = { status: 200, body: BEFORE, etag: '"v1"' };
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 1 });
    expect(gh.issues[0].comments.at(-1)).toMatch(/HTTP 500/);
    nm.state.next = { status: 404 };
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 0 });
    expect(gh.issues[0].state).toBe('closed');
  });

  it('warns of a quiet repo itself, once per quiet stretch, since a monthly run can miss days 45 to 60', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    // The last commit lands 2026-09-21: the 10-01 and 11-01 reminders (10 and 41 days) carry no
    // note, and schedules stop about 11-20. The weekly run on 11-09 (49 days) warns.
    const lastCommit = { sha: 'd'.repeat(40), date: new Date('2026-09-21T00:00:00Z') };
    await weekly(nm, gh, { now: new Date('2026-11-02T01:17:00Z'), lastCommit });
    expect(gh.issues).toHaveLength(0);
    await weekly(nm, gh, { now: new Date('2026-11-09T01:17:00Z'), lastCommit });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]).toMatchObject({ labels: [LABELS.reminder], title: 'No commit for 49 days: the scheduled checks stop at 60' });
    expect(gh.issues[0].body).toContain(`<!-- vnm-drift:quiet ${'d'.repeat(40)} -->`);
    expect(gh.issues[0].body).toMatch(/before 2026-11-20/);
    await gh.updateIssue(1, { state: 'closed' });
    await weekly(nm, gh, { now: new Date('2026-11-16T01:17:00Z'), lastCommit });
    expect(gh.issues).toHaveLength(1);
  });

  it('a quiet issue is null while the repo is active', () => {
    expect(quietIssue({ today: NOW, lastCommit: { sha: 'd'.repeat(40), date: new Date('2026-11-01T00:00:00Z') } })).toBeNull();
  });

  it('a next-year list that is not a list is a failure, not a new year', async () => {
    const nm = fakeNusMods();
    const gh = fakeGitHub();
    nm.state.next = { status: 200, body: { error: 'not a list' } };
    expect(await weekly(nm, gh)).toMatchObject({ exitCode: 1 });
    expect(gh.issues.map((i) => i.labels[0])).toEqual([LABELS.failure]);
  });
});

describe('the monthly check', () => {
  /** @param {ReturnType<typeof fakeGitHub>} gh @param {Date} now @param {Date} last */
  const monthly = (gh, now, last) => monthlyCheck({ github: gh, now: () => now, lastCommit: { sha: 'c'.repeat(40), date: last }, ngUpdatedAsAt: '01 Sep 2026', log: () => {} });

  it('opens one reminder a month', async () => {
    const gh = fakeGitHub();
    await monthly(gh, new Date('2026-12-01T01:41:00Z'), new Date('2026-11-20T00:00:00Z'));
    await monthly(gh, new Date('2026-12-01T05:00:00Z'), new Date('2026-11-20T00:00:00Z'));
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].body).toContain('<!-- vnm-drift:reminder 2026-12 -->');
    expect(gh.issues[0].body).not.toMatch(/60 days/);
    await monthly(gh, new Date('2027-01-01T01:41:00Z'), new Date('2026-11-20T00:00:00Z'));
    expect(gh.issues).toHaveLength(2);
    expect(gh.issues[1].body).not.toMatch(/60 days/);
  });

  it('adds the 60-day warning when the last commit is more than 45 days old', async () => {
    const gh = fakeGitHub();
    await monthly(gh, new Date('2027-01-01T01:41:00Z'), new Date('2026-11-01T00:00:00Z'));
    expect(gh.issues[0].body).toMatch(/61 days/);
    expect(gh.issues[0].body).toMatch(/after 60 days/);
  });
});

describe('the GitHub client', () => {
  it('lists by label, skips pull requests, pages, and sends the token only in the header', async () => {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      const page = Number(new URL(String(input)).searchParams.get('page'));
      const items = page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: 't', body: 'b', state: 'open', labels: [{ name: 'drift:pending' }], ...(i === 0 ? { pull_request: {} } : {}) }))
        : [{ number: 101, title: 't', body: null, state: 'open', labels: [{ name: 'drift:pending' }] }];
      return new Response(JSON.stringify(items), { status: 200 });
    };
    const gh = githubRest({ repo: 'o/r', token: 'ghs_secret', fetchImpl });
    const list = await gh.listIssues({ label: 'drift:pending', state: 'open' });
    expect(list).toHaveLength(100);
    expect(list.at(-1)).toMatchObject({ number: 101, body: '', labels: ['drift:pending'] });
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/issues?labels=drift%3Apending&state=open&per_page=100&page=1');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer ghs_secret');
    expect(calls.every((c) => !c.url.includes('ghs_secret'))).toBe(true);
  });

  it('an API error names the call and the status, never the token', async () => {
    const gh = githubRest({ repo: 'o/r', token: 'ghs_secret', fetchImpl: async () => new Response('{"message":"Bad credentials"}', { status: 401 }) });
    await expect(gh.createIssue({ title: 't', body: 'b', labels: [] })).rejects.toThrow(/POST \/repos\/o\/r\/issues -> HTTP 401/);
    await expect(gh.createIssue({ title: 't', body: 'b', labels: [] })).rejects.not.toThrow(/ghs_secret/);
  });
});
