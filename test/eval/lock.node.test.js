// @ts-check
// The query sets are locked by hashes written in ADR 0003. The manifest alone
// only checks itself (a PR could change a ciphertext and MANIFEST.json
// together), so this test ties both to the ADR: changing a set means
// changing the ADR, visibly, in the same PR (PR #10 review).
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyManifest } from '../../eval/lib/crypto.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

const ADR = 'docs/decisions/0003-eval-holdout-and-gate.md';
const sha256 = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');

/** @param {string} text @param {string} label */
function recorded(text, label) {
  const m = text.match(new RegExp(`${label} sha256 \`([0-9a-f]{64})\``));
  if (!m) throw new Error(`${ADR} records no "${label} sha256"`);
  return m[1];
}

describe('query-set locks (ADR 0003)', () => {
  it('the dev set and the holdout ciphertext match the hashes the ADR records', async () => {
    const adr = await readFile(join(REPO, ADR), 'utf8');
    expect(sha256(await readFile(join(REPO, 'eval/dev/queries.json')))).toBe(recorded(adr, 'dev plaintext'));
    const manifest = JSON.parse(await readFile(join(REPO, 'eval/holdout/MANIFEST.json'), 'utf8'));
    expect(manifest.files['queries.json.enc']).toBe(recorded(adr, 'holdout ciphertext'));
    expect(sha256(await readFile(join(REPO, 'eval/holdout/queries.json.enc')))).toBe(recorded(adr, 'holdout ciphertext'));
  });

  it('a plaintext file in an encrypted-set directory fails verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vnm-lock-'));
    try {
      await writeFile(join(dir, '.DS_Store'), ''); // Finder's, ignored
      await writeFile(join(dir, '._queries.json.enc'), ''); // Finder's, ignored
      await writeFile(join(dir, 'queries.json'), '{}');
      await writeFile(join(dir, '.queries.json'), '{}'); // a hidden plaintext is still refused
      const problems = await verifyManifest(dir);
      expect(problems).toHaveLength(2);
      expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/\/queries\.json is not a ciphertext/), expect.stringMatching(/\/\.queries\.json is not a ciphertext/)]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
