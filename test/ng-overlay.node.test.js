// @ts-check
// The restrictions builder reads its year's overlay (scripts/ng-overlay/<year>.mjs) and documents
// through the year's source manifest, and finds the self-funded list and the off-list rule by
// role, not by an id a new year may rename. From documents matching the manifest, the builder
// writes the committed rules file byte for byte (here from fakes that hold the committed lists, so only `sourceSha256`, which
// names the documents, differs, and that is checked equal to the manifest's hashes separately).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, rolesOf } from '../scripts/build-ng-restrictions.mjs';
import { builderHashes, latestRevision, readManifest } from '../scripts/ng-sources.mjs';
import { REPO, Y, copyTree, fakeDocuments, readJson, useFakeDocuments } from './year-fakes.node.mjs';

const manifest = /** @type {import('../scripts/ng-sources.mjs').SourceManifest} */ (readManifest(Y, { root: REPO }));
const { OVERLAY } = await import(`../${manifest.overlay}`);

describe('overlay roles', () => {
  it('the year\'s overlay names each role once', () => {
    expect(rolesOf(OVERLAY)).toEqual({ 'self-funded-list': 'A-self-funded', 'off-list-rule': 'E-offerings-list' });
  });

  it('fails on a role that is missing, doubled, or unknown', () => {
    const { 'E-offerings-list': e, ...noE } = OVERLAY;
    expect(() => rolesOf(noE)).toThrow(/role off-list-rule is missing/);
    expect(() => rolesOf({ ...OVERLAY, 'E-again': { ...e } })).toThrow(/role off-list-rule appears 2 times \(E-offerings-list, E-again\)/);
    expect(() => rolesOf({ ...OVERLAY, 'X-new': { info: 'x', role: 'made-up' } })).toThrow(/unknown role made-up/);
  });
});

describe('the restrictions builder, through the manifest', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let root;
  /** @type {string} */
  let docs;
  /** @type {string[]} */
  let lines;
  const log = (/** @type {string} */ m) => { lines.push(m); };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vnm-overlay-'));
    root = copyTree(join(dir, 'repo'));
    docs = join(dir, 'docs');
    useFakeDocuments(root, fakeDocuments(docs));
    lines = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rebuilds the committed rules file byte for byte from documents matching the manifest', async () => {
    expect(await main(['--sources', docs, '--check'], { root, log })).toBe(0);
    expect(lines.join('\n')).toMatch(/rebuilds byte for byte/);
    // The temp tree's rules file differs from the repo's only in sourceSha256 (the fakes' hashes) ...
    const rel = `data/ng-restrictions-${Y}.json`;
    const committed = readFileSync(join(REPO, rel), 'utf8');
    const real = JSON.parse(committed);
    expect(readFileSync(join(root, rel), 'utf8')).toBe(`${JSON.stringify({ ...real, sourceSha256: readJson(root, rel).sourceSha256 }, null, 1)}\n`);
    expect(`${JSON.stringify(real, null, 1)}\n`).toBe(committed);
    // ... and the repo's sourceSha256 is the manifest's hashes for the real documents.
    expect(real.sourceSha256).toEqual(builderHashes(latestRevision(manifest)));
  });

  it('needs --sources (there is no default dir), and refuses a document that is not the manifest\'s', async () => {
    expect(await main([], { root, log })).toBe(2);
    expect(lines.join('\n')).toMatch(/there is no default/);
    writeFileSync(join(docs, 'self-funded-graduate-courses.txt'), 'CS5000\n');
    expect(await main(['--sources', docs, '--check'], { root, log })).toBe(1);
    expect(lines.at(-1)).toMatch(/self-funded-graduate-courses\.txt/);
  });

  it('fails --check when the committed file was edited by hand', async () => {
    const rel = `data/ng-restrictions-${Y}.json`;
    const rules = readJson(root, rel);
    rules.rules[0].reason = 'Edited by hand.';
    writeFileSync(join(root, rel), `${JSON.stringify(rules, null, 1)}\n`);
    expect(await main(['--sources', docs, '--check'], { root, log })).toBe(1);
    expect(lines.at(-1)).toMatch(/is not what the builder writes/);
  });
});
