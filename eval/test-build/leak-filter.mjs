#!/usr/bin/env node
// @ts-check
// The sealed test set's leak filter (ADR 0003 "Test set, pre-registered now";
// "SC4 custody and the test-set exclusions"). A test query is dropped when its
// query-text embedding has cosine >= 0.9 to any dev, holdout, SC4 suite or
// gibberish-set text, or when it shares a source query with one of them
// (typo variants carry `source`; every test source is a test query, so no
// test query shares a source with another set). Custodian only. Prints counts
// and the dropped test ids, never a text.
//
// Within the test set too (lead's addition, 2026-11-08): the six writers work
// from the same persona cards in every round, so a later query with cosine
// >= 0.9 to an earlier test query is dropped as a duplicate (the earlier one
// stays). Duplicates would enter the paired comparison twice.
//
//   node eval/test-build/leak-filter.mjs [--threshold 0.9] [--split <custody dir>]
//     --split writes queries.filtered.json (the SC5 set) and queries.dropped.json there.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { embeddingKey, MODEL } from '../lib/embeddings.mjs';
import { layout, loadQueries, readSetJson, REPO, setFile } from '../lib/sets.mjs';

const { values: a } = parseArgs({ options: { threshold: { type: 'string', default: '0.9' }, split: { type: 'string' } } });
const TH = Number(a.threshold);

/** @param {string} b64 */
const vec = (b64) => { const buf = Buffer.from(b64, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
/** @param {Float32Array} x @param {Float32Array} y */
const cos = (x, y) => { let s = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { s += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; } return s / Math.sqrt(nx * ny); };

/** @param {{ entries: Record<string, string> }} file @param {string[]} texts @param {string} what */
function vectorsOf(file, texts, what) {
  const out = [];
  let missing = 0;
  for (const t of texts) {
    const v = file.entries[embeddingKey(MODEL, t)];
    if (v) out.push(vec(v)); else missing++;
  }
  if (missing) throw new Error(`${what}: ${missing} text(s) have no committed embedding`);
  return out;
}

const read = (/** @type {string} */ p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));
const test = layout('test');
const holdout = layout('holdout');
const testQs = (await loadQueries(test)).queries;
const testEmb = await readSetJson(test, setFile(test, 'embeddings.json'));
const devQs = (await loadQueries(layout('dev'))).queries;
const holdQs = (await loadQueries(holdout)).queries;
const holdEmb = await readSetJson(holdout, setFile(holdout, 'embeddings.json'));
const devEmb = read('eval/dev/embeddings.json');
const sc4 = read('test/sc4/queries.json');
const sc4Emb = read('test/sc4/embeddings.json');
const gib = read('eval/dev/gibberish.json');

/** Exclusion sets: their texts and where their vectors live. */
const sources = [
  { name: 'dev', vectors: vectorsOf(devEmb, devQs.map((q) => q.text), 'dev') },
  { name: 'holdout', vectors: vectorsOf(holdEmb, holdQs.map((q) => q.text), 'holdout') },
  { name: 'sc4', vectors: vectorsOf({ entries: { ...devEmb.entries, ...sc4Emb.entries } }, sc4.items.map((/** @type {any} */ i) => i.text), 'sc4') },
  { name: 'gibberish', vectors: vectorsOf({ entries: { ...devEmb.entries, ...sc4Emb.entries } }, gib.strings.map((/** @type {any} */ g) => g.text), 'gibberish') },
];
const testVecs = vectorsOf(testEmb, testQs.map((q) => q.text), 'test');

/** @type {{ id: string, set: string, cos: number }[]} */
const drops = [];
/** @type {Record<string, number>} */
const maxBySet = {};
testQs.forEach((q, i) => {
  for (const s of sources) {
    let m = -1;
    for (const v of s.vectors) m = Math.max(m, cos(testVecs[i], v));
    maxBySet[s.name] = Math.max(maxBySet[s.name] ?? -1, m);
    if (m >= TH) { drops.push({ id: q.id, set: s.name, cos: Math.round(m * 1000) / 1000 }); break; }
  }
});
// Within the test set: a later near-duplicate of an earlier kept test query.
const droppedIds = new Set(drops.map((d) => d.id));
testQs.forEach((q, i) => {
  if (droppedIds.has(q.id)) return;
  for (let j = 0; j < i; j++) {
    if (droppedIds.has(testQs[j].id)) continue;
    const c = cos(testVecs[i], testVecs[j]);
    if (c >= TH) { drops.push({ id: q.id, set: 'test', cos: Math.round(c * 1000) / 1000 }); droppedIds.add(q.id); return; }
  }
});
// A typo variant whose source is dropped goes with it (a shared source).
for (const q of testQs) if (/** @type {any} */ (q).source && droppedIds.has(/** @type {any} */ (q).source) && !droppedIds.has(q.id)) { drops.push({ id: q.id, set: 'source', cos: NaN }); droppedIds.add(q.id); }
console.log(JSON.stringify({
  threshold: TH, test: testQs.length, compared: Object.fromEntries(sources.map((s) => [s.name, s.vectors.length])),
  maxCosine: Object.fromEntries(Object.entries(maxBySet).map(([k, v]) => [k, Math.round(v * 1000) / 1000])), dropped: drops,
}));
if (a.split) {
  const file = await readSetJson(test, setFile(test, 'queries.json'));
  const keep = file.queries.filter((/** @type {any} */ q) => !droppedIds.has(q.id));
  const drop = file.queries.filter((/** @type {any} */ q) => droppedIds.has(q.id));
  const leak = { threshold: TH, dropped: drops.length, bySet: drops.reduce((m, d) => ({ ...m, [d.set]: (m[d.set] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({})) };
  writeFileSync(join(a.split, 'queries.filtered.json'), JSON.stringify({ ...file, leakFilter: leak, queries: keep }, null, 1), { mode: 0o600 });
  writeFileSync(join(a.split, 'queries.dropped.json'), JSON.stringify({ ...file, leakFilter: leak, unfiltered: 'the leak filter\'s drops, for the secondary unfiltered report', queries: drop }, null, 1), { mode: 0o600 });
  console.log(JSON.stringify({ kept: keep.length, ...leak }));
}
