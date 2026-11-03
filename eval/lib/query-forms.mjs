// @ts-check
// No imports: also loaded in workerd by test/eval/query-forms.test.js.

/**
 * The texts a ranker may embed for a query: the raw text (eval-v0) and the
 * canonical form rankers since PR #7 embed (src/search.js canonicalQuery:
 * trimmed, whitespace collapsed, ASCII letters lowercased). Embedding both
 * keeps a set's queries from going missing mid-run, where the dense breaker
 * would hide the misses (three in a row skip the dense half).
 * @param {string} text
 * @returns {string[]}
 */
export function queryTextForms(text) {
  const canonical = text.trim().replace(/\s+/g, ' ').replace(/[A-Z]+/g, (m) => m.toLowerCase());
  return canonical === text ? [text] : [text, canonical];
}
