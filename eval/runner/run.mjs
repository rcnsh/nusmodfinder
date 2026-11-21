// @ts-check
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCorpusFile, loadPinnedWith, writeRunCatalogue } from '../lib/corpus.mjs';
import { assertCorrectedEmbedded, rankerCorrector, writeRankerGroups, writeRankerVocabulary } from '../lib/corrected.mjs';
import { assertCorpusTextsEmbedded, base64ToF32, cachePart, embeddingKey, loadCorpusEmbeddings, packLookup, queryTextForms, readCache, readManifest, DIMS, MODEL } from '../lib/embeddings.mjs';
import { REPO, layout, loadQueries, runFile, searchParams, setFile, setKey, studyMapSha256 } from '../lib/sets.mjs';
import { constraintFieldsSha256 } from '../lib/compliance.mjs';
import { buildWorkspace } from '../lib/workspace.mjs';

const CHILD = fileURLToPath(new URL('./vitest-child.mjs', import.meta.url));

/** @param {NormalisedModule[]} modules */
function fieldsDigest(modules) {
  const byCode = new Map(modules.map((m) => [m.code, /** @type {any} */ (m)]));
  return constraintFieldsSha256([...byCode.keys()], (c) => byCode.get(c));
}

/**
 * @typedef {{
 *   set: import('../lib/sets.mjs').SetLayout,
 *   variant: string,
 *   ref?: string,
 *   embedding?: string,
 *   unfiltered?: boolean,
 *   strip?: string[],
 *   mode?: string,
 *   explicit?: { label: string, params: Record<string, Record<string, string>> },
 *   output?: string,
 *   log?: (line: string) => void,
 * }} RunOptions
 */

/**
 * @param {RunOptions} options
 * @returns {Promise<{ ok: boolean, output: string, problems: string[] }>}
 */
export async function runVariant(options) {
  const { set, variant, ref, unfiltered = false, strip = [], mode = 'hybrid' } = options;
  if (options.explicit && set.encrypted) throw new Error('explicit per-query params are the dev diagnostic\'s; never on an encrypted set');
  const log = options.log ?? ((/** @type {string} */ l) => console.log(l));
  const key = set.encrypted ? await setKey() : null;
  const querySet = await loadQueries(set);

  const ws = await buildWorkspace({ ref, name: `${set.name}-${variant}` });
  const fixtureCorpus = join(set.dir, 'corpus.json');
  const corpus = existsSync(fixtureCorpus) ? await loadCorpusFile(fixtureCorpus) : await loadPinnedWith(ws.root);

  const cache = await readCache(setFile(set, 'embeddings.json'), key, set.name);
  /** @type {{ keys: string[], vectors: Float32Array }[]} */
  const parts = [cachePart(cache)];
  /** @type {Record<string, unknown>} */
  let embedding = { corpus: 'set-cache', model: MODEL };
  if (!existsSync(fixtureCorpus)) {
    const version = options.embedding ?? (await readManifest()).default;
    const emb = await loadCorpusEmbeddings(version);
    assertCorpusTextsEmbedded(corpus.modules, emb, ws.ranker.ref);
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
  const setDirArg = set.dir === layout(set.name).dir ? '' : ` --set-dir ${relative(REPO, set.dir) || '.'}`;
  const missingQueries = querySet.queries.filter((q) => queryTextForms(q.text).some((t) => !have.has(embeddingKey(MODEL, t))));
  if (missingQueries.length) {
    throw new Error(`${missingQueries.length} query text(s) of the ${set.name} set have no embedding; run \`npm run eval:embed -- --set ${set.name}${setDirArg}\` locally`);
  }
  await writeRunCatalogue(ws.root);
  const corrector = await rankerCorrector(ws.root, corpus.modules, corpus.info.textSha256.slice(0, 12));
  assertCorrectedEmbedded({ set: set.name, setDirArg, ref: ws.ranker.ref, queries: querySet.queries, corrector, have });
  const vocabulary = corrector ? await writeRankerVocabulary(ws.root, corrector) : null;
  const groups = await writeRankerGroups(ws.root, corpus.modules, corpus.info.textSha256.slice(0, 12));

  const dense = await writeBundle(ws.root, corpus.modules, lookup, String(embedding.corpus));

  const output = options.output ?? runFile(set, variant);
  const header = {
    schema: 'vnm-eval-run/1',
    variant,
    set: set.name,
    createdAt: new Date().toISOString(),
    ranker: ws.ranker,
    corpus: { ...corpus.info, constraintFieldsSha256: fieldsDigest(corpus.modules) },
    embedding,
    queries: {
      version: querySet.version,
      sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'),
      count: querySet.queries.length,
    },
    config: {
      topK: 'worker default', filters: !unfiltered, mode, dense,
      studyMap: studyMapSha256(), ...(strip.length ? { strip } : {}),
      ...(options.explicit ? { explicit: options.explicit } : {}),
      ...(vocabulary ? { vocabulary, typo: corrector?.embedsCorrected ? '3c2' : '3c1' } : {}), ...(groups ? { groups } : {}),
    },
  };
  const reporterOptions = {
    output,
    missingOutput: join(REPO, '.eval-work', `missing-${set.name}.json${key ? '.enc' : ''}`),
    key,
    set: set.name,
    header,
    expectedIds: querySet.queries.map((q) => q.id),
  };

  /** @type {EvalPayload} */
  const payload = {
    queries: querySet.queries.map((q) => ({ id: q.id, params: { ...searchParams(q, { unfiltered, mode, strip }), ...(options.explicit?.params[q.id] ?? {}) } })),
    corpus: corpus.modules,
    lookup,
    seedTimeoutMs: 900_000,
  };

  log(`${set.name}/${variant}: ranker ${ws.ranker.ref} (${ws.ranker.sha.slice(0, 7)}${ws.ranker.dirty ? ', dirty' : ''}), `
    + `${corpus.modules.length} modules, ${querySet.queries.length} queries, embeddings ${embedding.corpus}`);
  const outcome = await runInChild({
    config: join(REPO, 'vitest.eval.config.mjs'),
    root: REPO,
    perQueryOutput: set.perQueryOutput,
    payload,
    reporter: reporterOptions,
  }, ws.root, log);
  return { ok: outcome.ok, output, problems: outcome.problems };
}

/**
 * @param {string} root
 * @param {NormalisedModule[]} modules
 * @param {{ keys: string[], b64: string }} lookup
 * @param {string} embedding
 * @returns {Promise<'bundle' | 'vectorize'>}
 */
async function writeBundle(root, modules, lookup, embedding) {
  const lib = join(root, 'src/vector-bundle.js');
  if (!existsSync(lib)) return 'vectorize';
  const { encodeBundle } = await import(pathToFileURL(lib).href);
  const all = base64ToF32(lookup.b64);
  const row = new Map(lookup.keys.map((k, i) => [k, i]));
  const bytes = await encodeBundle({
    corpus: 'eval', embedding, model: MODEL, modules,
    vectorOf: (/** @type {NormalisedModule} */ m) => {
      const i = row.get(embeddingKey(MODEL, m.text));
      return i === undefined ? undefined : all.subarray(i * DIMS, (i + 1) * DIMS);
    },
  });
  await mkdir(join(root, 'test/fixtures'), { recursive: true });
  await writeFile(join(root, 'test/fixtures/vectors.bin'), bytes);
  await writeFile(join(root, 'test/fixtures/vectors.js'), "import vectors from './vectors.bin';\n\nexport default vectors;\n");
  return 'bundle';
}

/**
 * @param {import('./vitest-child.mjs').ChildRequest} request
 * @param {string} workspace
 * @param {(line: string) => void} log
 * @returns {Promise<{ ok: boolean, written: string | null, problems: string[] }>}
 */
function runInChild(request, workspace, log) {
  const quiet = !request.perQueryOutput;
  const child = fork(CHILD, [], {
    cwd: REPO,
    env: { ...process.env, VNM_EVAL_WORKSPACE: workspace },
    stdio: quiet ? ['ignore', 'ignore', 'ignore', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'],
    serialization: 'advanced',
  });
  return new Promise((resolve, reject) => {
    /** @type {{ ok: boolean, written: string | null, problems: string[] } | null} */
    let outcome = null;
    child.on('message', (/** @type {import('./vitest-child.mjs').ChildMessage} */ msg) => {
      if (msg.type === 'log') log(msg.line);
      else if (msg.type === 'outcome') outcome = msg.outcome;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve(outcome ?? { ok: false, written: null, problems: [`the eval runner process exited (${signal ?? `code ${code}`}) without a result`] });
    });
    child.send(request);
  });
}
