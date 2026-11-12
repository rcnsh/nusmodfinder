#!/usr/bin/env node
// @ts-check
// `npm run eval:lock`: the ranking lock, eval/ranking-lock.json (Phase 7 7A; eval/lib/ranking-lock.mjs).
//
//   npm run eval:lock                                   rewrite the lock at HEAD; refused if the lists change
//   npm run eval:lock -- --evidence <kind> <ref>        write changed lists with their evidence:
//       holdout-pass <ledger row> | no-look <count-log row> | revert <commit> | bootstrap <ref>
//   npm run eval:lock -- --check [--base <rev>]         the eval gate (CI's eval-gate job)
//   npm run eval:lock -- --check --fast-only [--base <rev>]
//                                                       the fast path alone; prints and outputs fast=true|false
//   npm run eval:lock -- --diff-ref <ref>               <ref>'s ranker (with the HEAD runner) against HEAD's lock
//
// `--base` defaults to the merge base with origin/main. The runner calls no Cloudflare service:
// it needs the pinned corpus in .data/ and downloads the corpus embeddings release asset.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  LOCK_PATH, LOCK_SCHEMA, canonical, checkEvidence, checkGate, commitOf, diffLists, dirtyInputs, fastPath, inputsHash, readLockAt,
} from './lib/ranking-lock.mjs';
import { REPO } from './lib/sets.mjs';

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`eval:lock: ${msg}`);
  process.exit(1);
}

/** @type {any} */
let parsed;
try {
  parsed = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      'fast-only': { type: 'boolean', default: false },
      base: { type: 'string' },
      evidence: { type: 'string' },
      'diff-ref': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
} catch (err) {
  fail(/** @type {Error} */ (err).message);
}
const { values: a, positionals } = parsed;
if (a.help) {
  console.log('usage: npm run eval:lock [-- --evidence <kind> <ref>] | [-- --check [--fast-only] [--base <rev>]] | [-- --diff-ref <ref>]');
  process.exit(0);
}

/** The base: --base (empty means none), else the merge base with origin/main. */
function baseOf() {
  if (a.base !== undefined) return a.base.trim() || null;
  if (!commitOf(REPO, 'origin/main')) return null;
  const r = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** @param {string} key @param {string} value */
function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const recompute = async () => {
  const { computeLists } = await import('./lib/lock-runner.mjs');
  const started = Date.now();
  const computed = await computeLists({ log: (l) => console.log(`  ${l}`) });
  for (const [run, sha] of Object.entries(computed.resultsSha256)) console.log(`  ${run}: results sha256 ${sha.slice(0, 16)}`);
  console.log(`  recomputed in ${Math.round((Date.now() - started) / 1000)} s`);
  return computed;
};

function refuseDirty() {
  const dirty = dirtyInputs();
  if (dirty.length) fail(`LOCK_INPUTS have uncommitted changes, which the runner would read but inputsHash would not; commit or stash them first:\n  ${dirty.join('\n  ')}`);
}

if (a.check) {
  const base = baseOf();
  if (a['fast-only']) {
    const r = fastPath({ base });
    console.log(`eval:lock: fast path ${r.fast ? 'taken' : 'not taken'}: ${r.reason}`);
    output('fast', String(r.fast));
    process.exit(0);
  }
  refuseDirty();
  console.log(`eval:lock: checking ${LOCK_PATH} at ${commitOf(REPO, 'HEAD')?.slice(0, 7)} against base ${base ? base.slice(0, 7) : '(none)'}`);
  const r = await checkGate({ base, recompute });
  for (const n of r.notes) console.log(`  ${n}`);
  if (!r.ok) {
    console.error(`eval:lock: the ranking lock check FAILED (${r.path}):`);
    for (const p of r.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`eval:lock: passed (${r.path === 'fast' ? 'fast path' : 'recomputed'})`);
  process.exit(0);
}

if (a['diff-ref']) {
  const ref = a['diff-ref'];
  const lock = readLockAt(REPO, 'HEAD');
  if (!lock) fail(`HEAD has no ${LOCK_PATH}`);
  const { computeLists } = await import('./lib/lock-runner.mjs');
  const computed = await computeLists({ ref, log: (l) => console.log(`  ${l}`) });
  for (const [run, sha] of Object.entries(computed.resultsSha256)) console.log(`  ${run}: results sha256 ${sha.slice(0, 16)}`);
  const diff = diffLists(lock.lists, computed.lists);
  const count = Object.values(lock.lists).reduce((n, modes) => n + Object.values(modes).reduce((m, q) => m + Object.keys(q).length, 0), 0);
  if (diff.length) {
    console.log(`eval:lock: ${diff.length} of ${count} lists differ between ${ref} and HEAD's lock:`);
    for (const d of diff) console.log(`  ${d}`);
    process.exit(1);
  }
  console.log(`eval:lock: all ${count} lists of ${ref} equal HEAD's lock (embedding ${computed.embedding})`);
  process.exit(0);
}

// Write.
refuseDirty();
const base = baseOf();
const baseLock = base ? readLockAt(REPO, base) : null;
const current = readLockAt(REPO, 'HEAD');
if (a.evidence && positionals.length !== 1) fail('--evidence takes a kind and one ref: --evidence holdout-pass <row> | no-look <row> | revert <commit> | bootstrap <ref>');
if (!a.evidence && positionals.length) fail(`unexpected argument ${positionals[0]}`);
const computed = await recompute();
const lock = {
  schema: LOCK_SCHEMA,
  inputsHash: inputsHash(REPO, 'HEAD'),
  embedding: computed.embedding,
  corpus: computed.corpus,
  evidence: a.evidence ? { kind: a.evidence, ref: positionals[0] } : (current?.evidence ?? baseLock?.evidence ?? null),
  lists: computed.lists,
};
const changed = !baseLock || canonical(baseLock.lists) !== canonical(lock.lists);
if (changed) {
  if (!a.evidence) {
    const diff = baseLock ? diffLists(baseLock.lists, lock.lists) : ['(the base has no lock)'];
    fail(`HEAD's lists differ from the base lock's${base ? ` (${base.slice(0, 7)})` : ''}, so the lock needs --evidence <kind> <ref>:\n  ${diff.slice(0, 40).join('\n  ')}`);
  }
  if (!base && a.evidence !== 'bootstrap') fail('no base to check the evidence against: pass --base <rev>');
  const problems = base ? checkEvidence({ repo: REPO, head: 'HEAD', base, headLock: /** @type {any} */ (lock), baseLock }) : [];
  if (problems.length) fail(`the evidence is refused:\n  ${problems.join('\n  ')}`);
} else if (a.evidence) {
  fail('HEAD\'s lists equal the base lock\'s, so there is nothing to give evidence for (a neutral change leaves the lock as it is)');
} else if (current && canonical({ ...current, inputsHash: '' }) === canonical({ ...lock, inputsHash: '' })) {
  console.log(`eval:lock: HEAD's lists, embedding and corpus equal the lock's; ${LOCK_PATH} stays as it is (a neutral change never rewrites it)`);
  process.exit(0);
}
await writeFile(join(REPO, LOCK_PATH), `${JSON.stringify(lock, null, 1)}\n`);
console.log(`eval:lock: wrote ${LOCK_PATH} (evidence ${lock.evidence?.kind} ${lock.evidence?.ref}; inputs ${lock.inputsHash.slice(0, 12)}); commit it`);
