#!/usr/bin/env node
// @ts-check
// The top-1 exact cosine of the query as typed,
// with the query's filters, over the corpus the eval scores (the pinned
// bundle), for both halves of the gibberish set and the dev queries not
// tagged no-answer. It reads tags, never relevance labels. It uses the
// product's own parse (parsed.noSignal) and exact search, and the committed
// embeddings (test/query-suite/embeddings.json, eval/dev/embeddings.json), so it
// makes no remote call. It also derives the τ candidates from the derivation
// half (src/no-signal.js) and, per candidate, predicts the dev conditions
// /search would meet: the gate half's count-0 share and any untagged dev
// query it would empty.
//
//   node scripts/no-signal-cosines.mjs            print the summary
//   node scripts/no-signal-cosines.mjs --write    also write .data/no-signal-cosines.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOPWORDS_IN_FORCE } from '../src/fts-query.js';
import { noSignalCandidates } from '../src/no-signal.js';
import { buildIntentContext, canonicalQuery, parseQuery } from '../src/query-intent.js';
import { exactSearch } from '../src/vector-bundle.js';
import { buildVocabulary, parseVocabulary } from '../src/vocabulary.js';
import { loadPinnedCorpus } from './pinned-corpus.mjs';
import { loadCheckedBundle, readVectorsManifest } from './vectors-manifest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.data/no-signal-cosines.json');
const read = (/** @type {string} */ rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const entry = (await readVectorsManifest()).bundles.pinned;
if (!entry) throw new Error('data/vectors.json records no pinned bundle');
const { bundle } = await loadCheckedBundle(entry);
const { modules } = await loadPinnedCorpus();
const codes = new Set(bundle.codes);
const ctx = buildIntentContext({
  prefixes: Object.keys(read('data/pinned/prefixes.json').prefixes),
  catalogueCodes: read('data/pinned/catalogue-codes.json').codes,
  collision: read('data/collision-list.json').list,
  ge: read('data/ge-pillars.json'),
  stopwords: STOPWORDS_IN_FORCE,
  isOffered: (c) => codes.has(c),
  vocabulary: parseVocabulary(buildVocabulary(modules, { corpus: 'eval', dataVersion: entry.dataVersion })),
});

/** @type {Record<string, string>} */
const entries = {};
for (const rel of ['test/query-suite/embeddings.json', 'eval/dev/embeddings.json']) {
  const cache = read(rel);
  if (cache.model !== '@cf/baai/bge-small-en-v1.5' || cache.dims !== 384) throw new Error(`${rel}: unexpected model`);
  Object.assign(entries, cache.entries);
}
/** @param {string} text */
function vectorOf(text) {
  const b64 = entries[createHash('sha256').update(`@cf/baai/bge-small-en-v1.5\n${text}`).digest('hex')];
  if (!b64) throw new Error(`no committed embedding for ${JSON.stringify(text)}`);
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * @param {{ id: string, text: string, filters?: Record<string, unknown> }} item
 */
function measure(item) {
  const q = canonicalQuery(item.text.trim());
  const parsed = parseQuery(q, ctx);
  const [top] = exactSearch(bundle, vectorOf(q), /** @type {any} */ (item.filters ?? {}), 1);
  return { id: item.id, text: item.text, noSignal: parsed.noSignal, top: top ? top.score : null };
}

const gibberish = read('eval/dev/gibberish.json');
const byId = new Map(gibberish.strings.map((/** @type {any} */ s) => [s.id, s]));
const derivation = gibberish.split.derivation.map((/** @type {string} */ id) => measure(byId.get(id)));
const gate = gibberish.split.gate.map((/** @type {string} */ id) => measure(byId.get(id)));
const untagged = read('eval/dev/queries.json').queries.filter((/** @type {any} */ q) => !(q.shapes ?? []).includes('noanswer'));
const dev = untagged.map(measure);

const candidates = noSignalCandidates(derivation.map((/** @type {any} */ m) => m.top));
/** @param {{ noSignal: boolean, top: number | null }} m @param {number} tau */
const fires = (m, tau) => m.noSignal && m.top !== null && m.top < tau;
const predicted = candidates.map((tau) => ({
  tau,
  gateFires: gate.filter((/** @type {any} */ m) => fires(m, tau)).length,
  gateShare: gate.filter((/** @type {any} */ m) => fires(m, tau)).length / gate.length,
  derivationFires: derivation.filter((/** @type {any} */ m) => fires(m, tau)).length,
  devEmptied: dev.filter((/** @type {any} */ m) => fires(m, tau)).map((/** @type {any} */ m) => m.id),
}));

const out = {
  schema: 'vnm-3g1-cosines/1',
  corpus: { bundle: 'pinned', dataVersion: entry.dataVersion, count: bundle.codes.length },
  gibberish: { version: gibberish.version, seed: gibberish.split.seed },
  rule: 'top-1 exact cosine of the canonical q as typed, with the query\'s filters; candidates: derivation half, nearest-rank p90 and p95 and max, + 1e-6, distinct',
  candidates,
  predicted,
  derivation, gate, dev,
};
const sorted = (/** @type {any[]} */ xs) => xs.map((m) => m.top).sort((a, b) => a - b).map((x) => x.toFixed(3)).join(' ');
console.log(`derivation (${derivation.length}): ${sorted(derivation)}`);
console.log(`gate (${gate.length}): ${sorted(gate)}`);
console.log(`dev untagged (${dev.length}), noSignal ${dev.filter((/** @type {any} */ m) => m.noSignal).length}: lowest ${sorted(dev).split(' ').slice(0, 8).join(' ')}`);
console.log(`noSignal: derivation ${derivation.filter((/** @type {any} */ m) => m.noSignal).length}/${derivation.length}, gate ${gate.filter((/** @type {any} */ m) => m.noSignal).length}/${gate.length}`);
for (const p of predicted) console.log(`τ ${p.tau.toFixed(6)}: gate ${p.gateFires}/${gate.length}, derivation ${p.derivationFires}/${derivation.length}, dev emptied [${p.devEmptied.join(' ')}]`);
if (process.argv.includes('--write')) writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
