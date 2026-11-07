#!/usr/bin/env node
// @ts-check
// ADR 0004's cross-family check sheet for the SC5 test pool: every non-rule
// pair in the symmetric difference of final's and v0's test top-10s, shuffled
// (seed 20261108), in the calibration CSV format. Custodian only; the sheet is
// plaintext test content and stays outside git.
//
//   node eval/test-build/xfam-export.mjs <out.csv>
import { writeFileSync } from 'node:fs';
import { loadPinnedWith } from '../lib/corpus.mjs';
import { calibrationCsv, poolCandidate } from '../lib/judging.mjs';
import { layout, loadQrels, loadQueries, readSetJson, REPO, runFile } from '../lib/sets.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: xfam-export.mjs <out.csv>');
const set = layout('test');
const { queries } = await loadQueries(set);
const qrels = await loadQrels(set);
const base = await readSetJson(set, runFile(set, 'v0'));
const cand = await readSetJson(set, runFile(set, 'final'));
const corpus = await loadPinnedWith(REPO);
const modules = new Map(corpus.modules.map((m) => [m.code, poolCandidate(m)]));
/** @type {{ queryId: string, code: string }[]} */
const pairs = [];
let rule = 0;
for (const q of queries) {
  const b = new Set((base.results[q.id]?.codes ?? []).slice(0, 10));
  const c = new Set((cand.results[q.id]?.codes ?? []).slice(0, 10));
  for (const code of [...b].filter((x) => !c.has(x)).concat([...c].filter((x) => !b.has(x)))) {
    const j = /** @type {any} */ (qrels.queries[q.id]?.judgments?.[code]);
    if (typeof j === 'object' && j?.source === 'rule') { rule++; continue; }
    pairs.push({ queryId: q.id, code });
  }
}
let s = 20261108; const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
for (let i = pairs.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [pairs[i], pairs[k]] = [pairs[k], pairs[i]]; }
// The sheet carries no judge grade: calibrationCsv reads only queryId and code.
writeFileSync(out, calibrationCsv(/** @type {any} */ (pairs), queries, modules), { mode: 0o600 });
console.log(`${pairs.length} pairs (${rule} rule pairs excluded), ${new Set(pairs.map((p) => p.queryId)).size} queries -> ${out}`);
