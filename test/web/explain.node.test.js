// @ts-check
// public/explain.js (Phase 5 5C, D4, C2-3, C3-1, C3-2): the sentences the page
// writes about exchange status. Each exchange note in full (the `semester` one
// as an action), each hidden typed code with its own stored reasons and their
// sources, a partial code exchange mode empties, and the typed codes past the
// three that pin.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  filterMisses, hiddenCodeLine, noteText, notOfferedLine, partialCodeLine, prefixLabel, reasonLine, sourceNote, statusText, studyPhrase, typedCodes, unpinnedLine,
} from '../../public/explain.js';

const reasonsFile = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/ng-reasons.json', import.meta.url)), 'utf8'));
/** /facets' `ngSources`, as the Worker serves them (src/ng-reasons.js NG_SOURCES). */
const SOURCES = reasonsFile.sources;
/** @param {string} id */
const reason = (id) => ({ id, kind: reasonsFile.reasons[id].kind, text: reasonsFile.reasons[id].text });

/**
 * A /module `exchange` array for one study level from (status, reason ids) per semester.
 * @param {string} study
 * @param {Record<string, [import('../../public/explain.js').Status, string[]]>} bySem keys 1, 2, any
 * @returns {import('../../public/explain.js').ExchangeEntry[]}
 */
function exchange(study, bySem) {
  return Object.entries(bySem).map(([sem, [status, ids]]) => ({
    sem: sem === 'any' ? /** @type {const} */ ('any') : Number(sem), study, status, reasons: ids.map(reason),
  }));
}

describe('sources and statuses', () => {
  it('sourceNote names the NG list or the restrictions with its "updated as at" date', () => {
    expect(sourceNote('ng-list:not-listed', SOURCES)).toBe('NG list, updated 01 Sep 2026');
    expect(sourceNote('ng-list:nusmods-semester-differs', SOURCES)).toBe('NG list, updated 01 Sep 2026');
    expect(sourceNote('D-grad-levels-closed-exchange', SOURCES)).toBe('NG restrictions, updated 31 Aug 2026');
    // /facets down: the source still, without a date.
    expect(sourceNote('2-biz-major', null)).toBe('NG restrictions');
    expect(sourceNote('ng-list:not-listed', [])).toBe('NG list');
  });

  it('statusText never leaves the status to colour alone', () => {
    expect(statusText('open')).toBe('Open to exchange students');
    expect(statusText('note')).toBe('Open to exchange students, with conditions');
    expect(statusText('closed')).toBe('Not open to exchange students');
  });

  it('studyPhrase reads after "open to exchange students in Sem 1"', () => {
    expect(['ug1', 'ug2', 'ug3', 'ug4', 'grad'].map(studyPhrase))
      .toEqual(['at 1st year', 'at 2nd year', 'at 3rd year', 'at 4th year or later', 'for graduate students']);
  });
});

describe('noteText (every note in full; C2-3)', () => {
  it('words the `semester` note as an action, for the semester it is about', () => {
    expect(noteText(reason('ng-list:nusmods-semester-differs'), 1)).toBe("Not on NUSMods' timetable for Sem 1: check with the department.");
    expect(noteText(reason('ng-list:nusmods-semester-differs'), '2')).toBe("Not on NUSMods' timetable for Sem 2: check with the department.");
    expect(noteText(reason('ng-list:nusmods-semester-differs'), 'any')).toBe("Not on NUSMods' timetable in the semester the NG list gives: check with the department.");
  });

  it('names the other semester instead of "the other semester"', () => {
    expect(noteText(reason('ng-list:not-in-semester'), 1)).toBe('Offered to exchange students only in Sem 2.');
    expect(noteText(reason('ng-list:not-in-semester'), 2)).toBe('Offered to exchange students only in Sem 1.');
  });

  it('every other note is its stored text, unshortened', () => {
    for (const id of ['2-biz-l1234-priority', '2-biz-major', '3-soc-cg:elsewhere', '1-geog-quota']) {
      expect(noteText(reason(id), 1)).toBe(reasonsFile.reasons[id].text);
    }
  });

  it('reasonLine adds the source and its date', () => {
    expect(reasonLine(reason('2-biz-major'), 1, SOURCES)).toBe(`${reasonsFile.reasons['2-biz-major'].text.replace(/\.$/, '')} (NG restrictions, updated 31 Aug 2026).`);
  });
});

describe('hiddenCodeLine (D4: each hidden typed code, with its own stored reasons; C3-1)', () => {
  it('not on the NG list', () => {
    const ex = exchange('ug2', { 1: ['closed', ['ng-list:not-listed']], 2: ['closed', ['ng-list:not-listed']], any: ['closed', ['ng-list:not-listed']] });
    expect(hiddenCodeLine({ code: 'CS5562', sem: '1', study: 'ug2', exchange: ex, sources: SOURCES }))
      .toBe("CS5562 isn't on the Registrar's list of courses offered to exchange students (NG list, updated 01 Sep 2026).");
    expect(hiddenCodeLine({ code: 'CS5562', sem: '', study: 'ug2', exchange: ex, sources: SOURCES }))
      .toBe("CS5562 isn't on the Registrar's list of courses offered to exchange students (NG list, updated 01 Sep 2026).");
  });

  it('on the NG list for the other semester only (CS3244 at 2nd year, Sem 1)', () => {
    const ex = exchange('ug2', { 1: ['closed', ['ng-list:not-in-semester']], 2: ['open', []], any: ['open', []] });
    expect(hiddenCodeLine({ code: 'CS3244', sem: '1', study: 'ug2', exchange: ex, sources: SOURCES }))
      .toBe('CS3244 is open to exchange students only in Sem 2 (NG list, updated 01 Sep 2026).');
    // Noted, not only open, in the other semester still counts as open there.
    const noted = exchange('ug2', { 1: ['note', ['1-geog-quota']], 2: ['closed', ['ng-list:not-in-semester']], any: ['note', ['1-geog-quota']] });
    expect(hiddenCodeLine({ code: 'GE2101', sem: '2', study: 'ug2', exchange: noted, sources: SOURCES }))
      .toBe('GE2101 is open to exchange students only in Sem 1 (NG list, updated 01 Sep 2026).');
  });

  it('closed by a restriction: each closing reason, with its source', () => {
    const one = exchange('ug2', { 1: ['closed', ['D-grad-levels-closed-exchange']], 2: ['closed', ['ng-list:not-in-semester', 'D-grad-levels-closed-exchange']], any: ['closed', ['D-grad-levels-closed-exchange']] });
    expect(hiddenCodeLine({ code: 'AR5801', sem: '1', study: 'ug2', exchange: one, sources: SOURCES }))
      .toBe("AR5801 isn't open to exchange students in Sem 1 at 2nd year. Level 5000 and 6000 courses are not open to exchange students unless a department says so (NG restrictions, updated 31 Aug 2026).");
    const two = exchange('ug2', { 1: ['closed', ['D-grad-levels-closed-exchange', '7-pp-ug-closed']], 2: ['closed', []], any: ['closed', ['D-grad-levels-closed-exchange', '7-pp-ug-closed']] });
    const line = hiddenCodeLine({ code: 'PP5164', sem: '', study: 'ug2', exchange: two, sources: SOURCES });
    expect(line).toMatch(/^PP5164 isn't open to exchange students in either semester at 2nd year\. Level 5000 and 6000 courses are not open to exchange students unless a department says so \(NG restrictions, updated 31 Aug 2026\)\. .+ \(NG restrictions, updated 31 Aug 2026\)\.$/);
    expect(line).toContain(reasonsFile.reasons['7-pp-ug-closed'].text.replace(/\.$/, ''));
  });

  it('the other semester only, but closed there too: every reason, never "only in Sem 2"', () => {
    const ex = exchange('ug2', { 1: ['closed', ['ng-list:not-in-semester']], 2: ['closed', ['D-grad-levels-closed-exchange']], any: ['closed', ['D-grad-levels-closed-exchange']] });
    expect(hiddenCodeLine({ code: 'CM5223', sem: '1', study: 'ug2', exchange: ex, sources: SOURCES }))
      .toBe("CM5223 isn't open to exchange students in Sem 1 at 2nd year. Offered to exchange students only in Sem 2 (NG list, updated 01 Sep 2026). In Sem 2: Level 5000 and 6000 courses are not open to exchange students unless a department says so (NG restrictions, updated 31 Aug 2026).");
  });

  it('a code the exchange set-up allows was hidden by another filter: it says which', () => {
    const ex = exchange('ug2', { 1: ['open', []], 2: ['open', []], any: ['open', []] });
    const mod = { code: 'CS2030', semesters: [1, 2], level: 2, credits: 4, faculty: 'Computing' };
    expect(hiddenCodeLine({ code: 'CS2030', sem: '1', study: 'ug2', exchange: ex, sources: SOURCES, module: mod, filters: { level: 3 } }))
      .toBe('CS2030 is hidden by your filters: it is a level 2000 course.');
    expect(hiddenCodeLine({ code: 'CS2030', sem: '', study: '', exchange: ex, sources: SOURCES, module: { ...mod, semesters: [2] }, filters: { sem: 1, credits: 2 } }))
      .toBe("CS2030 is hidden by your filters: it isn't offered in Sem 1, and it is 4 units.");
    expect(hiddenCodeLine({ code: 'CS2030', sem: '', study: '', exchange: ex, sources: SOURCES, module: mod, filters: {} }))
      .toBe("CS2030 doesn't match this search's filters.");
  });

  it('filterMisses lists only the filters the course fails', () => {
    const mod = { code: 'X', semesters: [1], level: 2, credits: 4, faculty: 'Computing' };
    expect(filterMisses(mod, { sem: 1, level: 2, credits: 4, faculty: 'Computing' })).toEqual([]);
    expect(filterMisses(mod, { sem: 2, faculty: 'Science' })).toEqual(["it isn't offered in Sem 2", 'it is in Computing']);
    // In exchange mode the NG list decides the semester, not NUSMods' timetable (src/search.js localMatchesFilters).
    expect(filterMisses({ ...mod, level: 1 }, { sem: 2, ng: true, study: 'ug2', level: 2 })).toEqual(['it is a level 1000 course']);
  });
});

describe('notOfferedLine and the partial-code empty state (C3-2)', () => {
  it('a catalogue-only code', () => {
    expect(notOfferedLine('CS1001')).toBe("CS1001 isn't offered this academic year.");
    expect(notOfferedLine('CS1001', 'Programming Methodology')).toBe("CS1001 (Programming Methodology) isn't offered this academic year.");
  });

  it('prefixLabel pads a partial code with x', () => {
    expect(prefixLabel('CS32')).toBe('CS32xx');
    expect(prefixLabel('CS5')).toBe('CS5xxx');
    expect(prefixLabel('CS')).toBe('CS');
  });

  it('one semester, the other has results: names the chosen semester (the page adds the button)', () => {
    expect(partialCodeLine({ prefix: 'CS32', sem: '1', study: 'ug2', otherHasResults: true }))
      .toBe('No CS32xx course is open to exchange students in Sem 1 at 2nd year.');
    // Not known yet (the other semester is still being checked): the chosen semester.
    expect(partialCodeLine({ prefix: 'CG32', sem: '2', study: 'ug1', otherHasResults: null }))
      .toBe('No CG32xx course is open to exchange students in Sem 2 at 1st year.');
  });

  it('both semesters chosen, or the other is empty too: either semester, never "loosen a filter"', () => {
    expect(partialCodeLine({ prefix: 'CS52', sem: '1', study: 'ug2', otherHasResults: false }))
      .toBe('No CS52xx course is open to exchange students in either semester at 2nd year.');
    expect(partialCodeLine({ prefix: 'CS52', sem: '', study: 'grad', otherHasResults: null }))
      .toBe('No CS52xx course is open to exchange students in either semester for graduate students.');
    expect(partialCodeLine({ prefix: 'CS', sem: '', study: 'ug2', otherHasResults: null })).not.toMatch(/loosen/i);
  });
});

describe('typed codes past the three that pin (5C-api leaves a 4th code unexplained)', () => {
  it('typedCodes finds code-shaped words in order, upper-cased, once each, joined across one space as /search joins them', () => {
    expect(typedCodes('cs2030 CS3244 and cs2030 MA1301 machine learning cs2040s')).toEqual(['CS2030', 'CS3244', 'MA1301', 'CS2040S']);
    expect(typedCodes('CS1010 cs 3244 LC6009GRSII')).toEqual(['CS1010', 'CS3244', 'LC6009GRSII']);
    expect(typedCodes('machine learning')).toEqual([]);
  });

  const RULE = 'Only the first three course codes you type that are offered this year are pinned to the top of the results.';

  it('fewer than three pinned: every offered typed code pinned, so nothing to say', () => {
    expect(unpinnedLine('CS2030 CS3244 CS1010', { pinned: ['CS2030', 'CS3244', 'CS1010'], hidden: ['CS3244'], notOffered: [], shown: new Set(['CS2030', 'CS1010']) })).toBeNull();
    expect(unpinnedLine('CS1001 CS2030 CS3244 ZZ9999', { pinned: ['CS2030', 'CS3244'], hidden: [], notOffered: ['CS1001'], shown: new Set(['CS2030', 'CS3244']) })).toBeNull();
  });

  it('a 4th offered code: says only the first three pin, and names any typed code that is neither shown nor explained', () => {
    const shown = new Set(['CS2030', 'CS1010', 'CS2113']);
    expect(unpinnedLine('CS2030 CS3244 CS1010 CS2113', { pinned: ['CS2030', 'CS3244', 'CS1010'], hidden: ['CS3244'], notOffered: [], shown })).toBe(RULE);
    expect(unpinnedLine('CS2030 CS3244 CS1010 CS2104 CS2113', { pinned: ['CS2030', 'CS3244', 'CS1010'], hidden: ['CS3244'], notOffered: [], shown: new Set(['CS2030', 'CS1010']) }))
      .toBe(`${RULE} CS2104 and CS2113 are not in these results: search for each on its own.`);
    // A code typed with a space, as /search joins it.
    expect(unpinnedLine('CS1010 CS2030 CS2104 cs 3244', { pinned: ['CS1010', 'CS2030', 'CS2104'], hidden: [], notOffered: [], shown: new Set(['CS1010', 'CS2030', 'CS2104']) }))
      .toBe(`${RULE} CS3244 is not in these results: search for it on its own.`);
  });

  it('a code not offered this year neither counts toward the three nor is named (its own line says why)', () => {
    expect(unpinnedLine('CS1001 CS2030 CS1010 CS2104 CS2113', { pinned: ['CS2030', 'CS1010', 'CS2104'], hidden: [], notOffered: ['CS1001'], shown: new Set(['CS2030', 'CS1010', 'CS2104']) }))
      .toBe(`${RULE} CS2113 is not in these results: search for it on its own.`);
    expect(unpinnedLine('CS1001 CS2030 CS1010 CS2104', { pinned: ['CS2030', 'CS1010', 'CS2104'], hidden: [], notOffered: ['CS1001'], shown: new Set(['CS2030', 'CS1010', 'CS2104']) })).toBeNull();
  });
});
