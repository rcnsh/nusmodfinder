#!/usr/bin/env node
// @ts-check
// `npm run test:eval`: the harness end to end on the synthetic fixture set,
// through the real CLI, in workerd, from the committed embedding cache (no
// Cloudflare call). Runs in CI. Checks:
//   1. eval-v0 overlay run reproduces the golden results and metrics, and
//      its ranker.treeHash is the hash of `git archive eval-v0` (so the old
//      ranker really ran; the fixture ranks identically under both);
//   2. a working-tree run + comparison + gate, and eval:report recomputes it
//      identically from the run files alone;
//   3. eval:pool output has no system or rank information;
//   4. holdout custody with a throwaway key, on the `selftest` set (the
//      holdout rules with its ledger in its own directory; its ciphertexts are
//      bound to that name, so real holdout files cannot be read through it):
//      encrypted-only output, a verdict-only terminal, ledger append, 13th
//      look refused, pool refused without --custodian, tampering and a wrong
//      key detected, errors withheld;
//   5. a probe ranker whose Worker logs, throws and throws uncaught with the
//      query text: the fixture set shows it (the probe works), the encrypted
//      set prints only the withheld line.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readLedger } from './lib/ledger.mjs';
import { HASHED, treeHash } from './lib/workspace.mjs';
import { REPO } from './lib/sets.mjs';

const WORK = join(REPO, '.eval-work', 'selftest');
const FIX = join(REPO, 'eval', 'fixtures');
const CLI = join(REPO, 'eval', 'cli.mjs');
const HOLDOUT = join(REPO, 'scripts', 'holdout.mjs');

/**
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function node(script, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env, FORCE_COLOR: '0' }, maxBuffer: 1 << 28 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null, out: string }>}
 */
function nodeAsync(script, args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: REPO, env: { ...process.env, ...env, FORCE_COLOR: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => done({ code, out }));
  });
}

/** @param {ReturnType<typeof node>} r @param {string} what */
function ok(r, what) {
  if (r.code !== 0) {
    console.error(r.out);
    throw new Error(`${what} exited ${r.code}`);
  }
  return r.out;
}

/** @param {string} p */
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
/** @param {string} name */
const step = (name) => console.log(`\n== ${name}`);

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
const queries = (await json(join(FIX, 'queries.json'))).queries;
const golden = await json(join(FIX, 'expected-v0.json'));

step('1. eval-v0 overlay reproduces the golden fixture run');
const v0Path = join(WORK, 'v0.json');
ok(node(CLI, ['run', '--set', 'fixture', '--variant', 'selftest-v0', '--ref', 'eval-v0', '--out', v0Path]), 'v0 run');
const v0 = await json(v0Path);
assert.equal(v0.ranker.sha, golden.ranker);
assert.deepEqual(v0.results, golden.results, 'eval-v0 results differ from eval/fixtures/expected-v0.json');
assert.equal(v0.queries.sha256, golden.queries.sha256);
for (const field of ['ranker', 'corpus', 'embedding', 'queries', 'config']) assert.ok(v0[field], `run file has ${field}`);
assert.equal(v0.corpus.moduleInfoSha256, '2d138795d387d133237669a7f5a22c7c4d30b4a26bf82dad0a982636e80857b1');
assert.equal(v0.embedding.model, '@cf/baai/bge-small-en-v1.5');
// The fixture ranks every query the same at eval-v0 and HEAD, so results
// alone cannot show which ranker ran: compare the hash of the files that ran
// with the hash of eval-v0's own files, extracted independently.
const archiveDir = join(WORK, 'eval-v0-archive');
await mkdir(archiveDir, { recursive: true });
const atV0 = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `eval-v0:${p}`], { cwd: REPO }).status === 0);
const tar = spawnSync('git', ['archive', '--format=tar', 'eval-v0', '--', ...atV0], { cwd: REPO, maxBuffer: 1 << 30 });
assert.equal(tar.status, 0, 'git archive eval-v0');
assert.equal(spawnSync('tar', ['-x', '-C', archiveDir], { input: tar.stdout }).status, 0, 'extract eval-v0');
const v0Tree = await treeHash(archiveDir);
assert.match(v0.ranker.treeHash, /^[0-9a-f]{64}$/);
assert.equal(v0.ranker.treeHash, v0Tree, '--ref eval-v0 must run exactly the ranker files of eval-v0');
console.log(`ok: results identical to the golden run; ranker tree ${v0Tree.slice(0, 12)} = git archive eval-v0`);

step('2. working-tree run, comparison and gate; eval:report recomputes it');
const headPath = join(WORK, 'head.json');
const runReport = join(WORK, 'run-report.json');
const headOut = ok(node(CLI, ['run', '--set', 'fixture', '--variant', 'selftest-head', '--out', headPath, '--baseline', v0Path, '--json', runReport]), 'head run');
// The fixture's > 200-character query returns 400: the run reports it.
assert.match(headOut, /^errors: 1 of 11 queries returned a non-200 response$/m);
const head = await json(headPath);
assert.deepEqual(Object.keys(head.results).sort(), queries.map((/** @type {any} */ q) => q.id).sort());
const worktreeTree = await treeHash(REPO);
assert.equal(head.ranker.treeHash, worktreeTree, 'a working-tree run records the working tree\'s ranker hash');
const treesDiffer = spawnSync('git', ['diff', '--quiet', 'eval-v0', '--', ...HASHED], { cwd: REPO }).status !== 0;
if (treesDiffer) assert.notEqual(head.ranker.treeHash, v0.ranker.treeHash, 'eval-v0 and the working tree differ, so must their tree hashes');
console.log(`ok: working-tree ranker tree ${worktreeTree.slice(0, 12)} (${treesDiffer ? 'differs from' : 'same files as'} eval-v0)`);
const recomputed = join(WORK, 'report.json');
ok(node(CLI, ['report', '--set', 'fixture', '--run', headPath, '--baseline', v0Path, '--json', recomputed]), 'eval:report');
const r1 = await json(runReport), r2 = await json(recomputed);
assert.deepEqual(r2, r1, 'eval:report must recompute exactly what the run printed');
assert.ok(['pass', 'fail'].includes(r1.verdict.verdict));
assert.deepEqual(r2.baseSummary, golden.summary, 'metrics of the eval-v0 run differ from the golden summary');
console.log(`ok: gate ${r1.verdict.verdict}; report identical; v0 metrics match golden`);

step('3. eval:pool is blind');
const poolPath = join(WORK, 'pool.json');
ok(node(CLI, ['pool', '--set', 'fixture', '--runs', `${v0Path},${headPath}`, '--out', poolPath]), 'eval:pool');
const pool = await json(poolPath);
for (const q of pool.queries) {
  const expected = new Set([...v0.results[q.id].codes.slice(0, 10), ...head.results[q.id].codes.slice(0, 10)]);
  assert.deepEqual(new Set(q.candidates.map((/** @type {any} */ c) => c.code)), expected, `pool for ${q.id}`);
  for (const c of q.candidates) for (const k of ['rank', 'score', 'system', 'variant', 'run']) assert.ok(!(k in c), `pool leaks ${k}`);
}
assert.ok(!JSON.stringify(pool).includes('selftest-'), 'pool names a run');
console.log(`ok: ${pool.queries.reduce((/** @type {number} */ n, /** @type {any} */ q) => n + q.candidates.length, 0)} candidates, no rank/system fields`);

step('4. holdout custody with a throwaway key');
const H = join(WORK, 'holdout');
const keyFile = join(WORK, 'throwaway.key');
const env = { VNM_HOLDOUT_KEY_FILE: keyFile };
ok(node(HOLDOUT, ['keygen'], env), 'keygen');
assert.notEqual(node(HOLDOUT, ['keygen'], env).code, 0, 'keygen refuses to overwrite');
assert.match(node(HOLDOUT, ['encrypt', join(FIX, 'queries.json'), '--as', 'queries.json', '--dir', H], env).out, /say which set it holds with --set/);
for (const f of ['queries.json', 'qrels.json', 'embeddings.json']) ok(node(HOLDOUT, ['encrypt', join(FIX, f), '--as', f, '--dir', H, '--set', 'selftest'], env), `encrypt ${f}`);
await cp(join(FIX, 'corpus.json'), join(H, 'corpus.json'));
ok(node(HOLDOUT, ['verify', '--dir', H]), 'verify');

/** Holdout output must never carry a query id or text. */
const assertNoLeak = (/** @type {string} */ out, /** @type {string} */ what) => {
  for (const q of queries) {
    assert.ok(!out.includes(q.id), `${what} printed query id ${q.id}`);
    assert.ok(!out.includes(q.text), `${what} printed a query text`);
  }
};
const hargs = ['--set', 'selftest', '--set-dir', H];
const base = node(CLI, ['run', ...hargs, '--variant', 'base', '--ref', 'eval-v0', '--store-only'], env);
ok(base, 'holdout baseline run');
assertNoLeak(base.out, 'holdout baseline run');
assert.ok(existsSync(join(H, 'runs', 'run-base.json.enc')));
assert.deepEqual(readdirSync(join(H, 'runs')).filter((f) => !f.endsWith('.enc')), [], 'no plaintext run files');
const enc = await readFile(join(H, 'runs', 'run-base.json.enc'));
assert.ok(!enc.includes('fx-01') && !enc.includes('CS1010'), 'ciphertext contains plaintext');

const look = node(CLI, ['run', ...hargs, '--variant', 'cand', '--baseline', 'base'], env);
ok(look, 'holdout look');
assertNoLeak(look.out, 'holdout look');
const verdictLines = look.out.trim().split('\n').filter((l) => !/^(wrote |selftest\/cand: ranker )/.test(l));
assert.equal(verdictLines.length, 3, `holdout prints only the verdict and two Δ lines, got:\n${look.out}`);
assert.match(verdictLines[0], /^holdout verdict: (PASS|FAIL) · qrels fixture-qrels-v1$/);
assert.match(verdictLines[1], /^ΔnDCG@10 [+-]\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\] \(BCa 95%\)$/);
assert.match(verdictLines[2], /^ΔP@5 +[+-]\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\] \(BCa 95%\)$/);
const ledgerPath = join(H, 'ledger.md');
const rows1 = await readLedger(ledgerPath);
assert.equal(rows1.length, 1, 'one ledger row per look');
assert.ok(['pass', 'fail'].includes(rows1[0].verdict), `the reserved row is finalised with the verdict, got ${rows1[0].verdict}`);

const wrongKey = join(WORK, 'wrong.key');
await writeFile(wrongKey, `${'ab'.repeat(32)}\n`);
const wrong = node(CLI, ['report', ...hargs, '--run', 'cand', '--baseline', 'base'], { VNM_HOLDOUT_KEY_FILE: wrongKey });
assert.notEqual(wrong.code, 0);
assert.equal(wrong.out, 'eval: selftest run failed (DecryptionError); details withheld\n', 'a holdout error prints only the generic line');
assert.ok(!wrong.out.includes('abab'), 'key material printed');
assert.equal((await readLedger(ledgerPath)).length, 1, 'a failed look is not recorded');

// A run that fails after its look was reserved still counts (finalised as aborted).
const aborted = node(CLI, ['run', ...hargs, '--variant', 'cand-x', '--baseline', 'base', '--ref', 'no-such-ref-for-selftest'], env);
assert.equal(aborted.out, 'eval: selftest run failed (Error); details withheld\n');
const rows2 = await readLedger(ledgerPath);
assert.deepEqual(rows2.map((r) => r.verdict).slice(1), ['aborted'], 'a failed run keeps its reserved look');

// Three parallel reports from 11 rows: the lock lets exactly one through.
for (let i = 3; i <= 11; i++) await appendFile(ledgerPath, `| 2026-01-01 | selftest | 0000000 | filler-${i} | base | fail | +0.000 [0.000, 0.000] | +0.000 [0.000, 0.000] |\n`);
assert.equal((await readLedger(ledgerPath)).length, 11);
const parallel = await Promise.all([1, 2, 3].map(() => nodeAsync(CLI, ['report', ...hargs, '--run', 'cand', '--baseline', 'base'], env)));
assert.deepEqual(parallel.map((r) => r.code).sort(), [0, 1, 1], `parallel looks:\n${parallel.map((r) => r.out).join('\n')}`);
assert.equal((await readLedger(ledgerPath)).length, 12, 'parallel looks cannot pass the limit');
assert.ok(!existsSync(`${ledgerPath}.lock`), 'the ledger lock is released');

const thirteenth = node(CLI, ['report', ...hargs, '--run', 'cand', '--baseline', 'base'], env);
assert.notEqual(thirteenth.code, 0);
assert.equal(thirteenth.out, 'eval: selftest run failed (LookLimitError); details withheld\n');
const thirteenthRun = node(CLI, ['run', ...hargs, '--variant', 'cand2', '--baseline', 'base'], env);
assert.equal(thirteenthRun.out, 'eval: selftest run failed (LookLimitError); details withheld\n');
assert.ok(!existsSync(join(H, 'runs', 'run-cand2.json.enc')), 'the 13th look is refused before any retrieval');

const pooled = node(CLI, ['pool', ...hargs, '--runs', 'base,cand'], env);
assert.notEqual(pooled.code, 0);
assert.match(pooled.out, /without --custodian/);


const tampered = join(WORK, 'tampered');
await cp(H, tampered, { recursive: true });
const q = await readFile(join(tampered, 'queries.json.enc'));
q[q.length - 1] ^= 1;
await writeFile(join(tampered, 'queries.json.enc'), q);
const t = node(HOLDOUT, ['verify', '--dir', tampered]);
assert.notEqual(t.code, 0);
assert.match(t.out, /MISMATCH/);
console.log('ok: encrypted-only output, verdict-only terminal, ledger, reserved looks, lock, look limit, custodian gate, tamper and key checks');

step('5. nothing the Worker prints reaches the terminal for an encrypted set');
// A commit object (no ref, no working-tree change) whose src/index.js wraps
// the real Worker and, on /search, logs, schedules an uncaught throw and
// throws, each carrying the query text.
const PROBE = `import worker from './index.orig.js';
export default {
  ...worker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      setTimeout(() => { throw new Error('LEAK-UNCAUGHT ' + q); }, 0);
      console.error('LEAK-CONSOLE ' + q);
      throw new Error('LEAK-THROW ' + q);
    }
    return worker.fetch(request, env, ctx);
  },
};
`;
const gitEnv = { ...process.env, GIT_INDEX_FILE: join(WORK, 'probe.index'), GIT_AUTHOR_NAME: 'selftest', GIT_AUTHOR_EMAIL: 'selftest@example.com', GIT_COMMITTER_NAME: 'selftest', GIT_COMMITTER_EMAIL: 'selftest@example.com' };
const g = (/** @type {string[]} */ args, /** @type {string} */ input = '') => {
  const r = spawnSync('git', args, { cwd: REPO, env: gitEnv, input, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
g(['read-tree', 'HEAD']);
g(['update-index', '--add', '--cacheinfo', `100644,${g(['rev-parse', 'HEAD:src/index.js'])},src/index.orig.js`]);
g(['update-index', '--cacheinfo', `100644,${g(['hash-object', '-w', '--stdin'], PROBE)},src/index.js`]);
const probe = g(['commit-tree', g(['write-tree']), '-p', 'HEAD', '-m', 'selftest leak probe']);
// Positive control: on the plain fixture set the probe's output is visible.
const shown = node(CLI, ['run', '--set', 'fixture', '--variant', 'probe', '--ref', probe, '--out', join(WORK, 'probe.json')]);
assert.notEqual(shown.code, 0, 'the probe run fails');
assert.match(shown.out, /LEAK-UNCAUGHT /, `the probe's uncaught exception is printed for a plain set:\n${shown.out}`);
const hidden = node(CLI, ['run', ...hargs, '--variant', 'probe', '--ref', probe, '--store-only'], env);
assert.equal(hidden.code, 1);
// Only the header line (ranker, counts) printed before retrieval, then the withheld line.
assert.match(hidden.out, /^selftest\/probe: ranker [0-9a-f]{40} \([0-9a-f]{7}\), \d+ modules, \d+ queries, embeddings set-cache\neval: selftest run failed \(RunFailedError\); details withheld\n$/, `an encrypted run prints only the withheld line, got:\n${hidden.out}`);
assertNoLeak(hidden.out, 'probe run');
console.log('ok: the probe leaks on the plain set and nothing reaches the terminal on the encrypted set');

console.log('\nselftest passed');
