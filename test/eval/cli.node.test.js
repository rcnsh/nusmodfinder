// @ts-check
// The eval CLI's `report` path end to end on a small encrypted set built here
// with a throwaway key (no workerd, no Cloudflare). Run files are synthetic:
// every returned code is judged, so the set is fully judged.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKey, readKey, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { appendLook, readLedger } from '../../eval/lib/ledger.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

const CLI = join(REPO, 'eval', 'cli.mjs');
// The self-test twin of the holdout set: same rules, ledger in its own
// directory. Tests never touch the real eval/holdout-ledger.md.
const SET = 'selftest';

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
/** @type {Buffer} */
let key;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-cli-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
  key = await readKey(keyFile);
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const fixture = async (/** @type {string} */ f) => JSON.parse(await readFile(join(REPO, 'eval', 'fixtures', f), 'utf8'));

/**
 * A synthetic run file over the fixture queries: each query returns its judged
 * codes, best grade first (`order: 'best'`) or worst first.
 * @param {any} querySet
 * @param {any} qrels
 * @param {string} variant
 * @param {'best' | 'worst'} order
 */
function syntheticRun(querySet, qrels, variant, order) {
  /** @type {Record<string, { status: number, codes: string[] }>} */
  const results = {};
  for (const q of querySet.queries) {
    const judged = Object.entries(qrels.queries[q.id]?.judgments ?? {})
      .map(([code, j]) => ({ code, g: typeof j === 'number' ? j : Number(/** @type {any} */ (j).grade) || 0 }))
      .sort((a, b) => (order === 'best' ? b.g - a.g : a.g - b.g) || a.code.localeCompare(b.code));
    results[q.id] = { status: 200, codes: judged.slice(0, 10).map((x) => x.code) };
  }
  return {
    schema: 'vnm-eval-run/1', variant, set: SET,
    ranker: { ref: 'synthetic', sha: '0'.repeat(40), dirty: false },
    corpus: { ...qrels.corpus },
    queries: { version: querySet.version, sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'), count: querySet.queries.length },
    results, docs: {},
  };
}

/**
 * Writes an encrypted set (queries, qrels, runs `base` and `cand`) into a new
 * directory under tmp, bound to `edit.as` (default the self-test set).
 * @param {string} name
 * @param {{ qrels?: (q: any) => void, as?: string }} [edit]
 */
async function makeSet(name, edit = {}) {
  const as = edit.as ?? SET;
  const dir = join(tmp, name);
  const querySet = await fixture('queries.json');
  const qrels = await fixture('qrels.json');
  const base = syntheticRun(querySet, qrels, 'base', 'worst');
  const cand = syntheticRun(querySet, qrels, 'cand', 'best');
  edit.qrels?.(qrels);
  await writeEncryptedJson(join(dir, 'queries.json.enc'), querySet, key, as);
  await writeEncryptedJson(join(dir, 'qrels.json.enc'), qrels, key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-base.json.enc'), base, key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-cand.json.enc'), cand, key, as);
  return { dir, querySet };
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, ...env, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('holdout errors are withheld (review finding 4)', () => {
  it('a bad grade prints only the generic line: no rationale, no query id', async () => {
    const { dir } = await makeSet('bad-grade', {
      qrels: (q) => { q.queries['fx-03'].judgments.CS3244 = { grade: 7, rationale: 'SECRET-RATIONALE fx-03 wants machine learning' }; },
    });
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`eval: ${SET} run failed (QrelsError); details withheld\n`);
  });

  it('a wrong key prints only the generic line', async () => {
    const { dir } = await makeSet('wrong-key');
    const wrong = join(tmp, 'wrong.key');
    await generateKey(wrong);
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base'], { VNM_HOLDOUT_KEY_FILE: wrong });
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toBe(`eval: ${SET} run failed (DecryptionError); details withheld\n`);
  });
});

describe('--embed-missing on an encrypted set (PR #6 review round 3)', () => {
  it('a failed embedding prints only the withheld line and finalises the reserved look as aborted', async () => {
    const { dir } = await makeSet('embed-fails');
    // A corrupt cache: embed.mjs fails reading it, before any network call.
    await writeFile(join(dir, 'embeddings.json.enc'), 'not a ciphertext\n');
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'em', '--baseline', 'base', '--embed-missing'], { CI: '' });
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toBe(`eval: ${SET} run failed (EmbeddingError); details withheld\n`);
    expect((await readLedger(join(dir, 'ledger.md'))).map((x) => [x.variant, x.verdict])).toEqual([['em', 'aborted']]);
  });
});

describe('set-bound ciphertexts (review finding 2)', () => {
  it('a look on the self-test set records one row in that set\'s own ledger', async () => {
    const { dir } = await makeSet('one-look');
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^holdout verdict: (PASS|FAIL)/);
    expect(await readFile(join(dir, 'ledger.md'), 'utf8')).toMatch(/\| selftest \| 0000000 \| cand \| base \|/);
  });

  it('holdout ciphertexts copied into a self-test directory do not decrypt there', async () => {
    const { dir } = await makeSet('copied-holdout', { as: 'holdout' });
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base']);
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toBe(`eval: ${SET} run failed (DecryptionError); details withheld\n`);
  });
});

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, out: string }>}
 */
function cliAsync(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO, env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, FORCE_COLOR: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => done({ code, out }));
  });
}

describe('parallel looks (review finding 3)', () => {
  it('three parallel reports from 11 ledger rows record exactly one look', async () => {
    const { dir } = await makeSet('parallel');
    const ledger = join(dir, 'ledger.md');
    for (let i = 0; i < 11; i++) {
      await appendLook(ledger, { date: '2026-01-01', set: SET, commit: '0000000', variant: `filler-${i}`, baseline: 'base', verdict: 'fail', ndcg: '+0.000', p5: '+0.000' });
    }
    const runs = await Promise.all([1, 2, 3].map(() => cliAsync(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base'])));
    expect(runs.map((r) => r.code).sort()).toEqual([0, 1, 1]);
    for (const r of runs.filter((x) => x.code === 1)) expect(r.out).toBe(`eval: ${SET} run failed (LookLimitError); details withheld\n`);
    expect(await readLedger(ledger)).toHaveLength(12);
  }, 60_000);
});

describe('qrels and runs must share a corpus (review finding 7)', () => {
  /**
   * A plaintext copy of the fixture set with synthetic runs; `edit` changes the qrels.
   * @param {string} name
   * @param {(q: any) => void} [edit]
   */
  async function devSet(name, edit) {
    const dir = join(tmp, name);
    await cp(join(REPO, 'eval', 'fixtures'), dir, { recursive: true });
    const querySet = await fixture('queries.json');
    const qrels = await fixture('qrels.json');
    for (const [variant, order] of /** @type {const} */ ([['base', 'worst'], ['cand', 'best']])) {
      await writeFile(join(dir, `${variant}.json`), JSON.stringify({ ...syntheticRun(querySet, qrels, variant, order), set: 'fixture' }));
    }
    edit?.(qrels);
    await writeFile(join(dir, 'qrels.json'), JSON.stringify(qrels));
    return dir;
  }
  const report = (/** @type {string} */ dir, /** @type {string[]} */ extra = []) => cli(['report', '--set', 'fixture', '--set-dir', dir, '--run', join(dir, 'cand.json'), '--baseline', join(dir, 'base.json'), ...extra]);

  it('dev: the comparison names the qrels version', async () => {
    const r = report(await devSet('same-corpus'));
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^paired over \d+ primary answerable queries · qrels fixture-qrels-v1$/m);
  });

  it('dev: report refuses qrels judged on another moduleInfo corpus', async () => {
    const r = report(await devSet('other-corpus', (q) => { q.version = 'fixture-qrels-v9'; q.corpus.moduleInfoSha256 = '0'.repeat(64); }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^eval: qrels fixture-qrels-v9 were judged on a corpus with moduleInfoSha256 000000000000…, but run base used 2d138795d387…/);
    expect(r.stdout).not.toMatch(/paired over/);
  });

  it('dev: report refuses a different NG corpus when the qrels record one', async () => {
    const r = report(await devSet('other-ng', (q) => { q.corpus.ngSha256 = 'f'.repeat(64); }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/with ngSha256 ffffffffffff…/);
  });

  it('dev: run refuses before any retrieval when the baseline used another corpus', async () => {
    const dir = await devSet('run-precheck', (q) => { q.corpus.moduleInfoSha256 = '0'.repeat(64); });
    const r = cli(['run', '--set', 'fixture', '--set-dir', dir, '--variant', 'never', '--out', join(dir, 'never.json'), '--baseline', join(dir, 'base.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^eval: qrels fixture-qrels-v1 were judged on a corpus with moduleInfoSha256 000000000000…/);
    expect(r.stdout).not.toMatch(/ranker/); // the runner never started
  });

  it('holdout: report refuses, withheld, and records no look', async () => {
    const { dir } = await makeSet('holdout-other-corpus', { qrels: (q) => { q.corpus.moduleInfoSha256 = '0'.repeat(64); } });
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base']);
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toBe(`eval: ${SET} run failed (CorpusMismatchError); details withheld\n`);
    expect(await readLedger(join(dir, 'ledger.md'))).toHaveLength(0);
  });
});

describe('a holdout run with nothing to score reserves no look', () => {
  it('refuses before reserving when the set has no qrels yet', async () => {
    const { dir } = await makeSet('unjudged');
    await rm(join(dir, 'qrels.json.enc'));
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'never', '--baseline', 'base']);
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toBe(`eval: ${SET} run failed (Error); details withheld\n`);
    expect(await readLedger(join(dir, 'ledger.md'))).toHaveLength(0);
  });
});
