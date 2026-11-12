// @ts-check
// src/groups.js, groups-v1 in the Worker: the eval's
// duplicate-group rule, one rule for eval and product, as a versioned module
// (data/groups.json, test/fixtures/groups.json) and the pure collapse.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as evalGroups from '../eval/lib/groups.mjs';
import { REPO } from '../eval/lib/sets.mjs';
import { build } from '../scripts/build-groups.mjs';
import { GROUPS_FILE_SCHEMA, GROUPS_VERSION, buildGroups, buildGroupsFile, collapse, groupKeyOf, parseGroupsFile, semesterRepresentative } from '../src/groups.js';

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const fixture = readJson('test/fixtures/corpus.json');

describe('the rule', () => {
  it('is the eval\'s: eval/lib/groups.mjs takes buildGroups and the version from src/groups.js', () => {
    expect(evalGroups.buildGroups).toBe(buildGroups);
    expect(evalGroups.GROUPS_VERSION).toBe(GROUPS_VERSION);
    expect(GROUPS_VERSION).toBe('groups-v1');
  });
});

describe('the module file', () => {
  it('records groups-v1, the corpus and its data version, and the groups', async () => {
    const f = buildGroupsFile(fixture.modules, { corpus: 'fixture', dataVersion: 'dv' });
    expect(f).toMatchObject({ schema: GROUPS_FILE_SCHEMA, version: 'groups-v1', corpus: 'fixture', dataVersion: 'dv' });
    expect(f.groups).toEqual(buildGroups(fixture.modules).groups);
  });

  it('parses to a code -> group key map; a singleton has none', () => {
    const groupOf = parseGroupsFile(buildGroupsFile(fixture.modules, { corpus: 'fixture', dataVersion: 'dv' }));
    expect(groupOf.get('TR3202I')).toBeDefined();
    expect(groupOf.get('TR3202I')).toBe(groupOf.get('TR3202S'));
    expect(groupOf.get('CS1010S')).toBe(groupOf.get('CS1010'));
    expect(groupOf.get('CS3244')).toBeUndefined();
    expect(groupKeyOf(groupOf, 'CS3244')).toBe('CS3244');
    expect(() => parseGroupsFile(/** @type {any} */ ({ schema: 'x', version: 'groups-v1', groups: [] }))).toThrow(/schema/);
    expect(() => parseGroupsFile(/** @type {any} */ ({ schema: GROUPS_FILE_SCHEMA, version: 'groups-v2', groups: [] }))).toThrow(/groups-v1/);
  });

  it('test/fixtures/groups.json is what scripts/build-groups.mjs builds from the fixture corpus', async () => {
    expect(readFileSync(join(REPO, 'test/fixtures/groups.json'), 'utf8')).toBe(await build('fixture'));
  });
});

describe('collapse', () => {
  const groupOf = new Map([['A1', 'g'], ['A2', 'g'], ['A3', 'g'], ['B1', 'h'], ['B2', 'h']]);

  it('keeps each group\'s first member in order and drops the rest: the group-first projection', () => {
    const { kept, hidden } = collapse(['A2', 'C1', 'A1', 'B2', 'D1', 'B1', 'A3'], groupOf);
    expect(kept).toEqual(['A2', 'C1', 'B2', 'D1']);
    expect(hidden).toEqual(new Map([['A2', ['A1', 'A3']], ['B2', ['B1']]]));
  });

  it('counts already-kept codes (pins) as their group\'s first member', () => {
    const { kept, hidden } = collapse(['A1', 'C1', 'A3'], groupOf, ['A2']);
    expect(kept).toEqual(['C1']);
    expect(hidden).toEqual(new Map([['A2', ['A1', 'A3']]]));
  });

  it('is the identity on a list with no two members of one group', () => {
    expect(collapse(['A1', 'B1', 'C1'], groupOf).kept).toEqual(['A1', 'B1', 'C1']);
    expect(collapse(['A1', 'B1'], new Map()).kept).toEqual(['A1', 'B1']);
  });
});

describe('semesterRepresentative', () => {
  // ACC1701X-shaped: one course text, members on different timetables. XB (Sem 2 only) ranks
  // first for a Sem 1 exchange search; XC (Sem 1) and XA (both) are its group mates.
  const semesters = new Map([['ACC1701XA', [1, 2]], ['ACC1701XB', [2]], ['ACC1701XC', [1]], ['ACC1701XD', [2]]]);
  /** @param {number} sem */
  const offeredIn = (sem) => (/** @type {string} */ c) => (semesters.get(c) ?? []).includes(sem);

  it('keeps the collapse\'s choice when it is offered in the semester', () => {
    const rank = new Map([['ACC1701XA', 0], ['ACC1701XC', 1]]);
    expect(semesterRepresentative('ACC1701XA', ['ACC1701XC'], rank, offeredIn(1))).toBe('ACC1701XA');
  });

  it('picks the highest-ranked offered member when the first is not offered', () => {
    const rank = new Map([['ACC1701XB', 0], ['ACC1701XC', 1], ['ACC1701XA', 2]]);
    expect(semesterRepresentative('ACC1701XB', ['ACC1701XA', 'ACC1701XC'], rank, offeredIn(1))).toBe('ACC1701XC');
    // Sem 2: XB is offered and stays.
    expect(semesterRepresentative('ACC1701XB', ['ACC1701XA', 'ACC1701XC'], rank, offeredIn(2))).toBe('ACC1701XB');
  });

  it('skips a member that is not offered either, whatever its rank', () => {
    const rank = new Map([['ACC1701XB', 0], ['ACC1701XD', 1], ['ACC1701XA', 2]]);
    expect(semesterRepresentative('ACC1701XB', ['ACC1701XD', 'ACC1701XA'], rank, offeredIn(1))).toBe('ACC1701XA');
  });

  it('ranks an unranked member after every ranked one, unranked ones in code order', () => {
    expect(semesterRepresentative('ACC1701XB', ['ACC1701XC', 'ACC1701XA'], new Map([['ACC1701XB', 0]]), offeredIn(1))).toBe('ACC1701XA');
    expect(semesterRepresentative('ACC1701XB', ['ACC1701XA', 'ACC1701XC'], new Map([['ACC1701XB', 0], ['ACC1701XC', 5]]), offeredIn(1))).toBe('ACC1701XC');
  });

  it('falls back to the collapse\'s choice when no member is offered', () => {
    const rank = new Map([['ACC1701XB', 0], ['ACC1701XD', 1]]);
    expect(semesterRepresentative('ACC1701XB', ['ACC1701XD'], rank, offeredIn(1))).toBe('ACC1701XB');
    expect(semesterRepresentative('ACC1701XB', [], rank, offeredIn(1))).toBe('ACC1701XB');
  });
});
