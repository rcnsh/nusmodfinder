// @ts-check
// scripts/deploy.mjs: the preflight (test/preflight.node.test.js covers each check), then the
// guard over D1's REST query endpoint (Phase 7 7B, G1), the upload with the commit as its tag,
// the startup gate, the intent record (the previous version id), the promote, an annotated
// `deploy/*` tag pushed before `wrangler triggers deploy`, and one run record on every exit
// path. git, gh and wrangler are a fake exec, D1 is the real REST client over a fake fetch, the
// bundle is injected: nothing here deploys, reads D1 or touches the repo's remote.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_VARS, MAX_STARTUP_MS, STARTUP_PROFILE, deploy, wranglerVars } from '../scripts/deploy.mjs';
import { productionD1 } from '../scripts/d1-read.mjs';
import { GUARD_CHECKS } from '../scripts/guard.mjs';
import {
  D1_MODULES, DV, KEY, NOW, PREVIOUS, RUNS_API, SHA, SHIM, SHORT, STATUS_KEY, TAG, TOKEN, VERSION,
  bundleOf, fakeD1, fakeExec, ghRun, runsBody,
} from './deploy-fakes.js';

/** Each test's run records (Phase 7 7C), in a temp dir. @type {string} */
let runsDir;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'vnm-deploy-runs-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });
const records = () => readdirSync(runsDir).sort().map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')));
const recordText = () => readdirSync(runsDir).map((f) => readFileSync(join(runsDir, f), 'utf8')).join('\n');

/**
 * @param {import('../scripts/deploy.mjs').Exec} exec
 * @param {{ bundle?: () => Promise<import('../scripts/deploy.mjs').DeployBundle>, d1?: () => Promise<any>, committed?: string,
 *   vars?: Record<string, unknown>, argv?: string[], env?: Record<string, string>, signals?: EventEmitter,
 *   guardChecks?: import('../scripts/guard.mjs').GuardCheck[] }} [o]
 */
async function runDeploy(exec, o = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  let d1Reads = 0;
  /** @type {number[]} */
  const exits = [];
  const code = await deploy({
    argv: o.argv ?? [], exec, log: (m) => out.push(m), error: (m) => err.push(m),
    bundle: o.bundle ?? bundleOf(),
    d1: async () => { d1Reads++; return o.d1 ? o.d1() : fakeD1().client; },
    committedDataVersion: async () => o.committed ?? DV,
    vars: async () => o.vars ?? { DENSE_BACKEND: 'bundle' },
    runsDir, now: () => NOW, env: o.env ?? {}, moduleExists: () => false,
    signals: o.signals ?? new EventEmitter(), exit: (c) => { exits.push(c); },
    ...(o.guardChecks ? { guardChecks: o.guardChecks } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), d1Reads, exits };
}

const ranWrangler = (/** @type {string[][]} */ calls) => calls.some((c) => c[0] === 'npx' && c[2] !== 'check');
const wrangler = (/** @type {string[][]} */ calls) => calls.filter((c) => c[0] === 'npx');
const promoted = (/** @type {string[][]} */ calls) => calls.some((c) => c[2] === 'versions' && c[3] === 'deploy');
/** The index of the first call matching. @param {string[][]} calls @param {(c: string[]) => boolean} p */
const at = (calls, p) => calls.findIndex(p);

describe('npm run deploy', () => {
  it('Phase 4: the committed wrangler.jsonc vars hold only DENSE_BACKEND, and any other var is refused before wrangler', async () => {
    expect(Object.keys(await wranglerVars())).toEqual(ALLOWED_VARS);
    const { exec, calls } = fakeExec({});
    const { code, err } = await runDeploy(exec, { vars: { DENSE_BACKEND: 'bundle', SC1_TRACE: '1' } });
    expect(code).toBe(1);
    expect(err).toContain('SC1_TRACE');
    expect(wrangler(calls)).toEqual([]);
  });

  it('refuses a dirty working tree and never runs wrangler', async () => {
    const { exec, calls } = fakeExec({ [STATUS_KEY]: { stdout: ' M src/index.js\n?? scratch.txt\n' } });
    const { code, err } = await runDeploy(exec);
    expect(code).toBe(1);
    expect(err).toContain('not clean');
    expect(err).toContain('M src/index.js');
    expect(wrangler(calls)).toEqual([]);
  });

  it('refuses when HEAD is not on origin/main, when files are hidden, and when origin/main cannot be fetched', async () => {
    for (const over of [
      { 'git rev-parse HEAD': { stdout: 'feedface\n' }, 'git merge-base --is-ancestor HEAD refs/remotes/origin/main': { code: 1 } },
      { 'git ls-files -v': { stdout: 'H package.json\nS src/search.js\n' } },
      { 'git fetch --quiet origin main': { code: 128 } },
    ]) {
      const { exec, calls } = fakeExec(over);
      expect((await runDeploy(exec)).code).toBe(1);
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('refuses a HEAD behind the tip unless --behind-ok, which it logs and records', async () => {
    const behind = { 'git rev-parse refs/remotes/origin/main': { stdout: 'feedfacefeedfacefeedfacefeedfacefeedface\n' } };
    const refused = await runDeploy(fakeExec(behind).exec);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/behind origin\/main/);
    expect(refused.d1Reads).toBe(0);
    const { exec, calls } = fakeExec(behind);
    const ok = await runDeploy(exec, { argv: ['--behind-ok'] });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/--behind-ok/);
    expect(promoted(calls)).toBe(true);
    expect(records().at(-1)).toMatchObject({ outcome: 'ok', args: ['--behind-ok'], details: { behindOk: true } });
  });

  it('refuses no run, a running run, a failed or cancelled run, and a Findings failure, before D1 or any upload', async () => {
    for (const runs of [
      [],
      [ghRun('CI', { status: 'queued', conclusion: null }), ghRun('Findings')],
      [ghRun('CI', { conclusion: 'failure' }), ghRun('Findings')],
      [ghRun('CI', { conclusion: 'cancelled' }), ghRun('Findings')],
      [ghRun('CI'), ghRun('Findings', { conclusion: 'failure' })],
      [ghRun('CI'), ghRun('Findings', { head_sha: 'f'.repeat(40) })],
    ]) {
      const { exec, calls } = fakeExec({ [RUNS_API]: { stdout: runsBody(runs) } });
      const { code, d1Reads } = await runDeploy(exec);
      expect(code, JSON.stringify(runs.map((r) => [r.name, r.status, r.conclusion]))).toBe(1);
      expect(d1Reads).toBe(0);
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('checks startup, guards, uploads tagged with its short SHA, gates startup, records the intent, promotes, tags and pushes, then deploys triggers', async () => {
    const { exec, calls } = fakeExec();
    const { code, out, d1Reads } = await runDeploy(exec);
    expect(code).toBe(0);
    expect(d1Reads).toBe(1);
    expect(wrangler(calls)).toEqual([
      // One argv entry: wrangler reads a separate `--alias …` as its own (unknown) flag.
      ['npx', 'wrangler', 'check', 'startup', '--outfile', STARTUP_PROFILE, `--args=--alias vectors-bundle:${SHIM}`],
      ['npx', 'wrangler', 'versions', 'upload', '--tag', SHORT, '--message', `${SHORT} feat(search): add Server-Timing`, '--alias', `vectors-bundle:${SHIM}`],
      ['npx', 'wrangler', 'deployments', 'status', '--json'],
      ['npx', 'wrangler', 'versions', 'deploy', `${VERSION}@100%`, '--yes', '--message', `${SHORT} feat(search): add Server-Timing`],
      // The Custom Domain (ADR 0009): `versions deploy` leaves routes alone.
      ['npx', 'wrangler', 'triggers', 'deploy'],
    ]);
    expect(out).toContain('startup 21 ms');
    expect(out).toContain(`version ${VERSION} (tag ${SHORT}) is live`);
    // The schema check reads 1 row in the fake, the hashes 6,800.
    expect(out).toMatch(/guard: 2 modules, 6801 D1 rows read/);
    expect(out).toContain(`previous version ${PREVIOUS}`);
  });

  it('tags HEAD before `triggers deploy`, with the previous id, data version and startup in the annotation, and pushes the tag', async () => {
    const { exec, calls } = fakeExec();
    expect((await runDeploy(exec)).code).toBe(0);
    const tag = /** @type {string[]} */ (calls.find((c) => c[0] === 'git' && c[1] === 'tag'));
    expect(tag.slice(0, 5)).toEqual(['git', 'tag', '-a', TAG, SHA]);
    const message = tag.slice(5).filter((_, i) => i % 2 === 1).join('\n');
    expect(tag.slice(5).filter((_, i) => i % 2 === 0).every((f) => f === '-m')).toBe(true);
    expect(message).toContain(`versionId: ${VERSION}`);
    expect(message).toContain(`previousVersionId: ${PREVIOUS}`);
    expect(message).toContain(`commit: ${SHA}`);
    expect(message).toContain(`dataVersion: ${DV}`);
    expect(message).toContain('startupMs: 21');
    const iPromote = at(calls, (c) => c[2] === 'versions' && c[3] === 'deploy');
    const iTag = at(calls, (c) => c[1] === 'tag');
    const iPush = at(calls, (c) => c[1] === 'push');
    const iTriggers = at(calls, (c) => c[2] === 'triggers');
    expect(calls[iPush]).toEqual(['git', 'push', 'origin', `refs/tags/${TAG}`]);
    expect(iPromote).toBeLessThan(iTag);
    expect(iTag).toBeLessThan(iPush);
    expect(iPush).toBeLessThan(iTriggers);
    expect(records()[0]).toMatchObject({ outcome: 'ok', versions: { versionId: VERSION, previousVersionId: PREVIOUS, tag: SHORT, dataVersion: DV, startupMs: 21, deployTag: TAG } });
  });

  it('a failed tag push does not fail the deploy: it prints the command to retry, and the record says so', async () => {
    const { exec, calls } = fakeExec({ push: { code: 1 } });
    const { code, err } = await runDeploy(exec);
    expect(code).toBe(0);
    expect(err).toContain(`git push origin refs/tags/${TAG}`);
    expect(calls.some((c) => c[2] === 'triggers')).toBe(true);
    expect(records()[0]).toMatchObject({ outcome: 'ok', details: { tagPushed: false } });
  });

  it('finishes the tag and the record on SIGINT after the promote, skips triggers, and exits 130', async () => {
    const signals = new EventEmitter();
    const { exec, calls } = fakeExec({ promote: () => { signals.emit('SIGINT'); return { stdout: 'Deployed\n' }; } });
    const { code, err, exits } = await runDeploy(exec, { signals });
    expect(code).toBe(130);
    expect(exits).toEqual([]);
    expect(calls.some((c) => c[1] === 'tag')).toBe(true);
    expect(calls.some((c) => c[1] === 'push')).toBe(true);
    expect(calls.some((c) => c[2] === 'triggers')).toBe(false);
    expect(err).toContain('npx wrangler triggers deploy');
    expect(records()).toEqual([expect.objectContaining({ outcome: 'interrupted', exitCode: 130, versions: expect.objectContaining({ versionId: VERSION, deployTag: TAG }) })]);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('a signal before the promote records an interruption and exits through exit()', async () => {
    const signals = new EventEmitter();
    const { exec } = fakeExec({ upload: () => { signals.emit('SIGTERM'); return { stdout: `Worker Startup Time: 21 ms\nWorker Version ID: ${VERSION}\n` }; } });
    const { exits } = await runDeploy(exec, { signals });
    expect(exits).toEqual([143]);
    expect(records()[0]).toMatchObject({ outcome: 'interrupted', exitCode: 143 });
  });

  it('caps the version message at 100 characters', async () => {
    const { exec, calls } = fakeExec({ 'git log -1 --format=%s': { stdout: `${'x'.repeat(150)}\n` } });
    await runDeploy(exec);
    const args = /** @type {string[]} */ (calls.find((c) => c[0] === 'npx' && c[2] === 'versions'));
    expect(args[args.indexOf('--message') + 1]).toHaveLength(100);
  });

  it('passes a wrangler failure through as the exit code, and never promotes after a failed check or upload', async () => {
    for (const [over, exit] of /** @type {const} */ ([[{ check: { code: 2 } }, 1], [{ upload: { code: 3 } }, 3], [{ promote: { code: 4 } }, 4], [{ triggers: { code: 5 } }, 5]])) {
      const { exec, calls } = fakeExec(over);
      expect((await runDeploy(exec)).code).toBe(exit);
      if (exit < 4) expect(promoted(calls)).toBe(false);
    }
  });

  it(`[B-4] refuses to promote a version whose startup time is above ${MAX_STARTUP_MS} ms, or missing`, async () => {
    for (const stdout of [`Worker Startup Time: ${MAX_STARTUP_MS + 1} ms\nWorker Version ID: ${VERSION}\n`, `Worker Version ID: ${VERSION}\n`]) {
      const { exec, calls } = fakeExec({ upload: { stdout } });
      const { code, err } = await runDeploy(exec);
      expect(code).toBe(1);
      expect(err).toContain(`refusing to promote ${VERSION}`);
      expect(promoted(calls)).toBe(false);
    }
    const { exec } = fakeExec({ upload: { stdout: `Worker Startup Time: ${MAX_STARTUP_MS} ms\nWorker Version ID: ${VERSION}\n` } });
    expect((await runDeploy(exec)).code).toBe(0);
  });

  it('[B-9, B2-4] refuses the fixture and the pinned bundle, before reading D1 or running wrangler', async () => {
    for (const bundle of [bundleOf({ corpus: 'fixture' }), bundleOf({ corpus: 'pinned' }), bundleOf({ sha256: 'pinned-sha' })]) {
      const { exec, calls } = fakeExec();
      const { code, err, d1Reads } = await runDeploy(exec, { bundle });
      expect(code).toBe(1);
      expect(err).toContain('only the production bundle deploys');
      expect(d1Reads).toBe(0);
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('refuses a missing or unverifiable bundle, and a manifest data version that is not src/data-version.json', async () => {
    const missing = await runDeploy(fakeExec().exec, { bundle: async () => { throw new Error('data/vectors.json has no production bundle'); } });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no production bundle');
    const stale = await runDeploy(fakeExec().exec, { committed: 'ffffffffffff' });
    expect(stale.code).toBe(1);
    expect(stale.err).toContain('src/data-version.json says ffffffffffff');
    expect(stale.d1Reads).toBe(0);
  });
});

describe('the guard over the D1 REST query (Phase 7 7B, G1)', () => {
  it('[B-2, B3-4] refuses when D1 does not hold the bundle\'s texts or the committed data version, or cannot be read', async () => {
    const otherText = D1_MODULES.map((m) => (m.code === 'CS2040' ? { ...m, text_hash: 'old' } : m));
    const otherRow = D1_MODULES.map((m) => (m.code === 'CS2040' ? { ...m, row_hash: 'old' } : m));
    for (const [d1, msg] of /** @type {const} */ ([
      [() => fakeD1({ modules: otherText }).client, 'rowsKey'],
      [() => fakeD1({ modules: otherRow }).client, "D1's data version is"],
      [() => fakeD1({ status: 403 }).client, 'HTTP 403'],
    ])) {
      const { exec, calls } = fakeExec();
      const { code, err } = await runDeploy(exec, { d1 });
      expect(code).toBe(1);
      expect(err).toContain(msg);
      expect(ranWrangler(calls)).toBe(false);
      expect(records().at(-1)).toMatchObject({ outcome: 'refused' });
    }
  });

  it('sends only reads, and records the rows D1 says it read', async () => {
    const d1 = fakeD1({ rowsRead: 6812 });
    expect((await runDeploy(fakeExec().exec, { d1: async () => d1.client })).code).toBe(0);
    expect(d1.sent.every((s) => /^\s*SELECT/i.test(s.sql))).toBe(true);
    expect(records()[0].read).toEqual([{ what: expect.stringMatching(/D1 rows.*REST/), estimate: 2, actual: 6812 + 1 }]);
  });

  it('in GitHub Actions, a D1 that differs from the bundle fails with the Mac runbook, and nothing is uploaded', async () => {
    const otherRow = D1_MODULES.map((m) => (m.code === 'CS2040' ? { ...m, row_hash: 'new' } : m));
    const { exec, calls } = fakeExec();
    const { code, err } = await runDeploy(exec, { d1: async () => fakeD1({ modules: otherRow }).client, env: { GITHUB_ACTIONS: 'true' } });
    expect(code).toBe(1);
    expect(err).toMatch(/re-ingest runs on the Mac/);
    expect(err).toMatch(/Nothing was deployed/);
    expect(ranWrangler(calls)).toBe(false);
  });

  it('never prints, logs or records the token, from the env or from wrangler auth token', async () => {
    for (const env of [{ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'acct' }, { CLOUDFLARE_ACCOUNT_ID: 'acct' }]) {
      for (const status of [200, 403]) {
        const { fetchImpl } = fakeD1({ status });
        const { exec } = fakeExec({ 'wrangler auth token': { stdout: JSON.stringify({ type: 'oauth', token: TOKEN }) } });
        const r = await runDeploy(exec, { env, d1: () => productionD1({ env, exec, fetchImpl }) });
        expect(r.code).toBe(status === 200 ? 0 : 1);
        expect(r.out + r.err).not.toContain(TOKEN);
        expect(recordText()).not.toContain(TOKEN);
      }
    }
  });

  it('a second comparison is one entry added to the list: its failure refuses, its value goes in the tag', async () => {
    /** @type {import('../scripts/guard.mjs').GuardCheck} */
    const extra = { name: 'catalogueKey', field: 'catalogueKey', d1: async () => 'cat-d1', expected: () => 'cat-d1', fix: 'Re-ingest the catalogue.' };
    const { exec, calls } = fakeExec();
    expect((await runDeploy(exec, { guardChecks: [...GUARD_CHECKS, extra] })).code).toBe(0);
    const tag = /** @type {string[]} */ (calls.find((c) => c[1] === 'tag'));
    expect(tag).toContain('catalogueKey: cat-d1');

    const { exec: exec2, calls: calls2 } = fakeExec();
    const r = await runDeploy(exec2, { guardChecks: [...GUARD_CHECKS, { ...extra, expected: () => 'cat-bundled' }] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/catalogueKey.*cat-d1.*cat-bundled.*Re-ingest the catalogue/s);
    expect(ranWrangler(calls2)).toBe(false);
  });

  it('the shipped checks are rowsKey and the data version', () => {
    expect(GUARD_CHECKS.map((c) => c.name)).toEqual(['rowsKey', 'dataVersion']);
    expect(GUARD_CHECKS.find((c) => c.name === 'dataVersion')?.field).toBe('dataVersion');
    expect(KEY).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Phase 7 7C: the clean-tree exemption and the run record', () => {
  it('admits new, untracked run records under docs/evidence/ops/runs/ and nothing else', async () => {
    const { exec } = fakeExec({ [STATUS_KEY]: {
      stdout: '?? docs/evidence/ops/runs/20261112T101530Z-ingest-ab12.json\n?? docs/evidence/ops/runs/20261112T101544Z-verify-cd34.json\n',
    } });
    expect((await runDeploy(exec)).code).toBe(0);
  });

  it('refuses a modified tracked run record, a new file elsewhere, and a new file that is not a run record', async () => {
    for (const line of [
      ' M docs/evidence/ops/runs/20261112T101530Z-ingest-ab12.json',
      'A  docs/evidence/ops/runs/20261112T101530Z-ingest-ab12.json',
      '?? docs/evidence/ops/notes.md',
      '?? docs/evidence/ops/runs/sub/20261112T101530Z-ingest-ab12.json',
      '?? docs/evidence/ops/runs/scratch.txt',
      '?? src/scratch.js',
    ]) {
      const { exec, calls } = fakeExec({ [STATUS_KEY]: { stdout: `?? docs/evidence/ops/runs/20261112T101530Z-ingest-ff00.json\n${line}\n` } });
      const { code, err } = await runDeploy(exec);
      expect(code, line).toBe(1);
      expect(err).toContain(line.trim());
      expect(err).not.toContain('ingest-ff00');
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('every exit path leaves exactly one record: refused, each failure after the upload, a throw, and live', async () => {
    /** @type {[Parameters<typeof fakeExec>[0], string, number][]} */
    const paths = [
      [{ [STATUS_KEY]: { stdout: ' M src/index.js\n' } }, 'refused', 1],
      [{ upload: { code: 3 } }, 'failed', 3],
      [{ upload: { stdout: `Worker Startup Time: 900 ms\nWorker Version ID: ${VERSION}\n` } }, 'failed', 1],
      [{ status: { code: 1 } }, 'failed', 1],
      [{ promote: { code: 4 } }, 'failed', 4],
      [{ push: { code: 1 } }, 'ok', 0],
      [{ triggers: { code: 5 } }, 'failed', 5],
      [{}, 'ok', 0],
    ];
    for (const [over, outcome, exitCode] of paths) {
      const before = records().length;
      await runDeploy(fakeExec(over).exec);
      expect(records()).toHaveLength(before + 1);
      const r = records().find((x) => !seen.has(JSON.stringify(x)));
      seen.add(JSON.stringify(r));
      expect(r, JSON.stringify(over)).toMatchObject({ script: 'deploy', outcome, exitCode });
      if (outcome !== 'refused') expect(r.versions.versionId).toBe(VERSION);
    }
    // A throw after the upload.
    const thrown = fakeExec({ promote: () => { throw new Error('wrangler vanished'); } });
    await expect(runDeploy(thrown.exec)).rejects.toThrow('wrangler vanished');
    expect(records().find((x) => !seen.has(JSON.stringify(x)))).toMatchObject({ outcome: 'failed', message: expect.stringContaining('wrangler vanished'), versions: { versionId: VERSION } });
  });
  /** @type {Set<string>} */
  const seen = new Set();

  it('a throw anywhere still leaves a record, and the error goes on up', async () => {
    const exec = /** @type {import('../scripts/deploy.mjs').Exec} */ (async () => { throw new Error('git vanished'); });
    await expect(runDeploy(exec)).rejects.toThrow('git vanished');
    expect(records()).toEqual([expect.objectContaining({ script: 'deploy', outcome: 'failed', message: expect.stringContaining('git vanished') })]);
  });

  it('in GitHub Actions, appends a job summary naming the outcome, the version and the tag', async () => {
    const summary = join(runsDir, '..', `summary-${process.pid}-${Date.now()}.md`);
    writeFileSync(summary, '');
    try {
      expect((await runDeploy(fakeExec().exec, { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } })).code).toBe(0);
      const text = readFileSync(summary, 'utf8');
      expect(text).toMatch(/deploy: ok/);
      expect(text).toContain(VERSION);
      expect(text).toContain(TAG);
      expect(text).toContain(DV);
    } finally {
      rmSync(summary, { force: true });
    }
  });
});
