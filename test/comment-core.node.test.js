// @ts-check
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { allowed, jsdocSkeleton, removeComments } from '../scripts/comment-core.mjs';

/** @param {string} src */
const commentsOf = (src) => {
  /** @type {import('../scripts/comment-core.mjs').Comment[]} */
  const found = [];
  parse(src, { ecmaVersion: 'latest', sourceType: 'module', onComment: (block, value, start, end) => found.push({ block, value, start, end }) });
  return found;
};

/** @param {string} src */
const strip = (src) => removeComments(src, commentsOf(src).filter((c) => !allowed(c)));

describe('allowed', () => {
  it.each([
    '// @ts-check',
    '// eslint-disable-next-line no-control-regex -- the tokeniser matches NUL',
    '/* global caches */',
    '/** @type {string} */',
    '/** @param {number} a @returns {number} */',
    '/** @import { Env } from "./env" */',
  ])('lets %s through', (src) => {
    expect(commentsOf(`${src}\nlet x;`).every(allowed)).toBe(true);
  });

  it.each([
    '// the cache key folds case',
    '/* a block */',
    '/** Returns x. @returns {number} */',
    '/** @param {number} a the count */',
    '// @ts-check because reasons',
  ])('bans %s', (src) => {
    expect(commentsOf(`${src}\nlet x;`).some((c) => !allowed(c))).toBe(true);
  });
});

describe('jsdocSkeleton', () => {
  it('keeps type tags and drops the prose around them', () => {
    const [c] = commentsOf('/**\n * Sums things.\n * @param {number[]} xs the numbers\n * @returns {number} their sum\n */\nlet x;');
    expect(jsdocSkeleton(c.value)).toEqual({ kept: ['@param {number[]} xs', '@returns {number}'], dropped: true });
  });

  it('keeps a multi-line typedef whole', () => {
    const [c] = commentsOf('/**\n * @typedef {{\n *   a: string,\n *   b: { c: number },\n * }} Row\n */\nlet x;');
    expect(jsdocSkeleton(c.value).kept).toEqual(['@typedef {{\n  a: string,\n  b: { c: number },\n}} Row']);
    expect(jsdocSkeleton(c.value).dropped).toBe(false);
  });
});

describe('removeComments', () => {
  it('takes an own-line comment with its line, and a collapsed blank line', () => {
    expect(strip('// @ts-check\n// header\n\nconst a = 1; // trailing\n')).toBe('// @ts-check\n\nconst a = 1;\n');
    expect(strip('// header\n\nconst a = 1;\n')).toBe('const a = 1;\n');
  });

  it('rewrites a docblock to its types', () => {
    expect(strip('class C {\n  /**\n   * Adds.\n   * @param {number} a first\n   * @param {number} b\n   */\n  add(a, b) {}\n}\n'))
      .toBe('class C {\n  /**\n   * @param {number} a\n   * @param {number} b\n   */\n  add(a, b) {}\n}\n');
    expect(strip('/** Adds. @param {number} a first */\nfunction f(a) {}\n')).toBe('/** @param {number} a */\nfunction f(a) {}\n');
  });

  it('keeps inline casts and the code around an inline block comment', () => {
    expect(strip('const a = /** @type {any} */ (b);\n')).toBe('const a = /** @type {any} */ (b);\n');
    expect(strip('f(a, /* why */ b);\n')).toBe('f(a, b);\n');
  });

  it('keeps the line break a multi-line comment stood for, and the space between tokens', () => {
    expect(strip('function f() {\n  return /*\n  */ 1;\n}\n')).toBe('function f() {\n  return\n 1;\n}\n');
    expect(strip('const x = typeof/* c */y;\n')).toBe('const x = typeof y;\n');
  });

  it('keeps bracketed names with defaults', () => {
    expect(strip('/**\n * @template [T=string]\n * @param {number[]} [list=[1, 2]] the list\n */\nfunction f(list) {}\n'))
      .toBe('/**\n * @template [T=string]\n * @param {number[]} [list=[1, 2]]\n */\nfunction f(list) {}\n');
  });

  it('treats a JSDoc-style @ts-expect-error as a directive', () => {
    expect(commentsOf('/** @ts-expect-error the cast is wrong on purpose */\nlet x;').every(allowed)).toBe(true);
  });

  it('leaves code that parses to the same program', () => {
    const src = 'const re = /a\\/\\/b/; // x\nconst s = "// not a comment"; /* y */\nexport { re, s };\n';
    const out = strip(src);
    expect(out).toBe('const re = /a\\/\\/b/;\nconst s = "// not a comment";\nexport { re, s };\n');
    expect(commentsOf(out)).toEqual([]);
  });
});
