// @ts-check
// Runs one variant (ranker ref × embedding version × query set) through the
// actual Worker in workerd and writes its run file. A variant is identified
// by name; the run file records the ranker ref and sha, corpus version,
// embedding version and query-set version.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createVitest } from 'vitest/node';
import { loadCorpusFile, loadPinnedWith } from '../lib/corpus.mjs';
import { cachePart, embeddingKey, loadCorpusEmbeddings, packLookup, readCache, readManifest, DIMS, MODEL } from '../lib/embeddings.mjs';
import { REPO, loadQueries, runFile, searchParams, setFile, setKey } from '../lib/sets.mjs';
import { buildWorkspace } from '../lib/workspace.mjs';
import { EvalReporter } from './reporter.mjs';

/**
 * @typedef {{
 *   set: import('../lib/sets.mjs').SetLayout,
 *   variant: string,
 *   ref?: string,
 *   embedding?: string,
 *   unfiltered?: boolean,
 *   output?: string,
 *   log?: (line: string) => void,
 * }} RunOptions
 */

/**
 * @param {RunOptions} options
 * @returns {Promise<{ ok: boolean, output: string, problems: string[] }>}
 */
export async function runVariant(options) {
  const { set, variant, ref, unfiltered = false } = options;
  const log = options.log ?? ((/** @type {string} */ l) => console.log(l));
  const key = set.encrypted ? await setKey() : null;
  const querySet = await loadQueries(set);

  const ws = await buildWorkspace({ ref, name: `${set.name}-${variant}` });
  const fixtureCorpus = join(set.dir, 'corpus.json');
  const corpus = existsSync(fixtureCorpus) ? await loadCorpusFile(fixtureCorpus) : await loadPinnedWith(ws.root);

  // Vectors: the set's query cache, plus the corpus release asset unless the
  // set carries its own corpus (fixture), whose vectors live in the same cache.
  const cache = await readCache(setFile(set, 'embeddings.json'), key, set.name);
  /** @type {{ keys: string[], vectors: Float32Array }[]} */
  const parts = [cachePart(cache)];
  /** @type {Record<string, unknown>} */
  let embedding = { corpus: 'set-cache', model: MODEL };
  if (!existsSync(fixtureCorpus)) {
    const version = options.embedding ?? (await readManifest()).default;
    const emb = await loadCorpusEmbeddings(version);
    parts.unshift({ keys: emb.keys, vectors: emb.vectors });
    embedding = { corpus: version, model: emb.model, textRef: emb.textRef };
  }
  const lookup = packLookup(parts, DIMS);
  const have = new Set(lookup.keys);

  const missingCorpus = corpus.modules.filter((m) => !have.has(embeddingKey(MODEL, m.text)));
  if (missingCorpus.length) {
    throw new Error(`${missingCorpus.length} of ${corpus.modules.length} corpus texts have no vector in ${embedding.corpus} `
      + `(the ranker's embedding text differs from the one embedded). Embed a new corpus version: npm run eval:embed -- --corpus --ref <ref> --version <new>`);
  }
  const missingQueries = querySet.queries.filter((q) => !have.has(embeddingKey(MODEL, q.text)));
  if (missingQueries.length) {
    throw new Error(`${missingQueries.length} query text(s) of the ${set.name} set have no embedding; run \`npm run eval:embed -- --set ${set.name}\` locally`);
  }

  const output = options.output ?? runFile(set, variant);
  const header = {
    schema: 'vnm-eval-run/1',
    variant,
    set: set.name,
    createdAt: new Date().toISOString(),
    ranker: ws.ranker,
    corpus: corpus.info,
    embedding,
    queries: {
      version: querySet.version,
      sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'),
      count: querySet.queries.length,
    },
    config: { topK: 'worker default', filters: !unfiltered },
  };
  const reporter = new EvalReporter({
    output,
    missingOutput: join(REPO, '.eval-work', `missing-${set.name}.json${key ? '.enc' : ''}`),
    key,
    set: set.name,
    header,
    expectedIds: querySet.queries.map((q) => q.id),
    log,
  });

  /** @type {EvalPayload} */
  const payload = {
    queries: querySet.queries.map((q) => ({ id: q.id, params: searchParams(q, { unfiltered }) })),
    corpus: corpus.modules,
    lookup,
    seedTimeoutMs: 900_000,
  };

  log(`${set.name}/${variant}: ranker ${ws.ranker.ref} (${ws.ranker.sha.slice(0, 7)}${ws.ranker.dirty ? ', dirty' : ''}), `
    + `${corpus.modules.length} modules, ${querySet.queries.length} queries, embeddings ${embedding.corpus}`);
  process.env.VNM_EVAL_WORKSPACE = ws.root;
  const vitest = await createVitest({
    config: join(REPO, 'vitest.eval.config.mjs'),
    root: REPO,
    watch: false,
    run: true,
    // Encrypted sets: only the eval reporter, and no console passthrough, so
    // no query id, text or per-query error reaches the terminal.
    reporters: set.perQueryOutput ? ['dot', reporter] : [reporter],
    silent: !set.perQueryOutput,
  });
  try {
    // The ProvidedContext key is typed on the worker side (eval/runner/vitest.d.ts).
    /** @type {any} */ (vitest).provide('evalPayload', payload);
    await vitest.start();
  } finally {
    await vitest.close();
  }
  const outcome = reporter.outcome ?? { ok: false, written: null, problems: ['the reporter never saw the end of the run'] };
  return { ok: outcome.ok, output, problems: outcome.problems };
}
