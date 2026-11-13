// @ts-check
// scripts/reviews.mjs: which comments count and how a course's numbers are made
// (ADR 0018), and the committed data/reviews.json's shape.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODE_RE, HALF_LIFE, MODEL, OUT, SCHEMA_ID, aggregate, codeOf, postsByCourse, reviewYear } from '../scripts/reviews.mjs';

/** @param {Partial<import('../scripts/reviews.mjs').Scored>} o @returns {import('../scripts/reviews.mjs').Scored} */
const scored = (o) => ({ id: 'x', is_review: true, taken: null, workload: null, difficulty: null, teaching: null, overall: null, ...o });
/** @param {string} id @param {string} createdAt @param {string} text */
const post = (id, createdAt, text) => ({ id, thread: 't', parent: null, createdAt, isDeleted: false, isSpam: false, text });

describe('codeOf', () => {
  it('takes the identifier that is a code, else the code in the link', () => {
    expect(codeOf({ id: '1', ident: ['2804895210', 'CS2010'], posts: 1, link: '' })).toBe('CS2010');
    expect(codeOf({ id: '1', ident: [], posts: 1, link: 'https://nusmods.com/courses/GEA1000/reviews' })).toBe('GEA1000');
    expect(codeOf({ id: '1', ident: ['not a code'], posts: 1, link: 'https://nusmods.com/' })).toBeNull();
  });
});

describe('postsByCourse', () => {
  it('drops deleted, spam and empty comments and sorts the rest oldest first', () => {
    const threads = [{ id: 't', ident: ['MA1521'], posts: 4, link: '' }];
    const posts = [post('b', '2024-02-01', 'later'), post('a', '2023-01-01', 'earlier'),
      { ...post('c', '2023-05-01', 'gone'), isDeleted: true }, { ...post('d', '2023-05-01', 'ad'), isSpam: true }, post('e', '2023-06-01', '  ')];
    expect(postsByCourse(threads, posts).get('MA1521')?.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('reviewYear', () => {
  it('reads the semester the writer names, else the academic year it was posted in', () => {
    expect(reviewYear(scored({ taken: 'AY22/23 S2' }), '2025-01-01')).toBe(22);
    expect(reviewYear(scored({}), '2024-08-15')).toBe(24);
    expect(reviewYear(scored({}), '2024-07-31')).toBe(23);
  });
});

describe('aggregate', () => {
  it('counts reviews only, a repeated review once, and weights each by age', () => {
    const postOf = new Map([
      ['new', post('new', '2026-09-01', 'Great course, would take again.')],
      ['old', post('old', '2020-09-01', 'Terrible course.')],
      ['dup', post('dup', '2026-09-02', 'Great course, would take again!')],
      ['q', post('q', '2026-09-03', 'Is this course hard?')],
    ]);
    const r = aggregate([
      scored({ id: 'new', overall: 5, workload: 2 }),
      scored({ id: 'old', overall: 1, workload: null }),
      scored({ id: 'dup', overall: 5 }),
      scored({ id: 'q', is_review: false }),
    ], postOf, 26);
    // AY26 weighs 1, AY20 weighs 0.5^(6/HALF_LIFE) = 0.25: (5 + 0.25) / 1.25 = 4.2.
    expect(HALF_LIFE).toBe(3);
    expect(r).toEqual({ n: 2, latest: 'AY26/27', overall: 4.2, workload: 2, difficulty: null, teaching: null });
  });

  it('is null for a course with no review', () => {
    expect(aggregate([scored({ id: 'q', is_review: false })], new Map(), 26)).toBeNull();
  });
});

describe('data/reviews.json', () => {
  const file = JSON.parse(readFileSync(OUT, 'utf8'));
  it('is the schema scripts/reviews.mjs builds', () => {
    expect(file).toMatchObject({ schema: SCHEMA_ID, model: MODEL, halfLifeYears: HALF_LIFE });
  });
  it('holds a code, a review count, a latest year and 1-5 scores (or null) per course', () => {
    const entries = Object.entries(file.courses);
    expect(entries.length).toBeGreaterThan(1000);
    for (const [code, r] of entries) {
      expect(code).toMatch(CODE_RE);
      expect(Object.keys(/** @type {object} */ (r)).sort()).toEqual(['difficulty', 'latest', 'n', 'overall', 'teaching', 'workload']);
      const v = /** @type {any} */ (r);
      expect(Number.isInteger(v.n) && v.n >= 1).toBe(true);
      expect(v.latest).toMatch(/^AY\d\d\/\d\d$/);
      for (const k of ['overall', 'workload', 'difficulty', 'teaching']) {
        if (v[k] !== null) expect(v[k] >= 1 && v[k] <= 5).toBe(true);
      }
    }
  });
});
