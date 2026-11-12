// @ts-check
// scripts/deploy.mjs: refuses a dirty tree or an unpushed HEAD, refuses any
// bundle but the production one and any D1 that does not match it (Phase 3
// 3-0 guard), and otherwise uploads a version tagged with the commit, checks
// its startup time, and only then promotes it. git and wrangler are a fake
// exec, the bundle and D1's hashes are injected, so nothing here deploys,
// reads D1 or touches the repo.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_VARS, MAX_STARTUP_MS, STARTUP_PROFILE, deploy, freePort, remoteHashes, wranglerVars } from '../scripts/deploy.mjs';
import { dataVersion } from '../src/rowhash.js';
import { rowsKey } from '../src/vector-bundle.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
const SHIM = '/repo/.data/vectors/vec-production-abc-emb.js';

/** D1 as runbook step 4 left it, and the production bundle built for it. */
const D1 = { modules: { CS1010S: { textHash: 't1', rowHash: 'r1' }, CS2040: { textHash: 't2', rowHash: 'r2' } } };
const D1_ROWS = Object.entries(D1.modules);
const DV = await dataVersion(D1_ROWS.map(([code, h]) => ({ code, rowHash: h.rowHash })));
const KEY = await rowsKey(D1_ROWS.map(([code, h]) => ({ code, textHash: h.textHash })));
/** @param {Partial<{ corpus: string, sha256: string, dataVersion: string, rowsKey: string }>} [o] */
const bundleOf = (o = {}) => async () => {
  const corpus = o.corpus ?? 'production';
  return /** @type {import('../scripts/deploy.mjs').DeployBundle} */ (/** @type {unknown} */ ({
    entry: { corpus, count: 2, dataVersion: o.dataVersion ?? DV, rowsKey: o.rowsKey ?? KEY, sha256: o.sha256 ?? 'prod-sha' },
    header: { corpus, dataVersion: o.dataVersion ?? DV, rowsKey: o.rowsKey ?? KEY },
    sha256: o.sha256 ?? 'prod-sha', shim: SHIM, others: ['fixture-sha', 'pinned-sha'],
  }));
};

/**
 * A fake exec answering git and wrangler from a table; records every call.
 * @param {Record<string, { code?: number, stdout?: string }>} [over] keyed by `cmd args…`
 */
function fakeExec(over = {}) {
  /** @type {Record<string, { code?: number, stdout?: string }>} */
  const table = {
    'git status --porcelain --untracked-files=all --ignore-submodules=none': { stdout: '' },
    'git ls-files -v': { stdout: 'H src/index.js\nH package.json\n' },
    'git fetch --quiet origin main': {},
    'git rev-parse HEAD': { stdout: `${SHA}\n` },
    'git rev-parse refs/remotes/origin/main': { stdout: `${SHA}\n` },
    'git merge-base --is-ancestor HEAD refs/remotes/origin/main': {},
    'git rev-parse --short HEAD': { stdout: '0123456\n' },
    'git log -1 --format=%s': { stdout: 'feat(search): add Server-Timing\n' },
    ...over,
  };
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'npx') {
      const sub = args.slice(1, 3).join(' ');
      const w = sub === 'check startup' ? over.check ?? { stdout: 'Bundle: 10500.00 KiB\nLocal startup profile:\n  Active: 4.2 ms\n' }
        : sub === 'versions upload' ? over.upload ?? { stdout: `Total Upload: 10500 KiB\nWorker Startup Time: 21 ms\nWorker Version ID: ${VERSION}\n` }
          : sub === 'versions deploy' ? over.promote ?? { stdout: 'Deployed\n' }
            : sub === 'triggers deploy' ? over.triggers ?? { stdout: 'Deployed triggers\n' }
            : { code: 99, stdout: `unexpected wrangler ${args.join(' ')}` };
      return { code: w.code ?? 0, stdout: w.stdout ?? '' };
    }
    const hit = table[[cmd, ...args].join(' ')];
    if (!hit) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '' };
  };
  return { exec, calls };
}

/** Each test's run records (Phase 7 7C), in a temp dir. @type {string} */
let runsDir;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'vnm-deploy-runs-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });
const records = () => readdirSync(runsDir).sort().map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')));

/**
 * @param {import('../scripts/deploy.mjs').Exec} exec
 * @param {{ bundle?: () => Promise<import('../scripts/deploy.mjs').DeployBundle>, d1?: any, committed?: string, vars?: Record<string, unknown> }} [o]
 */
async function runDeploy(exec, o = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  let d1Reads = 0;
  const code = await deploy({
    exec, log: (m) => out.push(m), error: (m) => err.push(m),
    bundle: o.bundle ?? bundleOf(),
    d1Hashes: async () => { d1Reads++; if (o.d1 instanceof Error) throw o.d1; return o.d1 ?? D1; },
    committedDataVersion: async () => o.committed ?? DV,
    vars: async () => o.vars ?? { DENSE_BACKEND: 'bundle' },
    runsDir,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), d1Reads };
}

const ranWrangler = (/** @type {string[][]} */ calls) => calls.some((c) => c[0] === 'npx');

describe('npm run deploy', () => {
  it('Phase 4: the committed wrangler.jsonc vars hold only DENSE_BACKEND, and any other var is refused before git or wrangler', async () => {
    expect(Object.keys(await wranglerVars())).toEqual(ALLOWED_VARS);
    const { exec, calls } = fakeExec({});
    const { code, err } = await runDeploy(exec, { vars: { DENSE_BACKEND: 'bundle', SC1_TRACE: '1' } });
    expect(code).toBe(1);
    expect(err).toContain('SC1_TRACE');
    expect(calls).toEqual([]);
  });

  it('refuses a dirty working tree and never runs wrangler', async () => {
    const { exec, calls } = fakeExec({ 'git status --porcelain --untracked-files=all --ignore-submodules=none': { stdout: ' M src/index.js\n?? scratch.txt\n' } });
    const { code, err } = await runDeploy(exec);
    expect(code).toBe(1);
    expect(err).toContain('not clean');
    expect(err).toContain('M src/index.js');
    expect(ranWrangler(calls)).toBe(false);
  });

  it('refuses when HEAD is not on origin/main', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse HEAD': { stdout: 'feedface\n' },
      'git merge-base --is-ancestor HEAD refs/remotes/origin/main': { code: 1 },
    });
    const { code, err } = await runDeploy(exec);
    expect(code).toBe(1);
    expect(err).toContain('not on origin/main');
    expect(ranWrangler(calls)).toBe(false);
  });

  it('refuses when files are hidden by assume-unchanged or skip-worktree', async () => {
    for (const line of ['h src/index.js', 'S src/search.js']) {
      const { exec, calls } = fakeExec({ 'git ls-files -v': { stdout: `H package.json\n${line}\n` } });
      const { code, err } = await runDeploy(exec);
      expect(code).toBe(1);
      expect(err).toContain('assume-unchanged or skip-worktree');
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('refuses when origin/main cannot be fetched', async () => {
    const { exec, calls } = fakeExec({ 'git fetch --quiet origin main': { code: 128 } });
    expect((await runDeploy(exec)).code).toBe(1);
    expect(ranWrangler(calls)).toBe(false);
  });

  it('checks startup, uploads a version tagged with its short SHA and the production bundle aliased in, gates its startup, then promotes it', async () => {
    const { exec, calls } = fakeExec();
    const { code, out, d1Reads } = await runDeploy(exec);
    expect(code).toBe(0);
    expect(d1Reads).toBe(1);
    expect(calls.filter((c) => c[0] === 'npx')).toEqual([
      // One argv entry: wrangler reads a separate `--alias …` as its own (unknown) flag.
      ['npx', 'wrangler', 'check', 'startup', '--outfile', STARTUP_PROFILE, `--args=--alias vectors-bundle:${SHIM}`],
      ['npx', 'wrangler', 'versions', 'upload', '--tag', '0123456', '--message', '0123456 feat(search): add Server-Timing', '--alias', `vectors-bundle:${SHIM}`],
      ['npx', 'wrangler', 'versions', 'deploy', `${VERSION}@100%`, '--yes', '--message', '0123456 feat(search): add Server-Timing'],
      // The Custom Domain (ADR 0009): `versions deploy` leaves routes alone.
      ['npx', 'wrangler', 'triggers', 'deploy'],
    ]);
    expect(out).toContain('startup 21 ms');
    expect(out).toContain(`version ${VERSION} (tag 0123456) is live`);
    expect(out).toContain('guard read 2 D1 rows');
  });

  it('caps the version message at 100 characters', async () => {
    const { exec, calls } = fakeExec({ 'git log -1 --format=%s': { stdout: `${'x'.repeat(150)}\n` } });
    await runDeploy(exec);
    const args = /** @type {string[]} */ (calls.find((c) => c[0] === 'npx' && c[2] === 'versions'));
    expect(args[args.indexOf('--message') + 1]).toHaveLength(100);
  });

  it('passes a wrangler failure through as the exit code, and never promotes after a failed check or upload', async () => {
    for (const [over, exit] of /** @type {const} */ ([[{ check: { code: 2 } }, 2], [{ upload: { code: 3 } }, 3], [{ promote: { code: 4 } }, 4], [{ triggers: { code: 5 } }, 5]])) {
      const { exec, calls } = fakeExec(over);
      expect((await runDeploy(exec)).code).toBe(exit);
      if (exit < 4) expect(calls.some((c) => c[2] === 'versions' && c[3] === 'deploy')).toBe(false);
    }
  });

  it(`[B-4] refuses to promote a version whose startup time is above ${MAX_STARTUP_MS} ms, or missing`, async () => {
    for (const stdout of [`Worker Startup Time: ${MAX_STARTUP_MS + 1} ms\nWorker Version ID: ${VERSION}\n`, `Worker Version ID: ${VERSION}\n`]) {
      const { exec, calls } = fakeExec({ upload: { stdout } });
      const { code, err } = await runDeploy(exec);
      expect(code).toBe(1);
      expect(err).toContain(`refusing to promote ${VERSION}`);
      expect(calls.some((c) => c[2] === 'versions' && c[3] === 'deploy')).toBe(false);
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

  it('[B-2, B3-4] the guard refuses when D1 does not hold the bundle\'s texts or the committed data version, or cannot be read', async () => {
    const otherText = { modules: { ...D1.modules, CS2040: { textHash: 'old', rowHash: 'r2' } } };
    const otherRow = { modules: { ...D1.modules, CS2040: { textHash: 't2', rowHash: 'old' } } };
    for (const [d1, msg] of /** @type {const} */ ([[otherText, 'Run the D1-only ingest'], [otherRow, "D1's data version is"], [new Error('dev session died'), 'dev session died']])) {
      const { exec, calls } = fakeExec();
      const { code, err } = await runDeploy(exec, { d1 });
      expect(code).toBe(1);
      expect(err).toContain(msg);
      expect(ranWrangler(calls)).toBe(false);
    }
  });
});

describe('Phase 7 7C: the clean-tree exemption and the run record', () => {
  it('admits new, untracked run records under docs/evidence/ops/runs/ and nothing else', async () => {
    const { exec } = fakeExec({ 'git status --porcelain --untracked-files=all --ignore-submodules=none': {
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
      const { exec, calls } = fakeExec({ 'git status --porcelain --untracked-files=all --ignore-submodules=none': { stdout: `?? docs/evidence/ops/runs/20261112T101530Z-ingest-ff00.json\n${line}\n` } });
      const { code, err } = await runDeploy(exec);
      expect(code, line).toBe(1);
      expect(err).toContain(line.trim());
      expect(err).not.toContain('ingest-ff00');
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('every exit path leaves exactly one record: refused, failed after the upload, and live', async () => {
    await runDeploy(fakeExec({ 'git status --porcelain --untracked-files=all --ignore-submodules=none': { stdout: ' M src/index.js\n' } }).exec);
    await runDeploy(fakeExec({ promote: { code: 4 } }).exec);
    await runDeploy(fakeExec().exec);
    const [refused, failed, live] = records();
    expect(records()).toHaveLength(3);
    expect(refused).toMatchObject({ script: 'deploy', outcome: 'refused', exitCode: 1 });
    expect(failed).toMatchObject({ script: 'deploy', outcome: 'failed', exitCode: 4, versions: { versionId: VERSION, tag: '0123456' } });
    expect(live).toMatchObject({
      script: 'deploy', outcome: 'ok', exitCode: 0, target: 'nusmodfinder',
      versions: { versionId: VERSION, tag: '0123456', dataVersion: DV }, read: [{ what: expect.stringMatching(/D1 rows/), actual: 2 }],
    });
  });

  it('a throw anywhere still leaves a record, and the error goes on up', async () => {
    const exec = /** @type {import('../scripts/deploy.mjs').Exec} */ (async () => { throw new Error('git vanished'); });
    await expect(runDeploy(exec)).rejects.toThrow('git vanished');
    expect(records()).toEqual([expect.objectContaining({ script: 'deploy', outcome: 'failed', message: expect.stringContaining('git vanished') })]);
  });
});

describe('the guard\'s wrangler dev port', () => {
  /** @param {number} port @returns {Promise<import('node:net').Server>} */
  const listen = (port) => new Promise((resolve, reject) => {
    const server = createServer().once('error', reject).listen(port, '127.0.0.1', () => resolve(server));
  });

  it('is a free port by default, so another dev server cannot answer the guard', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const server = await listen(port); // it is free: binding it succeeds
    server.close();
  });

  it('refuses a port already in use, before starting wrangler or asking anything', async () => {
    const server = await listen(0);
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    /** @type {string[]} */
    const asked = [];
    const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url) => { asked.push(url); return new Response('{}'); }));
    try {
      await expect(remoteHashes({ port, log: () => {}, fetchImpl })).rejects.toThrow(new RegExp(`port ${port} is in use`));
      expect(asked).toEqual([]);
    } finally {
      server.close();
    }
  });
});

