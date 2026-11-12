// @ts-check
// Phase 7 7E, G5: NUS's source documents in an AES-256-GCM archive per revision
// (scripts/sources.mjs). Every case uses fake documents, a throwaway key and a fake release store
// in temp dirs: no real document, key or release is touched. The key path never defaults to, or
// reads, the holdout key's.
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_KEY_PATH, archivedFiles, keyPath, keygen, main, open, publish, readKey, releaseName, restore, seal,
} from '../scripts/sources.mjs';
import { Y, copyTree, fakeDocuments, fakeReleases, readJson, throwawayKey, useFakeDocuments } from './year-fakes.node.mjs';

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
