// @ts-check
// The code-target rule through the CLIs: the red-team's cutoff demo on the
// committed dev qrels, and `eval:judge -- code-rule --holdout` printing
// counts only (a dev-derived fixture encrypted as holdout, throwaway key).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_RULE } from '../../eval/lib/code-rule.mjs';
import { generateKey, readEncryptedJson, readKey, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { LEDGER, REPO } from '../../eval/lib/sets.mjs';

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-code-rule-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

/** @param {string} script @param {string[]} args */
function node(script, args) {
  const r = spawnSync(process.execPath, [join(REPO, script), ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const readJson = async (/** @type {string} */ p) => JSON.parse(await readFile(join(REPO, p), 'utf8'));
const RED_TEAM = ['d-087', 'd-089', 'd-090', 'd-091', 'd-092'];

describe('the red-team cutoff demo (dev)', () => {
  it('emptying the five code queries fails --change-kind cutoff: they are answerable losses, not correct empties', async () => {
    const querySet = await readJson('eval/dev/queries.json');
    const qrels = await readJson('eval/dev/qrels.json');
    // A baseline that answers every query from the committed qrels (best grade
    // first), so every top 10 is judged; a query with no judgments returns nothing.
    /** @type {Record<string, { status: number, codes: string[] }>} */
    const results = {};
    for (const q of querySet.queries) {
      const j = Object.entries(qrels.queries[q.id]?.judgments ?? {}).map(([code, v]) => ({ code, grade: typeof v === 'number' ? v : v.grade }));
      j.sort((a, b) => b.grade - a.grade || (a.code < b.code ? -1 : 1));
      results[q.id] = { status: 200, codes: j.slice(0, 20).map((x) => x.code) };
    }
    const run = (/** @type {string} */ variant, /** @type {typeof results} */ res) => ({
      schema: 'vnm-eval-run/1', variant, set: 'dev', corpus: { ...qrels.corpus },
      queries: { version: querySet.version, sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'), count: querySet.queries.length },
      config: { mode: 'hybrid' }, results: res, docs: {},
    });
    const emptied = { ...results, ...Object.fromEntries(RED_TEAM.map((id) => [id, { status: 200, codes: [] }])) };
    const dir = join(tmp, 'demo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'base.json'), JSON.stringify(run('base', results)));
    await writeFile(join(dir, 'cand.json'), JSON.stringify(run('cand', emptied)));
    const r = node('eval/cli.mjs', ['report', '--run', join(dir, 'cand.json'), '--baseline', join(dir, 'base.json'), '--change-kind', 'cutoff', '--json', join(dir, 'out.json')]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
    expect(out.qrels).toBe('qrels-dev-v2');
    expect(out.verdict.verdict).toBe('fail');
    expect(out.verdict.checks.find((/** @type {{ name: string }} */ c) => /judged@10/.test(c.name)).pass).toBe(true);
    const check = (/** @type {RegExp} */ re) => out.verdict.checks.find((/** @type {{ name: string }} */ c) => re.test(c.name));
    expect(check(/correct-empty gain/).pass).toBe(false);
    expect(check(/answerable nDCG@10 loss/).pass).toBe(false);
    // The five are answerable now, so emptying them earns no no-answer credit.
    expect(out.comparison.noAnswer.delta).toBe(0);
  });
});

describe('eval:judge -- code-rule on an encrypted set', () => {
  // Dev code queries (public) standing in for holdout ones, a synthetic
  // corpus of their targets, and qrels with judge-A grades to override.
  const CODES = ['BN4207', 'LL4541V', 'LL4541', 'MLE2105', 'MA2101', 'MA2101S', 'EE4502', 'CN2109', 'CN2109X', 'CS2030', 'CS2030S', 'IS4246',
    'MUL2107', 'MUL2109', 'DAO1704X', 'GEC1001', 'GEC1002', 'GEC1003', 'ZZ1000', 'ZZ2000'];
  const title = (/** @type {string} */ c) => `Secret Title ${c.split('').reverse().join('')}`;
  const corpus = {
    source: { release: 'fixture', moduleInfoSha256: 'fixture-mi', ngSha256: 'fixture-ng' },
    modules: CODES.map((code) => ({
      code, title: title(code), description: `Secret description ${code.toLowerCase()}`, level: Number(/\d/.exec(code)?.[0]), credits: 4,
      semesters: [1, 2], ng: code !== 'CN2109X', ngSemesters: code === 'CN2109X' ? [] : [1, 2], faculty: 'F', department: 'D', text: code,
    })),
  };
  const judged = (/** @type {number} */ grade) => ({ grade, source: 'judged', round: 'r1', judges: { 'claude-opus-5-5': { slot: 'A', grade, rationale: 'SECRET-RATIONALE' } } });

  /** @type {any[]} */
  let queries = [];
  /** @param {string} name @param {boolean} encrypted */
  async function makeSet(name, encrypted) {
    const dev = await readJson('eval/dev/queries.json');
    queries = dev.queries.filter((/** @type {any} */ q) => q.origin === 'code');
    const qrels = {
      schema: 'vnm-eval-qrels/1', set: encrypted ? 'holdout' : 'dev', version: `qrels-${encrypted ? 'holdout' : 'dev'}-v1`,
      corpus: { moduleInfoSha256: 'fixture-mi', ngSha256: 'fixture-ng' }, groups: [], judging: [{ round: 'r1' }],
      queries: Object.fromEntries(queries.map((q) => [q.id, { judgments: { ZZ1000: judged(0), ZZ2000: judged(1), ...(q.target === 'MA2101' ? { MA2101: judged(1) } : {}), ...(q.target === 'CS2030' ? { CS2030S: judged(2) } : {}) } }])),
    };
    const dir = join(tmp, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'corpus.json'), JSON.stringify(corpus));
    const set = { version: 'fixture', queries };
    if (encrypted) {
      const key = await readKey(keyFile);
      await writeEncryptedJson(join(dir, 'queries.json.enc'), set, key, 'holdout');
      await writeEncryptedJson(join(dir, 'qrels.json.enc'), qrels, key, 'holdout');
    } else {
      await writeFile(join(dir, 'queries.json'), JSON.stringify(set));
      await writeFile(join(dir, 'qrels.json'), JSON.stringify(qrels));
    }
    return dir;
  }

  it('prints counts only: no id, text, code, title or rationale; no ledger look', async () => {
    const dir = await makeSet('holdout-fixture', true);
    const ledgerBefore = existsSync(join(REPO, LEDGER)) ? await readFile(join(REPO, LEDGER), 'utf8') : null;
    const r = node('eval/judge.mjs', ['code-rule', '--holdout', '--set-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    const printed = r.stdout + r.stderr;
    const secrets = [...queries.flatMap((q) => [q.id, q.text, q.target]), ...CODES, ...CODES.map(title), 'Secret', 'SECRET', 'hard constraint', 'exact code'];
    for (const s of secrets) expect(printed, `printed "${s}"`).not.toContain(s);
    expect(printed).toMatch(/queries affected: \d+/);
    expect(printed).toMatch(/A grades overridden: \d+ \(\d+ up, \d+ down, \d+ unchanged\)/);
    // The ledger is untouched and no lock was taken.
    expect(existsSync(join(REPO, LEDGER)) ? await readFile(join(REPO, LEDGER), 'utf8') : null).toBe(ledgerBefore);
    expect(existsSync(join(REPO, `${LEDGER}.lock`))).toBe(false);
    // The qrels were written, encrypted, with the rule grades.
    const out = await readEncryptedJson(join(dir, 'qrels.json.enc'), await readKey(keyFile), 'holdout');
    expect(out.version).toBe('qrels-holdout-v2');
    expect(out.judging.at(-1)).toMatchObject({ round: CODE_RULE, mode: 'rule', overrides: { total: 2, up: 1, down: 1, same: 0 } });
    const cn = queries.find((q) => q.target === 'CN2109');
    expect(out.queries[cn.id].judgments.CN2109).toMatchObject({ grade: 2, source: 'rule' });
    expect(out.queries[cn.id].judgments.CN2109X).toMatchObject({ grade: 0, source: 'rule' }); // a variant, but not open to NG students
    expect(existsSync(join(dir, 'qrels.json'))).toBe(false);
  });

  it('refuses qrels judged under another NG list (ngSha256 mismatch)', async () => {
    const dir = await makeSet('dev-fixture-ng', false);
    const path = join(dir, 'qrels.json');
    const q = JSON.parse(await readFile(path, 'utf8'));
    q.corpus.ngSha256 = 'ng-OLD';
    await writeFile(path, JSON.stringify(q));
    const r = node('eval/judge.mjs', ['code-rule', '--set', 'dev', '--set-dir', dir]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/ngSha256/);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe('qrels-dev-v1');
  });

  it('the plaintext twin (dev) prints the per-query changes the holdout run withholds', async () => {
    const dir = await makeSet('dev-fixture', false);
    const r = node('eval/judge.mjs', ['code-rule', '--set', 'dev', '--set-dir', dir]);
    expect(r.code, r.stderr).toBe(0);
    const cn = queries.find((q) => q.target === 'CN2109');
    expect(r.stdout).toContain(cn.id);
    expect(r.stdout).toContain('CN2109');
    expect(r.stdout).toMatch(/A grades overridden: 2 \(1 up, 1 down, 0 unchanged\)/);
  });
});
