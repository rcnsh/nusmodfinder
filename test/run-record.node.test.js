// @ts-check
// Phase 7 7C: the ops log is one file per run (scripts/run-record.mjs). Every
// record goes to a temp dir; nothing here writes under docs/evidence/ops/runs/
// or reaches a remote.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTCOMES, RUNS_DIR, RUN_SCHEMA, checkRunRecords, gitState, recordedLiveRun, runFileName, startRun, validateRunRecord,
} from '../scripts/run-record.mjs';

const RUN_RECORD = fileURLToPath(new URL('../scripts/run-record.mjs', import.meta.url));

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-runs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The records in `d`, parsed. @param {string} [d] */
const records = (d = dir) => readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, record: JSON.parse(readFileSync(join(d, f), 'utf8')) }));

const AT = new Date('2026-11-12T10:15:30.123Z');

describe('a run record', () => {
  it('holds the time, script, commit, target, reads and writes, requests by path, versions, bookmark and outcome', () => {
    const run = startRun('ingest', { dir, target: 'http://127.0.0.1:51234', args: ['--d1-only'], now: () => AT, random: () => 'ab12' });
    run.read('D1 rows', { estimate: 6800, actual: 6778 });
    run.wrote('D1 rows', { estimate: 40, actual: 2 });
    run.request('/admin/hashes');
    run.request('/admin/ingest', 3);
    run.version('dataVersion', 'd820d578cf81');
    run.setBookmark('00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683');
    const path = run.finish('ok', { exitCode: 0, message: 'done' });
    expect(path).toBe(join(dir, '20261112T101530Z-ingest-ab12.json'));
    const [{ file, record }] = records();
    expect(file).toBe('20261112T101530Z-ingest-ab12.json');
    expect(record).toMatchObject({
      schema: RUN_SCHEMA, time: '2026-11-12T10:15:30.123Z', script: 'ingest', args: ['--d1-only'], target: 'http://127.0.0.1:51234',
      commit: { sha: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: expect.any(Boolean) },
      read: [{ what: 'D1 rows', estimate: 6800, actual: 6778 }], written: [{ what: 'D1 rows', estimate: 40, actual: 2 }],
      requests: { '/admin/hashes': 1, '/admin/ingest': 3 }, versions: { dataVersion: 'd820d578cf81' },
      bookmark: '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683', outcome: 'ok', exitCode: 0, message: 'done',
    });
    expect(validateRunRecord(record, { file, now: new Date('2026-11-12T11:00:00Z') })).toEqual([]);
  });

  it('is written once: a second finish returns the same file and changes nothing', () => {
    const run = startRun('verify', { dir, now: () => AT, random: () => 'cd34' });
    const first = run.finish('failed', { exitCode: 1 });
    expect(run.finish('ok', { exitCode: 0 })).toBe(first);
    expect(records()).toHaveLength(1);
    expect(records()[0].record.outcome).toBe('failed');
  });

  it('refuses an outcome outside the closed set', () => {
    const run = startRun('verify', { dir, now: () => AT });
    expect(() => run.finish(/** @type {any} */ ('fine'))).toThrow(/outcome/);
    expect(OUTCOMES).toEqual(['ok', 'refused', 'failed', 'partial', 'interrupted']);
  });

  it('counts the live requests a wrapped fetch sends, by path, never the query string', async () => {
    const run = startRun('verify', { dir, now: () => AT });
    const f = run.countingFetch(/** @type {typeof fetch} */ (async () => new Response('{}')));
    await f('http://127.0.0.1:9/admin/verify?sample=3');
    await f(new URL('http://127.0.0.1:9/admin/verify'));
    await f('http://127.0.0.1:9/admin/hashes', { method: 'GET' });
    run.finish('ok');
    expect(records()[0].record.requests).toEqual({ '/admin/verify': 2, '/admin/hashes': 1 });
  });

  it('two writers in the same second get different names, even when their random suffixes collide', () => {
    const a = startRun('ingest', { dir, now: () => AT, random: () => 'ffff' });
    const b = startRun('ingest', { dir, now: () => AT, random: (() => { const r = ['ffff', '0a0b']; return () => /** @type {string} */ (r.shift()); })() });
    const pa = a.finish('ok');
    const pb = b.finish('ok');
    expect(pa).not.toBe(pb);
    expect(records().map((r) => r.file)).toEqual(['20261112T101530Z-ingest-0a0b.json', '20261112T101530Z-ingest-ffff.json']);
    // Without a fixed random, many in one second still never collide.
    for (let i = 0; i < 20; i++) startRun('verify', { dir, now: () => AT }).finish('ok');
    expect(records().filter((r) => r.record.script === 'verify')).toHaveLength(20);
  });

  it('names a script with characters a file name cannot hold by a slug, and keeps the script as given', () => {
    expect(runFileName(AT, 'd1:bookmark', '00aa')).toBe('20261112T101530Z-d1-bookmark-00aa.json');
    const run = startRun('eval:embed', { dir, now: () => AT, random: () => '1234' });
    run.finish('ok');
    const [{ file, record }] = records();
    expect(file).toBe('20261112T101530Z-eval-embed-1234.json');
    expect(record.script).toBe('eval:embed');
    expect(validateRunRecord(record, { file, now: new Date('2027-01-01T00:00:00Z') })).toEqual([]);
  });

  it('refuses, under Vitest, to write into the repo\'s docs/evidence/ops/runs/', () => {
    expect(() => startRun('ingest', { dir: RUNS_DIR })).toThrow(/tests must not write run records into the repo/);
  });
});

describe('the commit a record names', () => {
  /** @type {string} */
  let repo;
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vnm-git-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'one');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('a clean tree: the sha, dirty false, no diff hash; a new run record under docs/evidence/ops/runs/ is not dirt', () => {
    const sha = git('rev-parse', 'HEAD').trim();
    expect(gitState({ cwd: repo })).toEqual({ sha, dirty: false, diffSha256: null });
    execFileSync('mkdir', ['-p', join(repo, 'docs/evidence/ops/runs')]);
    writeFileSync(join(repo, 'docs/evidence/ops/runs/20261112T101530Z-ingest-ab12.json'), '{}\n');
    expect(gitState({ cwd: repo }).dirty).toBe(false);
  });

  it('a dirty tree is recorded, with the sha256 of `git diff HEAD`', () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: repo });
    const state = gitState({ cwd: repo });
    expect(state.dirty).toBe(true);
    expect(state.diffSha256).toBe(createHash('sha256').update(diff).digest('hex'));
    const run = startRun('deploy', { dir, cwd: repo, now: () => AT });
    run.finish('refused', { exitCode: 1 });
    expect(records()[0].record.commit).toEqual(state);
  });

  it('an untracked file outside the runs dir is dirt too', () => {
    writeFileSync(join(repo, 'scratch.txt'), 'x\n');
    expect(gitState({ cwd: repo }).dirty).toBe(true);
  });
});

describe('every exit path leaves a record', () => {
  /** Runs a script that imports run-record.mjs, with the runs dir given. @param {string} body */
  const node = (body) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { startRun } from ${JSON.stringify(RUN_RECORD)};\n${body}`], {
    env: { ...process.env, VITEST: '', VNM_RUNS_DIR: dir }, encoding: 'utf8',
  });

  it('process.exit(1) before finish: one record, outcome failed, with the exit code', () => {
    const r = node("const run = startRun('eval:embed'); run.guardExit(); run.request('/ai/run'); process.exit(1);");
    expect(r.status).toBe(1);
    const all = records();
    expect(all).toHaveLength(1);
    expect(all[0].record).toMatchObject({ script: 'eval:embed', outcome: 'failed', exitCode: 1, requests: { '/ai/run': 1 } });
  });

  it('an uncaught exception: one record, outcome failed', () => {
    const r = node("const run = startRun('eval:embed'); run.guardExit(); throw new Error('boom');");
    expect(r.status).not.toBe(0);
    expect(records().map((x) => x.record.outcome)).toEqual(['failed']);
  });

  it('a normal end: one record, outcome ok; a finished record is not written again at exit', () => {
    expect(node("const run = startRun('eval:embed'); run.guardExit();").status).toBe(0);
    expect(node("const run = startRun('p5-live'); run.guardExit(); run.finish('failed', { exitCode: 1 }); process.exit(1);").status).toBe(1);
    expect(records().map((x) => [x.record.script, x.record.outcome])).toEqual(expect.arrayContaining([['eval:embed', 'ok'], ['p5-live', 'failed']]));
    expect(records()).toHaveLength(2);
  });

  it('exit 130 (SIGINT) is recorded as interrupted', () => {
    node("const run = startRun('ingest'); run.guardExit(); process.exit(130);");
    expect(records()[0].record.outcome).toBe('interrupted');
  });
});

describe('the live checks\' record (p5-live, p6-live)', () => {
  const pass = [{ pass: true }, { pass: true }];
  it('a live URL: one record on success, with each request by path', async () => {
    const outcomes = await recordedLiveRun('p6-live', { url: 'https://nusmodfinder.rcn.sh', seed: 6 }, async (o) => {
      o.onSend?.('/facets');
      o.onSend?.('/module/CS2040');
      o.onSend?.('/module/CS2040');
      return pass;
    }, { dir, now: () => AT });
    expect(outcomes).toBe(pass);
    const [{ record }] = records();
    expect(record).toMatchObject({ script: 'p6-live', target: 'https://nusmodfinder.rcn.sh', outcome: 'ok', exitCode: 0, requests: { '/facets': 1, '/module/CS2040': 2 } });
  });

  it('a failed check, or a run that throws: one record each, outcome failed', async () => {
    await recordedLiveRun('p5-live', { url: 'https://nusmodfinder.rcn.sh' }, async () => [{ pass: true }, { pass: false }], { dir, now: () => AT, random: () => '0001' });
    await expect(recordedLiveRun('p5-live', { url: 'https://nusmodfinder.rcn.sh' }, async () => { throw new Error('browser crashed'); }, { dir, now: () => AT, random: () => '0002' }))
      .rejects.toThrow('browser crashed');
    expect(records().map((r) => [r.record.outcome, r.record.exitCode])).toEqual([['failed', 1], ['failed', 1]]);
    expect(records()[1].record.message).toContain('browser crashed');
  });

  it('a local server (npm run dev) is not a remote: no record', async () => {
    await recordedLiveRun('p6-live', { url: 'http://127.0.0.1:8911' }, async () => pass, { dir });
    await recordedLiveRun('p5-live', { url: 'http://localhost:8911' }, async () => pass, { dir });
    expect(records()).toEqual([]);
  });
});

describe('validating run records (check:findings)', () => {
  const NOW = new Date('2026-11-12T12:00:00Z');
  const good = () => {
    const run = startRun('verify', { dir, now: () => AT, random: () => 'beef' });
    run.finish('ok', { exitCode: 0 });
    return records()[0];
  };

  it('passes a record as written', () => {
    const { file, record } = good();
    expect(validateRunRecord(record, { file, now: NOW })).toEqual([]);
    expect(checkRunRecords(dir, NOW)).toEqual([]);
  });

  it('fails a wrong schema, a time in the future or not ISO, a missing outcome, and a name that disagrees', () => {
    const { file, record } = good();
    expect(validateRunRecord({ ...record, schema: 'other/1' }, { file, now: NOW })).toEqual([expect.stringMatching(/schema/)]);
    expect(validateRunRecord({ ...record, time: '2026-11-12T13:00:00.000Z' }, { file: '20261112T130000Z-verify-beef.json', now: NOW }))
      .toEqual([expect.stringMatching(/in the future/)]);
    expect(validateRunRecord({ ...record, time: '12 Nov 2026' }, { file, now: NOW })).toEqual(expect.arrayContaining([expect.stringMatching(/not an ISO UTC time/)]));
    const { outcome, ...noOutcome } = record;
    expect(outcome).toBe('ok');
    expect(validateRunRecord(noOutcome, { file, now: NOW })).toEqual([expect.stringMatching(/outcome/)]);
    expect(validateRunRecord({ ...record, outcome: 'fine' }, { file, now: NOW })).toEqual([expect.stringMatching(/outcome/)]);
    expect(validateRunRecord(record, { file: '20261112T101531Z-verify-beef.json', now: NOW })).toEqual([expect.stringMatching(/file name/)]);
    expect(validateRunRecord({ ...record, commit: { sha: 'x', dirty: true, diffSha256: null } }, { file, now: NOW })).toHaveLength(2);
    expect(validateRunRecord({ ...record, requests: { '/health': -1 } }, { file, now: NOW })).toEqual([expect.stringMatching(/requests/)]);
  });

  it('reports a file that is not JSON, and a file that is not a run record\'s name', () => {
    good();
    writeFileSync(join(dir, '20261112T101530Z-verify-dead.json'), '{ not json');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const errors = checkRunRecords(dir, NOW);
    expect(errors).toEqual([expect.stringMatching(/20261112T101530Z-verify-dead\.json: not JSON/), expect.stringMatching(/notes\.txt: not a run record/)]);
  });

  it('a missing runs dir has no records and no errors', () => {
    expect(checkRunRecords(join(dir, 'none'), NOW)).toEqual([]);
  });
});
