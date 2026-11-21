// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
 *   dense: ((text: string) => string[]) | null,
 * }} RankerCorrector
 */

/**
 * @param {string} root
 * @param {{ title: string, description?: string | null }[]} modules
 * @param {string} label
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
  /** @type {RankerCorrector['dense']} */
  let dense = null;
  const parse = await rankerIntentParser(root, vocab);
  if (parse) {
    dense = (text) => {
      const q = canonicalQuery(text.trim());
      const p = parse(q);
      return [p.dense, ...(EMBED_CORRECTED === true && p.corrected !== null ? [p.corrected] : [])].filter((t) => t !== q);
    };
  }
  return {
    dense,
    file,
    serialized: serializeVocabulary(file),
    embedsCorrected: EMBED_CORRECTED === true,
    corrected: (text) => {
      const q = canonicalQuery(text.trim());
      const c = correctQuery(q, vocab);
      return c.text === q ? null : c.text;
    },
  };
}

/**
 * @param {string} root
 * @param {unknown} vocab
 * @returns {Promise<((q: string) => { dense: string, corrected: string | null, constraints: Record<string, unknown> }) | null>}
 */
export async function rankerIntentParser(root, vocab) {
  if (!existsSync(join(root, 'src/intents.js'))) return null;
  const url = (/** @type {string} */ f) => pathToFileURL(join(root, 'src', f)).href;
  const { buildIntentContext, parseQuery } = await import(url('query-intent.js'));
  const { compileConstraintPhrases, PARSE_PHRASES } = await import(url('intents.js'));
  const { STOPWORDS_IN_FORCE } = await import(url('fts-query.js'));
  const data = (/** @type {string} */ f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
  const phrases = PARSE_PHRASES === false ? [] : compileConstraintPhrases(data('constraint-phrases.json'));
  const ctx = buildIntentContext({
    prefixes: Object.keys(data('prefixes.json').prefixes), catalogueCodes: data('catalogue-codes.json').codes,
    collision: data('collision-list.json').list, ge: data('ge-pillars.json'), stopwords: STOPWORDS_IN_FORCE,
    isOffered: () => false, vocabulary: vocab, constraintPhrases: phrases,
  });
  return (q) => parseQuery(q, ctx);
}

/**
 * @param {string} root
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
 * @param {Pick<RankerCorrector, 'corrected'> & Partial<Pick<RankerCorrector, 'dense'>>} corrector
 * @param {string[]} texts
 */
export function correctedTexts(corrector, texts) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const t of texts) {
    if (corrector.dense) for (const d of corrector.dense(t)) out.add(d);
    else {
      const c = corrector.corrected(t);
      if (c !== null) out.add(c);
    }
  }
  return [...out];
}

/**
 * @param {{
 *   set: string, setDirArg: string, ref: string, queries: { text: string }[],
 *   corrector: Pick<RankerCorrector, 'corrected' | 'embedsCorrected'> & Partial<Pick<RankerCorrector, 'dense'>> | null, have: Set<string>,
 * }} o
 */
export function assertCorrectedEmbedded({ set, setDirArg, ref, queries, corrector, have }) {
  if (!corrector?.embedsCorrected && !corrector?.dense) return;
  const missing = correctedTexts(corrector, queries.map((q) => q.text)).filter((t) => !have.has(embeddingKey(MODEL, t)));
  if (missing.length === 0) return;
  throw new Error(`${missing.length} dense query text(s) of the ${set} set have no embedding (the ranker embeds each query's corrected text, or its text with constraint phrases stripped); `
    + `run \`npm run eval:embed -- --set ${set}${setDirArg} --corrected-from-ref ${ref}\` locally`);
}

/** @param {{ items: { text: string, params: Record<string, unknown> }[] }} suite */
export function suiteTexts(suite) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const item of suite.items) {
    out.add(item.text);
    for (const k of ['clean', 'reference']) if (typeof item.params[k] === 'string') out.add(/** @type {string} */ (item.params[k]));
  }
  return [...out];
}

/**
 * @param {string} root
 * @param {{ code: string, title: string, description?: string | null }[]} modules
 * @param {string} label
 */
export async function writeRankerGroups(root, modules, label) {
  const path = join(root, 'src/groups.js');
  if (!existsSync(path)) return null;
  const { buildGroupsFile, serializeGroupsFile } = await import(pathToFileURL(path).href);
  const file = buildGroupsFile(modules, { corpus: 'eval', dataVersion: label });
  const serialized = serializeGroupsFile(file);
  await writeFile(join(root, 'data/groups.json'), serialized);
  return { version: file.version, groups: file.counts.groups, sha256: createHash('sha256').update(serialized).digest('hex') };
}
