// @ts-check
// Phase 2c analysis probe, Node side. Runs a list of /search requests through
// a ranker (default eval-v0) in workerd, exactly as `npm run eval` does
// (same workspace builder, corpus, corpus embeddings, harness and Vitest
// config), but returns whole response bodies and FTS5 rank values (see
// probe.eval.js). No Cloudflare call: every vector comes from the committed
// dev cache, the corpus release asset, or vectors the caller passes in.
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
import { loadPinnedWith } from '../../../eval/lib/corpus.mjs';
import { cachePart, loadCorpusEmbeddings, packLookup, readCache, readManifest, DIMS, MODEL } from '../../../eval/lib/embeddings.mjs';
import { REPO } from '../../../eval/lib/sets.mjs';
import { buildWorkspace } from '../../../eval/lib/workspace.mjs';

const SPEC = fileURLToPath(new URL('./probe.eval.js', import.meta.url));
/** The probe for Phase 1 rankers (second fidelity check). */
export const HEAD_SPEC = fileURLToPath(new URL('./probe-head.eval.js', import.meta.url));

/**
 * @typedef {{ id: string, path: string, override?: string, fts?: boolean, lex?: boolean }} ProbeRequest
 * @typedef {{ status: number, body: any, fts: Record<string, number> | null, lex: string[] | null }} ProbeResult
 * @typedef {{ keys: string[], vectors: Float32Array }} Part
 */

/** Corpus vectors (release asset) and the dev query cache, unpacked. */
export async function loadVectors() {
  const version = (await readManifest()).default;
  const emb = await loadCorpusEmbeddings(version);
  const dev = cachePart(await readCache(join(REPO, 'eval/dev/embeddings.json'), null, 'dev'));
  return { version, corpus: /** @type {Part} */ ({ keys: emb.keys, vectors: emb.vectors }), dev };
}

/**
 * @param {{
 *   requests: ProbeRequest[],
 *   ref?: string,
 *   name?: string,
 *   spec?: string,
 *   corpusVectors?: Part,
 *   queryVectors?: Part,
 *   overrides?: Record<string, Part>,
 * }} options
 * @returns {Promise<Map<string, ProbeResult>>}
 */
export async function runProbe(options) {
  const { requests, ref = 'eval-v0', name = 'probe', spec = SPEC } = options;
  const ws = await buildWorkspace({ ref, name });
  await copyFile(spec, join(ws.root, 'eval/runner/retrieval.eval.js'));
  const corpus = await loadPinnedWith(ws.root);
  const loaded = options.corpusVectors && options.queryVectors ? null : await loadVectors();
  const lookup = packLookup([options.corpusVectors ?? /** @type {any} */ (loaded).corpus, options.queryVectors ?? /** @type {any} */ (loaded).dev], DIMS);
  /** @type {Record<string, ReturnType<typeof packLookup>>} */
  const overrides = {};
  for (const [k, part] of Object.entries(options.overrides ?? {})) overrides[k] = packLookup([part], DIMS);
  if (lookup.model !== MODEL) throw new Error('unexpected model');

  /** @type {Map<string, ProbeResult>} */
  const results = new Map();
  /** @type {string[]} */
  const failures = [];
  const reporter = {
    /** @param {any} tc */
    onTestCaseResult(tc) {
      const meta = tc.meta().probe;
      if (meta) results.set(tc.name, meta);
      if (tc.result().state === 'failed') failures.push(`${tc.name}: ${tc.result().errors?.[0]?.message}`);
    },
  };
  const prev = process.env.VNM_EVAL_WORKSPACE;
  process.env.VNM_EVAL_WORKSPACE = ws.root;
  try {
    const vitest = await createVitest({ config: join(REPO, 'vitest.eval.config.mjs'), root: REPO, watch: false, run: true, reporters: [reporter], silent: true });
    try {
      /** @type {any} */ (vitest).provide('evalPayload', { requests, corpus: corpus.modules, lookup, overrides, seedTimeoutMs: 900_000 });
      await vitest.start();
    } finally {
      await vitest.close();
    }
  } finally {
    if (prev === undefined) delete process.env.VNM_EVAL_WORKSPACE;
    else process.env.VNM_EVAL_WORKSPACE = prev;
  }
  if (failures.length || results.size !== requests.length) {
    throw new Error(`probe: ${failures.length} failed, ${results.size}/${requests.length} results\n${failures.slice(0, 10).join('\n')}`);
  }
  return results;
}

/**
 * The /search path for a dev query, as the eval runner builds it (production
 * defaults + filters), plus a `_p` tag that v0 ignores but that keeps
 * caches.default from answering a repeated query string with an earlier body.
 * @param {{ text: string, filters?: Record<string, unknown> }} q
 * @param {{ unfiltered?: boolean, tag?: string }} [o]
 */
export function searchPath(q, o = {}) {
  /** @type {Record<string, string>} */
  const params = { q: q.text };
  if (!o.unfiltered) {
    for (const [k, v] of Object.entries(q.filters ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      params[k] = v === true ? '1' : String(v);
    }
  }
  if (o.tag) params._p = o.tag;
  return `/search?${new URLSearchParams(params)}`;
}
