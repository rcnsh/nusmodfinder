#!/usr/bin/env node
// @ts-check
// `npm run test:eval`: the harness end to end on the synthetic fixture set,
// through the real CLI, in workerd, from the committed embedding cache (no
// Cloudflare call). Runs in CI. Checks:
//   1. eval-v0 overlay run reproduces the golden results and metrics;
//   2. a working-tree run + comparison + gate, and eval:report recomputes it
//      identically from the run files alone;
//   3. eval:pool output has no system or rank information;
//   4. holdout custody with a throwaway key, on the `selftest` set (the
//      holdout rules with its ledger in its own directory; its ciphertexts are
//      bound to that name, so real holdout files cannot be read through it):
//      encrypted-only output, a verdict-only terminal, ledger append, 13th
//      look refused, pool refused without --custodian, tampering and a wrong
//      key detected, errors withheld.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
console.log('ok: results identical to the golden run');

step('2. working-tree run, comparison and gate; eval:report recomputes it');
const headPath = join(WORK, 'head.json');
const runReport = join(WORK, 'run-report.json');
const headOut = ok(node(CLI, ['run', '--set', 'fixture', '--variant', 'selftest-head', '--out', headPath, '--baseline', v0Path, '--json', runReport]), 'head run');
// The fixture's > 200-character query returns 400: the run reports it.
assert.match(headOut, /^errors: 1 of 11 queries returned a non-200 response$/m);
const head = await json(headPath);
assert.deepEqual(Object.keys(head.results).sort(), queries.map((/** @type {any} */ q) => q.id).sort());
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
assert.match(verdictLines[0], /^holdout verdict: (PASS|FAIL)$/);
assert.match(verdictLines[1], /^ΔnDCG@10 [+-]\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\] \(BCa 95%\)$/);
assert.match(verdictLines[2], /^ΔP@5 +[+-]\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\] \(BCa 95%\)$/);
const ledger = await readFile(join(H, 'ledger.md'), 'utf8');
assert.equal(ledger.split('\n').filter((l) => /^\| \d{4}-/.test(l)).length, 1, 'one ledger row per look');

const wrongKey = join(WORK, 'wrong.key');
await writeFile(wrongKey, `${'ab'.repeat(32)}\n`);
const wrong = node(CLI, ['report', ...hargs, '--run', 'cand', '--baseline', 'base'], { VNM_HOLDOUT_KEY_FILE: wrongKey });
assert.notEqual(wrong.code, 0);
assert.equal(wrong.out, 'eval: selftest run failed (DecryptionError); details withheld\n', 'a holdout error prints only the generic line');
assert.ok(!wrong.out.includes('abab'), 'key material printed');
assert.equal((await readFile(join(H, 'ledger.md'), 'utf8')).split('\n').filter((l) => /^\| \d{4}-/.test(l)).length, 1, 'a failed look is not recorded');

for (let i = 2; i <= 12; i++) await appendFile(join(H, 'ledger.md'), `| 2026-01-01 | selftest | 0000000 | filler-${i} | base | fail | +0.000 [0.000, 0.000] | +0.000 [0.000, 0.000] |\n`);
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
console.log('ok: encrypted-only output, verdict-only terminal, ledger, look limit, custodian gate, tamper and key checks');

console.log('\nselftest passed');
