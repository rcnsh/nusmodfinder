// @ts-check
// Phase 7 7B: `npm run deploy -- --preflight` runs every check but D1's, for HEAD, and writes
// a run record: the git checks, CI and Findings green on HEAD's push runs, the vars, the
// bundle, 7D's corpus manifest and 7E's `year check` (each skipped, and said so, while its
// module is absent), a committed `year check --full` record when HEAD changes a source-derived
// input, and `wrangler check startup`. It refuses on each failing check and writes nothing
// remote. git, gh and wrangler are a fake exec (test/deploy-fakes.js).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deploy } from '../scripts/deploy.mjs';
import { DEFAULT_ACAD_YEAR as Y } from '../scripts/lib.mjs';
import { OPTIONAL_CHECKS, isSourceInput, sourceInputsHash } from '../scripts/preflight.mjs';
import {
  DV, GREEN, LIVE_SHA, NOW, RUNS_API, SHA, STATUS_KEY, TAG_FETCH, TAG_LIST, bundleOf, fakeD1, fakeExec, ghRun, runsBody,
} from './deploy-fakes.node.mjs';

/** @type {string} */
let runsDir;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'vnm-preflight-runs-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });
const records = () => readdirSync(runsDir).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(runsDir, f), 'utf8')) }));

/**
 * @param {import('../scripts/deploy.mjs').Exec} exec
 * @param {{ argv?: string[], vars?: Record<string, unknown>, bundle?: any, modules?: Record<string, any> }} [o]
 */
async function preflight(exec, o = {}) {
  /** @type {string[]} */
  const out = [];
  let d1Asked = 0;
  const code = await deploy({
    argv: ['--preflight', ...(o.argv ?? [])], exec, log: (m) => out.push(m), error: (m) => out.push(m),
    bundle: o.bundle ?? bundleOf(), committedDataVersion: async () => DV, vars: async () => o.vars ?? { DENSE_BACKEND: 'bundle' },
    d1: async () => { d1Asked++; return fakeD1().client; }, runsDir, now: () => NOW,
    moduleExists: (/** @type {string} */ p) => Boolean(o.modules && p in o.modules),
    loadModule: async (/** @type {string} */ p) => /** @type {any} */ (o.modules)[p],
  });
  return { code, out: out.join('\n'), d1Asked };
}

/** Calls that would touch a remote other than reads: any wrangler command but the local startup check, a tag, a push. */
const remoteWrites = (/** @type {string[][]} */ calls) => calls.filter((c) => (c[0] === 'npx' && c[2] !== 'check') || (c[0] === 'git' && (c[1] === 'tag' || c[1] === 'push')));

describe('npm run deploy -- --preflight', () => {
  it('passes every check on a clean, green HEAD at the tip, writes a deploy:preflight record and nothing remote', async () => {
    const { exec, calls } = fakeExec();
    const { code, out, d1Asked } = await preflight(exec);
    expect(code).toBe(0);
    expect(d1Asked).toBe(0);
    expect(remoteWrites(calls)).toEqual([]);
    expect(calls.filter((c) => c[0] === 'npx')).toEqual([['npx', 'wrangler', 'check', 'startup', '--outfile', expect.any(String), expect.stringMatching(/^--args=--alias vectors-bundle:/)]]);
    const [r] = records();
    expect(r).toMatchObject({ script: 'deploy:preflight', outcome: 'ok', exitCode: 0, read: [], written: [] });
    expect(r.details.preflight.map((/** @type {any} */ c) => [c.name, c.status])).toEqual([
      ['git', 'ok'], ['ci', 'ok'], ['vars', 'ok'], ['bundle', 'ok'], ['corpus manifest', 'skipped'], ['year check', 'skipped'], ['source inputs', 'ok'], ['startup', 'ok'],
    ]);
    expect(out).toMatch(/corpus manifest: skipped \(scripts\/corpus\.mjs is absent/);
    expect(out).toMatch(/year check: skipped \(scripts\/year\.mjs is absent/);
  });

  it('refuses on each failing check, says which, and stops before the rest', async () => {
    /** @type {[string, Parameters<typeof fakeExec>[0], RegExp, Record<string, unknown>?][]} */
    const cases = [
      ['git', { [STATUS_KEY]: { stdout: ' M src/index.js\n' } }, /not clean/],
      ['git', { 'git ls-files -v': { stdout: 'h src/index.js\n' } }, /assume-unchanged/],
      ['git', { 'git merge-base --is-ancestor HEAD refs/remotes/origin/main': { code: 1 } }, /not on origin\/main/],
      ['git', { 'git rev-parse refs/remotes/origin/main': { stdout: 'feedfacefeedfacefeedfacefeedfacefeedface\n' } }, /behind origin\/main.*--behind-ok/s],
      ['ci', { [RUNS_API]: { stdout: runsBody([]) } }, /no CI push run/],
      ['ci', { [RUNS_API]: { stdout: runsBody([ghRun('CI', { status: 'in_progress', conclusion: null }), ghRun('Findings')]) } }, /gh run watch 101/],
      ['ci', { [RUNS_API]: { stdout: runsBody([ghRun('CI', { conclusion: 'failure' }), ghRun('Findings')]) } }, /gh run rerun 101/],
      ['ci', { [RUNS_API]: { stdout: runsBody([ghRun('CI', { conclusion: 'cancelled' }), ghRun('Findings')]) } }, /cancelled.*gh run rerun 101/s],
      ['ci', { [RUNS_API]: { stdout: runsBody([ghRun('CI'), ghRun('Findings', { conclusion: 'failure' })]) } }, /Findings.*gh run rerun 202/s],
      ['ci', { [RUNS_API]: { stdout: runsBody([ghRun('CI')]) } }, /no Findings push run/],
      ['ci', { [RUNS_API]: { code: 1, stdout: '' } }, /could not list/],
      ['startup', { check: { code: 2 } }, /wrangler check startup failed/],
    ];
    for (const [name, over, msg] of cases) {
      // Records made in the same (fixed) second sort by their random suffix: one per case.
      rmSync(runsDir, { recursive: true, force: true });
      mkdirSync(runsDir);
      const { exec, calls } = fakeExec(over);
      const { code, out } = await preflight(exec);
      expect(code, `${name} ${msg}`).toBe(1);
      expect(out).toMatch(msg);
      expect(remoteWrites(calls)).toEqual([]);
      const r = records().at(-1);
      expect(r).toMatchObject({ script: 'deploy:preflight', outcome: 'refused' });
      const failed = r.details.preflight.find((/** @type {any} */ c) => c.status === 'failed');
      expect(failed.name).toBe(name);
      const after = r.details.preflight.slice(r.details.preflight.indexOf(failed) + 1);
      expect(after.every((/** @type {any} */ c) => c.status === 'not run')).toBe(true);
    }
  });

  it('refuses extra vars and any bundle but the production one', async () => {
    const vars = await preflight(fakeExec().exec, { vars: { DENSE_BACKEND: 'bundle', SC1_TRACE: '1' } });
    expect(vars.code).toBe(1);
    expect(vars.out).toContain('SC1_TRACE');
    const pinned = await preflight(fakeExec().exec, { bundle: bundleOf({ corpus: 'pinned' }) });
    expect(pinned.code).toBe(1);
    expect(pinned.out).toContain('only the production bundle deploys');
  });

  it('a HEAD behind the tip passes with --behind-ok, which the record keeps', async () => {
    const { exec } = fakeExec({ 'git rev-parse refs/remotes/origin/main': { stdout: 'feedfacefeedfacefeedfacefeedfacefeedface\n' } });
    const { code, out } = await preflight(exec, { argv: ['--behind-ok'] });
    expect(code).toBe(0);
    expect(out).toMatch(/--behind-ok/);
    expect(records()[0]).toMatchObject({ args: ['--preflight', '--behind-ok'], details: { behindOk: true } });
  });

  it('7D\'s and 7E\'s checks run when their modules exist, and refuse when they fail', async () => {
    const ok = { preflight: async () => ({ ok: true, message: 'manifest current matches' }) };
    const bad = { preflight: async () => ({ ok: false, message: 'year sources disagree: public/year.js' }) };
    const pass = await preflight(fakeExec().exec, { modules: { [OPTIONAL_CHECKS[0].module]: ok, [OPTIONAL_CHECKS[1].module]: ok } });
    expect(pass.code).toBe(0);
    expect(records().at(-1).details.preflight.filter((/** @type {any} */ c) => c.status === 'skipped')).toEqual([]);
    const fail = await preflight(fakeExec().exec, { modules: { [OPTIONAL_CHECKS[0].module]: ok, [OPTIONAL_CHECKS[1].module]: bad } });
    expect(fail.code).toBe(1);
    expect(fail.out).toContain('year sources disagree');
  });
});

describe('the year check --full record (7E) is needed only when a source-derived input changes', () => {
  const NG = `data/ng-courses-${Y}.json`;
  const LS_TREE = `100644 blob ${'a'.repeat(40)}\t${NG}\n100644 blob ${'b'.repeat(40)}\tdata/ng-restrictions-${Y}.json\n100644 blob ${'c'.repeat(40)}\tsrc/search.js\n`;
  const RECORD_PATH = 'docs/evidence/ops/runs/20261112T090000Z-year-check-ab12.json';
  /** @param {string} hash @param {string} [outcome] */
  const yearRecord = (hash, outcome = 'ok') => JSON.stringify({ schema: 'vnm-run/1', script: 'year check', outcome, details: { mode: 'full', sourceInputsHash: hash } });
  const changed = { [`git diff --name-only --no-renames ${LIVE_SHA} HEAD`]: { stdout: `src/search.js\n${NG}\n` }, 'git ls-tree -r HEAD': { stdout: LS_TREE } };

  it('the source-derived paths', () => {
    for (const p of [NG, `data/ng-restrictions-${Y}.json`, `data/ng-sources-${Y}.json`, 'data/ng-reasons.json', `scripts/ng-overlay/${Y}.mjs`]) expect(isSourceInput(p), p).toBe(true);
    for (const p of ['data/groups.json', 'src/search.js', 'scripts/ingest.mjs', 'data/vectors.json']) expect(isSourceInput(p), p).toBe(false);
  });

  it('a hotfix touching none of them needs no record', async () => {
    const { exec, calls } = fakeExec();
    expect((await preflight(exec)).code).toBe(0);
    expect(calls.some((c) => c[1] === 'ls-tree')).toBe(false);
  });

  it('a change to one refuses without a committed record for HEAD\'s inputs hash, and passes with one', async () => {
    const hash = await sourceInputsHash(fakeExec(changed).exec);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const none = await preflight(fakeExec({ ...changed, [`git ls-tree -r --name-only HEAD -- docs/evidence/ops/runs`]: { stdout: '' } }).exec);
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/year check --full/);
    expect(none.out).toContain(NG);

    const withRecord = (/** @type {string} */ body) => fakeExec({
      ...changed,
      'git ls-tree -r --name-only HEAD -- docs/evidence/ops/runs': { stdout: `${RECORD_PATH}\ndocs/evidence/ops/runs/20261112T080000Z-ingest-cd34.json\n` },
      [`git show HEAD:${RECORD_PATH}`]: { stdout: body },
    }).exec;
    expect((await preflight(withRecord(yearRecord(hash)))).code).toBe(0);
    expect((await preflight(withRecord(yearRecord('f'.repeat(64))))).code).toBe(1);
    expect((await preflight(withRecord(yearRecord(hash, 'failed')))).code).toBe(1);
  });

  it('refuses when no deploy/* or rollback/* tag says what is live, or the tags cannot be fetched', async () => {
    const none = await preflight(fakeExec({ [TAG_LIST]: { stdout: '' } }).exec);
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/no deploy\/\* or rollback\/\* tag/);
    const offline = await preflight(fakeExec({ [TAG_FETCH]: { code: 128 } }).exec);
    expect(offline.code).toBe(1);
  });

  it('the live commit is the newest tag by its time, deploy or rollback alike', async () => {
    const newer = 'cccccccccccccccccccccccccccccccccccccccc';
    const { exec, calls } = fakeExec({
      [TAG_LIST]: { stdout: `deploy/20261111T235933Z-b0834844\t${LIVE_SHA}\nrollback/20261112T090000Z-f8aefeab\t${newer}\ndeploy/20261111T183946Z-f8aefeab\t${SHA}\n` },
      [`git diff --name-only --no-renames ${newer} HEAD`]: { stdout: 'src/search.js\n' },
    });
    expect((await preflight(exec)).code).toBe(0);
    expect(calls).toContainEqual(['git', 'diff', '--name-only', '--no-renames', newer, 'HEAD']);
  });
});

it('the default runs list reads HEAD\'s own push runs', () => {
  expect(RUNS_API).toContain(`head_sha=${SHA}&event=push`);
  expect(GREEN).toContain('"Findings"');
});
