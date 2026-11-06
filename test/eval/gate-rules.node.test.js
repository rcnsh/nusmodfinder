// @ts-check
// Phase 3 gate rules (docs/plans/phase3.md §3 P-5b), end to end through the
// CLI, on sets built here from dev-derived synthetic data with a throwaway
// key (no workerd, no Cloudflare, no real holdout file):
//   - the no-answer set by tag: dev reports list unscored ids, encrypted sets
//     print only their count;
//   - change kinds `no-loss` (with `--exempt`) and `answerable-floor`, dev only;
//   - `--gate sc5`, refused on the holdout under the recorded sealed reading,
//     and, in a temporary clone whose SC5_READING says `holdout`, the SC5
//     look recorded in that clone's ledger (never this checkout's).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKey, readKey, updateManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { ledgerRows } from '../../eval/lib/ledger.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { HASHED, treeHash } from '../../eval/lib/workspace.mjs';

const CLI = join(REPO, 'eval', 'cli.mjs');
const PINNED_SHA = '7ac984174ded88cb2b6497d9835b456981acdd99';

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
/** @type {Buffer} */
let key;
let v0Tree = '';
/** @type {string} */
let corpusSha;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-gate-rules-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
  key = await readKey(keyFile);
  const archive = join(tmp, 'eval-v0-archive');
  await mkdir(archive, { recursive: true });
  const present = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `eval-v0:${p}`], { cwd: REPO }).status === 0);
  const tar = spawnSync('git', ['archive', '--format=tar', 'eval-v0', '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
  expect(tar.status).toBe(0);
  expect(spawnSync('tar', ['-x', '-C', archive], { input: tar.stdout }).status).toBe(0);
  v0Tree = await treeHash(archive);
  corpusSha = JSON.parse(await readFile(join(REPO, 'eval', 'groups.json'), 'utf8')).corpus.moduleInfoSha256;
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const pinnedRanker = () => ({ ref: 'eval-v0', sha: PINNED_SHA, dirty: false, treeHash: v0Tree, runner: { sha: PINNED_SHA, dirty: false } });
const candRanker = () => ({ ref: 'WORKTREE', sha: 'c'.repeat(40), dirty: false, treeHash: 'd'.repeat(64), runner: { sha: 'c'.repeat(40), dirty: false } });

const GRADES = [2, 2, 1, 1, 1, 0, 0, 0, 0, 0];
const ANSWERABLE = 12;
const TAGGED = 4;
const UNSCORED = 4;

/**
 * The first 20 dev ids and texts: 12 answerable (`topical`, ten judged
 * codes), 4 tagged `noanswer` (three grade-0 codes; the first also has a
 * grade-2 code, which the tag overrides) and 4 untagged with only grade-0
 * codes (unscored). Codes are made up.
 */
async function derived() {
  const dev = JSON.parse(await readFile(join(REPO, 'eval', 'dev', 'queries.json'), 'utf8'));
  const picked = dev.queries.slice(0, ANSWERABLE + TAGGED + UNSCORED);
  const kind = (/** @type {number} */ i) => (i < ANSWERABLE ? 'answerable' : i < ANSWERABLE + TAGGED ? 'tagged' : 'unscored');
  const queries = picked.map((/** @type {any} */ q, /** @type {number} */ i) => ({
    id: q.id, text: q.text, persona: q.persona, shapes: [kind(i) === 'tagged' ? 'noanswer' : 'topical'],
  }));
  const querySet = { schema: 'vnm-eval-queries/1', set: 'x', version: 'derived-v1', queries };
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
  const qrels = { schema: 'vnm-eval-qrels/1', set: 'x', version: 'qrels-derived-v1', corpus: { moduleInfoSha256: corpusSha }, groups: [], queries: judged };
  const ids = queries.map((/** @type {any} */ q) => q.id);
  return {
    querySet, qrels, ranked,
    answerable: ids.slice(0, ANSWERABLE),
    tagged: ids.slice(ANSWERABLE, ANSWERABLE + TAGGED),
    unscored: ids.slice(ANSWERABLE + TAGGED),
  };
}
/** @typedef {Awaited<ReturnType<typeof derived>>} Derived */

/** @param {any} querySet @param {string} variant @param {string} set @param {any} ranker @param {Record<string, string[]>} codes */
function runFile(querySet, variant, set, ranker, codes) {
  return {
    schema: 'vnm-eval-run/1', variant, set, ranker,
    corpus: { moduleInfoSha256: corpusSha },
    queries: { version: querySet.version, sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'), count: querySet.queries.length },
    config: { mode: 'hybrid', filters: true },
    results: Object.fromEntries(Object.entries(codes).map(([id, c]) => [id, { status: 200, codes: c }])),
    docs: {},
  };
}

/** @param {Record<string, string[]>} codes */
const copy = (codes) => Object.fromEntries(Object.entries(codes).map(([id, c]) => [id, [...c]]));
/** The candidate swaps ranks 5 and 6 (grade 1 and grade 0) on the first answerable query: a small loss. */
const smallLoss = (/** @type {Derived} */ d) => {
  const c = copy(d.ranked);
  const id = d.answerable[0];
  [c[id][4], c[id][5]] = [c[id][5], c[id][4]];
  return c;
};
/** The candidate drops ranks 1 and 2 (both grade 2) to the bottom on the first two answerable queries. */
const bigLoss = (/** @type {Derived} */ d) => {
  const c = copy(d.ranked);
  for (const id of d.answerable.slice(0, 2)) c[id] = [...c[id].slice(2), c[id][0], c[id][1]];
  return c;
};

/**
 * @param {string[]} args
 * @param {{ cli?: string }} [options]
 */
function cli(args, options = {}) {
  const r = spawnSync(process.execPath, [options.cli ?? CLI, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} path */
const rowsOf = async (path) => (existsSync(path) ? ledgerRows(await readFile(path, 'utf8')) : []);

// ---------------------------------------------------------------------------
// dev (the fixture set name, at a temporary --set-dir)

/** @param {string} name @param {(d: Derived) => Record<string, string[]>} cand */
async function devSet(name, cand) {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  const d = await derived();
  await writeFile(join(dir, 'queries.json'), JSON.stringify({ ...d.querySet, set: 'fixture' }));
  await writeFile(join(dir, 'qrels.json'), JSON.stringify({ ...d.qrels, set: 'fixture' }));
  await writeFile(join(dir, 'base.json'), JSON.stringify(runFile(d.querySet, 'base', 'fixture', pinnedRanker(), copy(d.ranked))));
  await writeFile(join(dir, 'cand.json'), JSON.stringify(runFile(d.querySet, 'cand', 'fixture', candRanker(), cand(d))));
  const report = (/** @type {string[]} */ extra = []) => cli(['report', '--set', 'fixture', '--set-dir', dir, '--run', join(dir, 'cand.json'), '--baseline', join(dir, 'base.json'), ...extra]);
  return { dir, d, report };
}

describe('dev reports list unscored queries by id', () => {
  it('names each unscored id once, and counts the tagged query with a grade-2 document as no-answer', async () => {
    const { d, report } = await devSet('dev-unscored', (x) => copy(x.ranked));
    const r = report();
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^answerable \(primary\) n\s+12\s+12$/m);
    expect(r.stdout).toMatch(/^no-answer n\s+4\s+4$/m);
    expect(r.stdout).toMatch(/^unscored n\s+4\s+4$/m);
    expect(r.stdout).toContain(`\nunscored (untagged, no grade-≥1 document; in neither set): ${d.unscored.length}: ${d.unscored.join(', ')}\n`);
  });
});

describe('change kind no-loss (dev only)', () => {
  it('passes an unchanged candidate, which the general rule fails', async () => {
    const { report } = await devSet('noloss-same', (x) => copy(x.ranked));
    expect(report().stdout).toMatch(/^gate \(dev\): FAIL · rule general$/m);
    const r = report(['--change-kind', 'no-loss']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^gate \(dev\): PASS · rule no-loss$/m);
    expect(r.stdout).toMatch(/^ {2}\[pass\] ΔnDCG@10 >= 0 \(no-loss\) — ΔnDCG@10 0\.0000 over 12 primary answerable queries$/m);
  });

  it('fails any loss; --exempt leaves the named dev ids out and prints each with its Δ', async () => {
    const { dir, d, report } = await devSet('noloss-exempt', smallLoss);
    expect(report(['--change-kind', 'no-loss']).stdout).toMatch(/^gate \(dev\): FAIL · rule no-loss$/m);
    const exempt = join(dir, 'exempt.json');
    // An exempt id outside the primary set is listed too.
    await writeFile(exempt, JSON.stringify([d.answerable[0], d.unscored[0]]));
    const r = report(['--change-kind', 'no-loss', '--exempt', exempt]);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^gate \(dev\): PASS · rule no-loss$/m);
    expect(r.stdout).toMatch(/over 11 primary answerable queries, 2 exempt left out$/m);
    expect(r.stdout).toMatch(new RegExp(`^exempt from no-loss \\(dev only\\): 2\\n {2}${d.answerable[0]}  ΔnDCG@10 -0\\.\\d{3}\\n {2}${d.unscored[0]}  ΔnDCG@10 — \\(not primary answerable\\)$`, 'm'));
  });

  it('takes an { ids } object as well, and refuses an id the set does not have', async () => {
    const { dir, d, report } = await devSet('noloss-ids', smallLoss);
    await writeFile(join(dir, 'ok.json'), JSON.stringify({ rule: 'C3-8', ids: [d.answerable[0]] }));
    expect(report(['--change-kind', 'no-loss', '--exempt', join(dir, 'ok.json')]).stdout).toMatch(/^gate \(dev\): PASS · rule no-loss$/m);
    await writeFile(join(dir, 'bad.json'), JSON.stringify(['d-999']));
    const bad = report(['--change-kind', 'no-loss', '--exempt', join(dir, 'bad.json')]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^eval: --exempt .*bad\.json names 1 id the fixture set does not have: d-999/);
    await writeFile(join(dir, 'shape.json'), JSON.stringify({ queries: [] }));
    expect(report(['--change-kind', 'no-loss', '--exempt', join(dir, 'shape.json')]).stderr).toMatch(/--exempt .* must hold a JSON array of query ids/);
  });

  it('--exempt needs --change-kind no-loss', async () => {
    const { dir, d, report } = await devSet('exempt-kind', smallLoss);
    await writeFile(join(dir, 'ex.json'), JSON.stringify([d.answerable[0]]));
    for (const kind of ['general', 'answerable-floor', 'cutoff']) {
      const r = report(['--change-kind', kind, '--exempt', join(dir, 'ex.json')]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--exempt is for --change-kind no-loss only/);
    }
  });
});

describe('change kind answerable-floor (dev only)', () => {
  it('passes a loss within 0.01 and fails a larger one', async () => {
    const small = await devSet('floor-small', smallLoss);
    const ok = small.report(['--change-kind', 'answerable-floor']);
    expect(ok.stderr).toBe('');
    expect(ok.stdout).toMatch(/^gate \(dev\): PASS · rule answerable-floor$/m);
    expect(ok.stdout).toMatch(/^ {2}\[pass\] answerable ΔnDCG@10 >= -0\.01 — ΔnDCG@10 -0\.0\d{3} over 12 primary answerable queries$/m);
    const big = await devSet('floor-big', bigLoss);
    expect(big.report(['--change-kind', 'answerable-floor']).stdout).toMatch(/^gate \(dev\): FAIL · rule answerable-floor$/m);
  });
});

describe('--gate sc5', () => {
  it('is refused on dev', async () => {
    const { report } = await devSet('sc5-dev', (x) => copy(x.ranked));
    const r = report(['--gate', 'sc5']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^eval: --gate sc5 is not taken on dev/);
    expect(r.stdout).not.toMatch(/gate \(dev\)/);
  });

  it('takes only sc5, and no --change-kind or --target-shapes', async () => {
    const { report } = await devSet('sc5-args', (x) => copy(x.ranked));
    expect(report(['--gate', 'holdout']).stderr).toMatch(/^eval: --gate takes only sc5, got holdout/);
    expect(report(['--gate', 'sc5', '--change-kind', 'cutoff']).stderr).toMatch(/--gate sc5 takes no --change-kind or --target-shapes/);
    expect(report(['--gate', 'sc5', '--target-shapes', 'topical']).stderr).toMatch(/--gate sc5 takes no --change-kind or --target-shapes/);
  });
});

// ---------------------------------------------------------------------------
// encrypted sets

/**
 * An encrypted set bound to `as`, with a pinned baseline and a candidate.
 * @param {string} name @param {string} as @param {(d: Derived) => Record<string, string[]>} cand
 */
async function encSet(name, as, cand) {
  const dir = join(tmp, name);
  const d = await derived();
  await writeEncryptedJson(join(dir, 'queries.json.enc'), { ...d.querySet, set: as }, key, as);
  await writeEncryptedJson(join(dir, 'qrels.json.enc'), { ...d.qrels, set: as }, key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-base.json.enc'), runFile(d.querySet, 'base', as, pinnedRanker(), copy(d.ranked)), key, as);
  await writeEncryptedJson(join(dir, 'runs', 'run-cand.json.enc'), runFile(d.querySet, 'cand', as, candRanker(), cand(d)), key, as);
  await updateManifest(dir);
  return { dir, d };
}

describe('the self-test set (holdout rules, its own ledger)', () => {
  /** @param {string} dir @param {string[]} [extra] */
  const report = (dir, extra = []) => cli(['report', '--set', 'selftest', '--set-dir', dir, '--run', 'cand', '--baseline', 'base', ...extra]);

  it('a verdict gives the unscored count and no id', async () => {
    const { dir, d } = await encSet('enc-unscored', 'selftest', (x) => copy(x.ranked));
    const r = report(dir);
    expect(r.stderr).toBe('');
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^holdout verdict: PASS · rule general · /);
    expect(lines[3]).toBe('unscored queries: 4 (untagged, no grade-≥1 document; in neither set)');
    for (const id of [...d.unscored, ...d.tagged, ...d.answerable]) expect(r.stdout).not.toContain(id);
  });

  it.each([['no-loss'], ['answerable-floor']])('refuses --change-kind %s before any look', async (kind) => {
    const { dir } = await encSet(`enc-${kind}`, 'selftest', (x) => copy(x.ranked));
    const r = report(dir, ['--change-kind', kind]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`^eval: --change-kind ${kind} is a dev screen only`));
    expect(await rowsOf(join(dir, 'ledger.md'))).toHaveLength(0);
  });

  it('refuses --exempt before any look', async () => {
    const { dir } = await encSet('enc-exempt', 'selftest', (x) => copy(x.ranked));
    await writeFile(join(tmp, 'enc-exempt.json'), '[]');
    const r = report(dir, ['--change-kind', 'no-loss', '--exempt', join(tmp, 'enc-exempt.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--exempt is dev only/);
    expect(await rowsOf(join(dir, 'ledger.md'))).toHaveLength(0);
  });

  it('refuses --gate sc5 under the recorded sealed reading, before any look', async () => {
    const { dir } = await encSet('enc-sc5', 'selftest', (x) => copy(x.ranked));
    const r = report(dir, ['--gate', 'sc5']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^eval: --gate sc5 is refused on the holdout: ADR 0003 records the sealed-test-set reading/);
    expect(await rowsOf(join(dir, 'ledger.md'))).toHaveLength(0);
  });

  it('`run --gate sc5` is refused: an SC5 verdict is taken on stored runs', async () => {
    const { dir } = await encSet('enc-sc5-run', 'selftest', (x) => copy(x.ranked));
    const r = cli(['run', '--set', 'selftest', '--set-dir', dir, '--variant', 'never', '--baseline', 'base', '--gate', 'sc5']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--gate sc5 is taken with eval:report on stored runs/);
    expect(await rowsOf(join(dir, 'ledger.md'))).toHaveLength(0);
  });
});

describe('the holdout reading, in a temporary clone whose SC5_READING is holdout', () => {
  /** @type {string} */
  let clone;
  /** @type {string} */
  let cloneCli;
  const cloneLedger = () => join(clone, 'eval', 'holdout-ledger.md');
  beforeAll(async () => {
    clone = join(tmp, 'clone');
    expect(spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', REPO, clone]).status).toBe(0);
    expect(spawnSync('git', ['checkout', '--quiet', 'HEAD'], { cwd: clone }).status).toBe(0);
    for (const p of ['eval/cli.mjs', 'eval/lib', 'eval/groups.json', 'eval/holdout-ledger.md', 'scripts']) {
      await rm(join(clone, p), { recursive: true, force: true });
      await cp(join(REPO, p), join(clone, p), { recursive: true });
    }
    const gate = join(clone, 'eval', 'lib', 'gate.mjs');
    const src = await readFile(gate, 'utf8');
    expect(src).toContain("export const SC5_READING = 'sealed';");
    await writeFile(gate, src.replace("export const SC5_READING = 'sealed';", "export const SC5_READING = 'holdout';"));
    cloneCli = join(clone, 'eval', 'cli.mjs');
  });
  const restoreLedger = () => cp(join(REPO, 'eval', 'holdout-ledger.md'), cloneLedger());
  /** @param {string} dir @param {string[]} [extra] */
  const holdout = (dir, extra = []) => cli(['report', '--holdout', '--set-dir', dir, '--run', 'cand', '--baseline', 'base', ...extra], { cli: cloneCli });

  it('--gate sc5 takes the SC5 rule on the holdout and the ledger records rule sc5; a second SC5 look is refused', async () => {
    await restoreLedger();
    const before = (await rowsOf(cloneLedger())).length;
    const { dir } = await encSet('holdout-sc5', 'holdout', (x) => copy(x.ranked));
    const r = holdout(dir, ['--gate', 'sc5']);
    expect(r.stderr).toBe('');
    // An unchanged candidate passes the per-change rule but not SC5.
    expect(r.stdout).toMatch(/^holdout verdict: FAIL · rule sc5 · baseline eval-v0 7ac9841 · qrels qrels-derived-v1$/m);
    const rows = await rowsOf(cloneLedger());
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.slice(1, 2).concat(rows.at(-1)?.slice(5, 6) ?? [], rows.at(-1)?.slice(8) ?? [])).toEqual(['holdout', 'fail', 'sc5', '7ac9841']);
    const again = holdout(dir, ['--gate', 'sc5']);
    expect(`${again.stdout}${again.stderr}`).toBe('eval: holdout run failed (LookLimitError); details withheld\n');
    expect(await rowsOf(cloneLedger())).toHaveLength(before + 1);
    const general = holdout(dir);
    expect(general.stdout).toMatch(/^holdout verdict: PASS · rule general · /m);
  });

  it('the 12th holdout look is kept for SC5: a per-change look is refused at 11, the SC5 look is not', async () => {
    await restoreLedger();
    const filler = '| 2026-11-06 | holdout | ccccccc | filler | base | pass | +0.000 | +0.000 | general | 7ac9841 |\n';
    const have = (await rowsOf(cloneLedger())).filter((c) => c[1] === 'holdout').length;
    await appendFile(cloneLedger(), filler.repeat(11 - have));
    const { dir } = await encSet('holdout-slot12', 'holdout', (x) => copy(x.ranked));
    const general = holdout(dir);
    expect(`${general.stdout}${general.stderr}`).toBe('eval: holdout run failed (LookLimitError); details withheld\n');
    expect(await rowsOf(cloneLedger())).toHaveLength(11);
    const sc5 = holdout(dir, ['--gate', 'sc5']);
    expect(sc5.stderr).toBe('');
    expect(sc5.stdout).toMatch(/^holdout verdict: FAIL · rule sc5 · /m);
    expect(await rowsOf(cloneLedger())).toHaveLength(12);
    await restoreLedger();
  });
});
