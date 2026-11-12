// @ts-check
// The phrase rules, read straight from eval/query-rules/intent-phrases.json and
// eval/query-rules/ge-pillars.json, applied to a suite text to give the intent half
// of its `interpreted` object (ge, level, exam, su, hoursBelow, prereq). It is
// the matching rules those files state (intent-phrases.json `matching`) and no
// more: no code join, no code resolution, no correction. The suite tests use it
// to check every item's `interpreted` against its text.
import { join } from 'node:path';
import { REPO } from '../../eval/lib/sets.mjs';
import { queryTokens } from '../../src/fts-query.js';
import { readJson } from './suite-files.node.mjs';

export const PHRASES = readJson(join(REPO, 'eval/query-rules/intent-phrases.json'));
export const GE = readJson(join(REPO, 'eval/query-rules/ge-pillars.json'));
export const COLLISION = new Set(readJson(join(REPO, 'eval/query-rules/collision-list.json')).list.map((/** @type {string} */ s) => s.toLowerCase()));
export const STOPWORDS = new Set(readJson(join(REPO, 'eval/query-rules/stopwords.json')).current);

/** The intent keys this module derives; `pin` and `prefix` come from codes, not phrases. */
export const INTENT_KEYS = Object.freeze(['ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);

/** Canonical q: trimmed, whitespace collapsed, ASCII letters lower-cased. @param {string} s */
export const canonical = (s) => s.trim().replace(/\s+/g, ' ').replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * A phrase as a regex: bounded by no [a-z0-9] on either side, a space matching
 * a run of whitespace or '-', every other character literal, and `N` (when the
 * list has one) captured as one digit 1-9 (level) or an integer 1-99 (hours).
 * @param {string} phrase @param {'level' | 'hours' | null} n
 */
export function phraseRegex(phrase, n) {
  const parts = phrase.split(n ? /(N)/ : /(?!)/).map((p) => {
    if (n && p === 'N') return n === 'level' ? '([1-9])' : '([1-9]\\d?)';
    return p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '[\\s-]+');
  });
  return new RegExp(`(?<![a-z0-9])${parts.join('')}(?![a-z0-9])`, 'g');
}

/**
 * @typedef {{ key: string, kind?: string, phrase: string, start: number, end: number, n?: number, negated?: boolean }} Match
 * @typedef {{ key: string, kind?: string, phrase: string, n: 'level' | 'hours' | null }} Phrase
 */

/** @returns {Phrase[]} pass A: the constraint phrases. */
function passA() {
  /** @type {Phrase[]} */
  const out = [];
  for (const [key, c] of Object.entries(PHRASES.constraints)) {
    for (const phrase of /** @type {string[]} */ (c.phrases)) out.push({ key, phrase, n: key === 'hoursBelow' && phrase.includes('N') ? 'hours' : null });
  }
  return out;
}

/** @returns {Phrase[]} pass B: the level phrases and the GE phrases. */
function passB() {
  /** @type {Phrase[]} */
  const out = [];
  for (const [kind, l] of Object.entries(PHRASES.level)) {
    if (!l || typeof l !== 'object' || !Array.isArray(l.phrases)) continue;
    for (const phrase of /** @type {string[]} */ (l.phrases)) out.push({ key: 'level', kind, phrase, n: kind === 'levelN' ? 'level' : null });
  }
  for (const phrase of GE.genericPhrases) out.push({ key: 'ge', kind: 'generic', phrase, n: null });
  for (const p of GE.pillars) out.push({ key: 'ge', kind: p.name, phrase: p.name, n: null });
  return out;
}

/**
 * Leftmost-longest, non-overlapping matches of one pass's phrases.
 * @param {string} text @param {Phrase[]} phrases
 * @returns {Match[]}
 */
function matchPass(text, phrases) {
  /** @type {Match[]} */
  const all = [];
  for (const p of phrases) {
    for (const m of text.matchAll(phraseRegex(p.phrase, p.n))) {
      const start = /** @type {number} */ (m.index);
      all.push({ key: p.key, kind: p.kind, phrase: p.phrase, start, end: start + m[0].length, ...(p.n ? { n: Number(m[1]) } : {}) });
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  /** @type {Match[]} */
  const kept = [];
  let at = 0;
  for (const m of all) if (m.start >= at) { kept.push(m); at = m.end; }
  return kept;
}

/**
 * Every phrase match in a text, both passes. Pass B reads the text with pass
 * A's matches blanked; a pass-B level match is `negated` when a negator is
 * among the two tokens before it.
 * @param {string} raw
 */
export function phraseMatches(raw) {
  const text = canonical(raw);
  const a = matchPass(text, passA());
  let rest = text;
  for (const m of a) rest = rest.slice(0, m.start) + ' '.repeat(m.end - m.start) + rest.slice(m.end);
  const b = matchPass(rest, passB()).map((m) => {
    if (m.key !== 'level') return m;
    const before = queryTokens(text.slice(0, m.start)).slice(-PHRASES.negationWindow);
    return { ...m, negated: before.some((t) => PHRASES.negators.includes(t)) };
  });
  return { a, b };
}

/** A level phrase match as a window. @param {Match} m @returns {{ min: number, max: number | null, source: string }} */
function levelWindow(m) {
  const l = PHRASES.level;
  if (m.kind === 'beginner') return { ...l.beginner.window, source: 'beginner' };
  if (m.kind === 'graduate') return { ...l.graduate.window, source: 'graduate' };
  if (m.kind === 'levelN') return { min: /** @type {number} */ (m.n), max: /** @type {number} */ (m.n), source: 'level' };
  if (m.kind === 'year') return { min: l.year.N[m.phrase], max: l.year.window.max, source: 'year' };
  throw new Error(`unknown level kind ${m.kind}`);
}

/**
 * The level an `XX N000` code token sets (code resolution step 3), given the
 * prefix the item echoes: the token must be that prefix's letters, off the
 * collision and stopword lists, followed (with or without one space) by N000.
 * @param {string} raw @param {string | null} prefix
 */
export function codeLevel(raw, prefix) {
  if (!prefix || !/^[A-Z]+$/.test(prefix)) return null;
  const p = prefix.toLowerCase();
  if (COLLISION.has(p) || STOPWORDS.has(p)) return null;
  const m = new RegExp(`(?<![a-z0-9])${p} ?([1-9])000(?![a-z0-9])`).exec(canonical(raw));
  return m ? { min: Number(m[1]), max: Number(m[1]), source: 'level' } : null;
}

/**
 * The intent half of `interpreted` the phrase rules give for a text.
 * @param {string} raw
 * @param {string | null} [prefix] the item's `interpreted.prefix`, for an `XX N000` level
 */
export function deriveIntents(raw, prefix = null) {
  const { a, b } = phraseMatches(raw);
  /** @type {Record<string, any>} */
  const out = Object.fromEntries(INTENT_KEYS.map((k) => [k, null]));
  /** @type {{ min: number, max: number | null, source: string }[]} */
  const windows = [];
  for (const m of a) {
    const c = PHRASES.constraints[m.key];
    if (m.key === 'hoursBelow') out.hoursBelow = m.n ?? c.light;
    else out[m.key] = c.interpreted;
    // The shared phrase: pass A strips it and it sets beginner as if pass B had read it.
    if (PHRASES.level.beginner.phrases.includes(m.phrase)) windows.push({ ...PHRASES.level.beginner.window, source: 'beginner' });
  }
  /** @type {Set<string>} */
  const ge = new Set();
  for (const m of b) {
    if (m.key === 'ge') {
      const prefixes = m.kind === 'generic' ? GE.prefixes : GE.pillars.find((/** @type {any} */ p) => p.name === m.kind).prefixes;
      for (const p of prefixes) ge.add(p);
    } else if (!m.negated) windows.push(levelWindow(m));
  }
  const code = codeLevel(raw, prefix);
  if (code) windows.push(code);
  if (ge.size) out.ge = [...ge].sort();
  if (windows.length) {
    out.level = {
      min: Math.min(...windows.map((w) => w.min)),
      max: windows.some((w) => w.max === null) ? null : Math.max(...windows.map((w) => /** @type {number} */ (w.max))),
      source: [...new Set(windows.map((w) => w.source))].sort(),
    };
  }
  return out;
}
