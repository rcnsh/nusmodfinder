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
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // The committed log's header, without its real rows: each test starts from an empty log.
  if (existsSync(join(REPO, 'eval', 'count-log.md'))) {
    const log = await readFile(join(REPO, 'eval', 'count-log.md'), 'utf8');
    const header = log.slice(0, log.indexOf('|---|'));
    const columns = (header.trim().split('\n').pop()?.match(/\|/g)?.length ?? 6) - 1;
    await writeFile(cloneCountLog(), `${header}|${'---|'.repeat(columns)}\n`);
  }
});

/**
 * As gate-rules.node.test.js: 12 answerable, 4 tagged `noanswer` (the first with a grade-2
 * code, so answerable: 13 primary answerable, 3 no-answer), 4 unscored.
 */
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
  it('--set test --answerable: the primary answerable count, the tagged query with a grade-2 code included; no-answer and unscored queries are not', async () => {
    const { dir } = await encSet('test-answerable', 'test');
    const ledgerBefore = await readFile(cloneLedger(), 'utf8');
    const looksBefore = await looks(cloneLedger(), 'test');
    const r = count(['--custodian', '--set', 'test', '--set-dir', dir, '--answerable']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${ANSWERABLE + 1}\n`);
    expect(await rowsOf(cloneCountLog())).toEqual([[today(), 'test', 'count: answerable', '—', String(ANSWERABLE + 1), '—']]);
    // Not a look: the ledger is byte-for-byte unchanged.
    expect(await readFile(cloneLedger(), 'utf8')).toBe(ledgerBefore);
    expect(await looks(cloneLedger(), 'test')).toBe(looksBefore);
  });

  it('--holdout --emptied-untagged --run: queries outside the no-answer set the stored run returns empty, a tagged query with a grade-≥1 document included (an error is not empty)', async () => {
    const { dir } = await encSet('holdout-emptied', 'holdout');
    const looksBefore = await looks(cloneLedger(), 'holdout');
    const r = count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('4\n');
    expect(await rowsOf(cloneCountLog())).toEqual([[today(), 'holdout', 'count: emptied-untagged', 'cand', '4', '—']]);
    expect(await looks(cloneLedger(), 'holdout')).toBe(looksBefore);
    // A second call appends a second row.
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'base']).stdout).toBe('0\n');
    expect((await rowsOf(cloneCountLog())).map((c) => c[3])).toEqual(['cand', 'base']);
  });

  it('--holdout --lists-differing --run --baseline: queries whose stored lists (status and codes, in order) differ between the two runs', async () => {
    const { dir, d } = await encSet('holdout-differing', 'holdout');
    const looksBefore = await looks(cloneLedger(), 'holdout');
    // cand empties 5 lists and errors on a 6th; a reorder alone also counts.
    const r = count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'cand', '--baseline', 'base']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('6\n');
    expect(await rowsOf(cloneCountLog())).toEqual([[today(), 'holdout', 'count: lists-differing', 'cand vs base', '6', '—']]);
    expect(await looks(cloneLedger(), 'holdout')).toBe(looksBefore);
    // A run against itself, and a byte-identical copy under another name: 0.
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'base', '--baseline', 'base']).stdout).toBe('0\n');
    const same = runOf(d, 'same', { ref: 'x', sha: 'e'.repeat(40), dirty: false, treeHash: 'f'.repeat(64) }, d.ranked);
    const swapped = runOf(d, 'swapped', { ref: 'x', sha: 'e'.repeat(40), dirty: false, treeHash: 'f'.repeat(64) }, d.ranked);
    const first = d.answerable[0];
    swapped.results[first] = { status: 200, codes: [...d.ranked[first]].reverse() };
    await writeEncryptedJson(join(dir, 'runs', 'run-same.json.enc'), same, key, 'holdout');
    await writeEncryptedJson(join(dir, 'runs', 'run-swapped.json.enc'), swapped, key, 'holdout');
    await updateManifest(dir);
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'same', '--baseline', 'base']).stdout).toBe('0\n');
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'swapped', '--baseline', 'base']).stdout).toBe('1\n');
    expect((await rowsOf(cloneCountLog())).map((c) => c[4])).toEqual(['6', '0', '0', '1']);
  });

  it('--holdout --lists-differing --by-group: lists whose status or sequence of groups (eval/groups.json) differ; a swapped representative is not counted', async () => {
    const { dir, d } = await encSet('holdout-by-group', 'holdout');
    const looksBefore = await looks(cloneLedger(), 'holdout');
    const [first, second, third] = d.answerable;
    const ranker = { ref: 'x', sha: 'e'.repeat(40), dirty: false, treeHash: 'f'.repeat(64) };
    // ACC1701XB, XC and XD are one group-v1 group (ACC1701A…XD); NGN2001F and G another.
    const repBase = runOf(d, 'repbase', ranker, { ...d.ranked, [first]: ['ACC1701XB', 'CS3244', 'NGN2001F'], [second]: ['ACC1701XD', 'CS3244'] });
    const repSwap = runOf(d, 'repswap', ranker, { ...d.ranked, [first]: ['ACC1701XC', 'CS3244', 'NGN2001G'], [second]: ['ACC1701XA', 'CS3244'] });
    // Group order changed in one list, a group dropped in another, an error in a third.
    const regroup = runOf(d, 'regroup', ranker, { ...d.ranked, [first]: ['CS3244', 'ACC1701XC', 'NGN2001G'], [second]: ['ACC1701XA'] });
    regroup.results[third] = { status: 500, codes: [] };
    for (const r of [repBase, repSwap, regroup]) await writeEncryptedJson(join(dir, 'runs', `run-${r.variant}.json.enc`), r, key, 'holdout');
    await updateManifest(dir);
    const byGroup = (/** @type {string} */ run) => count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--by-group', '--run', run, '--baseline', 'repbase']);
    const r = byGroup('repswap');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('0\n');
    // Without --by-group the same pair differs in both swapped lists.
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'repswap', '--baseline', 'repbase']).stdout).toBe('2\n');
    expect(byGroup('regroup').stdout).toBe('3\n');
    expect(await rowsOf(cloneCountLog())).toEqual([
      [today(), 'holdout', 'count: lists-differing-by-group', 'repswap vs repbase', '0', '—'],
      [today(), 'holdout', 'count: lists-differing', 'repswap vs repbase', '2', '—'],
      [today(), 'holdout', 'count: lists-differing-by-group', 'regroup vs repbase', '3', '—'],
    ]);
    expect(await looks(cloneLedger(), 'holdout')).toBe(looksBefore);
  });

  it('the self-test set logs beside its own ledger', async () => {
    const { dir } = await encSet('selftest-emptied', 'selftest');
    const r = count(['--custodian', '--set', 'selftest', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']);
    expect(r.stdout).toBe('4\n');
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
    [['--qrels', 'q.json']],
    [['--out', 'x']],
    [['--ids']],
    [['--verbose']],
    [['--change-kind', 'general']],
    [['report']],
  ])('with %j, which could print ids or metrics', async (extra) => {
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--emptied-untagged', '--run', 'cand', ...extra], /^eval:count: .*eval:count takes only --custodian, --set, --holdout, --set-dir, --answerable, --emptied-untagged, --lists-differing, --by-group, --run, --baseline and --route/);
  });

  it('without exactly one count, or with a count the set does not have', async () => {
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir], /exactly one of --answerable, --emptied-untagged or --lists-differing/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--answerable', '--emptied-untagged', '--run', 'cand'], /exactly one of --answerable, --emptied-untagged or --lists-differing/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--emptied-untagged', '--lists-differing', '--run', 'cand', '--baseline', 'base'], /exactly one of --answerable, --emptied-untagged or --lists-differing/);
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir, '--lists-differing', '--run', 'cand', '--baseline', 'base'], /--lists-differing counts the holdout only/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--lists-differing', '--run', 'cand'], /--lists-differing needs --run <variant> and --baseline <variant>/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--lists-differing', '--baseline', 'base'], /--lists-differing needs --run <variant> and --baseline <variant>/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--emptied-untagged', '--run', 'cand', '--baseline', 'base'], /--baseline is for --lists-differing only/);
    await refused(['--custodian', '--holdout', '--set-dir', holdoutDir, '--emptied-untagged', '--by-group', '--run', 'cand'], /--by-group is for --lists-differing only/);
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir, '--answerable', '--by-group'], /--by-group is for --lists-differing only/);
    await refused(['--custodian', '--set', 'test', '--set-dir', testDir, '--answerable', '--baseline', 'base'], /--baseline is for --lists-differing only/);
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
    // Either side of a --lists-differing pair.
    await refused(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'other', '--baseline', 'base'], /^eval: holdout count failed \(RunFileError\); details withheld\n$/);
    await refused(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'cand', '--baseline', 'other'], /^eval: holdout count failed \(RunFileError\); details withheld\n$/);
  });

  it('a --lists-differing pair run under other settings (filters, mode) or missing a query: withheld, and no row', async () => {
    const { dir, d } = await encSet('other-config', 'holdout');
    const unfiltered = runOf(d, 'unfiltered', {}, d.ranked);
    unfiltered.config = { mode: 'hybrid', filters: false };
    const lexical = runOf(d, 'lexical', {}, d.ranked);
    lexical.config = { mode: 'lexical', filters: true };
    const short = runOf(d, 'short', {}, d.ranked);
    delete short.results[d.unscored[1]];
    for (const r of [unfiltered, lexical, short]) await writeEncryptedJson(join(dir, 'runs', `run-${r.variant}.json.enc`), r, key, 'holdout');
    await updateManifest(dir);
    for (const v of ['unfiltered', 'lexical', 'short']) {
      await refused(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', v, '--baseline', 'base'], /^eval: holdout count failed \(RunFileError\); details withheld\n$/);
      await refused(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--by-group', '--run', v, '--baseline', 'base'], /^eval: holdout count failed \(RunFileError\); details withheld\n$/);
    }
  });

  it('--by-group on runs made on another corpus than eval/groups.json\'s: withheld, and no row', async () => {
    const { dir, d } = await encSet('other-corpus', 'holdout');
    const ranker = { ref: 'x', sha: 'e'.repeat(40), dirty: false, treeHash: 'f'.repeat(64) };
    const a = runOf(d, 'othera', ranker, d.ranked);
    const b = runOf(d, 'otherb', ranker, d.ranked);
    a.corpus = { moduleInfoSha256: '0'.repeat(64) };
    b.corpus = { moduleInfoSha256: '0'.repeat(64) };
    for (const r of [a, b]) await writeEncryptedJson(join(dir, 'runs', `run-${r.variant}.json.enc`), r, key, 'holdout');
    await updateManifest(dir);
    await refused(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--by-group', '--run', 'othera', '--baseline', 'otherb'], /^eval: holdout count failed \(CorpusMismatchError\); details withheld\n$/);
    // Without --by-group the pair counts: the groups are not read.
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--lists-differing', '--run', 'othera', '--baseline', 'otherb']).stdout).toBe('0\n');
  });
});

describe('a count is never a look', () => {
  it('a count-log row placed in the ledger is refused as tampering, and no look can be taken past it', async () => {
    const { dir } = await encSet('count-into-ledger', 'holdout');
    expect(count(['--custodian', '--holdout', '--set-dir', dir, '--emptied-untagged', '--run', 'cand']).stdout).toBe('4\n');
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
    // Only count rows: one with no `count: ` kind would be a look row in the wrong file.
    for (const row of ledgerRows(log)) expect(row[2]).toMatch(/^count: /);
  });
});
