// @ts-check
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt, generateKey, readEncryptedJson, readKey, updateManifest, verifyManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { embeddingKey, estimateTokens } from '../../eval/lib/embeddings.mjs';
import { spawnSync } from 'node:child_process';
import { appendLook, assertLookAllowed, finaliseLook, looks, readLedger, reserveLook, withLedgerLock } from '../../eval/lib/ledger.mjs';
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

describe('ledger tampering (review finding 5)', () => {
  const row = { date: '2026-11-04', set: 'holdout', commit: 'abc1234', variant: 'v', baseline: 'v0', verdict: 'fail', ndcg: '+0.000 [0.000, 0.000]', p5: '+0.000 [0.000, 0.000]' };

  it('counts every table row however it is spaced', async () => {
    const path = join(dir, 'spaced.md');
    for (let i = 0; i < 14; i++) await appendLook(path, row);
    const lines = (await readFile(path, 'utf8')).split('\n');
    let k = 0, j = 0;
    // A space after the leading pipe of 11 rows, and two more rows squashed and indented.
    const edited = lines.map((l) => (l.startsWith('| 2026') && k++ < 11 ? l.replace(/^\| /, '|  ') : l))
      .map((l) => (l.startsWith('| 2026') && j++ < 2 ? `   ${l.replace(/ \| /g, '|')}   ` : l));
    expect(edited.filter((l) => /^\| \d{4}-/.test(l))).toHaveLength(1);
    await writeFile(path, edited.join('\n'));
    expect(await looks(path, 'holdout')).toBe(14);
    await expect(assertLookAllowed(path, 'holdout', 12)).rejects.toThrow(/refusing look 15/);
  });

  it('a row whose set cell was changed to an unknown value still counts against every set', async () => {
    const path = join(dir, 'renamed.md');
    await appendLook(path, row);
    await appendLook(path, { ...row, set: 'h0ldout' });
    expect(await looks(path, 'holdout')).toBe(2);
    expect(await looks(path, 'test')).toBe(1);
  });

  it('refuses when the ledger has fewer rows than HEAD or origin/main, or is missing while git has it', async () => {
    const repo = join(dir, 'repo');
    const git = (/** @type {string[]} */ ...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(repo, 'eval'), { recursive: true });
    git('init', '-q');
    const path = join(repo, 'eval', 'holdout-ledger.md');
    for (let i = 0; i < 5; i++) await appendLook(path, row);
    git('add', '.');
    git('commit', '-qm', 'five looks');
    const opts = { repo };
    expect(await assertLookAllowed(path, 'holdout', 12, opts)).toBe(5);

    // Cut back to 3 rows: refused against HEAD.
    const text = await readFile(path, 'utf8');
    const cut = text.split('\n').filter((l, i, all) => !(l.startsWith('| 2026') && all.slice(0, i).filter((x) => x.startsWith('| 2026')).length >= 3)).join('\n');
    await writeFile(path, cut);
    expect(await looks(path, 'holdout')).toBe(3);
    await expect(assertLookAllowed(path, 'holdout', 12, opts)).rejects.toThrow(/has 3 look rows but HEAD:eval\/holdout-ledger\.md has 5; rows may only be appended/);
    await expect(assertLookAllowed(path, 'holdout', 12, opts)).rejects.toMatchObject({ name: 'LedgerTamperError' });

    // Deleted: refused while git has it.
    await rm(path);
    await expect(assertLookAllowed(path, 'holdout', 12, opts)).rejects.toThrow(/is missing but HEAD has it \(5 look rows\)/);

    // Committing the cut does not help while origin/main still has 5.
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    await writeFile(path, cut);
    git('commit', '-qam', 'cut the ledger');
    await expect(assertLookAllowed(path, 'holdout', 12, opts)).rejects.toThrow(/but origin\/main:eval\/holdout-ledger\.md has 5/);

    // Appending is always fine.
    for (let i = 0; i < 3; i++) await appendLook(path, row);
    expect(await assertLookAllowed(path, 'holdout', 12, opts)).toBe(6);
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

describe('ledger concurrency (review finding 3)', () => {
  const row = { date: '2026-11-04', set: 'holdout', commit: 'abc1234', variant: 'v', baseline: 'v0', verdict: 'fail', ndcg: '+0.000 [0.000, 0.000]', p5: '+0.000 [0.000, 0.000]' };

  it('three parallel looks from 11 rows: one is recorded, two are refused', async () => {
    const path = join(dir, 'parallel.md');
    for (let i = 0; i < 11; i++) await appendLook(path, row);
    // What eval:report does: check, compute (a tick here), append, under the lock.
    const look = (/** @type {number} */ i) => withLedgerLock(path, async () => {
      await assertLookAllowed(path, 'holdout', 12);
      await new Promise((r) => setTimeout(r, 5));
      await appendLook(path, { ...row, variant: `p${i}` });
    });
    const results = await Promise.allSettled([1, 2, 3].map(look));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected').map((r) => /** @type {PromiseRejectedResult} */ (r).reason.name);
    expect(refused).toEqual(['LookLimitError', 'LookLimitError']);
    expect(await looks(path, 'holdout')).toBe(12);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('a reserved look counts before its verdict, and finalising replaces that row', async () => {
    const path = join(dir, 'reserve.md');
    for (let i = 0; i < 10; i++) await appendLook(path, row);
    const base = { date: row.date, set: row.set, commit: row.commit, variant: row.variant, baseline: row.baseline };
    const r1 = await reserveLook(path, 12, { ...base, commit: 'pending', variant: 'r1' });
    const r2 = await reserveLook(path, 12, { ...base, commit: 'pending', variant: 'r2' });
    expect(r1).toMatch(/^\| 2026-11-04 \| holdout \| pending \| r1 \| v0 \| reserved [0-9a-f]{8} \| — \| — \|$/);
    expect(await looks(path, 'holdout')).toBe(12);
    await expect(reserveLook(path, 12, { ...base, variant: 'r3' })).rejects.toMatchObject({ name: 'LookLimitError' });
    await finaliseLook(path, r2, { ...row, variant: 'r2', verdict: 'pass' });
    await finaliseLook(path, r1, { ...row, variant: 'r1', verdict: 'aborted' });
    const rows = await readLedger(path);
    expect(rows).toHaveLength(12);
    expect(rows.slice(10).map((r) => [r.variant, r.verdict])).toEqual([['r1', 'aborted'], ['r2', 'pass']]);
    expect(await readFile(path, 'utf8')).not.toMatch(/reserved/);
  });

  it('a reserved row deleted mid-run is appended again when finalised', async () => {
    const path = join(dir, 'reserve-gone.md');
    const base = { date: row.date, set: row.set, commit: row.commit, variant: row.variant, baseline: row.baseline };
    const line = await reserveLook(path, 12, base);
    await writeFile(path, (await readFile(path, 'utf8')).replace(`${line}\n`, ''));
    expect(await looks(path, 'holdout')).toBe(0);
    await finaliseLook(path, line, { ...row, verdict: 'pass' });
    expect(await looks(path, 'holdout')).toBe(1);
  });

  it('waits for a fresh lock, then gives up with LedgerLockError', async () => {
    const path = join(dir, 'locked.md');
    await writeFile(`${path}.lock`, '1 now\n');
    await expect(withLedgerLock(path, async () => 'ran', { waitMs: 150 })).rejects.toMatchObject({ name: 'LedgerLockError' });
    await expect(withLedgerLock(path, async () => 'ran', { waitMs: 150 })).rejects.toThrow(/another eval holds the ledger lock .*locked\.md\.lock/);
    await rm(`${path}.lock`);
    expect(await withLedgerLock(path, async () => 'ran', { waitMs: 150 })).toBe('ran');
  });

  it('removes a lock older than 30 minutes, saying so', async () => {
    const path = join(dir, 'stale.md');
    await writeFile(`${path}.lock`, '1 long ago\n');
    const old = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(`${path}.lock`, old, old);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await withLedgerLock(path, async () => 'ran', { waitMs: 0 })).toBe('ran');
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/^eval: removing a stale ledger lock .*stale\.md\.lock \(31 minutes old; a lock older than 30 minutes is treated as abandoned\)$/));
    } finally {
      err.mockRestore();
    }
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
