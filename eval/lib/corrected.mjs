// @ts-check
// 3C in the eval harness (docs/plans/phase3.md "3C Typos and prefixes").
//
// - The vocabulary a ranker corrects against is built from the run's own
//   corpus (the pinned snapshot, or a set's corpus.json) by the ranker's own
//   builder, and written over data/vocabulary.json in the run's workspace, so a
//   run never reads the production vocabulary the ref commits.
// - A ranker that embeds its corrected text (3C-2) needs an embedding for each
//   query's corrected form. The runner refuses a run that lacks one and names
//   the command that adds them: `eval:embed --corrected-from-ref <ref>`, which
//   asks the same corrector which texts it produces.
// A ranker without src/typo.js has no corrector (null) and needs nothing.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL, embeddingKey } from './embeddings.mjs';

/**
 * @typedef {{
 *   file: { corpus: string, documents: number, count: number, dataVersion: string },
 *   serialized: string,
 *   embedsCorrected: boolean,
 *   corrected: (text: string) => string | null,
 * }} RankerCorrector `corrected`: the text the ranker embeds beside the query
 *   (its canonical q with 3C's corrections), or null when it corrects nothing.
 */

/**
 * The 3C corrector of the ranker at `root`, with its vocabulary built from
 * `modules` by its own builder; null for a ranker without 3C.
 * @param {string} root a workspace (or the repo) holding the ranker's src/
 * @param {{ title: string, description?: string | null }[]} modules the run corpus
 * @param {string} label the run corpus's identity, recorded as the vocabulary's data version
 * @returns {Promise<RankerCorrector | null>}
 */
export async function rankerCorrector(root, modules, label) {
  const typoPath = join(root, 'src/typo.js');
  if (!existsSync(typoPath)) return null;
  const url = (/** @type {string} */ f) => pathToFileURL(join(root, 'src', f)).href;
  const { buildVocabulary, parseVocabulary, serializeVocabulary } = await import(url('vocabulary.js'));
  const { correctQuery, EMBED_CORRECTED } = await import(url('typo.js'));
  const { canonicalQuery } = await import(url('query-intent.js'));
  const file = buildVocabulary(modules, { corpus: 'eval', dataVersion: label });
  const vocab = parseVocabulary(file);
  return {
    file,
    serialized: serializeVocabulary(file),
    embedsCorrected: EMBED_CORRECTED === true,
    corrected: (text) => {
      // As /search does: trimmed, then canonical (src/search.js parseSearch).
      const q = canonicalQuery(text.trim());
      const c = correctQuery(q, vocab);
      return c.text === q ? null : c.text;
    },
  };
}

/**
 * Writes the run's vocabulary where the ranker reads it.
 * @param {string} root the workspace
 * @param {RankerCorrector} corrector
 */
export async function writeRankerVocabulary(root, corrector) {
  await writeFile(join(root, 'data/vocabulary.json'), corrector.serialized);
  return {
    corpus: corrector.file.corpus, terms: corrector.file.count, documents: corrector.file.documents,
    sha256: createHash('sha256').update(corrector.serialized).digest('hex'),
  };
}

/**
 * The distinct corrected forms of `texts`, in first-seen order.
 * @param {Pick<RankerCorrector, 'corrected'>} corrector
 * @param {string[]} texts
 */
export function correctedTexts(corrector, texts) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const t of texts) {
    const c = corrector.corrected(t);
    if (c !== null) out.add(c);
  }
  return [...out];
}

/**
 * Refuses a run whose ranker embeds corrected texts (3C-2) when any query's
 * corrected text has no embedding. Names only a count, never a text (holdout).
 * @param {{
 *   set: string, setDirArg: string, ref: string, queries: { text: string }[],
 *   corrector: Pick<RankerCorrector, 'corrected' | 'embedsCorrected'> | null, have: Set<string>,
 * }} o `setDirArg`: ' --set-dir <dir>' or ''; `have`: embedding keys available to the run
 */
export function assertCorrectedEmbedded({ set, setDirArg, ref, queries, corrector, have }) {
  if (!corrector?.embedsCorrected) return;
  const missing = correctedTexts(corrector, queries.map((q) => q.text)).filter((t) => !have.has(embeddingKey(MODEL, t)));
  if (missing.length === 0) return;
  throw new Error(`${missing.length} corrected query text(s) of the ${set} set have no embedding (the ranker embeds each query's corrected text, 3C-2); `
    + `run \`npm run eval:embed -- --set ${set}${setDirArg} --corrected-from-ref ${ref}\` locally`);
}

/**
 * Every text the SC4 runner (test/full/sc4.test.js) sends to /search: item
 * texts, typo clean forms and constraint references, distinct.
 * @param {{ items: { text: string, params: Record<string, unknown> }[] }} suite
 */
export function sc4Texts(suite) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const item of suite.items) {
    out.add(item.text);
    for (const k of ['clean', 'reference']) if (typeof item.params[k] === 'string') out.add(/** @type {string} */ (item.params[k]));
  }
  return [...out];
}
