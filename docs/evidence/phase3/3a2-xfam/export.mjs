// The ADR 0004 per-round cross-family check sheet: every non-rule pair in the
// symmetric difference of two dev runs' top-10s, in the calibration CSV format.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO = process.argv[2], baseV = process.argv[3], candV = process.argv[4], out = process.argv[5];
const lib = (p) => import(join(REPO, p));
const { calibrationCsv, poolCandidate } = await lib('eval/lib/judging.mjs');
const { layout, loadQueries } = await lib('eval/lib/sets.mjs');
const { loadPinnedWith } = await lib('eval/lib/corpus.mjs');
const set = layout('dev');
const { queries } = await loadQueries(set);
const qrels = JSON.parse(readFileSync(join(REPO, 'eval/dev/qrels.json'), 'utf8'));
const run = (v) => JSON.parse(readFileSync(join(REPO, 'eval/runs', `${v}.json`), 'utf8'));
const base = run(baseV), cand = run(candV);
const corpus = await loadPinnedWith(REPO);
const modules = new Map(corpus.modules.map((m) => [m.code, poolCandidate(m)]));
const pairs = [];
let rule = 0;
for (const q of queries) {
  const b = new Set((base.results[q.id]?.codes ?? []).slice(0, 10));
  const c = new Set((cand.results[q.id]?.codes ?? []).slice(0, 10));
  for (const code of [...b].filter((x) => !c.has(x)).concat([...c].filter((x) => !b.has(x)))) {
    const j = qrels.queries[q.id]?.judgments?.[code];
    const src = typeof j === 'object' ? j.source : undefined;
    if (src === 'rule') { rule++; continue; }
    pairs.push({ queryId: q.id, code });
  }
}
// Deterministic shuffle so order carries no signal (seed 20261107).
let s = 20261107; const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
for (let i = pairs.length - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [pairs[i], pairs[k]] = [pairs[k], pairs[i]]; }
writeFileSync(out, calibrationCsv(pairs, queries, modules));
console.log(`${pairs.length} pairs (${rule} rule pairs excluded) -> ${out}`);
