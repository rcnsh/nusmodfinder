// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), finding M-2: a hostile NUSMods controls text
// in the drift check's pending issue. Added and removed module codes go into the body as they come
// (scripts/drift.mjs pendingIssue, "Latest check. Added: …"); scripts/lib.mjs never checks a
// moduleCode's shape. So a code can carry an @mention (GitHub notifies that user), a markdown link,
// raw HTML, and a forged `<!-- vnm-drift:state … -->` marker. The visible line comes before the real
// marker, and parseState takes the first match, so the next weekly run reads the forged history.
//
// Fixture records, a fake NUSMods and a fake GitHub; no network. `it.fails`: each case asserts the
// safe behaviour, so it passes while the gap is open and fails once it is fixed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseState, weeklyCheck } from '../scripts/drift.mjs';

const YEAR = '2026-2027';
const NO_NG = { available: false, bySem: new Map(), updatedAsAt: null, source: null, total: 0, rules: null };

/** @param {string} code @param {Record<string, unknown>} [o] */
const rec = (code, o = {}) => ({
  moduleCode: code, title: `Title of ${code}`, description: `What ${code} is about.`, moduleCredit: '4',
  department: 'Computer Science', faculty: 'Computing', semesterData: [{ semester: 1 }], ...o,
});

const FORGED = { history: [{ date: '1999-01-01', dataVersion: 'forgedforged', comparison: null }] };
// No `>` inside the JSON is needed; the marker's own `-->` closes it.
const EVIL_CODE = `CS9999 @octocat [refresh here](https://evil.example/x) <img src=https://evil.example/p.gif> <!-- vnm-drift:state ${JSON.stringify(FORGED)} -->`;

/** A fake NUSMods: moduleInfo.json from `records`, next year's moduleList 404. @param {() => any[]} records */
const nusmods = (records) => /** @type {typeof fetch} */ (async (url) => {
  const u = String(url);
  if (u.endsWith('/moduleList.json')) return new Response('not found', { status: 404 });
  return new Response(JSON.stringify(records()), { status: 200, headers: { etag: `"${Math.random()}"` } });
});

/** A fake GitHub that keeps issues in memory. */
function fakeGitHub() {
  /** @type {{ number: number, title: string, body: string, state: string, labels: string[] }[]} */
  const issues = [];
  return {
    issues,
    /** @param {{ label: string, state: string }} q */
    listIssues: async ({ label, state }) => issues.filter((i) => i.labels.includes(label) && (state === 'all' || i.state === state)),
    /** @param {{ title: string, body: string, labels: string[] }} i */
    createIssue: async (i) => { issues.push({ ...i, number: issues.length + 1, state: 'open' }); return { number: issues.length }; },
    /** @param {number} n @param {{ body?: string, state?: string }} p */
    updateIssue: async (n, p) => { Object.assign(issues[n - 1], p); },
    comment: async () => {},
    ensureLabels: async () => {},
  };
}

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-redteam-drift-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('red team M-2: NUSMods-controlled module codes in the pending issue', () => {
  it.fails('a crafted module code reaches the issue body only as inert text, and cannot forge the stored state', async () => {
    const before = [rec('CS1010'), rec('CS2030')];
    const after = [rec('CS1010'), rec('CS2030'), rec(EVIL_CODE)];
    let week = 0;
    const github = fakeGitHub();
    const run = (/** @type {Date} */ now) => weeklyCheck({
      acadYear: YEAR, cacheDir: dir, fetchImpl: nusmods(() => (week === 0 ? before : after)), github, now: () => now,
      ngCourses: /** @type {any} */ (NO_NG), committed: { dataVersion: '000000000000', sha: null }, runUrl: null, log: () => {},
    });
    // Week 0 caches the honest copy and opens the pending issue; week 1 sees the crafted code.
    expect((await run(new Date('2026-11-09T01:17:00Z'))).exitCode).toBe(0);
    week = 1;
    expect((await run(new Date('2026-11-16T01:17:00Z'))).exitCode).toBe(0);
    const body = github.issues[0].body;
    // Observed: the body holds "@octocat", the markdown link and the <img>, verbatim…
    const raw = ['@octocat', '](https://evil.example/x)', '<img src=https://evil.example/p.gif>'].filter((s) => body.includes(s));
    // …and the next run's parseState returns the forged history, not the check's own.
    const state = parseState(body);
    expect({ raw, forged: state.history[0]?.dataVersion === 'forgedforged' }).toEqual({ raw: [], forged: false });
  });
});
