// @ts-check
// The catalogueKey, the hash of D1's catalogue_only codes, and the
// comparison the deploy guard and `verify --pre-deploy` make against the
// bundled catalogue file (catalogue-codes-data, data/catalogue-codes.json in
// production). The comparison takes catalogue_only rows as a SELECT returns
// them, so the guard's D1 read (the D1 REST query) can call it.
import { describe, expect, it } from 'vitest';
import { catalogueKeyMismatch, catalogueMismatch, readBundledCatalogue } from '../scripts/catalogue-check.mjs';
import { catalogueKey } from '../src/rowhash.js';

describe('catalogueKey', () => {
  it('is 12 hex characters over the codes, whatever their order, and moves when a code is added or dropped', async () => {
    const k = await catalogueKey(['CS1010', 'AA0999', 'GEQ1000']);
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    expect(await catalogueKey(['GEQ1000', 'CS1010', 'AA0999'])).toBe(k);
    expect(await catalogueKey(['CS1010', 'AA0999'])).not.toBe(k);
    expect(await catalogueKey(['CS1010', 'AA0999', 'GEQ1000', 'ZZ1000'])).not.toBe(k);
    expect(await catalogueKey([])).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('the comparison with the bundled catalogue file', () => {
  const bundled = { codes: ['AA0999', 'CS1010', 'GEQ1000'] };

  it('passes D1 rows holding exactly the file\'s codes, in any order', async () => {
    expect(await catalogueMismatch([{ code: 'GEQ1000' }, { code: 'AA0999' }, { code: 'CS1010' }], bundled)).toBeNull();
    expect(await catalogueKeyMismatch(await catalogueKey(bundled.codes), bundled)).toBeNull();
  });

  it('refuses a missing code, an extra one, and a key from elsewhere, naming both keys', async () => {
    const missing = await catalogueMismatch([{ code: 'AA0999' }, { code: 'CS1010' }], bundled);
    expect(missing).toMatch(/catalogueKey/);
    expect(missing).toContain(await catalogueKey(bundled.codes));
    expect(missing).toMatch(/GEQ1000/);
    expect(await catalogueMismatch([...bundled.codes, 'ZZ1000'].map((code) => ({ code })), bundled)).toMatch(/ZZ1000/);
    expect(await catalogueKeyMismatch('000000000000', bundled)).toMatch(/000000000000/);
    expect(await catalogueKeyMismatch(null, bundled)).toMatch(/no catalogueKey/);
  });

  it('reads the bundled file the Worker ships (wrangler.jsonc aliases catalogue-codes-data to it)', async () => {
    const file = await readBundledCatalogue();
    expect(file.codes.length).toBeGreaterThan(10_000);
    expect(file.path).toMatch(/data\/catalogue-codes\.json$/);
  });
});
