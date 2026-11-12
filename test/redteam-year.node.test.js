// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), finding H-1: `year check --full` rebuilds only
// data/ng-restrictions-<year>.json from the archived documents. data/ng-courses-<year>.json (the
// Registrar's list of courses offered to exchange students, extracted from ng-courses.pdf) is a
// source-derived input in the preflight's hash, but nothing in --full checks its contents against
// the PDF. A hand edit to it is committed, --full writes an `ok` record naming its hash, and the
// deploy preflight's "source inputs" check passes.
//
// `it.fails`: each case asserts what the record rule promises ("a hand-edited rules file has a hash
// no record names, so it can't pass"); it passes while the gap is open and fails once it is fixed.
// Same fakes as test/year-full.node.test.js: throwaway key, fake documents, temp dirs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceInputsCheck } from '../scripts/preflight.mjs';
import { publish } from '../scripts/sources.mjs';
import { execIn, yearCheckFull } from '../scripts/year.mjs';
import { Y, copyTree, fakeDocuments, fakeReleases, git, gitInit, readJson, throwawayKey, useFakeDocuments } from './year-fakes.node.mjs';

const RUNS = 'docs/evidence/ops/runs';
/** @type {string} */
let dir;

afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'vnm-redteam-year-'));
  const root = copyTree(join(dir, 'repo'));
  const docs = join(dir, 'docs');
  useFakeDocuments(root, fakeDocuments(docs));
  const key = throwawayKey(join(dir, 'test.key'));
  const releases = fakeReleases(join(dir, 'releases'));
  writeFileSync(join(root, 'README.md'), 'fake\n');
  const origin = join(dir, 'origin.git');
  mkdirSync(origin);
  gitInit(root, origin);
  git(root, ['tag', '-a', '-m', 'live', 'deploy/20261111T235933Z-b0834844']);
  git(root, ['push', '-q', 'origin', 'main', '--tags']);
  await publish({ from: docs, root, key, upload: releases.upload, runsDir: join(dir, 'publish-runs'), log: () => {} });
  git(root, ['commit', '-q', '-am', 'publish the sources archive']);
  const full = () => yearCheckFull({ root, key, download: releases.download, runsDir: join(root, RUNS), log: () => {}, pdfText: async () => null });
  const commit = (/** @type {string} */ m) => { git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', m]); };
  return { root, full, commit };
}

describe('red team H-1: a hand-edited NG course list passes year check --full and the preflight', () => {
  it.fails('adding a course to Sem 1 of data/ng-courses by hand is refused by --full', async () => {
    const { root, full, commit } = await setup();
    const rel = `data/ng-courses-${Y}.json`;
    const courses = readJson(root, rel);
    // A course NUS does not offer to exchange students, added by hand to both lists.
    courses.semesters['1'] = [...courses.semesters['1'], 'MED9999X'].sort();
    courses.allCodes = [...courses.allCodes, 'MED9999X'].sort();
    writeFileSync(join(root, rel), `${JSON.stringify(courses, null, 2)}\n`);
    commit('a hand edit to the NG list');

    const r = await full();
    // Observed: r.ok === true, r.problems === [], the record says outcome ok.
    commit('the year check --full record');
    const pre = await sourceInputsCheck(execIn(root));
    // Observed: pre.ok === true, "1 source-derived input(s) changed …; <record> covers them".
    expect(r.ok && pre.ok).toBe(false);
  });
});
