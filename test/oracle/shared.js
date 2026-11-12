// @ts-check
// What the oracle tests (test/oracle, over production) and their pinned-corpus
// assertions (test/full/oracle-pinned.test.js) share: the 15
// (sem, study) combinations, the standby's queries, and Workers AI answered
// from the committed query embeddings.
import devEmbeddings from '../../eval/dev/embeddings.json';
import correctedEmbeddings from '../fixtures/query-suite-corrected-embeddings.json';
import sc4Embeddings from '../query-suite/embeddings.json';
import { NG_SEMS, STUDIES } from '../../src/ng-bit.js';
import { sha256Hex } from '../../src/rowhash.js';

/** The 15 combinations, with the query string each sets. */
export const COMBOS = NG_SEMS.flatMap((sem) => STUDIES.map((study) => ({
  sem, study, qs: `ng=1&study=${study}${sem === 'any' ? '' : `&sem=${sem}`}`,
  /** @type {import('../../src/vector-bundle.js').FilterEcho} */
  echo: { ng: true, study, ...(sem === 'any' ? {} : { sem }) },
})));

/** The standby's queries: the bundle's top 50 for each is the standby's recall target. */
export const QUERIES = [
  'machine learning', 'introduction to programming', 'financial accounting', 'japanese language', 'climate change',
  'public policy', 'statistics', 'music', 'architecture design studio', 'law and technology', 'organic chemistry',
  'history of southeast asia', 'marketing', 'data structures and algorithms', 'philosophy of mind', 'urban planning',
  'quantum mechanics', 'psychology', 'supply chain management', 'materials science',
];

/** Results and their duplicate-group variants. @param {any} body @returns {string[]} */
export const shownCodes = (body) => body.results.flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)]);

/** @type {Record<string, string>} */
const ENTRIES = { ...devEmbeddings.entries, ...sc4Embeddings.entries, .../** @type {Record<string, string>} */ (correctedEmbeddings.entries) };

/** Workers AI answered from the committed caches; a text without one throws (the dense half degrades). */
export class CacheAI {
  /** @param {string} model @param {{ text: string | string[] }} input */
  async run(model, input) {
    const texts = Array.isArray(input.text) ? input.text : [input.text];
    /** @type {number[][]} */
    const data = [];
    for (const text of texts) {
      const b64 = ENTRIES[await sha256Hex(`${model}\n${text}`)];
      if (!b64) throw new Error('no committed embedding for this text');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      data.push(Array.from(new Float32Array(bytes.buffer)));
    }
    return { shape: [texts.length, 384], data, pooling: 'mean' };
  }
}

/**
 * The dev queries with an ng filter, as the eval runner sends them: `study` from the persona,
 * each filter as a query parameter.
 * @param {any[]} queries
 * @param {{ personas: Record<string, string>, noPersona: string }} studyMap
 */
export const ngDevRequests = (queries, studyMap) => queries.filter((q) => q.filters?.ng).map((q) => {
  const f = q.filters;
  const study = studyMap.personas[q.persona] ?? studyMap.noPersona;
  const sem = /** @type {1 | 2 | 'any'} */ (f.sem === 1 || f.sem === 2 ? f.sem : 'any');
  const params = new URLSearchParams({ q: q.text, ng: '1', study });
  for (const k of ['sem', 'level', 'credits', 'faculty']) if (f[k] !== undefined) params.set(k, String(f[k]));
  return { q, study, sem, path: `/search?${params}` };
});
