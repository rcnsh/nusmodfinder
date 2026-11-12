// @ts-check
// Phase 7 7B: `npm run d1:bookmark` records D1's current Time Travel bookmark (a read), and
// `npm run d1:restore -- [--bookmark <id>]` restores the newest recorded one (a D1 write; Time
// Travel restores aren't billed as row writes), recording the restore and re-reading D1's data
// version over the REST query. The code stays where it is. Fake exec and D1 only.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookmark, restore } from '../scripts/d1-time-travel.mjs';
import { RUN_SCHEMA } from '../scripts/run-record.mjs';
import { DV, fakeD1 } from './deploy-fakes.node.mjs';

const NOW = new Date('2026-11-12T12:00:00Z');
const B_OLD = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const B_NEW = '00000085-0000024c-00004c6e-0123456789abcdef0123456789abcdef';
const B_UNDO = '00000085-0000024c-00004c70-ffffffffffffffffffffffffffffffff';

/** @type {string} */
let dir;
/** @type {string} */
let runsDir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-tt-')); runsDir = join(dir, 'runs'); mkdirSync(runsDir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const records = () => readdirSync(runsDir).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(runsDir, f), 'utf8')) }));

/** A committed earlier record. @param {string} file @param {Record<string, unknown>} r */
const put = (file, r) => writeFileSync(join(runsDir, file), JSON.stringify({
  schema: RUN_SCHEMA, finishedAt: r.time, args: [], commit: { sha: null, dirty: false, diffSha256: null }, target: 'nusmods-apac',
  read: [], written: [], requests: {}, versions: {}, details: {}, exitCode: 0, message: null, bookmark: null, ...r,
}));

/** @param {Record<string, { code?: number, stdout?: string }>} table */
function fakeExec(table) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const hit = table[[cmd, ...args].join(' ')];
    if (!hit) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '' };
  };
  return { exec, calls };
}

describe('npm run d1:bookmark', () => {
  it('reads the current bookmark with --json, prints it and records it', async () => {
    const { exec, calls } = fakeExec({ 'npx wrangler d1 time-travel info nusmods-apac --json': { stdout: `${JSON.stringify({ bookmark: B_NEW }, null, 2)}\n` } });
    /** @type {string[]} */
    const out = [];
    expect(await bookmark({ argv: [], exec, log: (m) => out.push(m), error: (m) => out.push(m), runsDir, now: () => NOW })).toBe(0);
    expect(calls).toEqual([['npx', 'wrangler', 'd1', 'time-travel', 'info', 'nusmods-apac', '--json']]);
    expect(out.join('\n')).toContain(B_NEW);
    expect(records()).toEqual([expect.objectContaining({ script: 'd1:bookmark', outcome: 'ok', bookmark: B_NEW, target: 'nusmods-apac', requests: { 'wrangler d1 time-travel info': 1 } })]);
  });

  it('a failed or unreadable read leaves a failed record and no bookmark', async () => {
    for (const answer of [{ code: 1, stdout: '' }, { code: 0, stdout: 'not json' }]) {
      const { exec } = fakeExec({ 'npx wrangler d1 time-travel info nusmods-apac --json': answer });
      expect(await bookmark({ argv: [], exec, log: () => {}, error: () => {}, runsDir, now: () => NOW })).toBe(1);
    }
    expect(records().map((r) => [r.outcome, r.bookmark])).toEqual([['failed', null], ['failed', null]]);
  });
});

describe('npm run d1:restore', () => {
  const RESTORE = (/** @type {string} */ b) => `npx wrangler d1 time-travel restore nusmods-apac --bookmark ${b} --json`;
  const seedRecords = () => {
    put('20261110T090000Z-d1-bookmark-aaaa.json', { script: 'd1:bookmark', time: '2026-11-10T09:00:00.000Z', outcome: 'ok', bookmark: B_OLD });
    put('20261112T110000Z-d1-bookmark-bbbb.json', { script: 'd1:bookmark', time: '2026-11-12T11:00:00.000Z', outcome: 'ok', bookmark: B_NEW });
    put('20261112T113000Z-d1-bookmark-cccc.json', { script: 'd1:bookmark', time: '2026-11-12T11:30:00.000Z', outcome: 'failed', bookmark: null });
    put('20261112T111000Z-ingest-dddd.json', { script: 'ingest', time: '2026-11-12T11:10:00.000Z', outcome: 'ok', bookmark: B_NEW });
  };

  /** @param {import('../scripts/deploy.mjs').Exec} exec @param {string[]} [argv] @param {() => Promise<boolean>} [confirm] */
  async function run(exec, argv = ['--yes'], confirm) {
    /** @type {string[]} */
    const out = [];
    const d1 = fakeD1();
    const code = await restore({ argv, exec, log: (m) => out.push(m), error: (m) => out.push(m), runsDir, now: () => NOW, d1: async () => d1.client, ...(confirm ? { confirm } : {}) });
    return { code, out: out.join('\n'), d1 };
  }

  it('picks the newest bookmark record, says its age and the ingest it came before, restores with --json, records it and re-reads the data version', async () => {
    seedRecords();
    const { exec, calls } = fakeExec({ [RESTORE(B_NEW)]: { stdout: JSON.stringify({ bookmark: B_NEW, previous_bookmark: B_UNDO, message: 'restored' }) } });
    const { code, out, d1 } = await run(exec);
    expect(code).toBe(0);
    expect(calls).toEqual([['npx', 'wrangler', 'd1', 'time-travel', 'restore', 'nusmods-apac', '--bookmark', B_NEW, '--json']]);
    expect(out).toContain(B_NEW);
    expect(out).toMatch(/1 h old|60 min/);
    expect(out).toContain('20261112T111000Z-ingest-dddd.json');
    expect(out).toContain(B_UNDO);
    expect(out).toContain(DV);
    expect(d1.sent.every((s) => /^\s*SELECT/i.test(s.sql))).toBe(true);
    const r = records().find((x) => x.script === 'd1:restore');
    expect(r).toMatchObject({
      outcome: 'ok', bookmark: B_NEW, details: { previousBookmark: B_UNDO, bookmarkRecord: '20261112T110000Z-d1-bookmark-bbbb.json' },
      versions: { dataVersion: DV }, written: [expect.objectContaining({ what: expect.stringMatching(/Time Travel restore/) })],
    });
  });

  it('--bookmark overrides the records', async () => {
    seedRecords();
    const { exec, calls } = fakeExec({ [RESTORE(B_OLD)]: { stdout: JSON.stringify({ bookmark: B_OLD, previous_bookmark: B_UNDO }) } });
    expect((await run(exec, ['--yes', '--bookmark', B_OLD])).code).toBe(0);
    expect(calls[0]).toContain(B_OLD);
  });

  it('asks first without --yes, and restores nothing on no', async () => {
    seedRecords();
    const { exec, calls } = fakeExec({});
    const { code } = await run(exec, [], async () => false);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(records().find((x) => x.script === 'd1:restore')).toMatchObject({ outcome: 'refused' });
  });

  it('refuses with no bookmark record, and a bookmark older than Time Travel\'s 30 days', async () => {
    const empty = await run(fakeExec({}).exec);
    expect(empty.code).toBe(1);
    expect(empty.out).toMatch(/no d1:bookmark record/);
    put('20261001T090000Z-d1-bookmark-eeee.json', { script: 'd1:bookmark', time: '2026-10-01T09:00:00.000Z', outcome: 'ok', bookmark: B_OLD });
    const old = await run(fakeExec({}).exec);
    expect(old.code).toBe(1);
    expect(old.out).toMatch(/30 days/);
  });

  it('a failed restore is a failed record', async () => {
    seedRecords();
    const { exec } = fakeExec({ [RESTORE(B_NEW)]: { code: 1, stdout: '' } });
    expect((await run(exec)).code).toBe(1);
    expect(records().find((x) => x.script === 'd1:restore')).toMatchObject({ outcome: 'failed' });
  });
});
