// @ts-check
// B12-open (Phase 7 7D): the catalogue codes follow the corpus. Every code in
// the production catalogue file (`catalogue-codes-data`, data/catalogue-codes.json,
// built from `current`) that the pinned one (data/pinned/catalogue-codes.json)
// lacks was an unknown code to search before 7D, though /module called it
// catalogue-only. Over production, with catalogue_only loaded as ingest loads
// it, each answers as not offered: `not-offered`, or 6A's more specific
// `ng-unscheduled` for an NG-listed code with no classes. The one exception is
// older than 7D: the parse reads a token as a code only when its prefix is an
// offered one (`prefixes-data`), so a code whose prefix no offered course has
// (EX2991; 2,565 such codes in the pinned catalogue too) is not a code to
// search. Those are listed and counted, not answered. The counts are the exit
// check's.
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import production from 'catalogue-codes-data';
import prefixes from 'prefixes-data';
import catalogueFile from 'catalogue-only-data';
import pinned from '../../data/pinned/catalogue-codes.json';
import { unscheduled } from '../../src/ng-unscheduled.js';
import { createFakes } from '../fakes.js';
import { adminCall, callJson, seed } from '../helpers.js';

const corpus = inject('corpus');

describe.skipIf(!corpus)('B12: catalogue-only codes added since the pin answer not-offered', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const old = new Set(pinned.codes);
  const added = production.codes.filter((code) => !old.has(code));
  const fakes = createFakes();

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // D1 as ingest leaves it: every offered row, then the catalogue-only rows.
    await seed({ modules: c.modules, fakes });
    const want = new Set(added);
    const rows = /** @type {[string, string, string | null][]} */ (catalogueFile.rows).filter(([code]) => want.has(code));
    const upsert = rows.map(([code, title, description]) => ({ code, title, description, acadYear: c.acadYear }));
    for (let i = 0; i < upsert.length; i += 100) {
      const res = await adminCall('/admin/catalogue', fakes, { upsert: upsert.slice(i, i + 100) });
      if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status}`);
    }
  }, 600_000);

  it('the production file is for this corpus and holds codes the pinned one lacks', () => {
    expect(production.source.acadYear).toBe(c.acadYear);
    expect(production.source.moduleInfoSha256).toBe(c.moduleInfoSha256);
    expect(added.length).toBeGreaterThan(0);
  });

  it('each with an offered prefix answers not-offered (or ng-unscheduled), naming itself', async () => {
    const classless = unscheduled();
    /** @param {string} code */
    const prefixOf = (code) => /^[A-Z]+/.exec(code)?.[0] ?? '';
    const unparsed = added.filter((code) => !Object.hasOwn(prefixes.prefixes, prefixOf(code)));
    /** @type {string[]} */
    const wrong = [];
    let notOffered = 0, ngUnscheduled = 0;
    for (const code of added.filter((x) => !unparsed.includes(x))) {
      const { status, body } = await callJson(`/search?q=${encodeURIComponent(code)}`, { fakes });
      const want = classless.has(code) ? 'ng-unscheduled' : 'not-offered';
      if (status !== 200 || body.noMatch?.reason !== want || body.noMatch?.code !== code) {
        wrong.push(`${code}: HTTP ${status} ${JSON.stringify(body.noMatch ?? null)}, want ${want}`);
      } else if (want === 'not-offered') notOffered++;
      else ngUnscheduled++;
    }
    console.info(`B12: ${added.length} catalogue-only codes in the production file and not the pinned one: `
      + `${notOffered} answer not-offered, ${ngUnscheduled} ng-unscheduled (NG-listed, no classes), `
      + `${unparsed.length} have a prefix no offered course has, so the parse reads no code (${unparsed.join(', ') || 'none'})`);
    expect(wrong).toEqual([]);
    expect(notOffered + ngUnscheduled + unparsed.length).toBe(added.length);
    expect(notOffered).toBeGreaterThan(unparsed.length);
  }, 300_000);
});
