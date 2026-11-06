#!/usr/bin/env node
// @ts-check
// P-6: the SC4 typo threshold T (docs/plans/phase3.md §4, "Thresholds fixed at
// P-6"). For each of the 6 dev typo queries, an oracle variant runs the lexical
// half on the clean form and the dense half on the typo form: the best a
// keyword-only corrector can do. T is the smallest oracle overlap@10 with the
// clean form's own top 10, over the 6 pairs, capped at 7.
//
// The clean form of each typo query is its dev source query, verbatim: the
// noise-model typos were derived from those texts (`source` in
// eval/dev/queries.json), so the source is the clean form by construction,
// with the same filters, and its embedding is already committed.
//
// How the oracle runs through the eval runner, with no new embedding and no
// ranker change: two throwaway sets in a temp directory hold the 6 clean texts.
// In `clean` each text's embedding key maps to its own committed vector; in
// `oracle` it maps to the typo text's committed vector. The Worker searches
// the clean text lexically and embeds "the clean text", which the lookup
// answers with the typo vector. A third set, `typo`, runs the typo texts as
// they are (no correction), for context only.
//
// Runs at the shipped-ranker pin (eval/lib/baseline.mjs SHIPPED_BASELINE), on
// the pinned corpus and emb-bge-small-v0, offline. Writes
// eval/prereg/typo-threshold.json.
//
//   node eval/prereg/typo-threshold.mjs
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHIPPED_BASELINE } from '../lib/baseline.mjs';
import { embeddingKey, MODEL, queryTextForms } from '../lib/embeddings.mjs';
import { REPO, layout } from '../lib/sets.mjs';
import { runVariant } from '../runner/run.mjs';

export const OUT = join(REPO, 'eval/prereg/typo-threshold.json');
export const CAP = 7;
export const K = 10;

/**
 * T from per-pair oracle overlaps: the smallest, capped.
 * @param {number[]} overlaps
 */
export function thresholdT(overlaps) {
  if (overlaps.length === 0) throw new Error('no typo pairs');
  return Math.min(CAP, ...overlaps);
}

/**
 * |top-K(a) ∩ top-K(b)| on module codes.
 * @param {string[]} a
 * @param {string[]} b
 */
export function overlapAt(a, b, k = K) {
  const top = new Set(b.slice(0, k));
  return a.slice(0, k).filter((c) => top.has(c)).length;
}

/**
 * Embedding entries mapping each form of `asText` to the same form of `vectorOf`.
 * Forms pair by kind: raw with raw, canonical with canonical.
 * @param {string} asText
 * @param {string} vectorOf
 * @param {Record<string, string>} entries the dev cache
 */
function remap(asText, vectorOf, entries) {
  const from = queryTextForms(asText);
  const to = queryTextForms(vectorOf);
  /** @type {Record<string, string>} */
  const out = {};
  for (const form of from) {
    const raw = from.length > 1 && form === from[0];
    const src = raw ? to[0] : to[to.length - 1];
    const vec = entries[embeddingKey(MODEL, src)];
    if (!vec) throw new Error(`no committed dev embedding for a form of ${JSON.stringify(vectorOf)}`);
    out[embeddingKey(MODEL, form)] = vec;
  }
  return out;
}

async function main() {
  const dev = JSON.parse(await readFile(join(REPO, 'eval/dev/queries.json'), 'utf8'));
  const cache = JSON.parse(await readFile(join(REPO, 'eval/dev/embeddings.json'), 'utf8'));
  const byId = new Map(dev.queries.map((/** @type {any} */ q) => [q.id, q]));
  const typos = dev.queries.filter((/** @type {any} */ q) => q.shapes.includes('typo'));
  if (typos.length !== 6) throw new Error(`expected 6 dev typo queries, found ${typos.length}`);
  /** @type {{ id: string, source: string, typo: string, clean: string, filters: Record<string, unknown> }[]} */
  const pairs = typos.map((/** @type {any} */ t) => {
    const src = byId.get(t.source);
    if (!src) throw new Error(`${t.id}: source ${t.source} is not a dev query`);
    if (JSON.stringify(src.filters) !== JSON.stringify(t.filters)) throw new Error(`${t.id}: filters differ from its source ${src.id}`);
    return { id: t.id, source: src.id, typo: t.text, clean: src.text, filters: t.filters };
  });

  const root = await mkdtemp(join(tmpdir(), 'vnm-typo-oracle-'));
  try {
    /** @type {Record<string, Record<string, string[]>>} */
    const codes = {};
    for (const kind of ['clean', 'oracle', 'typo']) {
      const dir = join(root, kind);
      await mkdir(dir, { recursive: true });
      /** @type {Record<string, string>} */
      let entries = {};
      for (const p of pairs) {
        if (kind === 'clean') entries = { ...entries, ...remap(p.clean, p.clean, cache.entries) };
        if (kind === 'oracle') entries = { ...entries, ...remap(p.clean, p.typo, cache.entries) };
        if (kind === 'typo') entries = { ...entries, ...remap(p.typo, p.typo, cache.entries) };
      }
      const queries = pairs.map((p) => ({ id: `${kind}-${p.id}`, text: kind === 'typo' ? p.typo : p.clean, filters: p.filters, shapes: ['typo'] }));
      await writeFile(join(dir, 'queries.json'), `${JSON.stringify({ schema: 'vnm-eval-queries/1', set: 'dev', version: `p6-typo-${kind}`, queries }, null, 1)}\n`);
      await writeFile(join(dir, 'embeddings.json'), `${JSON.stringify({ schema: cache.schema, model: cache.model, dims: cache.dims, entries }, null, 1)}\n`);
      const set = layout('dev', dir);
      const out = join(dir, 'run.json');
      const r = await runVariant({ set, variant: `p6-typo-${kind}`, ref: SHIPPED_BASELINE.ref, output: out });
      if (!r.ok) throw new Error(`${kind} run failed: ${r.problems.join('; ')}`);
      const run = JSON.parse(await readFile(out, 'utf8'));
      codes[kind] = Object.fromEntries(pairs.map((p) => {
        const res = run.results[`${kind}-${p.id}`];
        if (!res || res.status !== 200) throw new Error(`${kind}-${p.id}: status ${res?.status}`);
        return [p.id, res.codes];
      }));
      codes[`${kind}:ranker`] = /** @type {any} */ ([run.ranker.sha, run.ranker.treeHash]);
    }
    const perPair = pairs.map((p) => ({
      id: p.id,
      source: p.source,
      typo: p.typo,
      clean: p.clean,
      filters: p.filters,
      oracleOverlapAt10: overlapAt(codes.oracle[p.id], codes.clean[p.id]),
      uncorrectedOverlapAt10: overlapAt(codes.typo[p.id], codes.clean[p.id]),
      cleanTop10: codes.clean[p.id].slice(0, K),
      oracleTop10: codes.oracle[p.id].slice(0, K),
    }));
    const T = thresholdT(perPair.map((p) => p.oracleOverlapAt10));
    const result = {
      schema: 'vnm-p6-typo-threshold/1',
      rule: 'T = min over the 6 dev typo pairs of overlap@10(oracle, clean), capped at 7; oracle = lexical half on the clean form, dense half on the typo form',
      ranker: { ref: SHIPPED_BASELINE.ref, sha: codes['clean:ranker'][0], treeHash: codes['clean:ranker'][1] },
      corpus: 'data-2026-2027-20260904',
      embedding: 'emb-bge-small-v0',
      cap: CAP,
      T,
      perPair,
    };
    await writeFile(OUT, `${JSON.stringify(result, null, 1)}\n`);
    console.log(`T = ${T} (oracle overlaps@10: ${perPair.map((p) => `${p.id} ${p.oracleOverlapAt10}`).join(', ')}) -> ${OUT}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
