// @ts-check
// Phase 7 7A: `eval:count --route` and `eval:representatives --route` write ADR 0003's no-look
// route into the count log's `route` column, the evidence `eval:lock -- --evidence no-look <row>`
// cites. Every set, run and log here lives in a temp dir: the count runs on a `selftest` set (its
// count log sits in its own directory) with a throwaway key and synthetic queries, and the
// representatives check on a copy of the fixture set. Neither tool is ever pointed at the real
// ledger or the real count log.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKey, readKey, updateManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { countLogRows } from '../../eval/lib/count-log.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
/** @type {Buffer} */
let key;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-route-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
  key = await readKey(keyFile);
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const today = () => new Date().toISOString().slice(0, 10);
const QUERIES = { schema: 'vnm-eval-queries/1', set: 'selftest', version: 'route-v1', queries: [{ id: 'q1', text: 'alpha' }, { id: 'q2', text: 'beta' }] };
const sha = createHash('sha256').update(JSON.stringify(QUERIES.queries)).digest('hex');
// --by-group compares the runs' corpus with the one eval/groups.json was built from.
const corpusSha = JSON.parse(await readFile(join(REPO, 'eval', 'groups.json'), 'utf8')).corpus.moduleInfoSha256;
/** @param {string} variant @param {Record<string, string[]>} lists */
const run = (variant, lists) => ({
  schema: 'vnm-eval-run/1', variant, set: 'selftest', ranker: { ref: 'x', sha: 'e'.repeat(40) },
  corpus: { moduleInfoSha256: corpusSha },
  queries: { version: QUERIES.version, sha256: sha, count: 2 },
  config: { mode: 'hybrid', filters: true },
  results: Object.fromEntries(Object.entries(lists).map(([id, codes]) => [id, { status: 200, codes }])),
  docs: {},
});

let sets = 0;
async function selftestSet() {
  const dir = join(tmp, `selftest-${++sets}`);
  await writeEncryptedJson(join(dir, 'queries.json.enc'), QUERIES, key, 'selftest');
  await writeEncryptedJson(join(dir, 'runs', 'run-cand.json.enc'), run('cand', { q1: ['CS1010'], q2: ['MA1521'] }), key, 'selftest');
  await writeEncryptedJson(join(dir, 'runs', 'run-shipped.json.enc'), run('shipped', { q1: ['CS1010'], q2: ['MA1521'] }), key, 'selftest');
  await updateManifest(dir);
  return dir;
}

/** @param {string} script @param {string[]} args */
function node(script, args) {
  const r = spawnSync(process.execPath, [join(REPO, 'eval', script), ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} dir */
const rows = async (dir) => (existsSync(join(dir, 'count-log.md')) ? countLogRows(await readFile(join(dir, 'count-log.md'), 'utf8')) : []);

describe('eval:count --route', () => {
  it('writes the route into the count log\'s route column', async () => {
    const dir = await selftestSet();
    const r = node('count.mjs', ['--custodian', '--set', 'selftest', '--set-dir', dir, '--lists-differing', '--by-group', '--run', 'cand', '--baseline', 'shipped', '--route', 'representative-only']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('0\n');
    expect(await rows(dir)).toEqual([{ date: today(), set: 'selftest', kind: 'count: lists-differing-by-group', run: 'cand vs shipped', count: '0', route: 'representative-only' }]);
  });

  it('writes an empty route without --route', async () => {
    const dir = await selftestSet();
    expect(node('count.mjs', ['--custodian', '--set', 'selftest', '--set-dir', dir, '--lists-differing', '--run', 'cand', '--baseline', 'shipped']).stdout).toBe('0\n');
    expect((await rows(dir)).map((x) => x.route)).toEqual(['—']);
  });

  it('refuses a route ADR 0003 does not name, before counting anything', async () => {
    const dir = await selftestSet();
    const r = node('count.mjs', ['--custodian', '--set', 'selftest', '--set-dir', dir, '--lists-differing', '--run', 'cand', '--baseline', 'shipped', '--route', 'trust-me']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/route/);
    expect(await rows(dir)).toEqual([]);
  });
});

describe('eval:representatives --route', () => {
  /** A copy of the fixture set with two stored runs. @param {Record<string, string[]>} candLists */
  async function fixtureSet(candLists) {
    const dir = join(tmp, `fixture-${++sets}`);
    await mkdir(join(dir, 'runs'), { recursive: true });
    for (const f of ['queries.json', 'corpus.json']) await cp(join(REPO, 'eval', 'fixtures', f), join(dir, f));
    const queries = JSON.parse(await readFile(join(dir, 'queries.json'), 'utf8')).queries;
    const corpus = JSON.parse(await readFile(join(dir, 'corpus.json'), 'utf8'));
    const qsha = createHash('sha256').update(JSON.stringify(queries)).digest('hex');
    /** @param {string} variant @param {Record<string, string[]>} lists */
    const stored = (variant, lists) => ({
      variant, config: { mode: 'hybrid', filters: true, strip: ['ng'] }, queries: { sha256: qsha },
      corpus: { moduleInfoSha256: corpus.source?.moduleInfoSha256 ?? 'n/a' },
      results: Object.fromEntries(queries.map((/** @type {{ id: string }} */ q) => [q.id, { status: 200, codes: lists[q.id] ?? [] }])),
    });
    await writeFile(join(dir, 'runs', 'shipped.json'), JSON.stringify(stored('shipped', {})));
    await writeFile(join(dir, 'runs', 'cand.json'), JSON.stringify(stored('cand', candLists)));
    return { dir, first: queries[0].id };
  }

  it('writes a row with the route when the check passes', async () => {
    const { dir } = await fixtureSet({});
    const r = node('representatives.mjs', ['--set', 'fixture', '--set-dir', dir, '--run', 'cand', '--baseline', 'shipped', '--route', 'representative-only']);
    expect(r.code).toBe(0);
    expect(await rows(dir)).toEqual([{ date: today(), set: 'fixture', kind: 'representatives', run: 'cand vs shipped', count: '0', route: 'representative-only' }]);
  });

  it('writes nothing when the check fails, and nothing without --route', async () => {
    const failing = await fixtureSet({});
    const cand = JSON.parse(await readFile(join(failing.dir, 'runs', 'cand.json'), 'utf8'));
    cand.results[failing.first] = { status: 500, codes: [] };
    await writeFile(join(failing.dir, 'runs', 'cand.json'), JSON.stringify(cand));
    expect(node('representatives.mjs', ['--set', 'fixture', '--set-dir', failing.dir, '--run', 'cand', '--baseline', 'shipped', '--route', 'representative-only']).code).toBe(1);
    expect(await rows(failing.dir)).toEqual([]);
    const plain = await fixtureSet({});
    expect(node('representatives.mjs', ['--set', 'fixture', '--set-dir', plain.dir, '--run', 'cand', '--baseline', 'shipped']).code).toBe(0);
    expect(await rows(plain.dir)).toEqual([]);
  });

  it('refuses a route ADR 0003 does not name', async () => {
    const { dir } = await fixtureSet({});
    const r = node('representatives.mjs', ['--set', 'fixture', '--set-dir', dir, '--run', 'cand', '--baseline', 'shipped', '--route', 'trust-me']);
    expect(r.code).toBe(1);
    expect(await rows(dir)).toEqual([]);
  });
});
