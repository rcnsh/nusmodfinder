// @ts-check
import { queryTokens } from './fts-query.js';
import { INTENT, SU_BASIS, passA } from './intents.js';
import { correctQuery } from './typo.js';
import { dfOf, prefixMatches } from './vocabulary.js';

export const INTERPRETED_KEYS = Object.freeze(['pin', 'prefix', 'ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);
export const IGNORABLE_INTENTS = Object.freeze(['ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);
export const MAX_PINS = 3;
export const MAX_CODES = 10;

/**
 * @typedef {[string, string]} CodeRange
 * @typedef {{ min: number, max: number | null }} LevelWindow
 * @typedef {{
 *   pin: string[] | null, prefix: string | null, ge: string[] | null,
 *   level: { min: number, max: number | null, source: string[] } | null,
 *   exam: number | null, su: { value: number, basis: string[] } | null, hoursBelow: number | null,
 *   prereq: { value: string, semantics: string } | null,
 * }} Interpreted
 * @typedef {{ reason: 'not-offered' | 'unknown-code', code: string }} NoMatch
 * @typedef {{ code: string, status: 'offered' | 'not-offered' | 'unknown' }} TypedCode
 * @typedef {{
 *   q: string, lexical: string, dense: string, interpreted: Interpreted,
 *   kind: 'search' | 'mask' | 'no-match',
 *   pins: string[], codes: TypedCode[], ranges: CodeRange[] | null, codeList: CodeRange[] | null,
 *   level: LevelWindow | null, noMatch: NoMatch | null,
 *   tokens: string[], corrected: string | null, fts: import('./fts-query.js').FtsTerms,
 *   noSignal: boolean, constraints: IntentConstraints,
 * }} ParsedQuery
 * @typedef {{ exam?: 0, su?: 1, hoursBelow?: number, prereq?: 'none' }} IntentConstraints
 * @typedef {{ prefixes: string[], genericPhrases: string[], pillars: { name: string, prefixes: string[] }[] }} GeTable
 * @typedef {{
 *   prefixes: Set<string>, catalogue: Set<string>, collision: Set<string>, stopwords: Set<string>,
 *   ge: GeTable, gePhrases: { re: RegExp, prefixes: string[] }[], isOffered: (code: string) => boolean,
 *   vocabulary: import('./vocabulary.js').Vocabulary | null,
 *   constraintPhrases: import('./intents.js').ConstraintPhrase[] | null,
 *   intentVariant: { prereq: 'i' | 'ii', dense: 'stripped' | 'raw' },
 * }} IntentContext
 */

/** @param {string} trimmed */
export const canonicalQuery = (trimmed) => trimmed.replace(/\s+/g, ' ').replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * @param {string} p
 * @returns {CodeRange}
 */
export const codeRange = (p) => [/\d$/.test(p) ? p : `${p}0`, `${p}:`];

/**
 * @param {string | null | undefined} raw
 * @returns {{ ignore: string[], error?: undefined } | { error: string, ignore?: undefined }}
 */
export function parseIgnore(raw) {
  const names = [...new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))].sort();
  const unknown = names.filter((n) => !IGNORABLE_INTENTS.includes(n));
  if (unknown.length) return { error: `Unknown ignore intent${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}; expected any of ${IGNORABLE_INTENTS.join(', ')}.` };
  return { ignore: names };
}

/** @param {string} phrase */
const phraseRegex = (phrase) => new RegExp(
  `(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '[\\s-]+')}(?![a-z0-9])`, 'g');

/**
 * @param {{
 *   prefixes: Iterable<string>, catalogueCodes: Iterable<string>, collision: Iterable<string>,
 *   ge: GeTable, stopwords: Iterable<string>, isOffered: (code: string) => boolean,
 *   vocabulary?: import('./vocabulary.js').Vocabulary | null,
 *   constraintPhrases?: import('./intents.js').ConstraintPhrase[] | null,
 *   intentVariant?: { prereq: 'i' | 'ii', dense: 'stripped' | 'raw' },
 * }} data
 * @returns {IntentContext}
 */
export function buildIntentContext({
  prefixes, catalogueCodes, collision, ge, stopwords, isOffered, vocabulary = null, constraintPhrases = null, intentVariant = INTENT,
}) {
  return {
    prefixes: new Set(prefixes),
    catalogue: new Set(catalogueCodes),
    collision: new Set(collision),
    stopwords: new Set(stopwords),
    ge,
    gePhrases: [
      ...ge.genericPhrases.map((p) => ({ re: phraseRegex(p), prefixes: ge.prefixes })),
      ...ge.pillars.map((p) => ({ re: phraseRegex(p.name), prefixes: p.prefixes })),
    ],
    isOffered,
    vocabulary,
    constraintPhrases,
    intentVariant,
  };
}

const FULL_CODE = /^([a-z]{1,4})(\d{4})([a-z0-9]{0,5})$/;
const PARTIAL_CODE = /^([a-z]{2,4})(\d{1,3})$/;
const LETTERS = /^[a-z]{1,4}$/;
const N000 = /^[A-Z]+([1-9])000$/;
const core = (/** @type {string} */ w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
/** @param {string} w */
const suffixOf = (w) => /^([a-z]{1,2})(?:[^a-z0-9/-][^/-]*)?$/.exec(w)?.[1] ?? null;

/** @typedef {{ text: string, from: number, to: number, joined: boolean }} Token */

/**
 * @param {string[]} words
 * @param {IntentContext} ctx
 * @returns {Token[]}
 */
function joinCodes(words, ctx) {
  const known = (/** @type {string} */ c) => ctx.isOffered(c.toUpperCase()) || ctx.catalogue.has(c.toUpperCase());
  const n = words.length;
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  while (i < n) {
    const w = core(words[i]);
    /** @type {Token} */
    let tok = { text: w, from: i, to: i, joined: false };
    if (LETTERS.test(w) && ctx.prefixes.has(w.toUpperCase()) && i + 1 < n) {
      const d = core(words[i + 1]);
      if (ctx.collision.has(w.toUpperCase()) || ctx.stopwords.has(w)) {
        const s = n === 3 ? suffixOf(words[2]) : null;
        if (n === 2 && /^\d{4}[a-z0-9]{0,5}$/.test(d) && known(w + d)) tok = { text: w + d, from: 0, to: 1, joined: true };
        else if (s !== null && /^\d{4}$/.test(d) && known(w + d + s)) tok = { text: w + d + s, from: 0, to: 2, joined: true };
      } else if (/^(\d{1,3}|\d{4}[a-z0-9]{0,5})$/.test(d)) {
        tok = { text: w + d, from: i, to: i + 1, joined: true };
      }
    }
    const next = tok.to + 1 < n ? suffixOf(words[tok.to + 1]) : null;
    if (next !== null && FULL_CODE.test(tok.text) && known(tok.text + next)) {
      tok = { text: tok.text + next, from: tok.from, to: tok.to + 1, joined: true };
    }
    out.push(tok);
    i = tok.to + 1;
  }
  return out;
}


/** @returns {Interpreted} */
const emptyInterpreted = () => ({ pin: null, prefix: null, ge: null, level: null, exam: null, su: null, hoursBelow: null, prereq: null });

/**
 * @param {string} q
 * @param {IntentContext} ctx
 * @param {readonly string[]} [ignore]
 * @returns {ParsedQuery}
 */
export function parseQuery(q, ctx, ignore = []) {
  const ignored = new Set(ignore);
  const interpreted = emptyInterpreted();
  /** @type {ParsedQuery} */
  const parsed = {
    q, lexical: q, dense: q, interpreted, kind: 'search', pins: [], codes: [], ranges: null, codeList: null, level: null, noMatch: null,
    tokens: [], corrected: null, fts: { prefixes: [], corrections: [] }, noSignal: false, constraints: {},
  };

  const c = ctx.vocabulary ? correctQuery(q, ctx.vocabulary) : { tokens: queryTokens(q), text: q, prefixes: [], corrections: [] };
  parsed.tokens = c.tokens;
  parsed.corrected = c.text === q ? null : c.text;
  parsed.fts = { prefixes: c.prefixes, corrections: c.corrections };
  parsed.lexical = c.text;
  const a = ctx.constraintPhrases ? passA(c.text, ctx.constraintPhrases, ignored) : null;
  const rest = a ? a.text : c.text;
  if (a && (a.exam || a.su || a.hoursBelow !== null || a.prereq)) {
    if (a.exam) { interpreted.exam = 0; parsed.constraints.exam = 0; }
    if (a.su) { interpreted.su = { value: 1, basis: [...SU_BASIS] }; parsed.constraints.su = 1; }
    if (a.hoursBelow !== null) { interpreted.hoursBelow = a.hoursBelow; parsed.constraints.hoursBelow = a.hoursBelow; }
    if (a.prereq) { interpreted.prereq = { value: 'none', semantics: ctx.intentVariant.prereq }; parsed.constraints.prereq = 'none'; }
    if (ctx.intentVariant.dense === 'stripped') {
      const phrases = /** @type {import('./intents.js').ConstraintPhrase[]} */ (ctx.constraintPhrases);
      const dense = passA(q, phrases, ignored).text;
      if (dense !== '') parsed.dense = dense;
      if (parsed.corrected !== null && rest !== '') parsed.corrected = rest;
    }
  }
  const words = rest.split(' ').filter((w) => core(w) !== '');

  const tokens = joinCodes(words, ctx);
  const whole = tokens.length === 1;

  /** @type {{ prefix: string, level: number | null } | null} */
  let route = null;
  for (const tok of tokens) {
    const full = FULL_CODE.exec(tok.text);
    if (full && ctx.prefixes.has(full[1].toUpperCase())) {
      const code = tok.text.toUpperCase();
      const letters = full[1];
      const n000 = N000.exec(code);
      const offered = ctx.isOffered(code);
      if (parsed.codes.length < MAX_CODES && !parsed.codes.some((t) => t.code === code)) {
        parsed.codes.push({ code, status: offered ? 'offered' : ctx.catalogue.has(code) ? 'not-offered' : 'unknown' });
      }
      if (offered) {
        if (parsed.pins.length < MAX_PINS && !parsed.pins.includes(code)) parsed.pins.push(code);
      } else if (ctx.catalogue.has(code)) {
        if (whole) parsed.noMatch = { reason: 'not-offered', code };
      } else if (n000 && !ctx.collision.has(letters.toUpperCase()) && !ctx.stopwords.has(letters)) {
        route ??= { prefix: letters.toUpperCase(), level: Number(n000[1]) };
      } else if (whole) {
        parsed.noMatch = { reason: 'unknown-code', code };
      }
      continue;
    }
    const partial = PARTIAL_CODE.exec(tok.text);
    if (partial && ctx.prefixes.has(partial[1].toUpperCase())) {
      route ??= { prefix: tok.text.toUpperCase(), level: null };
      continue;
    }
    if (whole && LETTERS.test(tok.text) && ctx.prefixes.has(tok.text.toUpperCase()) && !ctx.collision.has(tok.text.toUpperCase())) {
      route = { prefix: tok.text.toUpperCase(), level: null };
    }
  }

  if (parsed.noMatch) {
    parsed.kind = 'no-match';
    return parsed;
  }
  if (parsed.pins.length) interpreted.pin = [...parsed.pins];

  let masked = '';
  let lexical = '';
  for (const tok of tokens) {
    const raw = words.slice(tok.from, tok.to + 1).join(' ');
    masked += `${masked ? ' ' : ''}${tok.joined ? '#'.repeat(raw.length) : raw}`;
    lexical += `${lexical ? ' ' : ''}${raw}`;
  }
  /** @type {Set<string>} */
  const pillars = new Set();
  if (!ignored.has('ge')) {
    /** @type {[number, number][]} */
    const spans = [];
    for (const { re, prefixes } of ctx.gePhrases) {
      for (const m of masked.matchAll(re)) {
        const start = /** @type {number} */ (m.index);
        if (m[0] === 'ge' && /^[^a-z0-9]+\d/.test(masked.slice(start + 2))) continue;
        spans.push([start, start + m[0].length]);
        for (const p of prefixes) pillars.add(p);
      }
    }
    spans.sort((a, b) => b[0] - a[0]);
    let cut = Infinity;
    for (const [s, e] of spans) {
      const end = Math.min(e, cut);
      if (end > s) lexical = lexical.slice(0, s) + lexical.slice(end);
      cut = Math.min(cut, s);
    }
    lexical = lexical.replace(/\s+/g, ' ').trim();
  }
  /** @type {{ min: number, max: number | null, source: string }[]} */
  const levelWindows = [];
  parsed.lexical = lexical;

  if (pillars.size) {
    interpreted.ge = [...pillars].sort();
    parsed.ranges = interpreted.ge.map(codeRange);
    if (!/[a-z0-9]/.test(lexical) && !route && !parsed.pins.length) parsed.kind = 'mask';
  }

  if (route) {
    interpreted.prefix = route.prefix;
    const range = [codeRange(route.prefix)];
    if (whole) {
      parsed.kind = 'mask';
      parsed.ranges = range;
    } else {
      parsed.codeList = range;
    }
    if (route.level !== null) levelWindows.push({ min: route.level, max: route.level, source: 'level' });
  }

  if (levelWindows.length && !ignored.has('level')) {
    const min = Math.min(...levelWindows.map((w) => w.min));
    const max = levelWindows.some((w) => w.max === null) ? null : Math.max(...levelWindows.map((w) => /** @type {number} */ (w.max)));
    interpreted.level = { min, max, source: [...new Set(levelWindows.map((w) => w.source))].sort() };
    parsed.level = { min, max };
  }
  const vocab = ctx.vocabulary;
  parsed.noSignal = vocab !== null && parsed.kind === 'search' && INTERPRETED_KEYS.every((k) => interpreted[/** @type {keyof Interpreted} */ (k)] === null)
    && c.tokens.every((t) => dfOf(vocab, t) === 0 && !((t.match(/[a-z]/g)?.length ?? 0) >= 4 && prefixMatches(vocab, t)));
  return parsed;
}
