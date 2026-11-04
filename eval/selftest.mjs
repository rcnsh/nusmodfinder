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
//      set prints only the withheld line; a ranker answering `degraded` fails
//      the run;
//   6. judging on the fixture set: lexical-mode and unfiltered runs, a pool of
//      four runs, prepare (rule pre-grading, packets) -> scripted judges ->
//      collect (a bad output refused) -> agree -> adjudicate (blind pass 1,
//      then pass 2) -> merge -> eval:report on the merged qrels; calibration
//      export/import; a drift round; a single-judge round (prepare with one
//      judge) and a two-judge round turned single-judge by drop-judge ->
//      collect -> agree/adjudicate refused -> merge (rule, else A) ->
//      calibration without a B row; clean;
//   7. the same judging cycle on an encrypted copy of the fixture set: state
//      and qrels only as ciphertext, plaintext only in the 0700 round
//      directory until clean, nothing set-specific printed, a verdict on the
//      merged qrels, calibration refused.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readEncryptedJson, readKey } from './lib/crypto.mjs';
import { verbatimBlock } from './lib/judging.mjs';
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
ok(node(HOLDOUT, ['verify', '--dir', H]), 'verify');
// The fixture corpus is public and the runner reads it in plain form; it goes
// in after verification, which (rightly) refuses any non-.enc file.
await cp(join(FIX, 'corpus.json'), join(H, 'corpus.json'));

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
// A pool-variant baseline is refused before a look is reserved (PR #15 review).
ok(node(CLI, ['run', ...hargs, '--variant', 'lexbase', '--ref', 'eval-v0', '--mode', 'lexical', '--store-only'], env), 'holdout lexical pool run');
const lexBase = node(CLI, ['run', ...hargs, '--variant', 'cand-l', '--baseline', 'lexbase'], env);
assert.notEqual(lexBase.code, 0, 'a lexical baseline must be refused');
assertNoLeak(lexBase.out, 'refused lexical baseline');
assert.equal((await readLedger(ledgerPath)).length, 1, 'a refused pool-variant baseline uses no look');

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

// A ranker whose /search answers 200 but `degraded` (the dense half skipped,
// as when the breaker is open) measures a different ranker: the run fails.
const DEGRADED = `import worker from './index.orig.js';
export default {
  ...worker,
  async fetch(request, env, ctx) {
    const res = await worker.fetch(request, env, ctx);
    if (new URL(request.url).pathname !== '/search' || res.status !== 200) return res;
    const body = await res.json();
    return Response.json({ ...body, degraded: { source: 'vectorize', reason: 'circuit-open' } });
  },
};
`;
g(['read-tree', 'HEAD']);
g(['update-index', '--add', '--cacheinfo', `100644,${g(['rev-parse', 'HEAD:src/index.js'])},src/index.orig.js`]);
g(['update-index', '--cacheinfo', `100644,${g(['hash-object', '-w', '--stdin'], DEGRADED)},src/index.js`]);
const degradedRef = g(['commit-tree', g(['write-tree']), '-p', 'HEAD', '-m', 'selftest degraded probe']);
const degraded = node(CLI, ['run', '--set', 'fixture', '--variant', 'degraded', '--ref', degradedRef, '--out', join(WORK, 'degraded.json')]);
assert.notEqual(degraded.code, 0, 'a run with degraded responses fails');
assert.match(degraded.out, /degraded response \(vectorize: circuit-open\); the dense half did not run/);
assert.ok(!existsSync(join(WORK, 'degraded.json')), 'no run file is written');
console.log('ok: degraded responses fail the run');

step('6. judging cycle on the fixture set');
const JUDGE = join(REPO, 'eval', 'judge.mjs');
const JUDGING = await readFile(join(REPO, 'eval', 'JUDGING.md'), 'utf8');
const fixQrels = await json(join(FIX, 'qrels.json'));
/** The fixture's synthetic grade of a pair (unlisted = 0). */
const truth = (/** @type {string} */ q, /** @type {string} */ c) => fixQrels.queries[q]?.judgments?.[c] ?? 0;
/**
 * A scripted judge: answers every section of a slot's batches from the round
 * state, the way a judge agent fills in the packet's templates.
 * @param {any} state
 * @param {string} outDir
 * @param {string} who "A", "B" or "adjudicator/p1|p2"
 * @param {(q: string, c: string, n: number) => number} grade
 */
async function scriptedJudge(state, outDir, who, grade) {
  const adj = who.startsWith('adjudicator');
  const batches = adj ? state.adjudication.batches : state.batches[who];
  let n = 0;
  for (const b of batches) {
    for (const sec of b.sections) {
      const out = Object.fromEntries(sec.items.map((/** @type {string} */ id) => {
        const it = adj ? state.adjudication.items[id] : state.items[id];
        return [id, { grade: grade(it.queryId, it.code, n++), rationale: `scripted ${who} grade` }];
      }));
      await writeFile(join(outDir, who, b.id, `${sec.id}.json`), JSON.stringify(out));
    }
  }
}
/** Judge B disagrees with the truth on every 5th item. */
const judgeB = (/** @type {string} */ q, /** @type {string} */ c, /** @type {number} */ n) => (n % 5 === 0 ? (truth(q, c) + 1) % 3 : truth(q, c));

const lexPath = join(WORK, 'lex.json'), unfPath = join(WORK, 'unf.json');
ok(node(CLI, ['run', '--set', 'fixture', '--variant', 'selftest-lex', '--mode', 'lexical', '--out', lexPath]), 'lexical-mode run');
ok(node(CLI, ['run', '--set', 'fixture', '--variant', 'selftest-unf', '--unfiltered', '--out', unfPath]), 'unfiltered run');
assert.equal((await json(lexPath)).config.mode, 'lexical', 'a --mode lexical run records its mode');
assert.equal(head.config.mode, 'hybrid');
assert.match(node(CLI, ['run', '--set', 'fixture', '--variant', 'x', '--mode', 'dense']).out, /--mode must be one of hybrid, lexical, vector/);
// A pool variant never meets a gate.
assert.match(node(CLI, ['run', '--set', 'fixture', '--variant', 'x', '--mode', 'lexical', '--baseline', v0Path]).out, /takes no --baseline/);
const lexGate = node(CLI, ['report', '--set', 'fixture', '--run', lexPath, '--baseline', v0Path]);
assert.notEqual(lexGate.code, 0);
assert.match(lexGate.out, /used --mode lexical, a pool variant; gates compare hybrid runs only/);
const pool4 = join(WORK, 'pool-fixture.json');
ok(node(CLI, ['pool', '--set', 'fixture', '--runs', [v0Path, headPath, lexPath, unfPath].join(','), '--out', pool4]), 'pool of four runs');
const poolJson = await json(pool4);
assert.equal(poolJson.corpus.moduleInfoSha256, v0.corpus.moduleInfoSha256, 'the pool records the corpus');
assert.ok(!JSON.stringify(poolJson).includes('selftest-'), 'pool names a run');

const JW = join(WORK, 'judging');
const fx = ['--set', 'fixture', '--work-dir', JW, '--round', 'fx1'];
const prep = ok(node(JUDGE, ['prepare', ...fx, '--judges', 'judge-a,judge-b', '--pool', pool4, '--batch-size', '4']), 'judge prepare');
assert.match(prep, /graded 0 by rule \(hard constraints\)/);
let state = await json(join(JW, 'state-fx1.json'));
const ruled = Object.keys(state.rule);
assert.ok(ruled.length > 0, 'the unfiltered run puts hard-constraint violations in the pool, and rule grades them');
assert.equal(node(JUDGE, ['prepare', ...fx, '--judges', 'judge-a,judge-b', '--pool', pool4]).code, 1, 'a round is never overwritten');
const plainDir = join(JW, 'plain-fx1'), outDir = join(plainDir, 'out');
assert.equal((await stat(plainDir)).mode & 0o777, 0o700, 'the packet directory is 0700');
const instructions = verbatimBlock(JUDGING, 'judge-instructions');
for (const slot of ['A', 'B']) {
  for (const b of state.batches[slot]) {
    const packet = await readFile(join(plainDir, 'packets', `${slot}-${b.id}.md`), 'utf8');
    assert.ok(packet.includes(instructions), 'a packet carries the judge instructions verbatim');
    for (const qq of queries) assert.ok(!packet.includes(qq.id), 'a packet names a query id');
    assert.ok(!packet.includes('selftest-'), 'a packet names a run');
    for (const key of ruled) {
      const [qid, code] = key.split('\t');
      for (const sec of b.sections.filter((/** @type {any} */ x) => x.queryId === qid)) {
        assert.ok(!sec.items.some((/** @type {string} */ id) => state.items[id].code === code), 'a rule-graded pair reached a judge');
      }
    }
  }
}
// A bad output is refused (content-free message), then fixed.
const firstSec = state.batches.A[0].sections[0];
await writeFile(join(outDir, 'A', 'b01', `${firstSec.id}.json`), '{}');
await scriptedJudge(state, outDir, 'B', judgeB);
const bad = node(JUDGE, ['collect', ...fx]);
assert.equal(bad.code, 1);
assert.match(bad.out, new RegExp(`A b01/${firstSec.id}: item i[0-9a-z]{6} not graded`));
await scriptedJudge(state, outDir, 'A', truth);
const coll = ok(node(JUDGE, ['collect', ...fx]), 'collect');
assert.match(coll, /judge A: (\d+) of \1 items graded; planted repeats [1-9]\d*: exact agreement 1\.000/);
const agreeJson = join(WORK, 'agree.json');
const agree = ok(node(JUDGE, ['agree', ...fx, '--json', agreeJson]), 'agree');
assert.match(agree, /Krippendorff α \(ordinal\)/);
const agreement = await json(agreeJson);
state = await json(join(JW, 'state-fx1.json'));
const judgedPairs = Object.values(state.items).filter((/** @type {any} */ i) => i.slot === 'A' && i.kind === 'new').length;
assert.equal(agreement.overall.n, judgedPairs, 'agreement covers every pair both judges graded');
assert.ok(agreement.disagreements > 0, 'judge B was scripted to disagree');
ok(node(JUDGE, ['adjudicate', 'prepare', ...fx, '--adjudicator', 'judge-c']), 'adjudicate prepare');
state = await json(join(JW, 'state-fx1.json'));
assert.equal(Object.keys(state.adjudication.items).length, agreement.disagreements, 'every disagreement goes to the adjudicator');
const p1 = await readFile(join(plainDir, 'packets', 'adj-p1-b01.md'), 'utf8');
assert.ok(!/Grader 1|scripted A grade|scripted B grade/.test(p1), 'pass 1 is blind');
assert.equal(node(JUDGE, ['adjudicate', 'collect', ...fx, '--pass', '2']).code, 1, 'pass 2 cannot be collected before pass 1');
await scriptedJudge(state, outDir, 'adjudicator/p1', () => 1);
ok(node(JUDGE, ['adjudicate', 'collect', ...fx, '--pass', '1']), 'adjudicate collect pass 1');
assert.match(node(JUDGE, ['adjudicate', 'collect', ...fx, '--pass', '1']).out, /pass 1 is closed/, 'pass 1 cannot change once both grades are shown');
assert.match(node(JUDGE, ['collect', ...fx]).out, /already in adjudication; the judges' grades are frozen/);
const p2 = await readFile(join(plainDir, 'packets', 'adj-p2-b01.md'), 'utf8');
assert.match(p2, /- Grader 1: grade [012]: "scripted [AB] grade"/);
assert.match(p2, /- Your first-pass grade 1: "scripted adjudicator\/p1 grade"/);
await scriptedJudge(state, outDir, 'adjudicator/p2', truth);
ok(node(JUDGE, ['adjudicate', 'collect', ...fx, '--pass', '2']), 'adjudicate collect pass 2');
const merged = join(WORK, 'qrels-merged.json');
const mergeOut = ok(node(JUDGE, ['merge', ...fx, '--no-base', '--out', merged]), 'merge');
assert.match(mergeOut, /^qrels qrels-fixture-v1 -> /m);
// --no-base never silently overwrites existing qrels (PR #15 review).
const clobber = node(JUDGE, ['merge', ...fx, '--no-base', '--out', merged]);
assert.notEqual(clobber.code, 0, '--no-base over an existing qrels file must be refused');
assert.match(clobber.out, /already exists/);
const mq = await json(merged);
assert.equal(mq.schema, 'vnm-eval-qrels/1');
assert.equal(mq.corpus.moduleInfoSha256, v0.corpus.moduleInfoSha256, 'merged qrels carry moduleInfoSha256');
for (const qq of poolJson.queries) {
  for (const c of qq.candidates) {
    const j = mq.queries[qq.id]?.judgments?.[c.code];
    assert.ok(j, 'every pooled pair has a final judgment');
    const key = `${qq.id}\t${c.code}`;
    assert.equal(j.grade, state.rule[key] ? 0 : truth(qq.id, c.code), 'final = rule, else agreed, else adjudicated');
    assert.ok(Object.keys(j.judges).length >= 1);
  }
}
assert.match(node(JUDGE, ['merge', ...fx, '--base', merged, '--out', join(WORK, 'q2.json')]).out, /already judged in the base qrels/);
const rep = ok(node(CLI, ['report', '--set', 'fixture', '--run', headPath, '--baseline', v0Path, '--qrels', merged]), 'eval:report on merged qrels');
assert.match(rep, /qrels qrels-fixture-v1/);

// Calibration: export a blind sheet, fill it in with the truth, import it.
const calib = join(WORK, 'calibration.csv');
ok(node(JUDGE, ['calibrate', 'export', '--set', 'fixture', '--qrels', merged, '--n', '20', '--out', calib]), 'calibrate export');
const sheet = (await readFile(calib, 'utf8')).split('\r\n').filter(Boolean);
assert.ok(!/scripted|judge-a|judge-b/.test(sheet.join('\n')), 'the calibration sheet is blind');
const { parseCsv, toCsv } = await import('./lib/judging.mjs');
const [hdr, ...rws] = parseCsv(await readFile(calib, 'utf8'));
for (const r of rws) r[hdr.indexOf('your_grade')] = String(mq.queries[r[hdr.indexOf('query_id')]].judgments[r[hdr.indexOf('code')]].grade);
await writeFile(calib, toCsv([hdr, ...rws]));
const imp = ok(node(JUDGE, ['calibrate', 'import', '--set', 'fixture', '--csv', calib, '--qrels', merged, '--baseline', v0Path, '--run', headPath]), 'calibrate import');
assert.match(imp, /^final +\d+ +1\.000/m, 'the truth agrees with the final grades');
assert.match(imp, /^human +\S+ +[+−0—]/m);

// Drift: a new round over the same runs has nothing unjudged, so it re-judges a sample of old pairs only.
const poolUnj = join(WORK, 'pool-unjudged.json');
ok(node(CLI, ['pool', '--set', 'fixture', '--runs', `${v0Path},${headPath}`, '--unjudged', '--qrels', merged, '--out', poolUnj]), 'unjudged pool');
const fx2 = ['--set', 'fixture', '--work-dir', JW, '--round', 'fx2'];
ok(node(JUDGE, ['prepare', ...fx2, '--judges', 'judge-a,judge-b', '--pool', poolUnj, '--drift-from', merged]), 'drift round');
const s2 = await json(join(JW, 'state-fx2.json'));
assert.ok(Object.values(s2.items).every((/** @type {any} */ i) => i.kind === 'drift'), 'only drift items');
const driftN = Object.keys(s2.drift).length;
assert.ok(driftN >= 1);
for (const slot of ['A', 'B']) await scriptedJudge(s2, join(JW, 'plain-fx2', 'out'), slot, (q, c) => mq.queries[q].judgments[c].grade);
assert.match(ok(node(JUDGE, ['collect', ...fx2]), 'collect drift'), new RegExp(`drift ${driftN}: agreement with stored grade 1\\.000`));
// Single-judge: prepare with one judge makes only A packets, items and grades.
const fx4 = ['--set', 'fixture', '--work-dir', JW, '--round', 'fx4'];
assert.match(ok(node(JUDGE, ['prepare', ...fx4, '--judges', 'judge-a', '--pool', pool4, '--batch-size', '4']), 'single-judge prepare'), /single-judge/);
const s4 = await json(join(JW, 'state-fx4.json'));
assert.deepEqual(s4.judges, { A: 'judge-a' });
assert.deepEqual(Object.keys(s4.batches), ['A']);
assert.ok(Object.values(s4.items).every((/** @type {any} */ i) => i.slot === 'A'), 'only A items');
assert.ok(Object.values(s4.items).some((/** @type {any} */ i) => i.kind === 'repeat'), 'planted repeats go to A');
assert.ok(readdirSync(join(JW, 'plain-fx4', 'packets')).every((f) => f.startsWith('A-')), 'only A packets');
assert.match(node(JUDGE, ['collect', ...fx4, '--slot', 'B']).out, /single-judge: it has no judge B/);

// drop-judge: a two-judge round with A collected and no B grades becomes single-judge.
const fx3 = ['--set', 'fixture', '--work-dir', JW, '--round', 'fx3'];
ok(node(JUDGE, ['prepare', ...fx3, '--judges', 'judge-a,judge-b', '--pool', pool4, '--batch-size', '4']), 'prepare fx3');
let s3 = await json(join(JW, 'state-fx3.json'));
const out3 = join(JW, 'plain-fx3', 'out');
await scriptedJudge(s3, out3, 'A', truth);
ok(node(JUDGE, ['collect', ...fx3, '--slot', 'A']), 'collect fx3 A');
s3 = await json(join(JW, 'state-fx3.json'));
const aBefore = { items: Object.fromEntries(Object.entries(s3.items).filter(([, i]) => /** @type {any} */ (i).slot === 'A')), batches: s3.batches.A, grades: s3.grades.A };
assert.match(node(JUDGE, ['drop-judge', ...fx3, '--slot', 'A', '--reason', 'x']).out, /judge A cannot be dropped/);
assert.match(node(JUDGE, ['drop-judge', ...fx3, '--slot', 'C', '--reason', 'x']).out, /--slot must be A or B/);
assert.match(node(JUDGE, ['drop-judge', ...fx3, '--slot', 'B']).out, /--reason <text>/);
const drop = ok(node(JUDGE, ['drop-judge', ...fx3, '--slot', 'B', '--reason', 'owner decision: one judge']), 'drop-judge');
assert.match(drop, /dropped judge B \(judge-b\).*now single-judge \(judge A, judge-a: (\d+) of \1 items graded\)/);
s3 = await json(join(JW, 'state-fx3.json'));
assert.deepEqual({ items: s3.items, batches: s3.batches.A, grades: s3.grades.A }, aBefore, 'A untouched by drop-judge');
assert.deepEqual(Object.keys(s3.batches), ['A']);
assert.equal(s3.dropped[0].judge, 'judge-b');
assert.ok(readdirSync(join(JW, 'plain-fx3', 'packets')).every((f) => f.startsWith('A-')), 'B packets removed');
assert.match(node(JUDGE, ['drop-judge', ...fx3, '--slot', 'B', '--reason', 'x']).out, /no judge in slot B/);
const st3 = ok(node(JUDGE, ['status', ...fx3]), 'status fx3');
assert.match(st3, /^mode: single-judge/m);
assert.match(st3, /^dropped: judge B \(judge-b\) at \S+: owner decision: one judge$/m);
assert.ok(!/adjudication/.test(st3.replace(/no agreement or adjudication/, '')), 'status of a single-judge round has no adjudication line');
// A's outputs still validate after the drop.
assert.match(ok(node(JUDGE, ['collect', ...fx3]), 'collect fx3 after drop'), /judge A: (\d+) of \1 items graded/);
assert.match(node(JUDGE, ['agree', ...fx3]).out, /single-judge \(judge A only\): agree needs two judges/);
assert.match(node(JUDGE, ['adjudicate', 'prepare', ...fx3, '--adjudicator', 'judge-c']).out, /single-judge \(judge A only\): adjudicate needs two judges/);
const merged3 = join(WORK, 'qrels-single.json');
assert.match(ok(node(JUDGE, ['merge', ...fx3, '--no-base', '--out', merged3]), 'single-judge merge'), new RegExp(`: ${ruled.length} rule, \\d+ judged by A \\(single-judge\\)`));
const mq3 = await json(merged3);
assert.deepEqual({ ...mq3.judging[0], createdAt: null, pool: null }, { round: 'fx3', mode: 'single', judges: { A: 'judge-a' }, adjudicator: null, dropped: s3.dropped, pairs: mq3.judging[0].pairs, pool: null, createdAt: null });
for (const qq of poolJson.queries) {
  for (const c of qq.candidates) {
    const j = mq3.queries[qq.id].judgments[c.code];
    const key = `${qq.id}\t${c.code}`;
    assert.equal(j.source, s3.rule[key] ? 'rule' : 'judged');
    assert.equal(j.grade, s3.rule[key] ? 0 : truth(qq.id, c.code), 'single-judge final = rule, else A');
  }
}
const calib3 = join(WORK, 'calibration-single.csv');
ok(node(JUDGE, ['calibrate', 'export', '--set', 'fixture', '--qrels', merged3, '--n', '20', '--out', calib3]), 'single-judge calibrate export');
const [hdr3, ...rws3] = parseCsv(await readFile(calib3, 'utf8'));
for (const r of rws3) r[hdr3.indexOf('your_grade')] = String(mq3.queries[r[hdr3.indexOf('query_id')]].judgments[r[hdr3.indexOf('code')]].grade);
await writeFile(calib3, toCsv([hdr3, ...rws3]));
const imp3 = ok(node(JUDGE, ['calibrate', 'import', '--set', 'fixture', '--csv', calib3, '--qrels', merged3, '--baseline', v0Path, '--run', headPath]), 'single-judge calibrate import');
assert.match(imp3, /single-judge qrels \(judge A only\)/);
assert.match(imp3, /^A +\d+ +1\.000/m);
assert.match(imp3, /^final +\d+ +1\.000/m);
assert.match(imp3, /^final \(rule, else A\) /m);
assert.ok(!/^B /m.test(imp3) && !/NaN/.test(imp3), 'no B row, no NaN');
for (const r of ['fx3', 'fx4']) ok(node(JUDGE, ['clean', '--set', 'fixture', '--work-dir', JW, '--round', r]), `clean ${r}`);

ok(node(JUDGE, ['clean', ...fx]), 'clean');
assert.ok(!existsSync(plainDir), 'clean removes the round directory');
console.log(`ok: ${ruled.length} rule-graded, ${judgedPairs} judged pairs, ${agreement.disagreements} adjudicated; qrels-fixture-v1 scored; calibration and drift; single-judge and drop-judge rounds`);

step('7. judging cycle on an encrypted fixture set');
// A fresh copy of the encrypted set (its own ledger), without its qrels.
const H2 = join(WORK, 'holdout2');
await mkdir(join(H2, 'runs'), { recursive: true });
for (const f of ['queries.json.enc', 'embeddings.json.enc', 'corpus.json']) await cp(join(H, f), join(H2, f));
for (const f of ['run-base.json.enc', 'run-cand.json.enc']) await cp(join(H, 'runs', f), join(H2, 'runs', f));
const h2 = ['--set', 'selftest', '--set-dir', H2];
const JW2 = join(WORK, 'judging-enc');
const hx = [...h2, '--work-dir', JW2, '--round', 'hx1'];
const encPool = join(WORK, 'pool-selftest.json.enc');
ok(node(CLI, ['pool', ...h2, '--runs', 'base,cand', '--custodian', '--out', encPool], env), 'encrypted pool');
const hprep = ok(node(JUDGE, ['prepare', ...hx, '--judges', 'judge-a,judge-b', '--pool', encPool, '--batch-size', '4'], env), 'encrypted prepare');
assertNoLeak(hprep, 'encrypted prepare');
assert.match(hprep, /Delete it once collected:\n {2}npm run eval:judge -- clean --set selftest/);
const encState = join(JW2, 'state-hx1.json.enc');
const encBytes = await readFile(encState);
assert.ok(!encBytes.includes('fx-01') && !encBytes.includes('CS1010'), 'the round state is ciphertext');
assert.equal((await stat(join(JW2, 'plain-hx1'))).mode & 0o777, 0o700, 'plaintext packets live in a 0700 directory');
/** Every file under JW2 outside the plaintext round directory is a ciphertext. */
const assertOnlyCiphertext = () => {
  for (const e of readdirSync(JW2, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = join(e.parentPath, e.name).slice(JW2.length + 1);
    if (!rel.startsWith('plain-')) assert.ok(rel.endsWith('.enc'), `plaintext outside the round directory: ${rel}`);
  }
};
assertOnlyCiphertext();
const throwaway = await readKey(keyFile);
let hstate = await readEncryptedJson(encState, throwaway, 'selftest');
const hout = join(JW2, 'plain-hx1', 'out');
await scriptedJudge(hstate, hout, 'A', truth);
await scriptedJudge(hstate, hout, 'B', judgeB);
const hcoll = ok(node(JUDGE, ['collect', ...hx], env), 'encrypted collect');
assertNoLeak(hcoll, 'encrypted collect');
const hagree = ok(node(JUDGE, ['agree', ...hx], env), 'encrypted agree');
assertNoLeak(hagree, 'encrypted agree');
assert.equal(node(JUDGE, ['agree', ...hx, '--json', join(WORK, 'x.json')], env).code, 1, '--json refused for an encrypted set');
ok(node(JUDGE, ['adjudicate', 'prepare', ...hx, '--adjudicator', 'judge-c'], env), 'encrypted adjudicate');
hstate = await readEncryptedJson(encState, throwaway, 'selftest');
await scriptedJudge(hstate, hout, 'adjudicator/p1', () => 1);
ok(node(JUDGE, ['adjudicate', 'collect', ...hx, '--pass', '1'], env), 'encrypted pass 1');
await scriptedJudge(hstate, hout, 'adjudicator/p2', truth);
ok(node(JUDGE, ['adjudicate', 'collect', ...hx, '--pass', '2'], env), 'encrypted pass 2');
const hmerge = ok(node(JUDGE, ['merge', ...hx], env), 'encrypted merge');
assertNoLeak(hmerge, 'encrypted merge');
const hq = await readEncryptedJson(join(H2, 'qrels.json.enc'), throwaway, 'selftest');
assert.equal(hq.version, 'qrels-selftest-v1');
assert.ok(Object.values(hq.queries).some((/** @type {any} */ q) => Object.values(q.judgments).some((/** @type {any} */ j) => j.judges?.['judge-a'])), 'judges recorded');
const hlook = ok(node(CLI, ['report', ...h2, '--run', 'cand', '--baseline', 'base'], env), 'verdict on the merged encrypted qrels');
assertNoLeak(hlook, 'encrypted verdict');
assert.match(hlook, /^holdout verdict: (PASS|FAIL) · qrels qrels-selftest-v1$/m);
assert.match(node(JUDGE, ['calibrate', 'export', ...h2], env).out, /human calibration is dev-only/);
const corruptState = join(WORK, 'judging-corrupt');
await mkdir(corruptState, { recursive: true });
const cb = Buffer.from(encBytes);
cb[cb.length - 1] ^= 1;
await writeFile(join(corruptState, 'state-hx1.json.enc'), cb);
assert.equal(node(JUDGE, ['status', ...h2, '--work-dir', corruptState, '--round', 'hx1'], env).out, 'eval:judge: selftest judging failed (DecryptionError); details withheld\n');
assertOnlyCiphertext();
ok(node(JUDGE, ['clean', ...hx], env), 'encrypted clean');
assert.ok(!existsSync(join(JW2, 'plain-hx1')), 'clean removes the plaintext');
assertOnlyCiphertext();
console.log('ok: encrypted state and qrels, 0700 plaintext until clean, nothing set-specific printed, verdict on merged qrels');

console.log('\nselftest passed');
