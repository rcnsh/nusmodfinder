// @ts-check
// src/level-note.js (Jacob's ruling R6-2, ADR 0010): GRO's sentence on
// higher-level undergraduate courses, a condition like a quota note, on every
// level 4000 course outside Law that an undergraduate exchange student is
// shown. The whole-corpus agreement with the SC1 oracle's own reading is in
// test/sc1/paths.test.js; the paths on the fixture in test/exchange.test.js.
import { describe, expect, it } from 'vitest';
import { GRO_LEVEL4, LEVEL_NOTE, levelNote, levelNoteApplies } from '../src/level-note.js';

const UG = /** @type {const} */ (['ug1', 'ug2', 'ug3', 'ug4']);

describe('R6-2: GRO\'s level 4000 note', () => {
  it('is GRO\'s sentence, word for word, with GRO named, under a stable id and kind', () => {
    expect(GRO_LEVEL4).toBe('Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very limited supply and are usually NOT available to exchange students. In order to increase the chances of securing enough courses, incoming exchange students should consider taking courses with course code starting from 1000 to 3000');
    expect(LEVEL_NOTE).toBe('gro:level-4000');
    expect(levelNote({ level: 4, faculty: 'Computing' }, 'ug3')).toEqual({ id: 'gro:level-4000', kind: 'supply', text: `GRO: “${GRO_LEVEL4}”` });
  });

  it('covers a level 4000 course at every undergraduate year', () => {
    for (const study of UG) expect(levelNoteApplies({ level: 4, faculty: 'Science' }, study), study).toBe(true);
    // D1 answers `level` as a number; a string digit reads the same.
    expect(levelNoteApplies({ level: /** @type {any} */ ('4'), faculty: 'Science' }, 'ug1')).toBe(true);
  });

  it('not levels 1000 to 3000, which GRO recommends', () => {
    for (const level of [1, 2, 3]) expect(levelNoteApplies({ level, faculty: 'Science' }, 'ug2'), String(level)).toBe(false);
  });

  it('not graduate courses (level 5000 and up), which rule D and the departments\' rules govern', () => {
    for (const level of [5, 6, 8]) expect(levelNoteApplies({ level, faculty: 'College of Design and Engineering' }, 'ug4'), String(level)).toBe(false);
  });

  it('not a graduate student (C5-m1): GRO\'s course list is for undergraduate exchange students', () => {
    expect(levelNoteApplies({ level: 4, faculty: 'Science' }, 'grad')).toBe(false);
    expect(levelNote({ level: 4, faculty: 'Science' }, 'grad')).toBeNull();
  });

  it('not Law (C5-m1): NUS Law opens only its LL4 electives to exchange students', () => {
    for (const study of UG) expect(levelNoteApplies({ level: 4, faculty: 'Law' }, study), study).toBe(false);
  });

  it('a row with no level, or an unknown study level, gets no note', () => {
    expect(levelNote({ level: null, faculty: 'Science' }, 'ug1')).toBeNull();
    expect(levelNote({ faculty: 'Science' }, 'ug1')).toBeNull();
    expect(levelNote({ level: 4, faculty: 'Science' }, /** @type {any} */ (''))).toBeNull();
  });
});
