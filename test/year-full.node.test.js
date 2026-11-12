// @ts-check
// Phase 7 7E, `year check --full` (docs/plans/phase7.md 7E, tests first) and what the deploy
// preflight makes of its record (7B).
//
// --full runs on the Mac with the real archive; these cases use fake documents, a throwaway key
// and a fake release store in temp dirs instead. As the plan says, the two --full cases (a missing
// quote, a rules file edited by hand) run on the Mac only, and skip in CI, where the record's
// presence is what is checked. The preflight cases run everywhere: a fresh --full record satisfies
// the preflight for HEAD, and a rules file edited by hand after it doesn't.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FULL_RECORD, sourceInputsCheck, sourceInputsHash } from '../scripts/preflight.mjs';
import { publish } from '../scripts/sources.mjs';
import { execIn, yearCheckFull } from '../scripts/year.mjs';
import { Y, copyTree, fakeDocuments, fakeReleases, git, gitInit, readJson, throwawayKey, useFakeDocuments } from './year-fakes.node.mjs';

const RUNS = 'docs/evidence/ops/runs';

/** @type {string} */
let dir;
/** @type {string} */
let root;
/** @type {string} */
let keyFile;
/** @type {ReturnType<typeof fakeReleases>} */
let releases;

/**
 * A git repo holding the gate's files, pointed at fake documents whose archive is published,
 * with a deploy tag on its first commit (what is live) pushed to its origin.
 * @param {{ restrictionsText?: string }} [o]
 */
async function setup(o = {}) {
  dir = mkdtempSync(join(tmpdir(), 'vnm-year-full-'));
  root = copyTree(join(dir, 'repo'));
  const docs = join(dir, 'docs');
  useFakeDocuments(root, fakeDocuments(docs, o));
  keyFile = throwawayKey(join(dir, 'test.key'));
  releases = fakeReleases(join(dir, 'releases'));
  writeFileSync(join(root, 'README.md'), 'fake\n');
  const origin = join(dir, 'origin.git');
  mkdirSync(origin);
  gitInit(root, origin);
  git(root, ['tag', '-a', '-m', 'live', 'deploy/20261111T235933Z-b0834844']);
  git(root, ['push', '-q', 'origin', 'main', '--tags']);
  // The archive's publish changes a source-derived input (the manifest), as the lead's will.
  await publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: join(dir, 'publish-runs'), log: () => {} });
  git(root, ['commit', '-q', '-am', 'publish the sources archive']);
}

/** `year check --full` into the repo's runs dir. */
const full = () => yearCheckFull({ root, key: keyFile, download: releases.download, runsDir: join(root, RUNS), log: () => {} });
/** Commits whatever the run left. @param {string} m */
const commit = (m) => { git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', m]); };

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the --full record and the deploy preflight', () => {
  beforeEach(() => setup());

  it('a fresh --full record, committed, satisfies the preflight for HEAD; with none it refuses', async () => {
    const exec = execIn(root);
    const before = await sourceInputsCheck(exec);
    expect(before.ok).toBe(false);
    expect(before.message).toMatch(/needs a committed `year check --full`/);

    const r = await full();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    const record = JSON.parse(readFileSync(/** @type {string} */ (r.record), 'utf8'));
    expect(record).toMatchObject({ script: FULL_RECORD.script, outcome: 'ok', details: { mode: FULL_RECORD.mode, sourceInputsHash: await sourceInputsHash(exec), rules: 'byte-identical' } });
    expect(r.record).toMatch(/-year-check-[0-9a-f]{4}\.json$/);
    commit('the year check --full record');
    expect(await sourceInputsCheck(exec)).toMatchObject({ ok: true, message: expect.stringMatching(/covers them/) });
  });

  it('a rules file edited by hand after the record does not pass: its hash is in no record', async () => {
    await full();
    commit('the year check --full record');
    const rel = `data/ng-restrictions-${Y}.json`;
    const rules = readJson(root, rel);
    rules.rules.find((/** @type {any} */ x) => x.id === 'A-dentistry').effect = 'note';
    writeFileSync(join(root, rel), `${JSON.stringify(rules, null, 1)}\n`);
    commit('a hand edit');
    const after = await sourceInputsCheck(execIn(root));
    expect(after.ok).toBe(false);
    expect(after.message).toContain(rel);
  });

  it('--full refuses uncommitted source-derived inputs, and a pending archive', async () => {
    const rel = `data/ng-courses-${Y}.json`;
    appendFileSync(join(root, rel), '\n');
    expect((await full()).problems.join('\n')).toMatch(/commit the source-derived inputs first/);
    git(root, ['checkout', '--', rel]);
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    m.revisions.at(-1).archive = { ...m.revisions.at(-1).archive, sha256: null, pending: 'not yet' };
    writeFileSync(join(root, `data/ng-sources-${Y}.json`), `${JSON.stringify(m, null, 1)}\n`);
    expect((await full()).problems.join('\n')).toMatch(/archive is pending/);
  });
});

// The plan's two --full cases: on the Mac (here, against the fakes); skipped in CI.
describe.skipIf(Boolean(process.env.CI))('year check --full (on the Mac)', () => {
  it('fails on a missing quote: rule E is not in the restrictions text', async () => {
    await setup({ restrictionsText: 'Course restrictions\nSome other sentence entirely.\n' });
    const r = await full();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/quote rule-e \(public\/shortlist\.js\) is not in restrictions word for word/);
    expect(JSON.parse(readFileSync(/** @type {string} */ (r.record), 'utf8'))).toMatchObject({ outcome: 'failed', details: { mode: 'full' } });
  });

  it('fails on a rules file edited by hand: the builder does not reproduce it', async () => {
    await setup();
    const rel = `data/ng-restrictions-${Y}.json`;
    const rules = readJson(root, rel);
    rules.rules.find((/** @type {any} */ x) => x.id === 'A-dentistry').reason = 'Edited by hand.';
    writeFileSync(join(root, rel), `${JSON.stringify(rules, null, 1)}\n`);
    commit('a hand edit');
    const r = await full();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/is not what the builder writes/);
    expect(JSON.parse(readFileSync(/** @type {string} */ (r.record), 'utf8'))).toMatchObject({ outcome: 'failed', details: { rules: 'differs' } });
  });
});
