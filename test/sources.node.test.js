// @ts-check
// Phase 7 7E, G5: NUS's source documents in an AES-256-GCM archive per revision
// (scripts/sources.mjs). Every case uses fake documents, a throwaway key and a fake release store
// in temp dirs: no real document, key or release is touched. The key path never defaults to, or
// reads, the holdout key's.
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRestrictions, dirReader, loadInputs } from '../scripts/build-ng-restrictions.mjs';
import { latestRevision, manifestProblems } from '../scripts/ng-sources.mjs';
import {
  DEFAULT_KEY_PATH, archivedFiles, keyPath, keygen, main, open, publish, readKey, releaseName, restore, seal, sha256,
} from '../scripts/sources.mjs';
import { yearCheck } from '../scripts/year.mjs';
import { REPO, Y, copyTree, fakeDocuments, fakeReleases, readJson, throwawayKey, useFakeDocuments, writeJson } from './year-fakes.node.mjs';

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-sources-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the key', () => {
  it('keygen writes 64 hex at mode 0600, prints none of it, and never overwrites', async () => {
    const out = join(dir, 'k', 'sources-archive.key');
    /** @type {string[]} */
    const lines = [];
    expect(await main(['keygen', '--out', out], { log: (m) => lines.push(m) })).toBe(0);
    const key = readFileSync(out, 'utf8').trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toContain(key);
    expect(lines.join('\n')).toMatch(/nusmodfinder\/sources-archive-key/);
    expect(await main(['keygen', '--out', out], { log: (m) => lines.push(m) })).toBe(1);
    expect(readFileSync(out, 'utf8').trim()).toBe(key);
    expect(() => keygen(out)).toThrow(/never overwrites/);
  });

  it('the path: --key, then VNM_SOURCES_KEY_FILE, then ~/.config/vnm/sources-archive.key; never the holdout key', () => {
    expect(DEFAULT_KEY_PATH).toBe(join(homedir(), '.config/vnm/sources-archive.key'));
    expect(keyPath({ env: {} })).toBe(DEFAULT_KEY_PATH);
    expect(keyPath({ env: { VNM_SOURCES_KEY_FILE: join(dir, 'a.key') } })).toBe(join(dir, 'a.key'));
    expect(keyPath({ key: join(dir, 'b.key'), env: { VNM_SOURCES_KEY_FILE: join(dir, 'a.key') } })).toBe(join(dir, 'b.key'));
    expect(() => keyPath({ key: join(dir, 'holdout.key'), env: {} })).toThrow(/holdout key/);
    expect(() => keyPath({ env: { VNM_SOURCES_KEY_FILE: join(homedir(), '.config/vnm/holdout.key') } })).toThrow(/holdout key/);
    expect(() => keyPath({ key: join(dir, 'x'), env: { VNM_HOLDOUT_KEY_FILE: join(dir, 'x') } })).toThrow(/holdout key/);
    expect(() => keygen(join(dir, 'holdout.key'))).toThrow(/holdout key/);
  });

  it('never reads the holdout key under another name: any case, a symlink, a hard link (a fake holdout key in a temp dir)', () => {
    const holdout = join(dir, 'holdout.key');
    writeFileSync(holdout, `${'ef'.repeat(32)}\n`);
    const env = { VNM_HOLDOUT_KEY_FILE: holdout };
    for (const name of ['HOLDOUT.KEY', 'Holdout.key']) expect(() => keyPath({ key: join(dir, name), env: {} })).toThrow(/holdout key/);
    symlinkSync(holdout, join(dir, 'via-symlink.key'));
    expect(() => readKey(join(dir, 'via-symlink.key'), {})).toThrow(/is the holdout key/);
    linkSync(holdout, join(dir, 'via-hardlink.key'));
    expect(() => readKey(join(dir, 'via-hardlink.key'), env)).toThrow(/is the holdout key/);
    writeFileSync(join(dir, 'own.key'), `${'ab'.repeat(32)}\n`);
    expect(readKey(join(dir, 'own.key'), env).toString('hex')).toBe('ab'.repeat(32));
  });

  it('refuses a missing or malformed key file', () => {
    expect(() => readKey(join(dir, 'none.key'))).toThrow(/no sources key/);
    writeFileSync(join(dir, 'bad.key'), 'not a key\n');
    expect(() => readKey(join(dir, 'bad.key'))).toThrow(/64 hex/);
  });
});

describe('the archive', () => {
  const REV = 'r1';
  const key = Buffer.alloc(32, 7);
  const files = [{ name: 'a.pdf', bytes: Buffer.from('%PDF one') }, { name: 'b.txt', bytes: Buffer.from('two\n') }];

  it('opens to the same files with the same key, year and revision', () => {
    const archive = seal({ year: Y, revision: REV, files, key });
    expect(archive.includes(Buffer.from('%PDF one'))).toBe(false);
    expect(open({ archive, key, year: Y, revision: REV }).map((f) => [f.name, f.bytes.toString()])).toEqual([['a.pdf', '%PDF one'], ['b.txt', 'two\n']]);
  });

  it('refuses a wrong key, another revision\'s label, and a flipped byte', () => {
    const archive = seal({ year: Y, revision: REV, files, key });
    expect(() => open({ archive, key: Buffer.alloc(32, 8), year: Y, revision: REV })).toThrow(/does not open/);
    expect(() => open({ archive, key, year: Y, revision: `${REV}x` })).toThrow(/does not open/);
    const bad = Buffer.from(archive);
    bad[bad.length - 30] ^= 1;
    expect(() => open({ archive: bad, key, year: Y, revision: REV })).toThrow(/does not open/);
  });
});

describe('publish and restore', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let docs;
  /** @type {string} */
  let keyFile;
  /** @type {ReturnType<typeof fakeReleases>} */
  let releases;
  /** @type {string} */
  let runs;
  beforeEach(() => {
    root = copyTree(join(dir, 'repo'));
    docs = join(dir, 'docs');
    useFakeDocuments(root, fakeDocuments(docs));
    keyFile = throwawayKey(join(dir, 'test.key'));
    releases = fakeReleases(join(dir, 'releases'));
    runs = join(dir, 'runs');
  });

  it('publish refuses a revision with documents still to confirm', async () => {
    const m = readJson(join(root), `data/ng-sources-${Y}.json`);
    m.revisions.at(-1).documents[0].confirm = ['sha256'];
    writeFileSync(join(root, `data/ng-sources-${Y}.json`), `${JSON.stringify(m)}\n`);
    await expect(publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: runs, log: () => {} })).rejects.toThrow(/still to confirm/);
    expect(existsSync(join(dir, 'releases', releaseName(Y, m.revisions.at(-1).date)))).toBe(false);
  });

  it('publish refuses a document whose sha256 isn\'t the manifest\'s, or one missing from the dir', async () => {
    writeFileSync(join(docs, 'ng-courses.pdf'), 'changed');
    await expect(publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: runs, log: () => {} })).rejects.toThrow(/ng-courses\.pdf: sha256/);
    rmSync(join(docs, 'ng-courses.pdf'));
    await expect(publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: runs, log: () => {} })).rejects.toThrow(/ng-courses\.pdf \(ng-list\) is not in/);
  });

  it('publish uploads the sealed archive, writes its sha256 into the manifest and leaves a run record; restore gets every file back', async () => {
    const r = await publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: runs, log: () => {} });
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    expect(r.release).toBe(releaseName(Y, m.revisions.at(-1).date));
    expect(m.revisions.at(-1).archive).toEqual({ release: r.release, asset: `${r.release}.vnmsrc`, sha256: r.sha256 });
    const [rec] = readdirSync(runs).map((f) => JSON.parse(readFileSync(join(runs, f), 'utf8')));
    expect(rec).toMatchObject({ script: 'sources publish', outcome: 'ok', versions: { release: r.release } });
    // A second publish of the same revision is refused: an archive is never replaced.
    await expect(publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: runs, log: () => {} })).rejects.toThrow(/never replaced/);

    const out = await restore({ root, key: keyFile, download: releases.download, log: () => {} });
    try {
      const want = archivedFiles(m.revisions.at(-1)).map((f) => f.name).sort();
      expect(out.files.sort()).toEqual(want);
      for (const f of want) expect(readFileSync(join(out.dir, f))).toEqual(readFileSync(join(docs, f)));
    } finally { rmSync(out.dir, { recursive: true, force: true }); }
  });

  it('restore refuses an archive whose sha256 isn\'t the manifest\'s, a wrong key, and a pending archive', async () => {
    await expect(restore({ root, key: keyFile, download: releases.download, log: () => {} })).rejects.toThrow(/pending/);
    const r = await publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: runs, log: () => {} });
    const wrong = throwawayKey(join(dir, 'other.key'));
    writeFileSync(wrong, `${'cd'.repeat(32)}\n`);
    await expect(restore({ root, key: wrong, download: releases.download, log: () => {} })).rejects.toThrow(/does not open/);
    const asset = join(dir, 'releases', r.release, `${r.release}.vnmsrc`);
    writeFileSync(asset, Buffer.concat([readFileSync(asset), Buffer.from('x')]));
    await expect(restore({ root, key: keyFile, download: releases.download, log: () => {} })).rejects.toThrow(/not the manifest's/);
  });
});

// Red team L-4 (docs/evidence/phase7/redteam.md): no file name in the manifest was checked, so
// `../escaped.png` was read from outside --from at publish and written outside the restore dir.
describe('manifest file names are plain base names (red team L-4)', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let from;
  /** @type {Record<string, Buffer>} */
  let files;
  beforeEach(() => {
    root = copyTree(join(dir, 'repo'));
    from = join(dir, 'from', 'docs');
    files = fakeDocuments(from);
    useFakeDocuments(root, files);
  });
  /** Renames one document's `file` (and the rules file's key for it, so the two agree). @param {string} name */
  const rename = (name) => {
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    const doc = /** @type {any} */ (latestRevision(m)?.documents.find((/** @type {any} */ d) => d.file === 'law-compulsory-llb-courses.png'));
    doc.file = name;
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    const rules = readJson(root, `data/ng-restrictions-${Y}.json`);
    rules.sourceSha256 = Object.fromEntries(Object.entries(rules.sourceSha256)
      .map(([n, h]) => [n === 'law-compulsory-llb-courses.png' ? name : n, h]).sort(([a], [b]) => a.localeCompare(b)));
    writeJson(root, `data/ng-restrictions-${Y}.json`, rules);
  };

  it('a manifest file name with ../ is refused by year check, publish and restore', async () => {
    rename('../escaped.png');
    writeFileSync(join(dir, 'from', 'escaped.png'), files['law-compulsory-llb-courses.png']);
    const ci = yearCheck({ root });
    const key = throwawayKey(join(dir, 'test.key'));
    const releases = fakeReleases(join(dir, 'releases'));
    let published = true;
    try {
      await publish({ from, root, key, upload: releases.upload, runsDir: join(dir, 'runs'), log: () => {} });
    } catch (err) {
      published = false;
      expect(String(/** @type {Error} */ (err).message)).toMatch(/\.\.\/escaped\.png.*not a plain file name/);
    }
    const out = join(dir, 'restore', 'out');
    mkdirSync(out, { recursive: true });
    if (published) await restore({ root, key, out, download: releases.download, log: () => {} }).catch(() => {});
    const escaped = join(dir, 'restore', 'escaped.png');
    expect({
      ciNamesIt: ci.problems.some((p) => p.includes('../escaped.png')),
      published,
      wroteOutside: existsSync(escaped) && readFileSync(escaped).equals(files['law-compulsory-llb-courses.png']),
    }).toEqual({ ciNamesIt: true, published: false, wroteOutside: false });
  });

  it('every shape of path is refused: slashes, backslashes, .., an absolute path, a NUL; and a `text` name too', () => {
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    for (const bad of ['a/b.pdf', 'a\\b.pdf', '..', 'x..pdf', '/etc/passwd', 'C:\\x.pdf', 'a\u0000.pdf', '', '.']) {
      const copy = structuredClone(m);
      latestRevision(copy).documents[0].file = bad;
      latestRevision(copy).documents[1].text = bad;
      const problems = manifestProblems(copy, Y);
      expect(problems.filter((p) => p.includes('not a plain file name')), JSON.stringify(bad)).toHaveLength(2);
    }
    expect(manifestProblems(m, Y).filter((p) => p.includes('not a plain file name'))).toEqual([]);
  });

  it('restore checks each archive entry\'s name before writing anything', async () => {
    const key = throwawayKey(join(dir, 'test.key'));
    const releases = fakeReleases(join(dir, 'releases'));
    const r = await publish({ from, root, key, upload: releases.upload, runsDir: join(dir, 'runs'), log: () => {} });
    // An archive sealed with the same key, year and revision whose first entry is a path.
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    const rev = latestRevision(m);
    const entries = archivedFiles(rev).map((f) => ({ name: f.name, bytes: readFileSync(join(from, f.name)) }));
    entries[0] = { name: `../${entries[0].name}`, bytes: entries[0].bytes };
    const archive = seal({ year: Y, revision: rev.date, files: entries, key: Buffer.from('ab'.repeat(32), 'hex') });
    writeFileSync(join(dir, 'releases', r.release, `${r.release}.vnmsrc`), archive);
    rev.archive.sha256 = sha256(archive);
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    const out = join(dir, 'restore', 'out');
    await expect(restore({ root, key, out, download: releases.download, log: () => {} })).rejects.toThrow(/not a plain file name/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(dir, 'restore', entries[0].name.slice(3)))).toBe(false);
  });
});

// Red team L-5: a document's `text` extraction was archived with no sha256, so a hand-"fixed"
// extraction changed what --full accepts as NUS's words and what the builder reads.
describe('text extractions are pinned by textSha256 (red team L-5)', () => {
  /** The lead's sha256 of each published extraction (npm run sources -- hash over the archive). */
  const REAL_TEXT_SHA256 = {
    'ng-courses.txt': '60948390f9a3cedff9ebaeff0df3ad54317e93d6905a3421fc0abb8cd3e71816',
    'non-graduating-course-restrictions.txt': '572e172bba8f240cba5734d3727710ab9a7a70284cd4391e74a5c4de149482e5',
    'exchangeatnus.txt': '71a4e652b6a4e51153ac941a39f0e65c54106772dbcfc34c544728060ef5f22a',
    'coursereg-student-user-guide.txt': '9782ef676f9049f7b1ac45bc4d7dae8876178aa724a38c02210200a378feddd0',
    'ng-online-application-guide-2025.txt': 'ba53e356bb9b1c170612fe623cd082feee472e3ad5045faa89c3e4fcba0d1235',
    'nus-biz-exchange-factsheet-ug-t2620.txt': '83373eacea243b7ba4f320f9d693a803ddf7d35420829286a559957cdd891a1c',
  };

  it('the committed manifest pins every archived file of every revision, text extractions included', () => {
    const m = readJson(REPO, `data/ng-sources-${Y}.json`);
    for (const rev of m.revisions) {
      const files = archivedFiles(rev);
      expect(files.filter((f) => f.sha256 === null).map((f) => f.name), rev.date).toEqual([]);
      for (const d of rev.documents.filter((/** @type {any} */ x) => x.text)) expect(d.textSha256, `${rev.date} ${d.text}`).toBe(/** @type {any} */ (REAL_TEXT_SHA256)[d.text]);
    }
    expect(manifestProblems(m, Y)).toEqual([]);
  });

  it('a published revision with a text and no textSha256 is a manifest problem; a pending one is not (publish writes it)', () => {
    const m = readJson(REPO, `data/ng-sources-${Y}.json`);
    const doc = latestRevision(m).documents.find((/** @type {any} */ d) => d.text);
    delete doc.textSha256;
    expect(manifestProblems(m, Y)).toContainEqual(expect.stringMatching(new RegExp(`${doc.id}'s text ${doc.text.replaceAll('.', '\\.')} has no textSha256`)));
    latestRevision(m).archive = { ...latestRevision(m).archive, sha256: null, pending: 'not yet' };
    expect(manifestProblems(m, Y).filter((p) => p.includes('textSha256'))).toEqual([]);
    doc.textSha256 = 'nothex';
    expect(manifestProblems(m, Y)).toContainEqual(expect.stringMatching(/textSha256 is not 64 hex/));
  });

  describe('publish, restore and the builder', () => {
    /** @type {string} */
    let root;
    /** @type {string} */
    let docs;
    /** @type {string} */
    let keyFile;
    /** @type {ReturnType<typeof fakeReleases>} */
    let releases;
    /** @type {Record<string, Buffer>} */
    let files;
    const TEXT = 'non-graduating-course-restrictions.txt';
    beforeEach(() => {
      root = copyTree(join(dir, 'repo'));
      docs = join(dir, 'docs');
      files = fakeDocuments(docs);
      useFakeDocuments(root, files);
      keyFile = throwawayKey(join(dir, 'test.key'));
      releases = fakeReleases(join(dir, 'releases'));
    });
    const doPublish = () => publish({ from: docs, root, key: keyFile, upload: releases.upload, runsDir: join(dir, 'runs'), log: () => {} });
    const textDoc = () => latestRevision(readJson(root, `data/ng-sources-${Y}.json`)).documents.find((/** @type {any} */ d) => d.text === TEXT);

    it('publish writes each text\'s textSha256; every archived file is then pinned', async () => {
      const m = readJson(root, `data/ng-sources-${Y}.json`);
      delete latestRevision(m).documents.find((/** @type {any} */ d) => d.text === TEXT).textSha256;
      writeJson(root, `data/ng-sources-${Y}.json`, m);
      expect(textDoc().textSha256).toBeUndefined();
      await doPublish();
      expect(textDoc().textSha256).toBe(sha256(files[TEXT]));
      const rev = latestRevision(readJson(root, `data/ng-sources-${Y}.json`));
      expect(archivedFiles(rev).filter((f) => f.sha256 === null)).toEqual([]);
    });

    it('publish refuses a text whose bytes are not its textSha256', async () => {
      const m = readJson(root, `data/ng-sources-${Y}.json`);
      latestRevision(m).documents.find((/** @type {any} */ d) => d.text === TEXT).textSha256 = sha256('another extraction');
      writeJson(root, `data/ng-sources-${Y}.json`, m);
      await expect(doPublish()).rejects.toThrow(new RegExp(`${TEXT.replaceAll('.', '\\.')}: sha256 [0-9a-f]{64}, not the manifest's`));
    });

    it('restore refuses an archive whose text is not its textSha256, and refuses an unpinned text', async () => {
      await doPublish();
      const m = readJson(root, `data/ng-sources-${Y}.json`);
      const doc = latestRevision(m).documents.find((/** @type {any} */ d) => d.text === TEXT);
      doc.textSha256 = sha256('another extraction');
      writeJson(root, `data/ng-sources-${Y}.json`, m);
      await expect(restore({ root, key: keyFile, download: releases.download, log: () => {} })).rejects.toThrow(new RegExp(`${TEXT.replaceAll('.', '\\.')}: sha256`));
      delete doc.textSha256;
      writeJson(root, `data/ng-sources-${Y}.json`, m);
      await expect(restore({ root, key: keyFile, download: releases.download, log: () => {} })).rejects.toThrow(/no sha256 in the manifest/);
    });

    it('the builder refuses a text whose hash differs from its textSha256, or one with none', async () => {
      await doPublish();
      const inputs = await loadInputs({ year: Y, root });
      const ok = buildRestrictions({ ...inputs, sources: dirReader(docs) });
      expect(ok.text).toBe(readFileSync(join(root, `data/ng-restrictions-${Y}.json`), 'utf8'));
      writeFileSync(join(docs, TEXT), 'a hand-fixed extraction\n');
      expect(() => buildRestrictions({ ...inputs, sources: dirReader(docs) })).toThrow(new RegExp(`${TEXT.replaceAll('.', '\\.')}: sha256 [0-9a-f]{64} does not match the source manifest's textSha256`));
      writeFileSync(join(docs, TEXT), files[TEXT]);
      const m = readJson(root, `data/ng-sources-${Y}.json`);
      delete latestRevision(m).documents.find((/** @type {any} */ d) => d.text === TEXT).textSha256;
      writeJson(root, `data/ng-sources-${Y}.json`, m);
      await expect(loadInputs({ year: Y, root }).then((i) => buildRestrictions({ ...i, sources: dirReader(docs) }))).rejects.toThrow(/has no textSha256/);
    });
  });
});
