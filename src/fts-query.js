// @ts-check
import { FTS_SEPARATORS } from './fts-separators.js';

const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'own', 'the', 'to', 'with', 'you', 'your']);

export const STOPWORDS_CURRENT = STOPWORDS;

export const STOPWORDS_V2 = new Set([...STOPWORDS_CURRENT,
  'class', 'course', 'courses', 'module', 'modules', 'nus', 'something', 'teach']);

/** @typedef {'current' | 'v2'} StopwordVariant */
export const STOPWORD_VARIANTS = Object.freeze({ current: STOPWORDS_CURRENT, v2: STOPWORDS_V2 });

/** @type {StopwordVariant} */
export const STOPWORDS_VARIANT = 'current';

export const STOPWORDS_IN_FORCE = STOPWORD_VARIANTS[STOPWORDS_VARIANT];

/** @param {string} query */
export function queryTokens(query) {
  return query.toLowerCase().split(FTS_SEPARATORS).filter(Boolean);
}

/** @param {string} token */
const isStopword = (token) => STOPWORDS_IN_FORCE.has(token.normalize('NFD').replace(/\p{M}+/gu, ''));

/** @param {string} query */
function ftsTokens(query) {
  const all = queryTokens(query);
  const tokens = all.filter((t) => !isStopword(t));
  return tokens.length ? tokens : all;
}

/** @param {string[]} tokens */
function ftsMatchExpression(tokens) {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/** @typedef {{ prefixes: readonly string[], corrections: readonly { from: string, to: string }[] }} FtsTerms */

/**
 * @param {string} query
 * @param {FtsTerms} [terms]
 */
export function ftsMatch(query, terms) {
  const tokens = ftsTokens(query);
  if (!terms || (terms.prefixes.length === 0 && terms.corrections.length === 0)) return ftsMatchExpression(tokens);
  const prefix = new Set(terms.prefixes);
  const present = new Set(queryTokens(query));
  /** @type {Map<string, string[]>} */
  const originals = new Map();
  for (const { from, to } of terms.corrections) {
    if (present.has(to)) originals.set(to, [...(originals.get(to) ?? []), from]);
  }
  /** @type {string[]} */
  const parts = [];
  /** @type {Set<string>} */
  const added = new Set();
  /** @param {string} t */
  const addOriginals = (t) => {
    for (const o of originals.get(t) ?? []) if (!added.has(o)) { added.add(o); parts.push(`"${o}"*`); }
  };
  for (const t of tokens) {
    parts.push(prefix.has(t) ? `"${t}"*` : `"${t}"`);
    addOriginals(t);
  }
  for (const t of originals.keys()) addOriginals(t);
  return parts.length ? parts.join(' OR ') : null;
}
