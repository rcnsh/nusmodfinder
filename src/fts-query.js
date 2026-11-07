// @ts-check
// Query tokenising and the FTS5 MATCH expression for the lexical half
// (src/lexical.js). Pure: no bindings, no Worker types.
import { FTS_SEPARATORS } from './fts-separators.js';

// Stopwords are dropped before the FTS5 query is built. Without this, a natural
// question like "how do i start my own company" matches every "Design Your Own
// Course" record on the word "own" and buries the real answers. This is the same
// list the offline BM25 baseline uses, so neither retriever gets an easier query.
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'own', 'the', 'to', 'with', 'you', 'your']);

/** The list before Phase 3 (eval/prereg/stopwords.json `current`). */
export const STOPWORDS_CURRENT = STOPWORDS;

// Candidate `stopwords-v2` (docs/plans/phase3.md 3B "Keyword brittleness",
// eval/prereg/stopwords.json): the list above plus words that name the
// catalogue itself rather than a subject. Screened alone under the general CI
// rule; it ships only if it passes dev alone.
export const STOPWORDS_V2 = new Set([...STOPWORDS_CURRENT,
  'class', 'course', 'courses', 'module', 'modules', 'nus', 'something', 'teach']);

/** @typedef {'current' | 'v2'} StopwordVariant */
export const STOPWORD_VARIANTS = Object.freeze({ current: STOPWORDS_CURRENT, v2: STOPWORDS_V2 });

/**
 * The stopword list in force. Each screened ranker differs from the next only
 * here (tags `3b`, `3b-sw2`, `sw2`), so the ranker tree hash names the list the
 * eval scored. The 3B code-join guard reads the same list (src/query-intent.js).
 * @type {StopwordVariant}
 */
export const STOPWORDS_VARIANT = 'current';

export const STOPWORDS_IN_FORCE = STOPWORD_VARIANTS[STOPWORDS_VARIANT];

/**
 * The query's tokens, split exactly where the modules_fts tokenizer
 * (`porter unicode61`, 0006) splits text: on the separator table generated
 * from SQLite itself, not on `[^a-z0-9]` (FINDINGS B8: "naïve" became "na",
 * "ve"). Lower-cased; folding diacritics and stemming are left to FTS5, which
 * applies them to each quoted token as it does to the indexed text. For ASCII
 * input this is byte-identical to the old `[^a-z0-9]+` split.
 * @param {string} query
 */
export function queryTokens(query) {
  return query.toLowerCase().split(FTS_SEPARATORS).filter(Boolean);
}

/**
 * The stopword test sees the token as FTS5 does: diacritics stripped
 * (canonical decomposition, marks removed), so "ánd" is "and".
 * @param {string} token
 */
const isStopword = (token) => STOPWORDS_IN_FORCE.has(token.normalize('NFD').replace(/\p{M}+/gu, ''));

/** @param {string} query */
function ftsTokens(query) {
  const all = queryTokens(query);
  // If the query is nothing but stopwords, keep them rather than matching nothing.
  const tokens = all.filter((t) => !isStopword(t));
  return tokens.length ? tokens : all;
}

// FTS5 MATCH is its own query language: unescaped user text is a syntax error
// waiting to happen. Reduce the query to bare tokens, quote each one, and OR
// them together — recall comes from the OR, ranking from the rank column. No
// token can hold a `"`: it is a separator.
/** @param {string[]} tokens */
function ftsMatchExpression(tokens) {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * @typedef {{ prefixes: readonly string[], corrections: readonly { from: string, to: string }[] }} FtsTerms
 *   3C's terms (src/typo.js): tokens written as prefix terms, and corrections
 *   whose original joins the OR, as a prefix term, beside its corrected term.
 */

/**
 * The FTS5 MATCH expression for a user query, or null when it has no tokens.
 * With 3C's terms, a token in `prefixes` is written `"tok"*`, and each
 * correction's original follows its corrected term (or ends the expression
 * when that term is a stopword), so nothing typed is lost. A query with
 * neither gets exactly the expression it had before 3C.
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
