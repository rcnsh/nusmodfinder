// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), findings L-4 and L-5: the sources archive.
//
// L-4: no file name in data/ng-sources-<year>.json is checked (scripts/ng-sources.mjs
// manifestProblems), and `sources publish` / `sources restore` join them onto the --from and output
// dirs as they are. A document whose `file` is `../escaped.pdf` is read from outside --from at
// publish and written outside the restore dir. Restore checks archive names against the manifest's,
// so it needs a committed manifest entry and an archive sealed with the key: a maintainer slip, not
// an outside attack.
//
// L-5: a document's `text` extraction is archived with no sha256 in the manifest (archivedFiles gives
// it sha256 null) and nothing ties it to the PDF it is extracted from. `year check --full` looks for
// each quote in the text first, and the restrictions builder reads the .txt lists. A hand-edited
// extraction, published, makes --full pass: test/year-fakes.node.mjs already shows it, since its fake
// PDFs hold none of the text the checks find.
//
// Throwaway key, fake documents, temp dirs. `it.fails`: each case asserts the safe behaviour.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archivedFiles, publish, restore } from '../scripts/sources.mjs';
import { latestRevision } from '../scripts/ng-sources.mjs';
import { yearCheck } from '../scripts/year.mjs';
import { RULE_E_SENTENCE, Y, copyTree, fakeDocuments, fakeReleases, readJson, throwawayKey, useFakeDocuments, writeJson } from './year-fakes.node.mjs';

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-redteam-sources-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('red team L-4: archive file names are paths', () => {
  it.fails('a manifest file name with ../ is refused by year check, publish and restore', async () => {
    const root = copyTree(join(dir, 'repo'));
    const from = join(dir, 'from', 'docs');
    const files = fakeDocuments(from);
    useFakeDocuments(root, files);
    // One document's file now points one level up from --from (and from the restore dir).
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    const doc = /** @type {any} */ (latestRevision(m)?.documents.find((/** @type {any} */ d) => d.file === 'law-compulsory-llb-courses.png'));
    doc.file = '../escaped.png';
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    // The rules file names its builder inputs by file name; follow the rename so CI mode agrees.
    const rules = readJson(root, `data/ng-restrictions-${Y}.json`);
    rules.sourceSha256 = Object.fromEntries(Object.entries(rules.sourceSha256)
      .map(([n, h]) => [n === 'law-compulsory-llb-courses.png' ? '../escaped.png' : n, h]).sort(([a], [b]) => a.localeCompare(b)));
    writeJson(root, `data/ng-restrictions-${Y}.json`, rules);
    writeFileSync(join(dir, 'from', 'escaped.png'), files['law-compulsory-llb-courses.png']);

    const ci = yearCheck({ root });
    const key = throwawayKey(join(dir, 'test.key'));
    const releases = fakeReleases(join(dir, 'releases'));
    let published = true;
    try {
      await publish({ from, root, key, upload: releases.upload, runsDir: join(dir, 'runs'), log: () => {} });
    } catch { published = false; }
    const out = join(dir, 'restore', 'out');
    mkdirSync(out, { recursive: true });
    if (published) await restore({ root, key, out, download: releases.download, log: () => {} }).catch(() => {});
    const escaped = join(dir, 'restore', 'escaped.png');
    // Observed: year check has no problem naming the path, publish succeeds, and restore writes
    // <dir>/restore/escaped.png, outside its output dir <dir>/restore/out.
    expect({
      ciNamesIt: ci.problems.some((p) => p.includes('../escaped.png')),
      published,
      wroteOutside: existsSync(escaped) && readFileSync(escaped).equals(files['law-compulsory-llb-courses.png']),
    }).toEqual({ ciNamesIt: true, published: false, wroteOutside: false });
  });
});

describe('red team L-5: text extractions are not pinned to their documents', () => {
  it.fails('the manifest pins every archived file, text extractions included', () => {
    const root = copyTree(join(dir, 'repo'));
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    const unpinned = archivedFiles(latestRevision(m)).filter((f) => f.sha256 === null).map((f) => f.name);
    // Observed: the committed manifest for this year's text extractions (the restrictions text, the
    // self-funded list, the YST lists, …) have no sha256.
    expect(unpinned).toEqual([]);
  });

  it('(evidence) the fakes pass the quote check with a PDF that holds none of the quote', () => {
    const files = fakeDocuments(join(dir, 'docs'));
    expect(files['non-graduating-course-restrictions.pdf'].toString()).not.toContain('Course registration');
    expect(files['non-graduating-course-restrictions.txt'].toString()).toContain(RULE_E_SENTENCE);
  });
});
