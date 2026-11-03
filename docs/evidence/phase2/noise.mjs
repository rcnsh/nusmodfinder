// @ts-check
// Phase 2c item 3: what Workers AI embedding nondeterminism does to eval-v0's
// retrieval on the dev set. No Cloudflare call: it reuses the dev query cache,
// the corpus release asset, the 21 fixture texts embedded twice (batch of 31
// vs the corpus pass's batches of 100) and the one 20-text re-embedding
// (reembed.mjs).
//
// Conditions (each compared with the unperturbed run, same params):
// - real:   the 20 re-embedded query vectors (real query-side noise);
// - qXXXX:  every query vector moved to cosine XXXX of itself along a real
//           query-noise direction (orthogonalised re-embed deltas), 5 draws;
//           0.9996 = same text in two calls, 0.9957 / 0.9797 = batch-effect
//           median / minimum (eval/README.md);
// - corpus: every corpus vector moved along a real corpus-noise direction
//           (fixture deltas) to a cosine drawn from the 21 measured pairs,
//           3 draws (separate seeds), with base and re-embedded queries.
//
//   node docs/evidence/phase2/noise.mjs      -> docs/evidence/phase2/noise.json
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cachePart, base64ToF32, embeddingKey, readCache, DIMS, MODEL } from '../../../eval/lib/embeddings.mjs';
import { REPO } from '../../../eval/lib/sets.mjs';
import { rng } from '../../../eval/lib/stats.mjs';
import { FIDELITY } from './ids.mjs';
import { loadVectors, runProbe, searchPath } from './probe.mjs';
import { overlap, rbo } from './rank.mjs';

const DRAWS = 5;
const CORPUS_DRAWS = 3;
const LEVELS = [0.9996, 0.9957, 0.9797];

/** @param {Float32Array} a @param {Float32Array} b */
const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };
/** @param {Float32Array} a @param {Float32Array} b */
export const cosine = (a, b) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));

/**
 * v moved to cosine `c` of itself along direction d (orthogonalised against v), same norm.
 * @param {Float32Array} v @param {Float32Array} d @param {number} c
 */
function perturb(v, d, c) {
  const nv = Math.sqrt(dot(v, v));
  const vh = v.map((x) => x / nv);
  const p = dot(d, vh);
  const u = d.map((x, i) => x - p * vh[i]);
  const nu = Math.sqrt(dot(u, u));
  if (nu === 0 || c >= 1) return Float32Array.from(v);
  const t = Math.sqrt(1 / (c * c) - 1);
  const w = vh.map((x, i) => x + (t * u[i]) / nu);
  const nw = Math.sqrt(dot(w, w));
  return w.map((x) => (x / nw) * nv);
}

/** @param {Float32Array} all @param {number} i */
const row = (all, i) => all.subarray(i * DIMS, (i + 1) * DIMS);

const queries = JSON.parse(await readFile(join(REPO, 'eval/dev/queries.json'), 'utf8')).queries;
const valid = queries.filter((/** @type {any} */ q) => q.text.trim().length <= 200);
const byId = new Map(queries.map((/** @type {any} */ q) => [q.id, q]));
const { corpus, dev } = await loadVectors();
const devRow = new Map(dev.keys.map((k, i) => [k, i]));
/** @param {string} text */
const qv = (text) => {
  const i = devRow.get(embeddingKey(MODEL, text));
  if (i === undefined) throw new Error('missing dev vector');
  return row(dev.vectors, i);
};

// Real query-side noise: the one re-embedding request.
const re = JSON.parse(await readFile(join(REPO, 'docs/evidence/phase2/reembed-20.json'), 'utf8'));
/** @type {Map<string, Float32Array>} */
const reVec = new Map(Object.entries(re.vectors).map(([id, b64]) => [id, base64ToF32(/** @type {string} */ (b64))]));
const reCos = Object.fromEntries([...reVec].map(([id, v]) => [id, cosine(v, qv(byId.get(id).text))]));
const qDeltas = [...reVec].map(([id, v]) => { const b = qv(byId.get(id).text); return v.map((x, i) => x - b[i]); }).filter((d) => dot(d, d) > 0);

// Real corpus-side noise: fixture texts embedded in a batch of 31 vs the corpus pass.
const fx = cachePart(await readCache(join(REPO, 'eval/fixtures/embeddings.json'), null, 'fixture'));
const cRow = new Map(corpus.keys.map((k, i) => [k, i]));
/** @type {number[]} */
const fxCos = [];
/** @type {Float32Array[]} */
const cDeltas = [];
fx.keys.forEach((k, i) => {
  const j = cRow.get(k);
  if (j === undefined) return;
  const a = row(fx.vectors, i), b = row(corpus.vectors, j);
  fxCos.push(cosine(a, b));
  const d = a.map((x, n) => x - b[n]);
  if (dot(d, d) > 0) cDeltas.push(d);
});

/** @param {string} text @param {Float32Array} v */
const part1 = (entries) => {
  const keys = entries.map(([t]) => embeddingKey(MODEL, t));
  const vectors = new Float32Array(keys.length * DIMS);
  entries.forEach(([, v], i) => vectors.set(v, i * DIMS));
  return { keys, vectors };
};

// Parameter sets: dev (each query's own filters) and fid (the fidelity check's params).
/** @type {{ set: string, id: string, q: any, unfiltered: boolean }[]} */
const targets = [
  ...valid.map((/** @type {any} */ q) => ({ set: 'dev', id: q.id, q, unfiltered: false })),
  ...FIDELITY.map((f) => ({ set: 'fid', id: f.id, q: byId.get(f.id), unfiltered: !f.filtered })),
];

/** @type {Record<string, { keys: string[], vectors: Float32Array }>} */
const overrides = {};
overrides.real = part1([...reVec].map(([id, v]) => [byId.get(id).text, v]));
const rand = rng(20261104);
/** @type {string[]} */
const synth = [];
for (const c of LEVELS) {
  for (let d = 1; d <= DRAWS; d++) {
    const name = `q${String(c).slice(2)}-${d}`;
    synth.push(name);
    overrides[name] = part1(valid.map((/** @type {any} */ q) => [q.text, perturb(qv(q.text), qDeltas[Math.floor(rand() * qDeltas.length)].map((x) => (rand() < 0.5 ? -x : x)), c)]));
  }
}

/**
 * @param {string} cond
 * @param {(t: typeof targets[number]) => boolean} [only]
 */
const reqs = (cond, only = () => true) => targets.filter(only).map((t) => ({
  id: `${cond}|${t.set}|${t.id}`,
  path: searchPath(t.q, { unfiltered: t.unfiltered, tag: cond }),
  ...(cond === 'base' ? {} : { override: cond }),
}));
const inRe = (/** @type {typeof targets[number]} */ t) => reVec.has(t.id);

/** @type {Map<string, string[]>} */
const top = new Map();
/** @param {Map<string, import('./probe.mjs').ProbeResult>} res @param {string} prefix */
const collect = (res, prefix) => {
  for (const [id, r] of res) top.set(`${prefix}${id}`, (r.body?.results ?? []).map((/** @type {any} */ x) => x.code));
};

console.log(`session S0: base corpus, ${2 + synth.length} query conditions`);
collect(await runProbe({
  name: 'noise-s0',
  overrides,
  requests: [...reqs('base'), ...reqs('real', inRe), ...synth.flatMap((s) => reqs(s))],
}), 'S0:');

for (let s = 1; s <= CORPUS_DRAWS; s++) {
  const r2 = rng(1000 + s);
  const vectors = new Float32Array(corpus.vectors.length);
  for (let i = 0; i < corpus.keys.length; i++) {
    const c = fxCos[Math.floor(r2() * fxCos.length)];
    const d = cDeltas[Math.floor(r2() * cDeltas.length)].map((x) => (r2() < 0.5 ? -x : x));
    vectors.set(perturb(row(corpus.vectors, i), d, c), i * DIMS);
  }
  console.log(`session S${s}: corpus noise draw ${s}`);
  collect(await runProbe({
    name: `noise-s${s}`,
    corpusVectors: { keys: corpus.keys, vectors },
    queryVectors: dev,
    overrides: { real: overrides.real },
    requests: [...reqs('base'), ...reqs('real', inRe)],
  }), `S${s}:`);
}

// Compare every condition with S0 base, same params.
/** @type {Record<string, Record<string, { overlap10: number, rbo10: number, same10: boolean }>>} */
const per = {};
for (const [key, codes] of top) {
  const [sess, rest] = key.split(':');
  const [cond, set, id] = rest.split('|');
  if (sess === 'S0' && cond === 'base') continue;
  const base = /** @type {string[]} */ (top.get(`S0:base|${set}|${id}`));
  const name = sess === 'S0' ? cond : `corpus${sess.slice(1)}${cond === 'base' ? '' : '+real'}`;
  (per[`${set}:${name}`] ??= {})[id] = { overlap10: overlap(base, codes, 10), rbo10: rbo(base, codes, 10), same10: base.slice(0, 10).join() === codes.slice(0, 10).join() };
}
/** @type {Record<string, any>} */
const summary = {};
for (const [k, m] of Object.entries(per)) {
  const v = Object.values(m);
  summary[k] = {
    n: v.length,
    changed10: v.filter((x) => !x.same10).length,
    setChanged10: v.filter((x) => x.overlap10 < 10).length,
    meanOverlap10: v.reduce((s, x) => s + x.overlap10, 0) / v.length,
    minOverlap10: Math.min(...v.map((x) => x.overlap10)),
    minRbo10: Math.min(...v.map((x) => x.rbo10)),
  };
}
const out = {
  schema: 'vnm-phase2-noise/1',
  createdAt: new Date().toISOString(),
  ranker: 'eval-v0',
  realQueryCosines: reCos,
  fixtureCorpusCosines: fxCos.sort((a, b) => a - b),
  summary,
  perQuery: per,
};
await writeFile(join(REPO, 'docs/evidence/phase2/noise.json'), `${JSON.stringify(out, null, 1)}\n`);
for (const [k, s] of Object.entries(summary)) {
  console.log(`${k.padEnd(18)} n=${String(s.n).padStart(2)} top10 changed ${String(s.changed10).padStart(2)} · set changed ${String(s.setChanged10).padStart(2)} · mean overlap@10 ${s.meanOverlap10.toFixed(2)} · min ${s.minOverlap10} · min RBO ${s.minRbo10.toFixed(3)}`);
}
console.log('real re-embed cosines:', Object.values(reCos).map((c) => c.toFixed(5)).sort().join(' '));
