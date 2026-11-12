// @ts-check
// Phase 7 7A: the ranking lock (eval/ranking-lock.json) and its gate
// (eval/lib/ranking-lock.mjs). Every case runs over a throwaway git repo in a
// temp dir with fake list files: `recompute` stands in for the eval runner and
// returns the lists a test names, so no case runs workerd, reads the real
// ledger or the real count log, or calls anything remote.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LOCK_INPUTS, LOCK_PATH, NO_LOOK_ROUTES, checkGate, inputsHash, lockInputsProblems, queryHash,
} from '../../eval/lib/ranking-lock.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

const PIN = 'a23601de0b15934960bfef1d8b56ab3e80fa5587';
const OLD_PIN = '0b5f360c7faea8424215b4d4ddde81ebb1d850ff';
const EMBEDDING = 'emb-test-v1';
const CORPUS = { release: 'data-test', moduleInfoSha256: 'c'.repeat(64) };

/** @type {string} */
let tmp;
beforeAll(async () => { tmp = await mkdtemp(join(tmpdir(), 'vnm-ranking-lock-')); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let repos = 0;
/** A new repo holding a fake ranker, the shipped pin and empty logs. */
async function newRepo() {
  const dir = join(tmp, `repo-${++repos}`);
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await commit(dir, {
    'src/search.js': 'export const RRF_K = 60;\n',
    'eval/dev/queries.json': '{"version":"dev-test","queries":[]}\n',
    'eval/lib/baseline.mjs': pinFile(PIN),
    'eval/holdout-ledger.md': LEDGER_HEAD,
    'eval/count-log.md': COUNT_HEAD,
  }, 'ranker');
  return dir;
}

/** @param {string} sha */
const pinFile = (sha) => `export const SHIPPED_BASELINE = Object.freeze({ ref: '${sha}', sha: '${sha}' });\n`;
const LEDGER_HEAD = '# Holdout ledger\n\n| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] | rule | baseline ranker |\n|---|---|---|---|---|---|---|---|---|---|\n';
const COUNT_HEAD = '# Count log\n\n| date | set | kind | run | count | route |\n|---|---|---|---|---|---|\n';
/** @param {{ verdict?: string, ranker?: string, set?: string }} [o] */
const ledgerRow = (o = {}) => `| 2026-11-20 | ${o.set ?? 'holdout'} | abc1234 | cand | shipped | ${o.verdict ?? 'pass'} | +0.01 | +0.01 | general | ${(o.ranker ?? PIN).slice(0, 7)} |\n`;
/** @param {string} route */
const countRow = (route) => `| 2026-11-20 | holdout | count: lists-differing-by-group | cand vs shipped | 0 | ${route} |\n`;

/**
 * @param {string} dir
 * @param {Record<string, string | null>} files
 * @param {string} message
 */
async function commit(dir, files, message) {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) await rm(join(dir, path), { force: true });
    else {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), body);
    }
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** @param {string} dir @param {string} [rev] */
const readLock = async (dir, rev = 'HEAD') => JSON.parse(git(dir, ['show', `${rev}:${LOCK_PATH}`]));

/**
 * Lists in the lock's shape from a compact spec: set -> mode -> id -> [status, codes].
 * @param {Record<string, Record<string, Record<string, [number, string[]]>>>} spec
 */
function listsOf(spec) {
  /** @type {Record<string, Record<string, Record<string, string>>>} */
  const out = {};
  for (const [set, modes] of Object.entries(spec)) {
    out[set] = {};
    for (const [mode, queries] of Object.entries(modes)) {
      out[set][mode] = Object.fromEntries(Object.entries(queries).map(([id, [status, codes]]) => [id, queryHash(status, codes)]));
    }
  }
  return out;
}

/** The base lists: two dev queries and one fixture query in every mode. */
const SPEC = () => ({
  dev: {
    filtered: { 'd-001': [200, ['CS1010', 'CS2030']], 'd-002': [200, ['MA1521']] },
    'strip-ng': { 'd-001': [200, ['CS1010', 'CS2030']], 'd-002': [200, ['MA1521']] },
    unfiltered: { 'd-001': [200, ['CS1010', 'CS2030', 'CS2040']], 'd-002': [200, ['MA1521']] },
  },
  fixture: {
    filtered: { 'fx-01': [200, ['ZZ1001']] },
    'strip-ng': { 'fx-01': [200, ['ZZ1001']] },
    unfiltered: { 'fx-01': [200, ['ZZ1001', 'ZZ1002']] },
  },
});
/** @typedef {ReturnType<typeof SPEC>} Spec */
/** @param {(s: any) => void} edit */
const edited = (edit) => { const s = /** @type {any} */ (SPEC()); edit(s); return listsOf(s); };

/**
 * @param {string} dir
 * @param {{ lists: any, evidence: { kind: string, ref: string }, inputsHash?: string }} o
 */
const lockText = (dir, o) => `${JSON.stringify({
  schema: 'vnm-ranking-lock/1',
  inputsHash: o.inputsHash ?? inputsHash(dir, 'HEAD'),
  embedding: EMBEDDING,
  corpus: CORPUS,
  evidence: o.evidence,
  lists: o.lists,
}, null, 1)}\n`;

/** A repo whose base commit holds the bootstrap lock over SPEC's lists. */
async function withBootstrap() {
  const dir = await newRepo();
  const base = await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: listsOf(SPEC()), evidence: { kind: 'bootstrap', ref: 'a23601d' } }) }, 'lock');
  return { dir, base };
}

/** A recompute that returns these lists (and fails a test that expects the fast path if called). */
const recomputing = (/** @type {any} */ lists) => vi.fn(async () => ({ embedding: EMBEDDING, corpus: CORPUS, lists }));
const notCalled = () => vi.fn(async () => { throw new Error('recompute must not run on the fast path'); });

/**
 * @param {string} dir
 * @param {string | undefined} base
 * @param {any} recompute
 */
const gate = (dir, base, recompute) => checkGate({ repo: dir, base, head: 'HEAD', recompute });

describe('the ranking lock gate: inputs', () => {
  it('passes on the fast path when the inputs are unchanged since the lock', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'docs/REFERENCE.md': 'a doc\n' }, 'docs');
    const recompute = notCalled();
    const r = await gate(dir, base, recompute);
    expect(r).toMatchObject({ ok: true, path: 'fast' });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('passes on the fast path when the inputs equal a green base\'s, though the lock\'s inputsHash is stale', async () => {
    const { dir } = await withBootstrap();
    // A neutral ranker change merged: the lock was not rewritten, so its inputsHash is stale.
    const green = await commit(dir, { 'src/search.js': 'export const RRF_K = 60; // neutral\n' }, 'neutral');
    expect((await readLock(dir)).inputsHash).not.toBe(inputsHash(dir, 'HEAD'));
    await commit(dir, { 'docs/x.md': 'doc\n' }, 'docs');
    const recompute = notCalled();
    expect(await gate(dir, green, recompute)).toMatchObject({ ok: true, path: 'fast' });
    expect(recompute).not.toHaveBeenCalled();
  });

  it('recomputes, with no fast path, when there is no base to compare with', async () => {
    const { dir } = await withBootstrap();
    const recompute = recomputing(listsOf(SPEC()));
    expect(await gate(dir, undefined, recompute)).toMatchObject({ ok: true, path: 'recompute' });
    expect(recompute).toHaveBeenCalledOnce();
  });
});

describe('the ranking lock gate: lock edits', () => {
  it('a lock-only edit never takes the fast path, and fails without evidence', async () => {
    const { dir, base } = await withBootstrap();
    const lock = await readLock(dir);
    lock.lists.dev.filtered['d-001'] = queryHash(200, ['CS9999']);
    await commit(dir, { [LOCK_PATH]: `${JSON.stringify(lock, null, 1)}\n` }, 'lock-only');
    const recompute = recomputing(listsOf(SPEC()));
    const r = await gate(dir, base, recompute);
    expect(recompute).toHaveBeenCalledOnce();
    expect(r.ok).toBe(false);
    expect(r.path).toBe('recompute');
    expect(r.problems.join('\n')).toMatch(/dev filtered d-001/);
  });

  it('a lock-only edit of the evidence alone still recomputes', async () => {
    const { dir, base } = await withBootstrap();
    const lock = await readLock(dir);
    lock.evidence = { kind: 'no-look', ref: '1' };
    await commit(dir, { [LOCK_PATH]: `${JSON.stringify(lock, null, 1)}\n` }, 'evidence only');
    const recompute = recomputing(listsOf(SPEC()));
    const r = await gate(dir, base, recompute);
    expect(recompute).toHaveBeenCalledOnce();
    expect(r.path).toBe('recompute');
  });

  it('fails a lock whose inputsHash was hand-set to HEAD\'s over a ranking change', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 61;\n' }, 'ranking change');
    const lock = await readLock(dir);
    lock.inputsHash = inputsHash(dir, 'HEAD');
    await commit(dir, { [LOCK_PATH]: `${JSON.stringify(lock, null, 1)}\n` }, 'hand-set inputsHash');
    expect(inputsHash(dir, 'HEAD')).toBe(lock.inputsHash);
    const recompute = recomputing(edited((s) => { s.dev.filtered['d-002'] = [200, ['MA1522']]; }));
    const r = await gate(dir, base, recompute);
    expect(recompute).toHaveBeenCalledOnce();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/dev filtered d-002/);
  });
});

describe('the ranking lock gate: lists', () => {
  it('passes neutral lists after a ranker change, by recomputing, and the lock is not rewritten', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 60; // refactor\n' }, 'neutral');
    const recompute = recomputing(listsOf(SPEC()));
    expect(await gate(dir, base, recompute)).toMatchObject({ ok: true, path: 'recompute' });
  });

  it('fails a changed list with no lock change, naming the query and its statuses', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 61;\n' }, 'RRF_K');
    const r = await gate(dir, base, recomputing(edited((s) => { s.dev.filtered['d-001'] = [200, ['CS2030', 'CS1010']]; })));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringMatching(/dev filtered d-001: status 200 -> 200/)]));
  });

  it('fails a lock whose embedding version or corpus is not the one the lists were computed with', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'eval/embeddings.json': '{"default":"emb-test-v2"}\n' }, 'embedding');
    const recompute = vi.fn(async () => ({ embedding: 'emb-test-v2', corpus: CORPUS, lists: listsOf(SPEC()) }));
    const r = await gate(dir, base, recompute);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/embedding/);
  });
});

describe('the ranking lock gate: changes the old by-hand gate missed', () => {
  it('a status-only change (a 500 never hashes like an empty 200)', async () => {
    expect(queryHash(500, [])).not.toBe(queryHash(200, []));
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 60; // throws\n' }, 'status');
    const r = await gate(dir, base, recomputing(edited((s) => { s.dev.filtered['d-002'] = [500, ['MA1521']]; })));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/dev filtered d-002: status 200 -> 500/)]);
  });

  it('a fixture-only change', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 60; // fixture\n' }, 'fixture');
    const r = await gate(dir, base, recomputing(edited((s) => { s.fixture['strip-ng']['fx-01'] = [200, ['ZZ1002']]; })));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/fixture strip-ng fx-01/)]);
  });

  it('an unfiltered-only change', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 60; // unfiltered\n' }, 'unfiltered');
    const r = await gate(dir, base, recomputing(edited((s) => { s.dev.unfiltered['d-001'] = [200, ['CS1010']]; })));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/dev unfiltered d-001/)]);
  });
});

describe('the ranking lock gate: evidence for a ranking change', () => {
  const CHANGED = () => edited((s) => { s.dev.filtered['d-001'] = [200, ['CS2030', 'CS1010']]; });

  /**
   * Commits a ranking change at HEAD with the lock rewritten to CHANGED's lists.
   * @param {string} dir
   * @param {{ kind: string, ref: string }} evidence
   * @param {Record<string, string>} [files]
   */
  async function rankingChange(dir, evidence, files = {}) {
    await commit(dir, { 'src/search.js': `export const RRF_K = ${61 + repos};\n`, ...files }, 'ranking change');
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: CHANGED(), evidence }) }, 'lock');
  }
  /** @param {string} dir */
  const ledger = async (dir) => readFile(join(dir, 'eval/holdout-ledger.md'), 'utf8');
  /** @param {string} dir */
  const countLog = async (dir) => readFile(join(dir, 'eval/count-log.md'), 'utf8');

  it('passes a holdout pass row appended after the base lock, against the base commit\'s pin', async () => {
    const { dir, base } = await withBootstrap();
    await rankingChange(dir, { kind: 'holdout-pass', ref: '1' }, { 'eval/holdout-ledger.md': `${await ledger(dir)}${ledgerRow()}` });
    expect(await gate(dir, base, recomputing(CHANGED()))).toMatchObject({ ok: true, path: 'recompute', problems: [] });
  });

  it('refuses a row an earlier lock already cited', async () => {
    const { dir } = await withBootstrap();
    await rankingChange(dir, { kind: 'holdout-pass', ref: '1' }, { 'eval/holdout-ledger.md': `${await ledger(dir)}${ledgerRow()}` });
    const base = git(dir, ['rev-parse', 'HEAD']);
    await commit(dir, { 'src/search.js': 'export const RRF_K = 99;\n' }, 'another change');
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: edited((s) => { s.dev.filtered['d-002'] = [200, []]; }), evidence: { kind: 'holdout-pass', ref: '1' } }) }, 'reuse');
    const r = await gate(dir, base, recomputing(edited((s) => { s.dev.filtered['d-002'] = [200, []]; })));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/already cited/);
  });

  it('refuses a fail row', async () => {
    const { dir, base } = await withBootstrap();
    await rankingChange(dir, { kind: 'holdout-pass', ref: '1' }, { 'eval/holdout-ledger.md': `${await ledger(dir)}${ledgerRow({ verdict: 'fail' })}` });
    const r = await gate(dir, base, recomputing(CHANGED()));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/verdict fail/);
  });

  it('refuses a pass row against an older pin', async () => {
    const { dir, base } = await withBootstrap();
    await rankingChange(dir, { kind: 'holdout-pass', ref: '1' }, { 'eval/holdout-ledger.md': `${await ledger(dir)}${ledgerRow({ ranker: OLD_PIN })}` });
    const r = await gate(dir, base, recomputing(CHANGED()));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/baseline ranker 0b5f360.*a23601d/);
  });

  it('passes a count-log row with a no-look route, appended after the base lock', async () => {
    const { dir, base } = await withBootstrap();
    await rankingChange(dir, { kind: 'no-look', ref: '1' }, { 'eval/count-log.md': `${await countLog(dir)}${countRow('representative-only')}` });
    expect(await gate(dir, base, recomputing(CHANGED()))).toMatchObject({ ok: true, problems: [] });
  });

  it('refuses a count-log row with no route', async () => {
    const { dir, base } = await withBootstrap();
    await rankingChange(dir, { kind: 'no-look', ref: '1' }, { 'eval/count-log.md': `${await countLog(dir)}${countRow('—')}` });
    const r = await gate(dir, base, recomputing(CHANGED()));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/route/);
  });

  it('refuses a stale count-log row, one already there when the base lock was written', async () => {
    const dir = await newRepo();
    await commit(dir, { 'eval/count-log.md': `${COUNT_HEAD}${countRow('group-first')}` }, 'old count');
    const base = await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: listsOf(SPEC()), evidence: { kind: 'bootstrap', ref: 'a23601d' } }) }, 'lock');
    await rankingChange(dir, { kind: 'no-look', ref: '1' });
    const r = await gate(dir, base, recomputing(CHANGED()));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/not appended after the base lock/);
  });

  it('passes a revert to an earlier lock\'s lists', async () => {
    const { dir } = await withBootstrap();
    const first = git(dir, ['rev-parse', 'HEAD']);
    await rankingChange(dir, { kind: 'holdout-pass', ref: '1' }, { 'eval/holdout-ledger.md': `${await ledger(dir)}${ledgerRow()}` });
    const base = git(dir, ['rev-parse', 'HEAD']);
    await commit(dir, { 'src/search.js': 'export const RRF_K = 60;\n' }, 'revert');
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: listsOf(SPEC()), evidence: { kind: 'revert', ref: first } }) }, 'revert lock');
    expect(await gate(dir, base, recomputing(listsOf(SPEC())))).toMatchObject({ ok: true, problems: [] });
    // A "revert" to lists no earlier lock held is refused.
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: edited((s) => { s.dev.filtered['d-002'] = [200, []]; }), evidence: { kind: 'revert', ref: first } }) }, 'false revert');
    const r = await gate(dir, base, recomputing(edited((s) => { s.dev.filtered['d-002'] = [200, []]; })));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/revert/);
  });

  it('refuses an unchanged evidence', async () => {
    const { dir, base } = await withBootstrap();
    await commit(dir, { 'src/search.js': 'export const RRF_K = 70;\n' }, 'change');
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: CHANGED(), evidence: { kind: 'bootstrap', ref: 'a23601d' } }) }, 'same evidence');
    const r = await gate(dir, base, recomputing(CHANGED()));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/evidence is unchanged/);
  });

  it('refuses an ADR pin line as evidence (pin lines are written after the merge)', async () => {
    const { dir, base } = await withBootstrap();
    await rankingChange(dir, { kind: 'pin', ref: 'a23601d' });
    const r = await gate(dir, base, recomputing(CHANGED()));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/pin line/);
  });
});

describe('the ranking lock gate: bootstrap', () => {
  it('allows bootstrap only when the base has no lock, and refuses a second', async () => {
    const dir = await newRepo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: listsOf(SPEC()), evidence: { kind: 'bootstrap', ref: 'a23601d' } }) }, 'lock');
    expect(await gate(dir, base, recomputing(listsOf(SPEC())))).toMatchObject({ ok: true, path: 'recompute', problems: [] });
    const locked = git(dir, ['rev-parse', 'HEAD']);
    await commit(dir, { 'src/search.js': 'export const RRF_K = 80;\n' }, 'change');
    await commit(dir, { [LOCK_PATH]: lockText(dir, { lists: edited((s) => { s.dev.filtered['d-002'] = [200, []]; }), evidence: { kind: 'bootstrap', ref: 'HEAD' } }) }, 'second bootstrap');
    const r = await gate(dir, locked, recomputing(edited((s) => { s.dev.filtered['d-002'] = [200, []]; })));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/bootstrap/);
  });

  it('fails when HEAD has no lock at all', async () => {
    const dir = await newRepo();
    const r = await gate(dir, undefined, notCalled());
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/no eval\/ranking-lock\.json/);
  });

  it('no-look routes are ADR 0003\'s four', () => {
    expect([...NO_LOOK_ROUTES].sort()).toEqual(['answerable-floor', 'gated-without-a-look', 'group-first', 'representative-only']);
  });
});

/**
 * A copy of the code the closure walks (the runner, eval/lib, the lock CLI, scripts/, src/, the
 * fakes and the eval config): no set, ledger or log is copied.
 * @param {string} name
 */
async function runnerTree(name) {
  const root = join(tmp, name);
  for (const p of ['eval/runner', 'eval/lib', 'eval/lock.mjs', 'scripts', 'src', 'test/fakes.js', 'vitest.eval.config.mjs']) {
    await cp(join(REPO, p), join(root, p), { recursive: true });
  }
  return root;
}

describe('LOCK_INPUTS completeness', () => {
  it('covers the static import closure of the eval runner, with no unresolved import', async () => {
    expect(await lockInputsProblems({ root: REPO })).toEqual([]);
  });

  it('covers package-lock.json (workerd and its SQLite), the fakes, the eval config, the study map and the sets', () => {
    for (const p of ['package-lock.json', 'test/fakes.js', 'vitest.eval.config.mjs', 'eval/study-map.json', 'eval/dev', 'eval/fixtures', 'eval/embeddings.json', 'src', 'data', 'migrations', 'scripts/lib.mjs', 'test/wrangler.test.jsonc']) {
      expect(LOCK_INPUTS).toContain(p);
    }
    expect(LOCK_INPUTS.some((p) => p.startsWith('eval/v1'))).toBe(false);
  });

  it('fails when sets.mjs imports a file outside LOCK_INPUTS', async () => {
    const root = await runnerTree('closure');
    await writeFile(join(root, 'eval/lib/unlisted.mjs'), 'export const x = 1;\n');
    const sets = await readFile(join(root, 'eval/lib/sets.mjs'), 'utf8');
    await writeFile(join(root, 'eval/lib/sets.mjs'), `import './unlisted.mjs';\n${sets}`);
    expect(await lockInputsProblems({ root })).toEqual([expect.stringMatching(/eval\/lib\/unlisted\.mjs.*outside LOCK_INPUTS/)]);
  });

  it('fails on a dynamic import it cannot resolve to a listed path', async () => {
    const root = await runnerTree('closure-dynamic');
    const sets = await readFile(join(root, 'eval/lib/sets.mjs'), 'utf8');
    await writeFile(join(root, 'eval/lib/sets.mjs'), `${sets}\nexport const late = (/** @type {string} */ p) => import(p);\n`);
    expect(await lockInputsProblems({ root })).toEqual([expect.stringMatching(/eval\/lib\/sets\.mjs.*dynamic import/)]);
  });
});
