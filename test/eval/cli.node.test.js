// @ts-check
// The eval CLI's `report` path end to end on a small encrypted set built here
// with a throwaway key (no workerd, no Cloudflare). Run files are synthetic:
// every returned code is judged, so the set is fully judged.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKey, readKey, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
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
