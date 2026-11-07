// @ts-check
// The corpus vocabulary 3C corrects against (docs/plans/phase3.md "3C Typos
// and prefixes"): every surface token of the indexed text (title and
// description, split by queryTokens exactly as modules_fts splits them) with
// its document frequency, and the FTS index terms those tokens become (folded
// and porter-stemmed), so whether a prefix term `"tok"*` matches anything is
// decided here, with no D1 query. Built from the same corpus as the vectors
// bundle and versioned by its data version (scripts/build-vocabulary.mjs).
// Pure: no bindings, no JSON imports, so Node scripts and the eval import it.
import { queryTokens } from './fts-query.js';
import { ftsTerm } from './porter.js';

export const VOCABULARY_SCHEMA = 'vnm-vocabulary/1';

/**
 * @typedef {'production' | 'pinned' | 'fixture' | 'eval'} VocabularyCorpus
 * @typedef {{
 *   schema: string, corpus: VocabularyCorpus, dataVersion: string, rule: string, documents: number, count: number,
 *   terms: string, df: number[], stems: string,
 * }} VocabularyFile The committed form: `terms` and `stems` newline-joined, sorted by code unit.
 * @typedef {{
 *   corpus: VocabularyCorpus, dataVersion: string, documents: number,
 *   terms: string[], df: number[], stems: string[],
 * }} Vocabulary
 */

const RULE = 'surface tokens of title + description by queryTokens (src/fts-query.js), each with the number of '
  + 'documents containing it; stems: the distinct FTS5 index terms they make (src/porter.js ftsTerm)';

/** @param {string} a @param {string} b */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ title: string, description?: string | null }[]} modules
 * @param {{ corpus: VocabularyCorpus, dataVersion: string }} meta
 * @returns {VocabularyFile}
 */
export function buildVocabulary(modules, { corpus, dataVersion }) {
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const m of modules) {
    for (const t of new Set(queryTokens(`${m.title} ${m.description ?? ''}`))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const terms = [...df.keys()].sort(byCodeUnit);
  const stems = [...new Set(terms.map(ftsTerm))].filter((s) => s !== '').sort(byCodeUnit);
  return {
    schema: VOCABULARY_SCHEMA, corpus, dataVersion, rule: RULE, documents: modules.length, count: terms.length,
    terms: terms.join('\n'), df: terms.map((t) => /** @type {number} */ (df.get(t))), stems: stems.join('\n'),
  };
}

/**
 * The committed bytes: the header fields one per line, the data on one line each.
 * @param {VocabularyFile} file
 */
export function serializeVocabulary(file) {
  const lines = Object.entries(file).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** @param {string} s */
const lines = (s) => (s === '' ? [] : s.split('\n'));

/**
 * @param {VocabularyFile} file
 * @returns {Vocabulary}
 */
export function parseVocabulary(file) {
  if (file.schema !== VOCABULARY_SCHEMA) throw new Error(`vocabulary schema ${file.schema}, expected ${VOCABULARY_SCHEMA}`);
  const terms = lines(file.terms);
  if (terms.length !== file.df.length || terms.length !== file.count) {
    throw new Error(`vocabulary has ${terms.length} terms, ${file.df.length} df values and count ${file.count}`);
  }
  return { corpus: file.corpus, dataVersion: file.dataVersion, documents: file.documents, terms, df: file.df, stems: lines(file.stems) };
}

/**
 * The first index in sorted `xs` whose value is ≥ `x`.
 * @param {string[]} xs @param {string} x
 */
function lowerBound(xs, x) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The number of documents containing the surface token, 0 when none does.
 * @param {Vocabulary} v @param {string} token
 */
export function dfOf(v, token) {
  const i = lowerBound(v.terms, token);
  return v.terms[i] === token ? v.df[i] : 0;
}

/**
 * Whether the FTS prefix term `"token"*` matches any document: FTS5 folds and
 * stems the token, then looks for an index term starting with the result.
 * @param {Vocabulary} v @param {string} token
 */
export function prefixMatches(v, token) {
  const p = ftsTerm(token);
  if (p === '') return false;
  const i = lowerBound(v.stems, p);
  return i < v.stems.length && v.stems[i].startsWith(p);
}

/** Three DP rows, reused across calls (grown as needed). */
let rows = [new Int32Array(32), new Int32Array(32), new Int32Array(32)];

/**
 * The optimal string alignment distance (Levenshtein plus adjacent
 * transposition, each substring edited at most once), C2-5: `desgin` →
 * `design` costs 1. Above `max` it stops early and returns max + 1.
 * @param {string} a @param {string} b @param {number} [max]
 */
export function osaDistance(a, b, max = Infinity) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > max) return max + 1;
  if (rows[0].length <= m) rows = [new Int32Array(m + 1), new Int32Array(m + 1), new Int32Array(m + 1)];
  let [prev2, prev, cur] = rows;
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const ai = a.charCodeAt(i - 1);
    const aPrev = i > 1 ? a.charCodeAt(i - 2) : -1;
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let d = prev[j - 1] + (ai === bj ? 0 : 1);
      if (prev[j] + 1 < d) d = prev[j] + 1;
      if (cur[j - 1] + 1 < d) d = cur[j - 1] + 1;
      if (j > 1 && ai === b.charCodeAt(j - 2) && aPrev === bj && prev2[j - 2] + 1 < d) d = prev2[j - 2] + 1;
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    // No later row can come back under the bound (a transposition reaches back
    // two rows, but only from a cell the row between already improves on).
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m] > max ? max + 1 : prev[m];
}

/**
 * The vocabulary term nearest `token` within `maxDist` OSA edits: the
 * smallest distance, then the higher df, then the lexicographically smaller
 * term (C19). Null when none is within the bound.
 * @param {Vocabulary} v @param {string} token @param {number} maxDist
 */
export function nearestTerm(v, token, maxDist) {
  /** @type {{ term: string, d: number, df: number } | null} */
  let best = null;
  for (let i = 0; i < v.terms.length; i++) {
    const term = v.terms[i];
    if (Math.abs(term.length - token.length) > maxDist) continue;
    const bound = best ? best.d : maxDist;
    const d = osaDistance(token, term, bound);
    if (d > bound) continue;
    if (!best || d < best.d || (d === best.d && (v.df[i] > best.df || (v.df[i] === best.df && term < best.term)))) {
      best = { term, d, df: v.df[i] };
    }
  }
  return best ? best.term : null;
}
