// @ts-check
import { FTS_SEPARATORS } from './fts-separators.js';
import { queryTokens } from './fts-query.js';
import { dfOf, nearestTerm, prefixMatches } from './vocabulary.js';

export const TYPO_VARIANTS = Object.freeze({
  '3c1': Object.freeze({ embedCorrected: false }),
  '3c2': Object.freeze({ embedCorrected: true }),
});
/** @typedef {keyof typeof TYPO_VARIANTS} TypoVariant */

/** @type {TypoVariant} */
export const TYPO_VARIANT = '3c2';

export const EMBED_CORRECTED = TYPO_VARIANTS[TYPO_VARIANT].embedCorrected;

export const PREFIX_MIN_LETTERS = 4;
export const CORRECT_MIN_LETTERS = 5;
/** @param {number} letters */
export const maxDistance = (letters) => (letters >= 8 ? 2 : 1);

const LETTERS = /^[a-z]+$/;
const PIECES = new RegExp(`(${FTS_SEPARATORS.source})`, FTS_SEPARATORS.flags);

/**
 * @typedef {{ from: string, to: string }} Correction
 * @typedef {{ tokens: string[], text: string, prefixes: string[], corrections: Correction[] }} CorrectedQuery
 */

/** @type {{ q: string, vocab: import('./vocabulary.js').Vocabulary, result: CorrectedQuery } | null} */
let last = null;

/**
 * @param {string} q
 * @param {import('./vocabulary.js').Vocabulary} vocab
 * @returns {CorrectedQuery}
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
  const text = to.size ? q.split(PIECES).map((piece) => to.get(piece.toLowerCase()) ?? piece).join('') : q;
  return { tokens, text, prefixes, corrections: [...to].map(([from, t]) => ({ from, to: t })) };
}
