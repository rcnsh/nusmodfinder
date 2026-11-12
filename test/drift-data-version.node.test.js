// @ts-check
// The drift check's data version is production's, computed offline by the function CI uses
// (scripts/corpus-manifest.mjs corpusDataVersion: offeredModules over HEAD's NG
// files for the year, rowHash, dataVersion), so a match with src/data-version.json means
// production holds NUSMods' data. Fixture records under DEFAULT_ACAD_YEAR's real NG files.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { summarise } from '../scripts/drift.mjs';
import { corpusDataVersion } from '../scripts/corpus-manifest.mjs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from '../scripts/lib.mjs';
import { dataVersion, rowHash } from '../src/rowhash.js';

/** @param {string} code @param {Record<string, unknown>} [o] */
const rec = (code, o = {}) => ({
  moduleCode: code, title: `Title of ${code}`, description: `What ${code} is about.`, moduleCredit: '4',
  department: 'Computer Science', faculty: 'Computing', semesterData: [{ semester: 1 }], ...o,
});
// CS1010 and CS2030 are on the NG list, so the NG fields and rules feed the row hash.
const RECORDS = [rec('CS1010'), rec('CS2030', { semesterData: [{ semester: 1 }, { semester: 2 }] }), rec('ZZ9999'), rec('XX1000', { semesterData: [] })];

describe('the drift data version', () => {
  it('is corpusDataVersion\'s, over HEAD\'s NG files for the year, as ingest computes it', async () => {
    const ng = await loadNgCourses(DEFAULT_ACAD_YEAR);
    expect(ng.available).toBe(true);
    const s = await summarise(RECORDS, DEFAULT_ACAD_YEAR, ng);
    expect(s.dataVersion).toBe(await corpusDataVersion(RECORDS, DEFAULT_ACAD_YEAR));
    const { modules } = offeredModules(RECORDS, DEFAULT_ACAD_YEAR, ng);
    expect(s.dataVersion).toBe(await dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) })))));
    expect(modules.find((m) => m.code === 'CS1010')?.ng).toBe(true);
  });

  it('reuses that function rather than hashing on its own', () => {
    const src = readFileSync(new URL('../scripts/drift.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bcorpusDataVersion\b[^}]*\} from '\.\/corpus-manifest\.mjs'/);
    expect(src).not.toMatch(/createHash|subtle\.digest|\bdataVersion\(/);
  });
});
