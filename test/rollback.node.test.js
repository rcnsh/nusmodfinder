// @ts-check
// Phase 7 7B: `npm run rollback` (scripts/rollback.mjs). The target is `--to <id>` or the
// deployment before the live one; its commit, data version (and 7D's catalogueKey) come from
// its `deploy/*` tag. D1 is read directly over the REST query (no Worker session, no working
// tree code), and the rollback refuses unless every tagged field equals D1's, or
// `--accept-data-mismatch`. Then `wrangler rollback`, a `rollback/*` tag on the target's
// commit (a failed push is reported, not fatal), and the smoke command. No clean tree and no CI
// needed. Fake exec and D1 only.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_CHECKS } from '../scripts/guard.mjs';
import { rollback } from '../scripts/rollback.mjs';
import { DV, NOW, TAG_FETCH, TAG_LIST, fakeD1 } from './deploy-fakes.js';

const LIVE = '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
const PREV = 'b0834844-f6fd-4bb9-838d-a45927c195fb';
const OLDER = 'f8aefeab-49c4-4548-b994-73bc6bae4f86';
const PREV_COMMIT = 'a23601de0b15934960bfef1d8b56ab3e80fa5587';
const OLDER_COMMIT = '0b5f360c7faea8424215b4d4ddde81ebb1d850ff';
const DEPLOYMENTS = JSON.stringify([
  { id: 'd1', created_on: '2026-11-11T18:39:46Z', versions: [{ version_id: OLDER, percentage: 100 }] },
  { id: 'd2', created_on: '2026-11-11T23:59:33Z', versions: [{ version_id: PREV, percentage: 100 }] },
  { id: 'd3', created_on: '2026-11-12T10:15:30Z', versions: [{ version_id: LIVE, percentage: 100 }] },
]);
/** @param {string} id @param {string} dv @param {Record<string, string>} [more] */
const tagText = (id, dv, more = {}) => [`deploy ${id.slice(0, 8)}`, `versionId: ${id}`, `dataVersion: ${dv}`, ...Object.entries(more).map(([k, v]) => `${k}: ${v}`)].join('\n\n');

/** @param {Record<string, any>} [over] */
function fakeExec(over = {}) {
  /** @type {Record<string, any>} */
  const table = {
    'npx wrangler deployments list --json': { stdout: DEPLOYMENTS },
    [TAG_FETCH]: {},
    [TAG_LIST]: { stdout: `deploy/20261111T183946Z-f8aefeab\t${OLDER_COMMIT}\ndeploy/20261111T235933Z-b0834844\t${PREV_COMMIT}\ndeploy/20261112T101530Z-9b1c2d3e\tdddd\n` },
    'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844': { stdout: tagText(PREV, DV) },
    'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T183946Z-f8aefeab': { stdout: tagText(OLDER, DV) },
    ...over,
  };
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'npx' && args[1] === 'rollback') return { code: over.rollback?.code ?? 0, stdout: 'rolled back\n' };
    if (cmd === 'git' && args[0] === 'tag') return { code: over.tag?.code ?? 0, stdout: '' };
    if (cmd === 'git' && args[0] === 'push') return { code: over.push?.code ?? 0, stdout: '' };
    const hit = table[[cmd, ...args].join(' ')];
    if (!hit) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '' };
  };
  return { exec, calls };
}

/** @type {string} */
let runsDir;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'vnm-rollback-runs-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });
const records = () => readdirSync(runsDir).sort().map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')));

/**
 * @param {import('../scripts/deploy.mjs').Exec} exec
 * @param {{ argv?: string[], d1?: ReturnType<typeof fakeD1>, checks?: import('../scripts/guard.mjs').GuardCheck[] }} [o]
 */
async function run(exec, o = {}) {
  /** @type {string[]} */
  const out = [];
  const d1 = o.d1 ?? fakeD1();
  let sessions = 0;
  const code = await rollback({
    argv: ['--yes', ...(o.argv ?? [])], exec, log: (m) => out.push(m), error: (m) => out.push(m), runsDir, now: () => NOW,
    d1: async () => { sessions++; return d1.client; }, ...(o.checks ? { checks: o.checks } : {}),
  });
  return { code, out: out.join('\n'), d1, sessions };
}
const rolledBack = (/** @type {string[][]} */ calls) => calls.find((c) => c[0] === 'npx' && c[2] === 'rollback');

describe('npm run rollback', () => {
  it('defaults to the deployment before the live one, checks D1 against its tag, rolls back, tags its commit and prints the smoke', async () => {
    const { exec, calls } = fakeExec();
    const { code, out } = await run(exec);
    expect(code).toBe(0);
    expect(rolledBack(calls)).toEqual(['npx', 'wrangler', 'rollback', PREV, '--message', 'rollback to deploy/20261111T235933Z-b0834844', '-y']);
    const tag = /** @type {string[]} */ (calls.find((c) => c[1] === 'tag'));
    expect(tag.slice(0, 5)).toEqual(['git', 'tag', '-a', 'rollback/20261112T101530Z-b0834844', PREV_COMMIT]);
    expect(tag).toContain(`versionId: ${PREV}`);
    expect(tag).toContain(`previousVersionId: ${LIVE}`);
    expect(tag).toContain(`dataVersion: ${DV}`);
    expect(calls).toContainEqual(['git', 'push', 'origin', 'refs/tags/rollback/20261112T101530Z-b0834844']);
    expect(out).toContain(`npm run smoke -- --expect ${PREV_COMMIT}`);
    expect(records()).toEqual([expect.objectContaining({
      script: 'rollback', outcome: 'ok', versions: expect.objectContaining({ versionId: PREV, previousVersionId: LIVE, dataVersion: DV }),
      read: [expect.objectContaining({ what: expect.stringMatching(/D1 rows/), actual: 6801 })],
    })]);
  });

  it('takes --to, by full id or its first 8', async () => {
    for (const to of [OLDER, OLDER.slice(0, 8)]) {
      const { exec, calls } = fakeExec();
      expect((await run(exec, { argv: ['--to', to] })).code).toBe(0);
      expect(rolledBack(calls)?.[3]).toBe(OLDER);
      expect(calls.find((c) => c[1] === 'tag')?.slice(3, 5)).toEqual(['rollback/20261112T101530Z-f8aefeab', OLDER_COMMIT]);
    }
  });

  it('refuses a data-version mismatch unless --accept-data-mismatch, which prints the risk', async () => {
    const { exec, calls } = fakeExec({ 'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844': { stdout: tagText(PREV, 'aaaaaaaaaaaa') } });
    const refused = await run(exec);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/data version/);
    expect(refused.out).toMatch(/d1:restore/);
    expect(rolledBack(calls)).toBeUndefined();
    expect(records()[0]).toMatchObject({ outcome: 'refused' });

    const { exec: exec2, calls: calls2 } = fakeExec({ 'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844': { stdout: tagText(PREV, 'aaaaaaaaaaaa') } });
    const forced = await run(exec2, { argv: ['--accept-data-mismatch'] });
    expect(forced.code).toBe(0);
    expect(forced.out).toMatch(/old bundle against new D1 rows|mismatch/i);
    expect(rolledBack(calls2)).toBeDefined();
  });

  it('refuses a catalogueKey mismatch, or a tag missing a field a check names', async () => {
    /** @type {import('../scripts/guard.mjs').GuardCheck} */
    const catalogue = { name: 'catalogueKey', field: 'catalogueKey', d1: async () => 'cat-now', expected: () => 'unused' };
    const checks = [...GUARD_CHECKS, catalogue];
    const mismatch = fakeExec({ 'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844': { stdout: tagText(PREV, DV, { catalogueKey: 'cat-then' }) } });
    const r1 = await run(mismatch.exec, { checks });
    expect(r1.code).toBe(1);
    expect(r1.out).toMatch(/catalogueKey.*cat-now.*cat-then/s);
    expect(rolledBack(mismatch.calls)).toBeUndefined();

    const missing = fakeExec();
    const r2 = await run(missing.exec, { checks });
    expect(r2.code).toBe(1);
    expect(r2.out).toMatch(/has no catalogueKey/);

    const same = fakeExec({ 'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844': { stdout: tagText(PREV, DV, { catalogueKey: 'cat-now' }) } });
    expect((await run(same.exec, { checks })).code).toBe(0);
  });

  it('refuses a target with no tag, unless --accept-data-mismatch (then no rollback tag)', async () => {
    const none = fakeExec({ [TAG_LIST]: { stdout: '' } });
    const r = await run(none.exec);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/no deploy\/\* tag/);
    expect(rolledBack(none.calls)).toBeUndefined();
    const forced = fakeExec({ [TAG_LIST]: { stdout: '' } });
    expect((await run(forced.exec, { argv: ['--accept-data-mismatch'] })).code).toBe(0);
    expect(forced.calls.some((c) => c[1] === 'tag')).toBe(false);
  });

  it('works from a dirty tree with no CI: it never asks git status or GitHub\'s runs', async () => {
    const { exec, calls } = fakeExec();
    expect((await run(exec)).code).toBe(0);
    expect(calls.some((c) => c[1] === 'status' || c[0] === 'gh')).toBe(false);
  });

  it('never starts a Worker session: D1 is read over the REST query, reads only', async () => {
    const { exec, calls } = fakeExec();
    const { d1, sessions } = await run(exec);
    expect(calls.some((c) => c.includes('dev'))).toBe(false);
    expect(sessions).toBe(1);
    expect(d1.sent.length).toBeGreaterThan(0);
    expect(d1.sent.every((s) => /^\s*SELECT/i.test(s.sql))).toBe(true);
  });

  it('a failed tag push or tag fetch is reported, not fatal', async () => {
    const push = fakeExec({ push: { code: 1 } });
    const r = await run(push.exec);
    expect(r.code).toBe(0);
    expect(r.out).toContain('git push origin refs/tags/rollback/20261112T101530Z-b0834844');
    const offline = fakeExec({ [TAG_FETCH]: { code: 128 } });
    expect((await run(offline.exec)).code).toBe(0);
  });

  it('a failed wrangler rollback fails, with a record', async () => {
    const { exec } = fakeExec({ rollback: { code: 1 } });
    expect((await run(exec)).code).toBe(1);
    expect(records()[0]).toMatchObject({ outcome: 'failed' });
  });

  it('without --yes, asks first and does nothing on no', async () => {
    const { exec, calls } = fakeExec();
    const code = await rollback({ argv: [], exec, log: () => {}, error: () => {}, runsDir, now: () => NOW, d1: async () => fakeD1().client, confirm: async () => false });
    expect(code).toBe(1);
    expect(rolledBack(calls)).toBeUndefined();
  });
});
