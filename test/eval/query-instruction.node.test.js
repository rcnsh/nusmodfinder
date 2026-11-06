// @ts-check
// The eval asks a ranker which query instruction it embeds with (3A-1), so a
// run checks for exactly the query vectors that ranker needs: eval-v0 and the
// 3-0 ranker have none, the working tree has bge's retrieval instruction.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rankerQueryInstruction } from '../../eval/lib/embeddings.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { QUERY_INSTRUCTION } from '../../src/embedding.js';

/** @type {string} */
let dir;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'vnm-instruction-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('rankerQueryInstruction', () => {
  it('reads the working tree\'s QUERY_INSTRUCTION', async () => {
    expect(await rankerQueryInstruction(REPO)).toBe(QUERY_INSTRUCTION);
    expect(QUERY_INSTRUCTION).toBe('Represent this sentence for searching relevant passages: ');
  });

  it('is empty for a ranker with no src/embedding.js (eval-v0)', async () => {
    const root = join(dir, 'v0');
    await mkdir(join(root, 'src'), { recursive: true });
    expect(await rankerQueryInstruction(root)).toBe('');
  });

  it('is empty for a ranker whose src/embedding.js has no QUERY_INSTRUCTION (the 3-0 ranker)', async () => {
    const root = join(dir, 'r30');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/embedding.js'), "export const DEFAULT_MODEL = '@cf/baai/bge-small-en-v1.5';\nexport const EMBEDDING_DIMS = 384;\n");
    expect(await rankerQueryInstruction(root)).toBe('');
  });

  it('refuses a QUERY_INSTRUCTION that is not a string', async () => {
    const root = join(dir, 'bad');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/embedding.js'), 'export const QUERY_INSTRUCTION = 42;\n');
    await expect(rankerQueryInstruction(root)).rejects.toThrow(/QUERY_INSTRUCTION/);
  });
});
