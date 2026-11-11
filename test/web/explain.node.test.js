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
  NOT_OFFERED_STAMP, boxNotOffered, codesCount, codesOnly, filterMisses, hiddenCodeLine, hiddenCodeStamp, noteLead, noteText, notOfferedLine, partialCodeLine, prefixLabel, reasonLine, sourceNote, statusText, studyPhrase, typedCodes, unpinnedLine,
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

  it('[R3] the year-of-study note cites the course\'s NUS prerequisite, not either NG list', () => {
    expect(sourceNote('prereq:year-of-study', SOURCES)).toBe('NUS prerequisite');
    expect(sourceNote('prereq:year-of-study', null)).toBe('NUS prerequisite');
  });

  it('statusText never leaves the status to colour alone', () => {
    expect(statusText('open')).toBe('Open to exchange students');
    expect(statusText('note')).toBe('Open to exchange students, with notes');
    expect(statusText('closed')).toBe('Not open to exchange students');
  });

  it('studyPhrase reads after "open to exchange students in Sem 1"', () => {
    expect(['ug1', 'ug2', 'ug3', 'ug4', 'grad'].map(studyPhrase))
      .toEqual(['1st-year exchange students', '2nd-year exchange students', '3rd-year exchange students', '4th-year (or later) exchange students', 'graduate exchange students']);
  });
});

describe('noteText (every note in full; C2-3)', () => {
  it('words the `semester` note as an action, for the semester it is about', () => {
    expect(noteText(reason('ng-list:nusmods-semester-differs'), 1)).toBe("The NG list offers it in Sem 1, but NUSMods shows no classes for it in Sem 1. Ask the department that teaches it whether it will run.");
    expect(noteText(reason('ng-list:nusmods-semester-differs'), '2')).toBe("The NG list offers it in Sem 2, but NUSMods shows no classes for it in Sem 2. Ask the department that teaches it whether it will run.");
    expect(noteText(reason('ng-list:nusmods-semester-differs'), 'any')).toBe("The NG list offers it to exchange students, but NUSMods shows no classes for it in the semester the NG list gives. Ask the department that teaches it whether it will run.");
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

  it('[R3] the year-of-study note leads with "Year of study." and is said in full, with its source', () => {
    const year = { id: 'prereq:year-of-study', kind: 'year', text: 'NUS lists this course for Year 4 students. Ask the department whether your year of study during your exchange counts.' };
    expect(noteLead('year')).toBe('Year of study.');
    expect(noteText(year, 1)).toBe(year.text);
    expect(reasonLine(year, 1, SOURCES)).toBe('NUS lists this course for Year 4 students. Ask the department whether your year of study during your exchange counts (NUS prerequisite).');
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
      .toBe("AR5801 isn't open to 2nd-year exchange students in Sem 1. Level 5000 and 6000 courses are graduate courses. Exchange students can take one only if NUS's restrictions list opens it to their year of study, and the list doesn't open this one to yours. If you need it, ask the department that teaches it (NG restrictions, updated 31 Aug 2026).");
    const two = exchange('ug2', { 1: ['closed', ['D-grad-levels-closed-exchange', '7-pp-ug-closed']], 2: ['closed', []], any: ['closed', ['D-grad-levels-closed-exchange', '7-pp-ug-closed']] });
    const line = hiddenCodeLine({ code: 'PP5164', sem: '', study: 'ug2', exchange: two, sources: SOURCES });
    expect(line).toMatch(/^PP5164 isn't open to 2nd-year exchange students in either semester\. Level 5000 and 6000 courses are graduate courses. Exchange students can take one only if NUS's restrictions list opens it to their year of study, and the list doesn't open this one to yours. If you need it, ask the department that teaches it \(NG restrictions, updated 31 Aug 2026\)\. .+ \(NG restrictions, updated 31 Aug 2026\)\.$/);
    expect(line).toContain(reasonsFile.reasons['7-pp-ug-closed'].text.replace(/\.$/, ''));
  });

  it('the other semester only, but closed there too: every reason, never "only in Sem 2"', () => {
    const ex = exchange('ug2', { 1: ['closed', ['ng-list:not-in-semester']], 2: ['closed', ['D-grad-levels-closed-exchange']], any: ['closed', ['D-grad-levels-closed-exchange']] });
    expect(hiddenCodeLine({ code: 'CM5223', sem: '1', study: 'ug2', exchange: ex, sources: SOURCES }))
      .toBe("CM5223 isn't open to 2nd-year exchange students in Sem 1 or in Sem 2. Sem 1: the NG list offers it in Sem 2 only (NG list, updated 01 Sep 2026). Sem 2: Level 5000 and 6000 courses are graduate courses. Exchange students can take one only if NUS's restrictions list opens it to their year of study, and the list doesn't open this one to yours. If you need it, ask the department that teaches it (NG restrictions, updated 31 Aug 2026).");
  });

  it('a code the exchange set-up allows was hidden by another filter: it says which', () => {
    const ex = exchange('ug2', { 1: ['open', []], 2: ['open', []], any: ['open', []] });
    const mod = { code: 'CS2030', semesters: [1, 2], level: 2, credits: 4, faculty: 'Computing' };
    expect(hiddenCodeLine({ code: 'CS2030', sem: '1', study: 'ug2', exchange: ex, sources: SOURCES, module: mod, filters: { level: 3 } }))
      .toBe('CS2030 is hidden by your filters: it is a level 2000 course.');
    expect(hiddenCodeLine({ code: 'CS2030', sem: '', study: '', exchange: ex, sources: SOURCES, module: { ...mod, semesters: [2] }, filters: { sem: 1, credits: 2 } }))
      .toBe("CS2030 is hidden by your filters: it isn't offered in Sem 1, and it is 4 units.");
    expect(hiddenCodeLine({ code: 'CS2030', sem: '', study: '', exchange: ex, sources: SOURCES, module: mod, filters: {} }))
      .toBe("A setting in this search hides CS2030, but the page can't tell which one. Try removing filters one at a time.");
  });

  it('filterMisses lists only the filters the course fails', () => {
    const mod = { code: 'X', semesters: [1], level: 2, credits: 4, faculty: 'Computing' };
    expect(filterMisses(mod, { sem: 1, level: 2, credits: 4, faculty: 'Computing' })).toEqual([]);
    expect(filterMisses(mod, { sem: 2, faculty: 'Science' })).toEqual(["it isn't offered in Sem 2", 'it is in Computing']);
    // In exchange mode the NG list decides the semester, not NUSMods' timetable (src/search.js localMatchesFilters).
    expect(filterMisses({ ...mod, level: 1 }, { sem: 2, ng: true, study: 'ug2', level: 2 })).toEqual(['it is a level 1000 course']);
  });
});

describe('boxNotOffered: the typed codes the hidden-codes box lists as not offered', () => {
  it('leaves out the code a whole-query noMatch already names, for not-offered and 6A\'s ng-unscheduled alike', () => {
    expect(boxNotOffered(['EE4407'], { reason: 'not-offered', code: 'EE4407' })).toEqual([]);
    // 6A review finding: the page said EE4407 twice, once as "isn't offered this academic year".
    expect(boxNotOffered(['EE4407'], { reason: 'ng-unscheduled', code: 'EE4407' })).toEqual([]);
    expect(boxNotOffered(['EE4438', 'CS1001'], { reason: 'ng-unscheduled', code: 'EE4438' })).toEqual(['CS1001']);
  });

  it('keeps every code otherwise: no noMatch, another reason, or another code', () => {
    expect(boxNotOffered(['EE4407', 'CS1001'], null)).toEqual(['EE4407', 'CS1001']);
    expect(boxNotOffered(['EE4407'], { reason: 'unknown-code', code: 'EE4407' })).toEqual(['EE4407']);
    expect(boxNotOffered(['EE4407'], { reason: 'not-offered', code: 'CS1001' })).toEqual(['EE4407']);
    expect(boxNotOffered(undefined, null)).toEqual([]);
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
      .toBe('No CS32xx course is open to 2nd-year exchange students in Sem 1.');
    // Not known yet (the other semester is still being checked): the chosen semester.
    expect(partialCodeLine({ prefix: 'CG32', sem: '2', study: 'ug1', otherHasResults: null }))
      .toBe('No CG32xx course is open to 1st-year exchange students in Sem 2.');
  });

  it('both semesters chosen, or the other is empty too: either semester, never "loosen a filter"', () => {
    expect(partialCodeLine({ prefix: 'CS52', sem: '1', study: 'ug2', otherHasResults: false }))
      .toBe('No CS52xx course is open to 2nd-year exchange students in either semester.');
    expect(partialCodeLine({ prefix: 'CS52', sem: '', study: 'grad', otherHasResults: null }))
      .toBe('No CS52xx course is open to graduate exchange students in either semester.');
    expect(partialCodeLine({ prefix: 'CS', sem: '', study: 'ug2', otherHasResults: null })).not.toMatch(/loosen/i);
  });
});

describe('typed codes past the three that pin (5C-api leaves a 4th code unexplained)', () => {
  it('typedCodes finds code-shaped words in order, upper-cased, once each, joined across one space as /search joins them', () => {
    expect(typedCodes('cs2030 CS3244 and cs2030 MA1301 machine learning cs2040s')).toEqual(['CS2030', 'CS3244', 'MA1301', 'CS2040S']);
    expect(typedCodes('CS1010 cs 3244 LC6009GRSII')).toEqual(['CS1010', 'CS3244', 'LC6009GRSII']);
    expect(typedCodes('machine learning')).toEqual([]);
  });

  const RULE = 'The results put at most three of the codes you type at the top: the first three that NUS offers this year.';

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

describe('[5G] the stamp on a hidden typed code, and its switch (direction D)', () => {
  it('on the NG list for the other semester only: "Not on the NG list for Sem 1", switch to Sem 2', () => {
    const ex = exchange('ug2', { 1: ['closed', ['ng-list:not-in-semester']], 2: ['open', []], any: ['open', []] });
    expect(hiddenCodeStamp({ sem: '1', study: 'ug2', exchange: ex })).toEqual({ text: 'Not on the NG list for Sem 1', switchTo: '2' });
  });

  it('not on the NG list: "Not for exchange students", nothing to switch to', () => {
    const ex = exchange('ug2', { 1: ['closed', ['ng-list:not-listed']], 2: ['closed', ['ng-list:not-listed']], any: ['closed', ['ng-list:not-listed']] });
    expect(hiddenCodeStamp({ sem: '1', study: 'ug2', exchange: ex })).toEqual({ text: 'Not for exchange students', switchTo: '' });
    expect(hiddenCodeStamp({ sem: '', study: 'ug2', exchange: ex })).toEqual({ text: 'Not for exchange students', switchTo: '' });
  });

  it('closed by a restriction: "Not open in Sem 1"; the switch only where the other semester is open', () => {
    const closedBoth = exchange('ug2', { 1: ['closed', ['D-grad-levels-closed-exchange']], 2: ['closed', ['D-grad-levels-closed-exchange']] });
    expect(hiddenCodeStamp({ sem: '1', study: 'ug2', exchange: closedBoth })).toEqual({ text: 'Not open in Sem 1', switchTo: '' });
    const openIn2 = exchange('ug2', { 1: ['closed', ['D-grad-levels-closed-exchange']], 2: ['note', ['2-biz-major']] });
    expect(hiddenCodeStamp({ sem: '1', study: 'ug2', exchange: openIn2 })).toEqual({ text: 'Not open in Sem 1', switchTo: '2' });
    // Only in the other semester, but closed there too: no switch.
    const onlyOther = exchange('ug2', { 2: ['closed', ['ng-list:not-in-semester']], 1: ['closed', ['D-grad-levels-closed-exchange']] });
    expect(hiddenCodeStamp({ sem: '2', study: 'ug2', exchange: onlyOther })).toEqual({ text: 'Not on the NG list for Sem 2', switchTo: '' });
  });

  it('both semesters chosen: "Not open in either semester", never a switch', () => {
    const ex = exchange('ug2', { any: ['closed', ['D-grad-levels-closed-exchange']] });
    expect(hiddenCodeStamp({ sem: '', study: 'ug2', exchange: ex })).toEqual({ text: 'Not open in either semester', switchTo: '' });
  });

  it('allowed by the exchange set-up, or outside exchange mode: "Outside your filters"', () => {
    const ex = exchange('ug2', { 1: ['open', []] });
    expect(hiddenCodeStamp({ sem: '1', study: 'ug2', exchange: ex })).toEqual({ text: 'Outside your filters', switchTo: '' });
    expect(hiddenCodeStamp({ sem: '1', study: '', exchange: ex })).toEqual({ text: 'Outside your filters', switchTo: '' });
    expect(hiddenCodeStamp({ sem: '1', study: 'ug2', exchange: null })).toEqual({ text: 'Outside your filters', switchTo: '' });
  });

  it('a code not offered this year has its own stamp, unlike "Not for exchange students" (not on the NG list)', () => {
    expect(NOT_OFFERED_STAMP).toBe('Not this year');
  });
});

describe('[5G] the count line for a query of course codes only', () => {
  it('codesOnly: codes and separators, nothing else; a partial code or a word is not', () => {
    expect(codesOnly('CS2030 CS3244')).toBe(true);
    expect(codesOnly(' cs 3244, ma1521 ')).toBe(true);
    expect(codesOnly('CS2030+CS3244')).toBe(true);
    expect(codesOnly('CS32')).toBe(false);
    expect(codesOnly('CS3244 machine learning')).toBe(false);
    expect(codesOnly('networks')).toBe(false);
    expect(codesOnly('')).toBe(false);
  });

  /** @param {string} code @param {string[]} [variants] */
  const r = (code, variants = []) => ({ code, variants: variants.map((v) => ({ code: v })) });

  it('names the typed codes pinned at the top, in the order typed, then the other matches', () => {
    expect(codesCount('CS3244 CS2030', [r('CS2030'), r('CS3244'), r('MA1521')], ['CS3244', 'CS2030'])).toEqual({ count: '3 courses', rest: ' shown: CS3244, CS2030, then 1 other match' });
    expect(codesCount('CS2030 MA1301', [r('CS2030'), r('MA1301')], ['CS2030', 'MA1301'])).toEqual({ count: '2 courses', rest: ' shown: CS2030, MA1301' });
    expect(codesCount('CS2030', [r('CS2030'), r('A'), r('B')], ['CS2030'])).toEqual({ count: '3 courses', rest: ' shown: CS2030, then 2 other matches' });
  });

  it('a typed code shown as a pinned entry\'s "Also as" counts as pinned, and its entry is not an other match', () => {
    expect(codesCount('ACC1701XB', [r('ACC1701XA', ['ACC1701XB']), r('X')], ['ACC1701XB'])).toEqual({ count: '2 courses', rest: ' shown: ACC1701XB, then 1 other match' });
  });

  it('no typed code pinned: the entries are other matches', () => {
    expect(codesCount('CS3244', [r('A')], [])).toEqual({ count: '1 course', rest: ' shown: other matches for the code you typed' });
    expect(codesCount('CS3244 CS5562', [r('A'), r('B')], ['CS3244'])).toEqual({ count: '2 courses', rest: ' shown: other matches for the codes you typed' });
  });

  it('[PD2] a typed code that is not pinned, shown lower as an ordinary match, is not named as if it led the list (p1, live)', () => {
    // p1 typed six codes; the first three pinned; PF3210 (the 4th) ranked 20th as an ordinary match.
    const results = [r('AR3101'), r('AR4601'), r('AR3223'), ...Array.from({ length: 16 }, (_, i) => r(`XX${1000 + i}`)), r('PF3210')];
    expect(codesCount('AR3101 AR4601 AR3223 PF3210 PF3208 RE4701', results, ['AR3101', 'AR4601', 'AR3223']))
      .toEqual({ count: '20 courses', rest: ' shown: AR3101, AR4601, AR3223, then 17 other matches' });
  });

  it('[PD2] a pinned code is named only if its entry is at the top: a pin the filters hid is not named', () => {
    // CS3244 pins but the filters hide it (it is in `interpreted.pin`, not in the results); MA1521 ranks 2nd unpinned.
    expect(codesCount('CS2030 CS3244 MA1521', [r('CS2030'), r('MA1521'), r('A')], ['CS2030', 'CS3244', 'MA1521']))
      .toEqual({ count: '3 courses', rest: ' shown: CS2030, MA1521, then 1 other match' });
    expect(codesCount('CS2030 CS3244', [r('A'), r('CS2030')], ['CS3244']))
      .toEqual({ count: '2 courses', rest: ' shown: other matches for the codes you typed' });
  });
});
