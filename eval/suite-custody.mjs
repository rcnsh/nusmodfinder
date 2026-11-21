#!/usr/bin/env node
// @ts-check
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { base64ToF32, embeddingKey, MODEL, queryTextForms, readCache } from './lib/embeddings.mjs';
import { REPO, layout, loadQueries, setFile, setKey } from './lib/sets.mjs';
import { readFileSync } from 'node:fs';

const { values: a } = parseArgs({ options: { custodian: { type: 'boolean', default: false }, against: { type: 'string', default: 'holdout' } } });
if (a.against !== 'holdout' && a.against !== 'dev') {
  console.error('suite-custody: --against is holdout or dev');
  process.exit(1);
}
if (a.against === 'holdout' && !a.custodian) {
  console.error('suite-custody: custodian only; pass --custodian');
  process.exit(1);
}

const json = (/** @type {string} */ p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));
const suite = json('test/query-suite/queries.json').items;
const gibberish = json('eval/dev/gibberish.json').strings;
const suiteCache = json('test/query-suite/embeddings.json').entries;
const devCache = json('eval/dev/embeddings.json').entries;

/** @param {string} text */
const codeTokens = (text) => [...text.matchAll(/\b([a-z]{2,4})\s?(\d{1,4}[a-z]{0,2})\b/gi)].map((m) => `${m[1]}${m[2]}`.toUpperCase());

/** @param {any} item */
function suiteCodes(item) {
  const i = item.interpreted ?? {};
  const p = item.params ?? {};
  const fromParams = [p.code, ...(p.codes ?? []), p.prefix].filter((x) => typeof x === 'string');
  return [...new Set([...codeTokens(item.text), ...(i.pin ?? []), ...(typeof i.prefix === 'string' ? [i.prefix] : []), ...fromParams]
    .map((c) => String(c).toUpperCase())
    .filter((c) => /\d/.test(c)))];
}

const set = layout(/** @type {string} */ (a.against));
const key = a.against === 'holdout' ? await setKey() : null;
const holdout = (await loadQueries(set, { verify: a.against === 'holdout' })).queries;
const hCache = (await readCache(setFile(set, 'embeddings.json'), key, set.name)).entries;
const targets = holdout.map((/** @type {any} */ q) => q.target).filter((t) => typeof t === 'string').map((t) => t.toUpperCase());

/**
 * @param {string} text
 * @param {Record<string, string>[]} caches
 */
function vectors(text, caches) {
  return queryTextForms(text).map((f) => {
    const k = embeddingKey(MODEL, f);
    const b64 = caches.map((c) => c[k]).find(Boolean);
    if (!b64) throw new Error('suite-custody: a text has no embedding; embed the texts in test/query-suite/needs-embedding.txt first');
    return base64ToF32(b64);
  });
}
/** @param {Float32Array} x @param {Float32Array} y */
function cos(x, y) {
  let d = 0;
  let nx = 0;
  let ny = 0;
  for (let k = 0; k < x.length; k++) { d += x[k] * y[k]; nx += x[k] * x[k]; ny += y[k] * y[k]; }
  return d / Math.sqrt(nx * ny);
}
const hVecs = holdout.map((/** @type {any} */ q) => vectors(q.text, [hCache]));

const entries = [
  ...suite.flatMap((/** @type {any} */ it) => [
    { id: it.id, text: it.text, codes: suiteCodes(it) },
    ...['clean', 'reference'].filter((f) => it.params?.[f]).map((f) => ({ id: `${it.id}/${f}`, text: it.params[f], codes: codeTokens(it.params[f]) })),
  ]),
  ...gibberish.map((/** @type {any} */ g) => ({ id: g.id, text: g.text, codes: codeTokens(g.text) })),
];
/** @type {Set<string>} */
const hits = new Set();
for (const e of entries) {
  if (e.codes.some((/** @type {string} */ c) => targets.some((/** @type {string} */ t) => c.startsWith(t) || t.startsWith(c)))) hits.add(e.id);
  const mine = vectors(e.text, [suiteCache, devCache]);
  if (hVecs.some((hv) => hv.some((h) => mine.some((m) => cos(m, h) >= 0.9)))) hits.add(e.id);
}
console.log(`checked ${entries.length} suite, comparison and gibberish texts against the ${a.against} set`);
console.log(`hits: ${hits.size}${hits.size ? ` (${[...hits].join(', ')})` : ''}`);
process.exit(hits.size ? 2 : 0);
