// @ts-check
// No imports: also loaded in workerd by test/eval/query-forms.test.js.

/**
 * The texts a ranker may embed for a query: the raw text (eval-v0), the
 * canonical form rankers since PR #7 embed (src/search.js canonicalQuery:
 * trimmed, whitespace collapsed, ASCII letters lowercased) and, for a ranker
 * with a query instruction (3A-1, src/embedding.js QUERY_INSTRUCTION), the
 * instruction + the canonical form, last. Embedding every form keeps a set's
 * queries from going missing mid-run, where the dense breaker would hide the
 * misses (three in a row skip the dense half).
 * @param {string} text
 * @param {string} [instruction] the ranker's query instruction ('' for none)
 * @returns {string[]}
 */
export function queryTextForms(text, instruction = '') {
  const canonical = text.trim().replace(/\s+/g, ' ').replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const forms = canonical === text ? [text] : [text, canonical];
  return instruction ? [...forms, `${instruction}${canonical}`] : forms;
}
