// @ts-check
// B12-open (Phase 7 7D): the catalogue codes follow the corpus. Every code in
// the production catalogue file (`catalogue-codes-data`, data/catalogue-codes.json,
// built from `current`) that the pinned one (data/pinned/catalogue-codes.json)
// lacks was an unknown code to search before 7D, though /module called it
// catalogue-only. Over production, with catalogue_only loaded as ingest loads
// it, each must answer `not-offered`. The count is the exit check's.
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import production from 'catalogue-codes-data';
import catalogueFile from 'catalogue-only-data';
import pinned from '../../data/pinned/catalogue-codes.json';
import { createFakes } from '../fakes.js';
import { adminCall, callJson } from '../helpers.js';

const corpus = inject('corpus');

describe.skipIf(!corpus)('B12: catalogue-only codes added since the pin answer not-offered', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const old = new Set(pinned.codes);
  const added = production.codes.filter((code) => !old.has(code));
  const fakes = createFakes();

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const want = new Set(added);
    const rows = /** @type {[string, string, string | null][]} */ (catalogueFile.rows).filter(([code]) => want.has(code));
    const upsert = rows.map(([code, title, description]) => ({ code, title, description, acadYear: c.acadYear }));
    for (let i = 0; i < upsert.length; i += 100) {
      const res = await adminCall('/admin/catalogue', fakes, { upsert: upsert.slice(i, i + 100) });
      if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status}`);
    }
  }, 120_000);

  it('the production file is for this corpus and holds codes the pinned one lacks', () => {
    expect(production.source.acadYear).toBe(c.acadYear);
    expect(production.source.moduleInfoSha256).toBe(c.moduleInfoSha256);
    expect(added.length).toBeGreaterThan(0);
  });

  it('each answers not-offered, naming itself', async () => {
    /** @type {string[]} */
    const wrong = [];
    for (const code of added) {
      const { status, body } = await callJson(`/search?q=${encodeURIComponent(code)}`, { fakes });
      if (status !== 200 || body.noMatch?.reason !== 'not-offered' || body.noMatch?.code !== code) {
        wrong.push(`${code}: HTTP ${status} ${JSON.stringify(body.noMatch ?? null)}`);
      }
    }
    console.info(`B12: ${added.length} catalogue-only codes in the production file and not the pinned one; ${added.length - wrong.length} answer not-offered`);
    expect(wrong).toEqual([]);
  }, 300_000);
});
