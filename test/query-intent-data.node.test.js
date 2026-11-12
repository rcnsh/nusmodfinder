// @ts-check
// The query-understanding data files the Worker reads (data/), against the
// eval's files they copy (eval/query-rules/) and their committed counts. No
// corpus needed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../eval/lib/sets.mjs';

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));

describe('the query-understanding data files', () => {
  it('the GE pillar table is the eval\'s, unchanged', () => {
    const evalCopy = readJson('eval/query-rules/ge-pillars.json');
    const data = readJson('data/ge-pillars.json');
    expect(data.prefixes).toEqual(evalCopy.prefixes);
    expect(data.genericPhrases).toEqual(evalCopy.genericPhrases);
    expect(data.pillars).toEqual(evalCopy.pillars);
    expect(data.source.url).toBe(evalCopy.source.url);
  });

  it('the collision list is the eval\'s, unchanged', () => {
    const evalCopy = readJson('eval/query-rules/collision-list.json');
    const data = readJson('data/collision-list.json');
    expect(data.list).toEqual(evalCopy.list);
    expect(data.exempt).toEqual(evalCopy.exempt);
  });

  // data/prefixes.json follows production's current corpus;
  // data/pinned/prefixes.json is the pinned corpus's (the eval's), unchanged.
  it.each([
    ['data/prefixes.json', 305, { CS: 165, LSM: 122, GEA: 2, GEC: 35, GEX: 15, GESS: 28 }],
    ['data/pinned/prefixes.json', 304, { CS: 164, LSM: 123, GEA: 2, GEC: 36, GEX: 16, GESS: 29 }],
  ])('%s: %i prefixes with counts; no collision-list entry or pillar prefix is missing from them', (rel, n, some) => {
    const { count, prefixes } = readJson(rel);
    expect(count).toBe(n);
    expect(Object.keys(prefixes)).toHaveLength(n);
    for (const p of [...readJson('data/collision-list.json').list, ...readJson('data/ge-pillars.json').prefixes]) {
      expect(prefixes[p], p).toBeGreaterThan(0);
    }
    for (const p of ['ART', 'LAW', 'COMP', 'MATH', 'ECON']) expect(prefixes[p], p).toBeUndefined();
    expect(prefixes).toMatchObject(some);
  });

  it('the catalogue-only codes and rows agree, sorted, and none is a prefix-less code', () => {
    const codes = readJson('data/catalogue-codes.json');
    const rows = readJson('data/catalogue-only.json');
    // Production's current corpus, whose count follows NUSMods; the pinned corpus has 14359.
    expect(codes.count).toBe(codes.codes.length);
    expect(rows.count).toBe(codes.count);
    expect(codes.count).toBeGreaterThan(10000);
    expect(readJson('data/pinned/catalogue-codes.json').count).toBe(14359);
    expect(rows.rows.map((/** @type {string[]} */ r) => r[0])).toEqual(codes.codes);
    expect([...codes.codes].sort()).toEqual(codes.codes);
    const byCode = new Map(rows.rows.map((/** @type {string[]} */ r) => [r[0], r]));
    expect(byCode.get('GEQ1000')?.[1]).toBe('Asking Questions');
    expect(byCode.get('GEH1001')?.[1]).toBe('Globalisation and New Media');
    expect(byCode.has('CS4400')).toBe(false);
    expect(byCode.has('CS1010S')).toBe(false);
  });
});
