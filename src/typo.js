// @ts-check
// 3C, typos and prefixes (docs/plans/phase3.md "3C Typos and prefixes",
// docs/plans/phase3-prereg.md §4): parse step 3, on the canonical q. For each
// pre-correction token with df 0 in the corpus vocabulary, letter-only:
//   1. 4+ letters: an FTS prefix term `"psych"*` (0006's prefix index);
//   2. only if that prefix term matches nothing (decided from the vocabulary)
//      and the token has 5+ letters: correct it to the nearest vocabulary term
//      by OSA distance, ≤ 1 for 5–7 letters and ≤ 2 for 8+, ties to the higher
//      df, then the lexicographically smaller term (C19);
//   3. the original stays in the OR, as its prefix term.
// The corrected text is what every later parse step reads (C2-4). Pure.
import { FTS_SEPARATORS } from './fts-separators.js';
import { queryTokens } from './fts-query.js';
import { dfOf, nearestTerm, prefixMatches } from './vocabulary.js';

/**
 * The pre-registered variants (plan 3C "Variants"). Each 3C ref differs from
 * the other only in TYPO_VARIANT (tags `3c1`, `3c2`), so the ranker tree hash
 * names the variant the eval scored.
 * - `3c1`: the lexical half only; the dense half embeds the query as typed.
 * - `3c2`: also embeds the corrected text, a second single-text call in
 *   parallel with the first; the dense half takes each module's better cosine
 *   of the two (src/search.js mergeDense).
 */
export const TYPO_VARIANTS = Object.freeze({
  '3c1': Object.freeze({ embedCorrected: false }),
  '3c2': Object.freeze({ embedCorrected: true }),
});
/** @typedef {keyof typeof TYPO_VARIANTS} TypoVariant */

/** @type {TypoVariant} */
export const TYPO_VARIANT = '3c1';

/** Whether the dense half also embeds the corrected text (3C-2). */
export const EMBED_CORRECTED = TYPO_VARIANTS[TYPO_VARIANT].embedCorrected;

/** A df-0 token this long becomes a prefix term. */
export const PREFIX_MIN_LETTERS = 4;
/** A df-0 token this long whose prefix term matches nothing is corrected. */
export const CORRECT_MIN_LETTERS = 5;
/** The OSA bound for a token of `letters` letters: 1 for 5–7, 2 for 8+. @param {number} letters */
export const maxDistance = (letters) => (letters >= 8 ? 2 : 1);

const LETTERS = /^[a-z]+$/;
/** Splits text into tokens and the separator runs between them, keeping both. */
const PIECES = new RegExp(`(${FTS_SEPARATORS.source})`, FTS_SEPARATORS.flags);

/**
 * @typedef {{ from: string, to: string }} Correction
 * @typedef {{ tokens: string[], text: string, prefixes: string[], corrections: Correction[] }} CorrectedQuery
 *   `tokens`: the pre-correction tokens (queryTokens of q; 3G's vocabulary
 *   test reads them). `text`: q with each corrected token replaced, separators
 *   kept. `prefixes`: the df-0 tokens of 4+ letters, in query order, each an FTS
 *   prefix term. `corrections`: original → vocabulary term, in query order.
 */

/**
 * The last correction, kept because /search parses a query more than once
 * when D1 has to say whether a code is offered (src/search.js
 * parseWithCorpus), and the nearest-term scan is the costly part.
 * @type {{ q: string, vocab: import('./vocabulary.js').Vocabulary, result: CorrectedQuery } | null}
 */
let last = null;

/**
 * @param {string} q the canonical q
 * @param {import('./vocabulary.js').Vocabulary} vocab
 * @returns {CorrectedQuery} not to be mutated (it may be returned again)
 */
export function correctQuery(q, vocab) {
  if (last && last.q === q && last.vocab === vocab) return last.result;
  const result = correct(q, vocab);
  last = { q, vocab, result };
  return result;
}

/**
 * @param {string} q
 * @param {import('./vocabulary.js').Vocabulary} vocab
 * @returns {CorrectedQuery}
 */
function correct(q, vocab) {
  const tokens = queryTokens(q);
  /** @type {string[]} */
  const prefixes = [];
  /** @type {Map<string, string>} */
  const to = new Map();
  for (const t of new Set(tokens)) {
    if (t.length < PREFIX_MIN_LETTERS || !LETTERS.test(t) || dfOf(vocab, t) > 0) continue;
    prefixes.push(t);
    if (t.length < CORRECT_MIN_LETTERS || prefixMatches(vocab, t)) continue;
    const near = nearestTerm(vocab, t, maxDistance(t.length));
    if (near !== null) to.set(t, near);
  }
  const text = to.size ? q.split(PIECES).map((piece) => to.get(piece) ?? piece).join('') : q;
  return { tokens, text, prefixes, corrections: [...to].map(([from, t]) => ({ from, to: t })) };
}
