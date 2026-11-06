// @ts-check
// `npm run eval:count` (docs/plans/phase3.md §3 P-5b, A3-1, A-N9): the
// custodian-only count tool. It prints one integer, logs each call in
// eval/count-log.md, and is not a look: the ledger never reads the count log,
// and a count-log row in the ledger is refused as tampering.
// Every test runs the tool from a temporary shared clone, so the holdout and
// test sets' fixed ledger and count log are the clone's, never this
// checkout's. Sets are built here from dev-derived synthetic data with a
// throwaway key; no real holdout file is read.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKey, readKey, updateManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { assertLookAllowed, ledgerRows, looks } from '../../eval/lib/ledger.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { HASHED, treeHash } from '../../eval/lib/workspace.mjs';

const PINNED_SHA = '7ac984174ded88cb2b6497d9835b456981acdd99';
const ANSWERABLE = 12;
const TAGGED = 4;
const UNSCORED = 4;
const GRADES = [2, 2, 1, 1, 1, 0, 0, 0, 0, 0];

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
/** @type {Buffer} */
let key;
/** @type {string} */
let clone;
/** @type {string} */
let corpusSha;
let v0Tree = '';

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-count-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
  key = await readKey(keyFile);
  corpusSha = JSON.parse(await readFile(join(REPO, 'eval', 'groups.json'), 'utf8')).corpus.moduleInfoSha256;
  const archive = join(tmp, 'eval-v0-archive');
  await mkdir(archive, { recursive: true });
  const present = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `eval-v0:${p}`], { cwd: REPO }).status === 0);
  const tar = spawnSync('git', ['archive', '--format=tar', 'eval-v0', '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
  expect(spawnSync('tar', ['-x', '-C', archive], { input: tar.stdout }).status).toBe(0);
  v0Tree = await treeHash(archive);
  clone = join(tmp, 'clone');
  expect(spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', REPO, clone]).status).toBe(0);
  expect(spawnSync('git', ['checkout', '--quiet', 'HEAD'], { cwd: clone }).status).toBe(0);
  // The code under test is this checkout's working tree.
  for (const p of ['eval/cli.mjs', 'eval/count.mjs', 'eval/lib', 'eval/groups.json', 'eval/holdout-ledger.md', 'eval/count-log.md', 'scripts']) {
    await rm(join(clone, p), { recursive: true, force: true });
    if (existsSync(join(REPO, p))) await cp(join(REPO, p), join(clone, p), { recursive: true });
  }
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const cloneLedger = () => join(clone, 'eval', 'holdout-ledger.md');
const cloneCountLog = () => join(clone, 'eval', 'count-log.md');
beforeEach(async () => {
  await cp(join(REPO, 'eval', 'holdout-ledger.md'), cloneLedger());
  await rm(cloneCountLog(), { force: true });
  if (existsSync(join(REPO, 'eval', 'count-log.md'))) await cp(join(REPO, 'eval', 'count-log.md'), cloneCountLog());
});

/** As gate-rules.node.test.js: 12 answerable, 4 tagged `noanswer` (one with a grade-2 code), 4 unscored. */
async function derived() {
  const dev = JSON.parse(await readFile(join(REPO, 'eval', 'dev', 'queries.json'), 'utf8'));
  const picked = dev.queries.slice(0, ANSWERABLE + TAGGED + UNSCORED);
  const kind = (/** @type {number} */ i) => (i < ANSWERABLE ? 'answerable' : i < ANSWERABLE + TAGGED ? 'tagged' : 'unscored');
  const queries = picked.map((/** @type {any} */ q, /** @type {number} */ i) => ({ id: q.id, text: q.text, persona: q.persona, shapes: [kind(i) === 'tagged' ? 'noanswer' : 'topical'] }));
  /** @type {Record<string, string[]>} */
  const ranked = {};
  /** @type {Record<string, { judgments: Record<string, number> }>} */
  const judged = {};
  queries.forEach((/** @type {any} */ q, /** @type {number} */ i) => {
    const n = kind(i) === 'answerable' ? GRADES.length : 3;
    ranked[q.id] = Array.from({ length: n }, (_, r) => `ZZ${String(i).padStart(2, '0')}R${r}`);
    judged[q.id] = { judgments: Object.fromEntries(ranked[q.id].map((c, r) => [c, kind(i) === 'answerable' ? GRADES[r] : 0])) };
  });
  judged[queries[ANSWERABLE].id].judgments.ZZTAGGED = 2;
  const ids = queries.map((/** @type {any} */ q) => q.id);
  return {
    querySet: { schema: 'vnm-eval-queries/1', set: 'x', version: 'derived-v1', queries },
    qrels: { schema: 'vnm-eval-qrels/1', set: 'x', version: 'qrels-derived-v1', corpus: { moduleInfoSha256: corpusSha }, groups: [], queries: judged },
    ranked, answerable: ids.slice(0, ANSWERABLE), tagged: ids.slice(ANSWERABLE, ANSWERABLE + TAGGED), unscored: ids.slice(ANSWERABLE + TAGGED),
  };
}
/** @typedef {Awaited<ReturnType<typeof derived>>} Derived */

/** @param {Derived} d @param {string} variant @param {any} ranker @param {Record<string, string[]>} codes */
const runOf = (d, variant, ranker, codes) => ({
  schema: 'vnm-eval-run/1', variant, set: 'x', ranker,
  corpus: { moduleInfoSha256: corpusSha },
  queries: { version: d.querySet.version, sha256: createHash('sha256').update(JSON.stringify(d.querySet.queries)).digest('hex'), count: d.querySet.queries.length },
  config: { mode: 'hybrid', filters: true },
  results: Object.fromEntries(Object.entries(codes).map(([id, c]) => [id, { status: 200, codes: c }])),
  docs: {},
});

/** The candidate empties 2 answerable, 1 unscored and 2 tagged queries, and errors on 1 more answerable one. */
const emptying = (/** @type {Derived} */ d) => {
  const c = Object.fromEntries(Object.entries(d.ranked).map(([id, x]) => [id, [...x]]));
  for (const id of [...d.answerable.slice(0, 2), d.unscored[0], ...d.tagged.slice(0, 2)]) c[id] = [];
  return c;
};

/** @param {string} name @param {string} as */
async function encSet(name, as) {
  const dir = join(tmp, name);
  const d = await derived();
  await writeEncryptedJson(join(dir, 'queries.json.enc'), { ...d.querySet, set: as }, key, as);
  await writeEncryptedJson(join(dir, 'qrels.json.enc'), { ...d.qrels, set: as }, key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-base.json.enc'), runOf(d, 'base', { ref: 'eval-v0', sha: PINNED_SHA, dirty: false, treeHash: v0Tree, runner: { sha: PINNED_SHA, dirty: false } }, d.ranked), key, as);
  const cand = runOf(d, 'cand', { ref: 'WORKTREE', sha: 'c'.repeat(40), dirty: false, treeHash: 'd'.repeat(64) }, emptying(d));
  cand.results[d.answerable[2]] = { status: 500, codes: [] };
  await writeEncryptedJson(join(dir, 'runs', 'run-cand.json.enc'), cand, key, as);
  await updateManifest(dir);
  return { dir, d };
}

/** @param {string[]} args */
function count(args) {
  const r = spawnSync(process.execPath, [join(clone, 'eval', 'count.mjs'), ...args], { cwd: clone, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} path */
const rowsOf = async (path) => (existsSync(path) ? ledgerRows(await readFile(path, 'utf8')) : []);
const today = () => new Date().toISOString().slice(0, 10);

describe('eval:count prints one integer and logs the call', () => {
  it('--set test --answerable: the primary answerable count; tagged and unscored queries are not counted', async () => {
    const { dir } = await encSet('test-answerable', 'test');
    const ledgerBefore = await readFile(cloneLedger(), 'utf8');
    const looksBefore = await looks(cloneLedger(), 'test');
    const r = count(['--custodian', '--set', 'test', '--set-dir', dir, '--answerable']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${ANSWERABLE}\n`);
    expect(await rowsOf(cloneCountLog())).toEqual([[today(), 'test', 'count: answerable', '—', String(ANSWERABLE)]]);
    // Not a look: the ledger is byte-for-byte unchanged.
    expect(await readFile(cloneLedger(), 'utf8')).toBe(ledgerBefore);
    expect(await looks(cloneLedger(), 'test')).toBe(looksBefore);
  });

  it('--holdout --emptied-untagged --run: untagged queries the stored run returns empty (an error is not empty)', async () => {
    const { dir } = await encSet('holdout-emptied', 'holdout');
    const looksBefore = await looks(cloneLedger(), 'holdout');
    const r = count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('3\n');
    expect(await rowsOf(cloneCountLog())).toEqual([[today(), 'holdout', 'count: emptied-untagged', 'cand', '3']]);
    expect(await looks(cloneLedger(), 'holdout')).toBe(looksBefore);
    // A second call appends a second row.
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'base']).stdout).toBe('0\n');
    expect((await rowsOf(cloneCountLog())).map((c) => c[3])).toEqual(['cand', 'base']);
  });

  it('the self-test set logs beside its own ledger', async () => {
    const { dir } = await encSet('selftest-emptied', 'selftest');
    const r = count(['--custodian', '--set', 'selftest', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']);
    expect(r.stdout).toBe('3\n');
    expect(await rowsOf(join(dir, 'count-log.md'))).toHaveLength(1);
    expect(await rowsOf(cloneCountLog())).toHaveLength(0);
  });
});

describe('eval:count refuses, printing nothing on stdout and logging nothing', () => {
  /** @type {string} */
  let testDir;
  /** @type {string} */
  let holdoutDir;
  beforeAll(async () => {
    testDir = (await encSet('refuse-test', 'test')).dir;
    holdoutDir = (await encSet('refuse-holdout', 'holdout')).dir;
  });

  /** @param {string[]} args @param {RegExp} why */
  const refused = async (args, why) => {
    const r = count(args);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(why);
    expect(await rowsOf(cloneCountLog())).toHaveLength(0);
  };

  it('without --custodian', async () => {
    await refused(['--set', 'test', '--set-dir', testDir, '--answerable'], /^eval:count: refusing without --custodian/);
    await refused(['--holdout', '--set-dir', holdoutDir, '--emptied-untagged', '--run', 'cand'], /^eval:count: refusing without --custodian/);
  });

  it('on dev, the fixture, or with no set named', async () => {
    await refused(['--custodian', '--set', 'dev', '--answerable'], /^eval:count: the dev set is open/);
    await refused(['--custodian', '--set', 'fixture', '--answerable'], /^eval:count: the fixture set is open/);
    await refused(['--custodian', '--answerable'], /^eval:count: name the set: --set test or --holdout/);
  });

  it.each([
    [['--json', 'out.json']],
    [['--baseline', 'base']],
    [['--qrels', 'q.json']],
    [['--out', 'x']],
    [['--ids']],
    [['--verbose']],
    [['--change-kind', 'general']],
    [['report']],
  ])('with %j, which could print ids or metrics', async (extra) => {
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--emptied-untagged', '--run', 'cand', ...extra], /^eval:count: .*eval:count takes only --custodian, --set, --holdout, --set-dir, --answerable, --emptied-untagged and --run/);
  });

  it('without exactly one count, or with a count the set does not have', async () => {
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir], /exactly one of --answerable or --emptied-untagged/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--answerable', '--emptied-untagged', '--run', 'cand'], /exactly one of --answerable or --emptied-untagged/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--answerable'], /--answerable counts the test set only/);
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir, '--emptied-untagged', '--run', 'cand'], /--emptied-untagged counts the holdout only/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--emptied-untagged'], /--emptied-untagged needs --run <variant>/);
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir, '--answerable', '--run', 'cand'], /--answerable takes no --run/);
  });

  it('a ciphertext the manifest does not match: withheld, and no row', async () => {
    const { dir, d } = await encSet('tampered', 'test');
    const forged = { ...d.qrels, set: 'test' };
    for (const id of d.unscored) forged.queries[id].judgments.ZZFORGED = 2;
    await writeEncryptedJson(join(dir, 'qrels.json.enc'), forged, key, 'test');
    await refused(['--custodian', '--set', 'test', '--set-dir', dir, '--answerable'], /^eval: test count failed \(ManifestError\); details withheld\n$/);
  });

  it('a run over other queries: withheld, and no row', async () => {
    const { dir, d } = await encSet('other-queries', 'holdout');
    const other = runOf({ ...d, querySet: { ...d.querySet, version: 'other' } }, 'other', {}, d.ranked);
    other.queries.sha256 = '0'.repeat(64);
    await writeEncryptedJson(join(dir, 'runs', 'run-other.json.enc'), other, key, 'holdout');
    await updateManifest(dir);
    await refused(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'other'], /^eval: holdout count failed \(RunFileError\); details withheld\n$/);
  });
});

describe('a count is never a look', () => {
  it('a count-log row placed in the ledger is refused as tampering, and no look can be taken past it', async () => {
    const { dir } = await encSet('count-into-ledger', 'holdout');
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']).stdout).toBe('3\n');
    const row = (await readFile(cloneCountLog(), 'utf8')).split('\n').filter((l) => l.includes('count: emptied-untagged'))[0];
    expect(row).toBeTruthy();
    await appendFile(cloneLedger(), `${row}\n`);
    await expect(assertLookAllowed(cloneLedger(), 'holdout', 12, { repo: clone })).rejects.toThrow(/count-log row .* counts are not looks/);
    const r = spawnSync(process.execPath, [join(clone, 'eval', 'cli.mjs'), 'report', '--holdout', '--set-dir', dir, '--run', 'cand', '--baseline', 'base'], { cwd: clone, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile } });
    expect(`${r.stdout}${r.stderr}`).toBe('eval: holdout run failed (LedgerTamperError); details withheld\n');
  });

  it('with the count log restored to the ledger, the look count is what it was before the counts', async () => {
    const { dir } = await encSet('count-no-look', 'holdout');
    const before = await looks(cloneLedger(), 'holdout');
    for (let i = 0; i < 3; i++) expect(count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']).code).toBe(0);
    expect(await rowsOf(cloneCountLog())).toHaveLength(3);
    expect(await looks(cloneLedger(), 'holdout')).toBe(before);
    await expect(assertLookAllowed(cloneLedger(), 'holdout', 12, { repo: clone })).resolves.toBe(before);
  });

  it('the committed count log is a separate file from the ledger, with its own header', async () => {
    const log = await readFile(join(REPO, 'eval', 'count-log.md'), 'utf8');
    expect(log).toMatch(/^# Count log\n/);
    expect(log).toContain('| date | set | kind | run | count |');
    expect(ledgerRows(log)).toEqual([]);
  });
});
