// @ts-check
// `year check --full` and what the deploy preflight makes of its record.
//
// --full runs on the Mac with the real archive; these cases use fake documents, a throwaway key
// and a fake release store in temp dirs instead. As the plan says, the two --full cases (a missing
// quote, a rules file edited by hand) run on the Mac only, and skip in CI, where the record's
// presence is what is checked. The preflight cases run everywhere: a fresh --full record satisfies
// the preflight for HEAD, and a rules file edited by hand after it doesn't.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FULL_RECORD, sourceInputsCheck, sourceInputsHash } from '../scripts/preflight.mjs';
import { publish } from '../scripts/sources.mjs';
import { NG_VENV_SETUP, execIn, yearCheckFull } from '../scripts/year.mjs';
import { LAST, Y, copyTree, fakeDocuments, fakeNgPages, fakeReleases, fromTextExtractor, git, gitInit, readJson, sha, throwawayKey, useFakeDocuments, writeJson } from './year-fakes.node.mjs';

const RUNS = 'ops/runs';

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
  // The archive's publish changes a source-derived input (the manifest), as a real publish does.
  await publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: join(dir, 'publish-runs'), log: () => {} });
  git(root, ['commit', '-q', '-am', 'publish the sources archive']);
}

/**
 * `year check --full` into the repo's runs dir. The NG list is re-extracted by extract-ng.py's
 * --from-text mode over the fake "PDF" (test/year-fakes.node.mjs), so no pypdf is needed.
 * @param {{ pdfText?: (path: string) => Promise<string | null>, extractNg?: import('../scripts/year.mjs').NgExtractor }} [o]
 */
const full = (o = {}) => yearCheckFull({
  root, key: keyFile, download: releases.download, runsDir: join(root, RUNS), log: () => {}, pdfText: async () => null, extractNg: fromTextExtractor, ...o,
});
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
    const courses = readJson(root, `data/ng-courses-${Y}.json`);
    expect(record).toMatchObject({
      script: FULL_RECORD.script, outcome: 'ok',
      details: {
        mode: FULL_RECORD.mode, sourceInputsHash: await sourceInputsHash(exec), rules: 'byte-identical',
        // The NG list, re-extracted from the archived PDF, byte for byte, with its sections.
        ngList: { result: 'byte-identical', semesters: { 1: courses.semesters['1'].length, 2: courses.semesters['2'].length } },
      },
    });
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

  // --full re-extracts the NG list as well as rebuilding the restrictions file, so a hand edit to
  // the NG list can't get an ok record past the preflight's record rule.
  it('a hand-edited NG course list fails --full (the archived list re-extracts otherwise), so the preflight refuses it', async () => {
    const rel = `data/ng-courses-${Y}.json`;
    const courses = readJson(root, rel);
    // A course NUS does not offer to exchange students, added by hand to both lists.
    courses.semesters['1'] = [...courses.semesters['1'], 'MED9999X'].sort();
    courses.allCodes = [...courses.allCodes, 'MED9999X'].sort();
    writeFileSync(join(root, rel), `${JSON.stringify(courses, null, 2)}\n`);
    commit('a hand edit to the NG list');

    const r = await full();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(new RegExp(`${rel.replaceAll('.', '\\.')} is not what scripts/extract-ng\\.py writes from the archived ng-courses\\.pdf`));
    expect(JSON.parse(readFileSync(/** @type {string} */ (r.record), 'utf8'))).toMatchObject({ outcome: 'failed', details: { ngList: { result: 'differs' } } });
    commit('the year check --full record');
    const pre = await sourceInputsCheck(execIn(root));
    expect(pre.ok).toBe(false);
  });

  it('--full refuses, naming the setup, when .venv/bin/python is missing or cannot import pypdf: never a silent pass', async () => {
    const missing = await full({ extractNg: undefined });
    expect(missing.ok).toBe(false);
    expect(missing.problems.join('\n')).toContain(NG_VENV_SETUP);
    expect(NG_VENV_SETUP).toBe('python3 -m venv .venv && .venv/bin/pip install pypdf');

    // A venv whose python has no pypdf (here, one that fails every import).
    mkdirSync(join(root, '.venv/bin'), { recursive: true });
    writeFileSync(join(root, '.venv/bin/python'), '#!/bin/sh\necho "ModuleNotFoundError: No module named \'pypdf\'" >&2\nexit 1\n');
    chmodSync(join(root, '.venv/bin/python'), 0o755);
    const noPypdf = await full({ extractNg: undefined });
    expect(noPypdf.ok).toBe(false);
    expect(noPypdf.problems.join('\n')).toContain(NG_VENV_SETUP);
  });

  it('--full refuses an uncommitted transcription: the rebuild reads it from the tree', async () => {
    const rel = readJson(root, `data/ng-sources-${Y}.json`).transcription;
    appendFileSync(join(root, rel), '\n');
    expect((await full()).problems.join('\n')).toMatch(new RegExp(`commit the source-derived inputs[^]*${rel.replaceAll('.', '\\.')}`));
  });

  it('--full refuses uncommitted source-derived inputs, and a pending archive', async () => {
    const rel = `data/ng-courses-${Y}.json`;
    appendFileSync(join(root, rel), '\n');
    expect((await full()).problems.join('\n')).toMatch(/commit the source-derived inputs/);
    git(root, ['checkout', '--', rel]);
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    m.revisions.at(-1).archive = { ...m.revisions.at(-1).archive, sha256: null, pending: 'not yet' };
    writeFileSync(join(root, `data/ng-sources-${Y}.json`), `${JSON.stringify(m, null, 1)}\n`);
    expect((await full()).problems.join('\n')).toMatch(/archive is pending/);
  });
});

// While a semester is unpublished, exchange mode serves last year's list for
// it (scripts/lib.mjs loadNgCourses), so --full checks that file against last year's archive too.
describe('--full and last year\'s NG list, while Sem 2 is unpublished', () => {
  const LAST_REL = `data/ng-courses-${LAST}.json`;
  /** The repo with this year's Sem 2 unpublished, and last year's list and archive. @param {{ lastArchive?: boolean }} [o] */
  async function setupUnpublished({ lastArchive = true } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'vnm-year-full-prev-'));
    root = copyTree(join(dir, 'repo'));
    // This year: Sem 1 only.
    const courses = readJson(root, `data/ng-courses-${Y}.json`);
    delete courses.semesters['2'];
    courses.allCodes = [...courses.semesters['1']];
    writeJson(root, `data/ng-courses-${Y}.json`, courses, 2);
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    m.published.ngList['2'] = false;
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    const docs = join(dir, 'docs');
    const files = fakeDocuments(docs);
    files['ng-courses.pdf'] = Buffer.from(fakeNgPages(courses));
    writeFileSync(join(docs, 'ng-courses.pdf'), files['ng-courses.pdf']);
    useFakeDocuments(root, files);
    // Last year: a Sem 2 list, extracted from its own archived NG list.
    const lastCourses = {
      source: courses.source, sourceFile: 'ng-courses.pdf', updatedAsAt: `15 Jan ${LAST.slice(5)}`, acadYear: LAST,
      semesters: { 2: ['CS1010', 'CS2030'] }, allCodes: ['CS1010', 'CS2030'],
    };
    writeJson(root, LAST_REL, lastCourses, 2);
    const lastDocs = join(dir, 'last-docs');
    mkdirSync(lastDocs, { recursive: true });
    const lastPdf = Buffer.from(fakeNgPages(lastCourses));
    writeFileSync(join(lastDocs, 'ng-courses.pdf'), lastPdf);
    if (lastArchive) {
      const date = `${LAST.slice(5)}-01-15`;
      writeJson(root, `data/ng-sources-${LAST}.json`, {
        ...m, acadYear: LAST, published: { ngList: { 1: false, 2: true }, yst: m.published.yst }, quotes: [],
        revisions: [{
          date, archive: { release: `sources-${LAST}-${date.replaceAll('-', '')}`, asset: 'x', sha256: null, pending: 'the fakes publish it' },
          documents: [{ id: 'ng-list', name: 'NG list', url: 'https://example.test/ng', file: 'ng-courses.pdf', sha256: sha(lastPdf), updatedAsAt: lastCourses.updatedAsAt, builder: true }],
        }],
      });
    }
    keyFile = throwawayKey(join(dir, 'test.key'));
    releases = fakeReleases(join(dir, 'releases'));
    writeFileSync(join(root, 'README.md'), 'fake\n');
    const origin = join(dir, 'origin.git');
    mkdirSync(origin);
    gitInit(root, origin);
    git(root, ['tag', '-a', '-m', 'live', 'deploy/20261111T235933Z-b0834844']);
    git(root, ['push', '-q', 'origin', 'main', '--tags']);
    await publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: join(dir, 'publish-runs'), log: () => {} });
    if (lastArchive) await publish({ from: lastDocs, year: LAST, root, key: keyFile, upload: releases.upload, runsDir: join(dir, 'publish-runs'), log: () => {} });
    commit('publish the sources archives');
  }

  it('re-extracts last year\'s list from its archive, and a hand edit to it fails --full and the preflight', async () => {
    await setupUnpublished();
    const r = await full();
    expect(r.problems).toEqual([]);
    expect(JSON.parse(readFileSync(/** @type {string} */ (r.record), 'utf8')).details).toMatchObject({
      ngList: { result: 'byte-identical', semesters: { 1: expect.any(Number) } }, ngListPrevious: { year: LAST, result: 'byte-identical', semesters: { 2: 2 } },
    });

    const lastCourses = readJson(root, LAST_REL);
    lastCourses.semesters['2'] = [...lastCourses.semesters['2'], 'MED9999X'].sort();
    lastCourses.allCodes = [...lastCourses.allCodes, 'MED9999X'].sort();
    writeJson(root, LAST_REL, lastCourses, 2);
    commit('a hand edit to last year\'s NG list');
    const edited = await full();
    expect(edited.ok).toBe(false);
    expect(edited.problems.join('\n')).toContain(`${LAST_REL} is not what scripts/extract-ng.py writes`);
    commit('the year check --full record');
    expect((await sourceInputsCheck(execIn(root))).ok).toBe(false);
  });

  it('refuses when last year has no archive to check its list against', async () => {
    await setupUnpublished({ lastArchive: false });
    const r = await full();
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(new RegExp(`Sem 2 unpublished: exchange mode shows ${LAST_REL.replaceAll('.', '\\.')}, which --full can't check`));
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

  it('a PDF quote that pdftotext -layout splits across columns passes on the PDF\'s reading-order text', async () => {
    // The layout extraction sets a page's columns side by side, so a sentence that wraps inside one
    // column is interleaved with its neighbour (the NG list's language note, Business's 50%).
    await setup({ restrictionsText: 'Course restrictions\nSome other sentence entirely.\n' });
    const ruleE = readJson(root, `data/ng-sources-${Y}.json`).quotes.find((/** @type {any} */ q) => q.id === 'rule-e').text;
    /** @type {string[]} */
    const asked = [];
    const r = await full({ pdfText: async (path) => { asked.push(path); return path.endsWith('.pdf') ? `Course restrictions\n${ruleE}\n` : null; } });
    expect(r.problems.join('\n')).not.toMatch(/quote rule-e/);
    expect(asked.some((p) => p.endsWith('.pdf'))).toBe(true);
    expect(asked.every((p) => p.endsWith('.pdf'))).toBe(true);
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
