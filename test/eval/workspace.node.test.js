// @ts-check
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HASHED, RANKER, TEST_CONFIG, treeHash } from '../../eval/lib/workspace.mjs';

/** @type {string} */
let dir;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'vnm-ws-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * @param {string} name
 * @param {Record<string, string>} files
 */
async function tree(name, files) {
  const root = join(dir, name);
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(root, p, '..'), { recursive: true });
    await writeFile(join(root, p), content);
  }
  return root;
}

describe('treeHash (review finding 8)', () => {
  const files = { 'src/index.js': 'export default 1;\n', 'src/lib/a.js': 'a\n', 'migrations/0001.sql': 'create table t;\n', 'scripts/lib.mjs': 'x\n', 'data/ng.json': '{}\n' };

  it('covers exactly the ranker paths', () => {
    expect(RANKER).toEqual(['src', 'migrations', 'scripts/lib.mjs', 'data']);
  });

  it('depends on content and paths only, not on mtimes or files outside the ranker paths', async () => {
    const a = await tree('a', files);
    const b = await tree('b', { ...files, 'eval/runner/retrieval.eval.js': 'runner\n', 'scripts/other.mjs': 'y\n' });
    await utimes(join(b, 'src/index.js'), new Date(0), new Date(0));
    expect(await treeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await treeHash(b)).toBe(await treeHash(a));
  });

  it('changes when a file changes, moves, appears or a symlink is retargeted', async () => {
    const base = await treeHash(await tree('c', files));
    expect(await treeHash(await tree('d', { ...files, 'src/lib/a.js': 'b\n' }))).not.toBe(base);
    const { 'src/lib/a.js': moved, ...rest } = files;
    expect(await treeHash(await tree('e', { ...rest, 'src/lib/b.js': moved }))).not.toBe(base);
    expect(await treeHash(await tree('f', { ...files, 'data/extra.json': '[]\n' }))).not.toBe(base);
    const g = await tree('g', files);
    await symlink('lib/a.js', join(g, 'src/link.js'));
    const h = await tree('h', files);
    await symlink('index.js', join(h, 'src/link.js'));
    expect(await treeHash(g)).not.toBe(await treeHash(h));
  });

  it('covers the test Worker config too: its compatibility date and flags change what runs (PR #6 review round 2, finding 7)', async () => {
    expect(TEST_CONFIG).toBe('test/wrangler.test.jsonc');
    expect(HASHED).toEqual([...RANKER, TEST_CONFIG]);
    const cfg = (/** @type {string} */ date, /** @type {string[]} */ flags) => JSON.stringify({ main: '../src/index.js', compatibility_date: date, compatibility_flags: flags });
    const a = await treeHash(await tree('cfg-a', { ...files, [TEST_CONFIG]: cfg('2025-01-01', []) }));
    const b = await treeHash(await tree('cfg-b', { ...files, [TEST_CONFIG]: cfg('2026-01-01', ['nodejs_compat']) }));
    expect(a).not.toBe(b);
  });
});
