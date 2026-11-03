// @ts-check
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateKey, readEncryptedJson, readKey, updateManifest, verifyManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { embeddingKey, estimateTokens } from '../../eval/lib/embeddings.mjs';
import { appendLook, assertLookAllowed, looks } from '../../eval/lib/ledger.mjs';
import { DecryptionError } from '../../eval/lib/errors.mjs';
import { REPO, layout, runFile, searchParams, validateQueries } from '../../eval/lib/sets.mjs';

/** @type {string} */
let dir;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'vnm-custody-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('AES-256-GCM files', () => {
  it('round-trips, and binds the file name so ciphertexts cannot be swapped', async () => {
    const keyPath = await generateKey(join(dir, 'k', 'holdout.key'));
    const key = await readKey(keyPath);
    expect(key).toHaveLength(32);
    const ct = encrypt(Buffer.from('{"a":1}'), key, 'qrels.json.enc', 'holdout');
    expect(ct.subarray(0, 8).toString('latin1')).toBe('VNMENC2\n');
    expect(decrypt(ct, key, 'qrels.json.enc', 'holdout').toString()).toBe('{"a":1}');
    expect(() => decrypt(ct, key, 'queries.json.enc', 'holdout')).toThrow(/decryption failed/);
    const flipped = Buffer.from(ct);
    flipped[flipped.length - 1] ^= 1;
    expect(() => decrypt(flipped, key, 'qrels.json.enc', 'holdout')).toThrow(/decryption failed/);
    expect(() => decrypt(ct, Buffer.alloc(32, 7), 'qrels.json.enc', 'holdout')).toThrow(/decryption failed/);
  });

  it('binds the set name, so a ciphertext copied into another set fails to decrypt (review finding 2)', async () => {
    const key = await readKey(await generateKey(join(dir, 'k-set', 'holdout.key')));
    const ct = encrypt(Buffer.from('{"q":1}'), key, '/somewhere/eval/holdout/queries.json.enc', 'holdout');
    // Same file name, any directory: the set name decides.
    expect(decrypt(ct, key, '/elsewhere/copy/queries.json.enc', 'holdout').toString()).toBe('{"q":1}');
    for (const other of ['test', 'selftest']) {
      expect(() => decrypt(ct, key, '/elsewhere/copy/queries.json.enc', other)).toThrow(DecryptionError);
    }
    expect(() => encrypt(Buffer.from('{}'), key, 'queries.json.enc', /** @type {any} */ (undefined))).toThrow(/needs a set name/);
  });

  it('never overwrites a key and never puts key material in an error', async () => {
    const keyPath = join(dir, 'k2.key');
    await generateKey(keyPath);
    await expect(generateKey(keyPath)).rejects.toThrow(/refusing to overwrite/);
    await writeFile(join(dir, 'bad.key'), 'deadbeef-not-a-key');
    await expect(readKey(join(dir, 'bad.key'))).rejects.toThrow(/is not 64 hex characters/);
    await expect(readKey(join(dir, 'bad.key'))).rejects.not.toThrow(/deadbeef/);
    await expect(readKey(join(dir, 'missing.key'))).rejects.toThrow(/holdout key not found/);
  });

  it('JSON helpers and the manifest detect tampering, missing and unlisted files without a key', async () => {
    const key = await readKey(await generateKey(join(dir, 'k3.key')));
    const h = join(dir, 'holdout');
    await writeEncryptedJson(join(h, 'queries.json.enc'), { version: 'x', queries: [] }, key, 'holdout');
    expect(await readEncryptedJson(join(h, 'queries.json.enc'), key, 'holdout')).toEqual({ version: 'x', queries: [] });
    await updateManifest(h);
    expect(await verifyManifest(h)).toEqual([]);
    await writeEncryptedJson(join(h, 'qrels.json.enc'), {}, key, 'holdout');
    expect((await verifyManifest(h)).join('\n')).toMatch(/qrels\.json\.enc is not in/);
    await updateManifest(h);
    const p = join(h, 'queries.json.enc');
    const bytes = await readFile(p);
    bytes[20] ^= 1;
    await writeFile(p, bytes);
    expect((await verifyManifest(h)).join('\n')).toMatch(/queries\.json\.enc sha256 .* != manifest/);
    await rm(p);
    expect((await verifyManifest(h)).join('\n')).toMatch(/in the manifest but missing/);
    expect(await verifyManifest(join(dir, 'nothing-here'))).toEqual([]);
  });
});

describe('ledger', () => {
  it('counts looks per set and refuses one past the limit', async () => {
    const path = join(dir, 'ledger.md');
    const row = { date: '2026-11-04', set: 'holdout', commit: 'abc1234', variant: 'v', baseline: 'v0', verdict: 'pass', ndcg: '+0.010 [0.000, 0.020]', p5: '+0.000 [0.000, 0.000]' };
    expect(await looks(path, 'holdout')).toBe(0);
    for (let i = 0; i < 12; i++) await appendLook(path, { ...row, variant: `v|${i}` });
    await appendLook(path, { ...row, set: 'test' });
    expect(await looks(path, 'holdout')).toBe(12);
    expect(await looks(path, 'test')).toBe(1);
    await expect(assertLookAllowed(path, 'holdout', 12)).rejects.toThrow(/refusing look 13 at the holdout set/);
    await expect(assertLookAllowed(path, 'test', 1)).rejects.toThrow(/refusing look 2/);
    // A pipe in a cell cannot shift the columns.
    expect((await readFile(path, 'utf8'))).toContain('| v 0 |');
  });
});

describe('sets', () => {
  it('lays out encrypted sets as .enc files only', () => {
    const h = layout('holdout');
    expect(h.encrypted).toBe(true);
    expect(h.maxLooks).toBe(12);
    expect(runFile(h, 'cand')).toMatch(/eval\/holdout\/run-cand\.json\.enc$/);
    expect(layout('test').maxLooks).toBe(1);
    expect(runFile(layout('dev'), 'v0')).toMatch(/eval\/runs\/v0\.json$/);
    expect(() => runFile(layout('dev'), '../x')).toThrow(/may only use/);
    expect(() => layout('nope')).toThrow(/unknown set/);
  });

  it('keeps the custody ledger at its fixed repo path whatever --set-dir says (review finding 2)', () => {
    const fixed = join(REPO, 'eval', 'holdout-ledger.md');
    for (const name of ['holdout', 'test']) {
      expect(layout(name).ledger).toBe(fixed);
      expect(layout(name, '/tmp/copy-of-holdout').ledger).toBe(fixed);
      expect(layout(name, join(REPO, 'eval', 'holdout')).ledger).toBe(fixed);
    }
    // Only the self-test set keeps a ledger in its directory; its ciphertexts are bound to "selftest".
    expect(layout('selftest', '/tmp/st').ledger).toBe('/tmp/st/ledger.md');
    expect(layout('selftest', '/tmp/st')).toMatchObject({ encrypted: true, maxLooks: 12, gate: 'holdout' });
    expect(layout('dev', '/tmp/d').ledger).toBe(null);
  });

  it('validates query files', () => {
    const ok = { version: 'v', queries: [{ id: 'd-001', text: 'x', filters: { ng: true, sem: 1 } }] };
    expect(() => validateQueries(ok, 'f')).not.toThrow();
    expect(() => validateQueries({ ...ok, queries: [...ok.queries, ok.queries[0]] }, 'f')).toThrow(/duplicate query id/);
    expect(() => validateQueries({ version: 'v', queries: [{ id: 'has space', text: 'x' }] }, 'f')).toThrow(/opaque/);
    expect(() => validateQueries({ version: 'v', queries: [{ id: 'a', text: 'x', filters: { mode: 'vector' } }] }, 'f')).toThrow(/unknown filter "mode"/);
  });

  it('maps filters to /search params with production defaults (no topK, no mode)', () => {
    expect(searchParams({ id: 'a', text: 'ml', filters: { ng: true, sem: 1, level: 3, faculty: 'Computing' } }))
      .toEqual({ q: 'ml', ng: '1', sem: '1', level: '3', faculty: 'Computing' });
    expect(searchParams({ id: 'a', text: 'ml', filters: { ng: false } })).toEqual({ q: 'ml' });
    expect(searchParams({ id: 'a', text: 'ml', filters: { sem: 2 } }, { unfiltered: true })).toEqual({ q: 'ml' });
  });
});

describe('embedding keys and token estimates', () => {
  it('keys by model and text', () => {
    expect(embeddingKey('m', 'a')).not.toBe(embeddingKey('m', 'b'));
    expect(embeddingKey('m1', 'a')).not.toBe(embeddingKey('m2', 'a'));
    expect(embeddingKey('m', 'a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('estimates conservatively: never below chars / 4, capped at 512', () => {
    expect(estimateTokens('machine learning')).toBe(Math.max(2 + 2, Math.ceil(16 / 4) + 2));
    expect(estimateTokens('a'.repeat(4000))).toBe(512);
    const text = 'Programming Methodology. Computing. This course introduces the fundamental concepts.';
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
  });
});
