// @ts-check
// The Phase 2 exit red-team's three gaps in the gate and holdout custody,
// end to end through the CLI on encrypted sets built here with a throwaway
// key from dev-derived synthetic data (no workerd, no Cloudflare, no real
// holdout file):
//   1. `--change-kind cutoff` must be a truncation of the baseline, and the
//      rule applied is printed and recorded in the ledger;
//   2. holdout and SC5 verdicts refuse a baseline that is not their pin
//      (eval-v0 for SC5, the shipped ranker for a per-change look), the
//      ledger records the baseline's ranker sha, and
//      `--store-only` never overwrites a manifested run file;
//   3. every ciphertext a verdict reads is checked against MANIFEST.json.
// The `selftest` set keeps its ledger in its own directory. The SC5 tests run
// the CLI from a temporary shared clone, so the `test` set's fixed ledger is
// that clone's, never this checkout's eval/holdout-ledger.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from '../../eval/lib/crypto.mjs';
import { generateKey, readKey, updateManifest, verifyManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { ledgerRows, readLedger } from '../../eval/lib/ledger.mjs';
import { emptyCloneLedger, resetCloneLedger } from './clone.node.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { HASHED, treeHash } from '../../eval/lib/workspace.mjs';
import { archiveTree, labelRe, rankerAt, SHIPPED_PIN } from './pins.node.mjs';

const CLI = join(REPO, 'eval', 'cli.mjs');
const SET = 'selftest';
/** ADR 0003's pin, spelled out here rather than imported from the code under test. */
const PINNED_SHA = '7ac984174ded88cb2b6497d9835b456981acdd99';

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
/** @type {Buffer} */
let key;
/** treeHash of `git archive eval-v0` over the hashed ranker paths, computed independently. */
let v0Tree = '';
/** treeHash of the shipped pin's commit (ADR 0003's last shipped-pin line). */
let holdoutTree = '';
/** @type {string} */
let corpusSha;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-gate-custody-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
  key = await readKey(keyFile);
  const archive = join(tmp, 'eval-v0-archive');
  await mkdir(archive, { recursive: true });
  const present = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `eval-v0:${p}`], { cwd: REPO }).status === 0);
  const tar = spawnSync('git', ['archive', '--format=tar', 'eval-v0', '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
  expect(tar.status).toBe(0);
  expect(spawnSync('tar', ['-x', '-C', archive], { input: tar.stdout }).status).toBe(0);
  v0Tree = await treeHash(archive);
  holdoutTree = await archiveTree(SHIPPED_PIN.sha);
  corpusSha = JSON.parse(await readFile(join(REPO, 'eval', 'groups.json'), 'utf8')).corpus.moduleInfoSha256;
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

/** The ranker block of a genuine `--ref eval-v0` run. */
const pinnedRanker = () => ({ ref: 'eval-v0', sha: PINNED_SHA, dirty: false, treeHash: v0Tree, runner: { sha: PINNED_SHA, dirty: false } });
/** The ranker block of a genuine run of the shipped pin: the baseline of a per-change holdout look. */
const holdoutRanker = () => rankerAt(SHIPPED_PIN, holdoutTree);
const SHIPPED_LABEL = labelRe(SHIPPED_PIN);
const candRanker = () => ({ ref: 'WORKTREE', sha: 'c'.repeat(40), dirty: false, treeHash: 'd'.repeat(64), runner: { sha: 'c'.repeat(40), dirty: false } });

/** Grades of an answerable query's ten returned codes, best first. */
const GRADES = [2, 2, 1, 1, 1, 0, 0, 0, 0, 0];
const ANSWERABLE = 15;
const NO_ANSWER = 5;

/**
 * Dev-derived synthetic data: the first 20 dev query ids and texts (shapes,
 * filters and narratives dropped), 15 answerable with ten judged codes each
 * and 5 no-answer with three grade-0 codes each. Codes are made up, so no
 * duplicate group touches them.
 */
async function derived() {
  const dev = JSON.parse(await readFile(join(REPO, 'eval', 'dev', 'queries.json'), 'utf8'));
  const picked = dev.queries.slice(0, ANSWERABLE + NO_ANSWER);
  const queries = picked.map((/** @type {any} */ q, /** @type {number} */ i) => ({
    id: q.id, text: q.text, persona: q.persona, shapes: [i < ANSWERABLE ? 'topical' : 'noanswer'],
  }));
  const querySet = { schema: 'vnm-eval-queries/1', set: SET, version: 'derived-v1', queries };
  /** @type {Record<string, string[]>} codes best first */
  const ranked = {};
  /** @type {Record<string, { judgments: Record<string, number> }>} */
  const judged = {};
  queries.forEach((/** @type {any} */ q, /** @type {number} */ i) => {
    const n = i < ANSWERABLE ? GRADES.length : 3;
    ranked[q.id] = Array.from({ length: n }, (_, r) => `ZZ${String(i).padStart(2, '0')}R${r}`);
    judged[q.id] = { judgments: Object.fromEntries(ranked[q.id].map((c, r) => [c, i < ANSWERABLE ? GRADES[r] : 0])) };
  });
  const qrels = { schema: 'vnm-eval-qrels/1', set: SET, version: 'qrels-derived-v1', corpus: { moduleInfoSha256: corpusSha }, groups: [], queries: judged };
  return { querySet, qrels, ranked, answerable: queries.slice(0, ANSWERABLE).map((/** @type {any} */ q) => q.id), noAnswer: queries.slice(ANSWERABLE).map((/** @type {any} */ q) => q.id) };
}

/**
 * @param {any} querySet
 * @param {string} variant
 * @param {string} set
 * @param {any} ranker
 * @param {Record<string, string[]>} codes
 */
function runFile(querySet, variant, set, ranker, codes, config = { mode: 'hybrid', filters: true }) {
  return {
    schema: 'vnm-eval-run/1', variant, set, ranker,
    corpus: { moduleInfoSha256: corpusSha },
    queries: { version: querySet.version, sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'), count: querySet.queries.length },
    config,
    results: Object.fromEntries(Object.entries(codes).map(([id, c]) => [id, { status: 200, codes: c }])),
    docs: {},
  };
}

/** @param {Record<string, string[]>} codes */
const copy = (codes) => Object.fromEntries(Object.entries(codes).map(([id, c]) => [id, [...c]]));

/**
 * Writes an encrypted set: queries, qrels and the given runs, bound to `as`.
 * `manifest: false` leaves out MANIFEST.json.
 * @param {string} name
 * @param {{ base?: { ranker?: any, config?: any, codes?: (d: Awaited<ReturnType<typeof derived>>) => Record<string, string[]> }, cand: (d: Awaited<ReturnType<typeof derived>>) => Record<string, string[]>, qrels?: (q: any, d: Awaited<ReturnType<typeof derived>>) => void, as?: string, manifest?: boolean }} spec
 */
async function makeSet(name, spec) {
  const as = spec.as ?? SET;
  const dir = join(tmp, name);
  const d = await derived();
  spec.qrels?.(d.qrels, d);
  const base = runFile(d.querySet, 'base', as, spec.base?.ranker ?? (as === 'test' ? pinnedRanker() : holdoutRanker()), spec.base?.codes?.(d) ?? copy(d.ranked), spec.base?.config);
  const cand = runFile(d.querySet, 'cand', as, candRanker(), spec.cand(d));
  await writeEncryptedJson(join(dir, 'queries.json.enc'), d.querySet, key, as);
  await writeEncryptedJson(join(dir, 'qrels.json.enc'), d.qrels, key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-base.json.enc'), base, key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-cand.json.enc'), cand, key, as);
  if (spec.manifest !== false) await updateManifest(dir);
  return { dir, d };
}

/**
 * @param {string[]} args
 * @param {{ cli?: string, env?: Record<string, string> }} [options]
 */
function cli(args, options = {}) {
  const r = spawnSync(process.execPath, [options.cli ?? CLI, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, ...options.env, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} dir @param {string[]} [extra] */
const report = (dir, extra = []) => cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand', '--baseline', 'base', ...extra]);
/** @param {string} dir */
const ledgerOf = (dir) => join(dir, 'ledger.md');
/** Cells of every look row. @param {string} path */
const rowsOf = async (path) => (existsSync(path) ? ledgerRows(await readFile(path, 'utf8')) : []);
/** @param {string} cls */
const withheld = (cls) => `eval: ${SET} run failed (${cls}); details withheld\n`;

/** No-answer queries emptied; on two answerable queries the rank-5 relevant code swaps with rank 10. */
const reorderingCutoff = (/** @type {Awaited<ReturnType<typeof derived>>} */ d) => {
  const c = copy(d.ranked);
  for (const id of d.noAnswer) c[id] = [];
  for (const id of d.answerable.slice(0, 2)) [c[id][4], c[id][9]] = [c[id][9], c[id][4]];
  return c;
};
/** No-answer queries emptied; two answerable lists cut after rank 8 (a real truncation). */
const truncatingCutoff = (/** @type {Awaited<ReturnType<typeof derived>>} */ d) => {
  const c = copy(d.ranked);
  for (const id of d.noAnswer) c[id] = [];
  for (const id of d.answerable.slice(0, 2)) c[id] = c[id].slice(0, 8);
  return c;
};

describe('gap 1: a cutoff verdict needs a truncation, and the rule is recorded', () => {
  it('refuses --change-kind cutoff for a candidate that reorders, before counting a look; general still fails it', async () => {
    const { dir } = await makeSet('cutoff-reorders', { cand: reorderingCutoff });
    const general = report(dir, ['--change-kind', 'general']);
    expect(general.stderr).toBe('');
    expect(general.stdout).toMatch(new RegExp(`^holdout verdict: FAIL · rule general · baseline ${SHIPPED_LABEL} · qrels qrels-derived-v1$`, 'm'));
    const cutoff = report(dir, ['--change-kind', 'cutoff']);
    expect(cutoff.code).toBe(1);
    expect(`${cutoff.stdout}${cutoff.stderr}`).toBe(withheld('CutoffError'));
    const rows = await rowsOf(ledgerOf(dir));
    expect(rows).toHaveLength(1);
    expect(rows[0][5]).toBe('fail');
    expect(rows[0][8]).toBe('general');
  });

  it('a candidate that only truncates passes the cutoff rule; the printed verdict and the ledger name it', async () => {
    const { dir } = await makeSet('cutoff-truncates', { cand: truncatingCutoff });
    const r = report(dir, ['--change-kind', 'cutoff']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^holdout verdict: PASS · rule cutoff · baseline ${SHIPPED_LABEL} · qrels qrels-derived-v1$`, 'm'));
    const rows = await rowsOf(ledgerOf(dir));
    expect(rows.map((c) => [c[3], c[5], c[8]])).toEqual([['cand', 'pass', 'cutoff']]);
  });

  it('a targeted change is recorded with its targets', async () => {
    const { dir } = await makeSet('targeted', { cand: truncatingCutoff });
    const r = report(dir, ['--target-shapes', 'topical,noanswer']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(new RegExp(`^holdout verdict: (PASS|FAIL) · rule targeted: topical,noanswer · baseline ${SHIPPED_LABEL} · `, 'm'));
    expect((await rowsOf(ledgerOf(dir)))[0][8]).toBe('targeted: topical,noanswer');
  });

  it('`run --change-kind cutoff` on an encrypted set is refused before a look is reserved', async () => {
    const { dir } = await makeSet('cutoff-run', { cand: truncatingCutoff });
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'never', '--baseline', 'base', '--change-kind', 'cutoff']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--store-only, then .*eval:report .*--change-kind cutoff/);
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
    expect(existsSync(join(dir, 'runs', 'run-never.json.enc'))).toBe(false);
  });

  it('--change-kind cutoff takes no --target-shapes', async () => {
    const { dir } = await makeSet('cutoff-targets', { cand: truncatingCutoff });
    const r = report(dir, ['--change-kind', 'cutoff', '--target-shapes', 'topical']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/cutoff takes no --target-shapes/);
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('dev: a cutoff candidate that reorders is refused, and says why', async () => {
    const dir = join(tmp, 'dev-cutoff');
    await cp(join(REPO, 'eval', 'fixtures'), dir, { recursive: true });
    const d = await derived();
    await writeFile(join(dir, 'queries.json'), JSON.stringify({ ...d.querySet, set: 'fixture' }));
    await writeFile(join(dir, 'qrels.json'), JSON.stringify({ ...d.qrels, set: 'fixture' }));
    await writeFile(join(dir, 'base.json'), JSON.stringify(runFile(d.querySet, 'base', 'fixture', pinnedRanker(), copy(d.ranked))));
    await writeFile(join(dir, 'cand.json'), JSON.stringify(runFile(d.querySet, 'cand', 'fixture', candRanker(), reorderingCutoff(d))));
    const args = ['report', '--set', 'fixture', '--set-dir', dir, '--run', join(dir, 'cand.json'), '--baseline', join(dir, 'base.json')];
    const general = cli(args);
    expect(general.code).toBe(0);
    expect(general.stdout).toMatch(/^gate \(dev\): FAIL · rule general$/m);
    const r = cli([...args, '--change-kind', 'cutoff']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^eval: --change-kind cutoff: candidate cand is not a truncation of baseline base on 2 of 20 queries/);
    expect(r.stdout).not.toMatch(/gate \(dev\)/);
  });
});

describe('gap 2: holdout and SC5 verdicts refuse a baseline that is not their pin', () => {
  /** Top-10s worst first: the baseline a forger wants. */
  const reversed = (/** @type {Awaited<ReturnType<typeof derived>>} */ d) => Object.fromEntries(Object.entries(copy(d.ranked)).map(([id, c]) => [id, c.reverse()]));

  it('refuses a baseline with an all-zero ranker sha and reversed top-10s; no look is recorded', async () => {
    const { dir } = await makeSet('forged-sha', { base: { ranker: { ...holdoutRanker(), sha: '0'.repeat(40) }, codes: reversed }, cand: (d) => copy(d.ranked) });
    const r = report(dir);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('BaselineError'));
    expect(r.code).toBe(1);
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it.each([
    ['a ranker ref other than the pin\'s', { ref: 'WORKTREE' }],
    ['a dirty ranker', { dirty: true }],
    ['a treeHash that is not the pin\'s', { treeHash: 'e'.repeat(64) }],
    ['no treeHash', { treeHash: undefined }],
  ])('refuses %s', async (_, edit) => {
    const { dir } = await makeSet(`forged-${Object.keys(edit)[0]}`, { base: { ranker: { ...holdoutRanker(), ...edit } }, cand: (d) => copy(d.ranked) });
    const r = report(dir);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('BaselineError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it.each([
    ['an unfiltered run of the pin', { config: { mode: 'hybrid', filters: false } }, 'BaselineError'],
    ['a lexical-mode run of the pin', { config: { mode: 'lexical', filters: true } }, 'RunFileError'], // a pool variant, refused first
    ['a run made by a dirty runner', { ranker: { ...holdoutRanker(), runner: { sha: SHIPPED_PIN.sha, dirty: true } } }, 'BaselineError'],
  ])('refuses %s as the baseline', async (_, base, error) => {
    const { dir } = await makeSet(`forged-${_.replace(/\W+/g, '-')}`, { base, cand: (d) => copy(d.ranked) });
    const r = report(dir);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld(error));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('`run` refuses a forged baseline before reserving a look', async () => {
    const { dir } = await makeSet('forged-run', { base: { ranker: { ...holdoutRanker(), sha: '0'.repeat(40) } }, cand: (d) => copy(d.ranked) });
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'never', '--baseline', 'base']);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('BaselineError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('the ledger row records the baseline ranker sha', async () => {
    const { dir } = await makeSet('pinned', { cand: truncatingCutoff });
    const r = report(dir);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const rows = await rowsOf(ledgerOf(dir));
    expect(rows.map((c) => [c[2], c[3], c[4], c[9]])).toEqual([['ccccccc', 'cand', 'base', SHIPPED_PIN.sha.slice(0, 7)]]);
  });

  describe('SC5 (the test set), from a temporary clone so its fixed ledger is the clone\'s', () => {
    /** @type {string} */
    let clone;
    /** @type {string} */
    let cloneCli;
    beforeAll(async () => {
      clone = join(tmp, 'clone');
      expect(spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', REPO, clone]).status).toBe(0);
      expect(spawnSync('git', ['checkout', '--quiet', 'HEAD'], { cwd: clone }).status).toBe(0);
      // The code under test is this checkout's working tree.
      for (const p of ['eval/cli.mjs', 'eval/lib', 'eval/groups.json', 'scripts']) {
        await rm(join(clone, p), { recursive: true, force: true });
        await cp(join(REPO, p), join(clone, p), { recursive: true });
      }
      emptyCloneLedger(clone);
      cloneCli = join(clone, 'eval', 'cli.mjs');
    });
    const cloneLedger = () => join(clone, 'eval', 'holdout-ledger.md');
    /** @param {string} dir @param {Record<string, string>} [env] */
    const sc5 = (dir, env) => cli(['report', '--set', 'test', '--set-dir', dir, '--run', 'cand', '--baseline', 'base'], { cli: cloneCli, env });

    it('refuses a forged eval-v0 baseline on the test set; no look is recorded', async () => {
      const { dir } = await makeSet('sc5-forged', { as: 'test', base: { ranker: { ...pinnedRanker(), sha: '0'.repeat(40) }, codes: reversed }, cand: (d) => copy(d.ranked) });
      const r = sc5(dir);
      expect(`${r.stdout}${r.stderr}`).toBe('eval: test run failed (BaselineError); details withheld\n');
      expect(await readLedger(cloneLedger())).toHaveLength(0);
    });

    it('a genuine eval-v0 baseline gets a verdict', async () => {
      const { dir } = await makeSet('sc5-genuine', { as: 'test', cand: (d) => copy(d.ranked) });
      const r = sc5(dir);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/^test verdict: FAIL · rule sc5 · baseline eval-v0 7ac9841 · qrels qrels-derived-v1$/m);
      const rows = await rowsOf(cloneLedger());
      expect(rows.map((c) => [c[1], c[8], c[9]])).toEqual([['test', 'sc5', '7ac9841']]);
      // Restore the clone's ledger for the next test (one test-set look only).
      resetCloneLedger(clone);
    });

    it('refuses when the eval-v0 tag no longer resolves to the pinned commit', async () => {
      expect(spawnSync('git', ['-c', 'tag.gpgsign=false', 'tag', '-f', 'eval-v0', 'HEAD'], { cwd: clone }).status).toBe(0);
      const { dir } = await makeSet('sc5-moved-tag', { as: 'test', cand: (d) => copy(d.ranked) });
      const r = sc5(dir);
      expect(`${r.stdout}${r.stderr}`).toBe('eval: test run failed (BaselineError); details withheld\n');
      expect(await readLedger(cloneLedger())).toHaveLength(0);
    });
  });
});

describe('gap 2: a stored encrypted run is never overwritten without a logged retirement', () => {
  it('--store-only refuses a run file the manifest already lists, before any retrieval', async () => {
    const { dir } = await makeSet('store-overwrite', { cand: (d) => copy(d.ranked) });
    const before = await readFile(join(dir, 'runs', 'run-base.json.enc'));
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'base', '--ref', 'eval-v0', '--store-only']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs\/run-base\.json\.enc is already in .*MANIFEST\.json.*retire-run/s);
    expect(r.stdout).not.toMatch(/ranker/); // the runner never started
    expect(await readFile(join(dir, 'runs', 'run-base.json.enc'))).toEqual(before);
  });

  it('--store-only refuses a manifested run even after its file was deleted', async () => {
    const { dir } = await makeSet('store-deleted', { cand: (d) => copy(d.ranked) });
    await rm(join(dir, 'runs', 'run-base.json.enc'));
    const manifestBefore = await readFile(join(dir, 'MANIFEST.json'), 'utf8');
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'base', '--ref', 'eval-v0', '--store-only']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs\/run-base\.json\.enc is already in .*MANIFEST\.json.*retire-run/s);
    expect(await readFile(join(dir, 'MANIFEST.json'), 'utf8')).toBe(manifestBefore);
  });

  it('a look run cannot overwrite a manifested run file either', async () => {
    const { dir } = await makeSet('look-overwrite', { cand: (d) => copy(d.ranked) });
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'cand', '--baseline', 'base']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/runs\/run-cand\.json\.enc is already in .*retire-run/s);
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('retire-run needs a reason, logs the retired sha256 and removes the file from the manifest', async () => {
    const { dir } = await makeSet('retire', { cand: (d) => copy(d.ranked) });
    const file = join(dir, 'runs', 'run-base.json.enc');
    const sha = createHash('sha256').update(await readFile(file)).digest('hex');
    const noReason = cli(['retire-run', '--set', SET, '--set-dir', dir, '--variant', 'base']);
    expect(noReason.code).toBe(1);
    expect(noReason.stderr).toMatch(/--reason/);
    expect(existsSync(file)).toBe(true);

    const r = cli(['retire-run', '--set', SET, '--set-dir', dir, '--variant', 'base', '--reason', 'rebuilt after the runner fix']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(file)).toBe(false);
    const manifest = JSON.parse(await readFile(join(dir, 'MANIFEST.json'), 'utf8'));
    expect(Object.keys(manifest.files).sort()).toEqual(['qrels.json.enc', 'queries.json.enc', 'runs/run-cand.json.enc']);
    const log = ledgerRows(await readFile(join(dir, 'retired-runs.md'), 'utf8'));
    expect(log.map((c) => c.slice(1))).toEqual([[SET, 'runs/run-base.json.enc', sha, 'rebuilt after the runner fix']]);
    // Retiring is not a look.
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
    // A file absent from the manifest has nothing to retire.
    expect(cli(['retire-run', '--set', SET, '--set-dir', dir, '--variant', 'base', '--reason', 'again']).stderr).toMatch(/not in .*MANIFEST\.json/);
  });

  it('recording a new run in the manifest leaves a tampered ciphertext flagged (updateManifest would hide it)', async () => {
    const { dir } = await makeSet('record-one', { cand: (d) => copy(d.ranked) });
    const q = await readFile(join(dir, 'queries.json.enc'));
    q[q.length - 1] ^= 1;
    await writeFile(join(dir, 'queries.json.enc'), q);
    await writeEncryptedJson(join(dir, 'runs', 'run-new.json.enc'), { variant: 'new' }, key, SET);
    await /** @type {any} */ (crypto).recordInManifest(dir, [join(dir, 'runs', 'run-new.json.enc')]);
    const problems = await verifyManifest(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/queries\.json\.enc sha256 .* != manifest/);
  });
});

describe('gap 3: every ciphertext a verdict reads matches MANIFEST.json', () => {
  /** Two queries' rank-1 grade 2 becomes 0 (and rank 10 becomes 2), enough to flip the verdict. */
  const regrade = (/** @type {any} */ q, /** @type {Awaited<ReturnType<typeof derived>>} */ d) => {
    for (const id of d.answerable.slice(0, 2)) {
      const [first, , , , , , , , , last] = d.ranked[id];
      q.queries[id].judgments[first] = 0;
      q.queries[id].judgments[last] = 2;
    }
  };
  /** The candidate moves rank 10 to the top on the first two answerable queries. */
  const promoteLast = (/** @type {Awaited<ReturnType<typeof derived>>} */ d) => {
    const c = copy(d.ranked);
    for (const id of d.answerable.slice(0, 2)) c[id] = [c[id][9], ...c[id].slice(0, 9)];
    return c;
  };

  it('refuses a --set-dir with no MANIFEST.json, whatever its qrels say; no look is counted', async () => {
    for (const [name, qrels] of /** @type {const} */ ([['no-manifest-a', undefined], ['no-manifest-b', regrade]])) {
      const { dir } = await makeSet(name, { cand: promoteLast, qrels, manifest: false });
      const r = report(dir);
      expect(`${r.stdout}${r.stderr}`).toBe(withheld('ManifestError'));
      expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
    }
  });

  it('refuses qrels re-encrypted after the manifest was written', async () => {
    const { dir, d } = await makeSet('swapped-qrels', { cand: promoteLast });
    regrade(d.qrels, d);
    await writeEncryptedJson(join(dir, 'qrels.json.enc'), d.qrels, key, SET);
    const r = report(dir);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('ManifestError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('refuses a run file the manifest does not list', async () => {
    const { dir } = await makeSet('unlisted-run', { cand: promoteLast });
    await cp(join(dir, 'runs', 'run-cand.json.enc'), join(dir, 'runs', 'run-cand2.json.enc'));
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', 'cand2', '--baseline', 'base']);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('ManifestError'));
  });

  it('refuses a run file outside the set directory', async () => {
    const { dir } = await makeSet('outside-run', { cand: promoteLast });
    const outside = join(tmp, 'elsewhere', 'run-cand.json.enc');
    await mkdir(join(tmp, 'elsewhere'), { recursive: true });
    await cp(join(dir, 'runs', 'run-cand.json.enc'), outside);
    const r = cli(['report', '--set', SET, '--set-dir', dir, '--run', outside, '--baseline', 'base']);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('ManifestError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('`run` refuses a manifest mismatch before reserving a look', async () => {
    const { dir, d } = await makeSet('run-mismatch', { cand: promoteLast });
    regrade(d.qrels, d);
    await writeEncryptedJson(join(dir, 'qrels.json.enc'), d.qrels, key, SET);
    const r = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'never', '--baseline', 'base']);
    expect(`${r.stdout}${r.stderr}`).toBe(withheld('ManifestError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('a matching manifest gets a verdict', async () => {
    const { dir } = await makeSet('manifest-ok', { cand: promoteLast });
    const r = report(dir);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^holdout verdict: (PASS|FAIL) · rule general · /m);
  });
});

describe('the shipped-ranker pin, in a temporary clone whose SHIPPED_BASELINE is another commit', () => {
  /** @type {string} */
  let clone;
  /** @type {string} */
  let cloneCli;
  /** This checkout's HEAD stands in for a later shipped ranker, pinned by plain sha. */
  let shippedSha = '';
  let shippedTree = '';
  const shippedRanker = () => ({ ref: shippedSha, sha: shippedSha, dirty: false, treeHash: shippedTree, runner: { sha: shippedSha, dirty: false } });
  beforeAll(async () => {
    shippedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
    expect(shippedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(shippedSha).not.toBe(PINNED_SHA);
    const archive = join(tmp, 'shipped-archive');
    await mkdir(archive, { recursive: true });
    const present = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `${shippedSha}:${p}`], { cwd: REPO }).status === 0);
    const tar = spawnSync('git', ['archive', '--format=tar', shippedSha, '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
    expect(tar.status).toBe(0);
    expect(spawnSync('tar', ['-x', '-C', archive], { input: tar.stdout }).status).toBe(0);
    shippedTree = await treeHash(archive);
    expect(shippedTree).not.toBe(v0Tree);

    clone = join(tmp, 'clone-shipped');
    expect(spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', REPO, clone]).status).toBe(0);
    expect(spawnSync('git', ['checkout', '--quiet', 'HEAD'], { cwd: clone }).status).toBe(0);
    for (const p of ['eval/cli.mjs', 'eval/lib', 'eval/groups.json', 'scripts']) {
      await rm(join(clone, p), { recursive: true, force: true });
      await cp(join(REPO, p), join(clone, p), { recursive: true });
    }
    emptyCloneLedger(clone);
    const baseline = join(clone, 'eval', 'lib', 'baseline.mjs');
    const src = await readFile(baseline, 'utf8');
    const line = /^export const SHIPPED_BASELINE = Object\.freeze\(\{ ref: '[^']+', sha: '[0-9a-f]{40}' \}\);$/m;
    expect(src).toMatch(line);
    await writeFile(baseline, src.replace(line, `export const SHIPPED_BASELINE = Object.freeze({ ref: '${shippedSha}', sha: '${shippedSha}' });`));
    cloneCli = join(clone, 'eval', 'cli.mjs');
  });
  /** @param {string} dir @param {string} [set] */
  const look = (dir, set = SET) => cli(['report', '--set', set, '--set-dir', dir, '--run', 'cand', '--baseline', 'base'], { cli: cloneCli });

  it('a per-change holdout look refuses an eval-v0 baseline (report and run), before any look', async () => {
    const { dir } = await makeSet('shipped-v0-base', { base: { ranker: pinnedRanker() }, cand: (d) => copy(d.ranked) });
    expect(`${look(dir).stdout}${look(dir).stderr}`).toBe(withheld('BaselineError'));
    const run = cli(['run', '--set', SET, '--set-dir', dir, '--variant', 'never', '--baseline', 'base'], { cli: cloneCli });
    expect(`${run.stdout}${run.stderr}`).toBe(withheld('BaselineError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('a per-change holdout look takes a genuine shipped baseline; the verdict names it and the ledger records its sha', async () => {
    const { dir } = await makeSet('shipped-genuine', { base: { ranker: shippedRanker() }, cand: (d) => copy(d.ranked) });
    const r = look(dir);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(new RegExp(`^holdout verdict: PASS · rule general · baseline ${shippedSha.slice(0, 7)} · qrels qrels-derived-v1$`, 'm'));
    expect((await rowsOf(ledgerOf(dir))).map((c) => [c[8], c[9]])).toEqual([['general', shippedSha.slice(0, 7)]]);
  });

  it.each([
    ['a dirty ranker', { dirty: true }],
    ['a dirty runner', { runner: { sha: 'x', dirty: true } }],
    ['another treeHash', { treeHash: 'e'.repeat(64) }],
    ['another sha', { sha: PINNED_SHA }],
  ])('refuses a shipped baseline with %s', async (_, edit) => {
    const { dir } = await makeSet(`shipped-forged-${Object.keys(edit)[0]}`, { base: { ranker: { ...shippedRanker(), ...edit } }, cand: (d) => copy(d.ranked) });
    expect(`${look(dir).stdout}${look(dir).stderr}`).toBe(withheld('BaselineError'));
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it.each([
    ['unfiltered', { mode: 'hybrid', filters: false }],
    ['lexical', { mode: 'lexical', filters: true }],
  ])('refuses a %s run of the shipped ranker', async (name, config) => {
    const { dir } = await makeSet(`shipped-config-${name}`, { base: { ranker: shippedRanker(), config }, cand: (d) => copy(d.ranked) });
    const r = look(dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(await rowsOf(ledgerOf(dir))).toHaveLength(0);
  });

  it('the SC5 baseline stays eval-v0: the test set takes an eval-v0 baseline and refuses the shipped one', async () => {
    const cloneLedger = join(clone, 'eval', 'holdout-ledger.md');
    const shipped = await makeSet('shipped-sc5-shipped', { as: 'test', base: { ranker: shippedRanker() }, cand: (d) => copy(d.ranked) });
    const refused = look(shipped.dir, 'test');
    expect(`${refused.stdout}${refused.stderr}`).toBe('eval: test run failed (BaselineError); details withheld\n');
    expect(await readLedger(cloneLedger)).toHaveLength(0);
    const v0 = await makeSet('shipped-sc5-v0', { as: 'test', cand: (d) => copy(d.ranked) });
    const r = look(v0.dir, 'test');
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^test verdict: FAIL · rule sc5 · baseline eval-v0 7ac9841 · qrels qrels-derived-v1$/m);
    resetCloneLedger(clone);
  });
});
