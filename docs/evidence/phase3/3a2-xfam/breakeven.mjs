// How many chunk-6 grades must go against 3a2-v1 (vs judge A's grade) before the
// verified-grade Δ nDCG@10 on the symmetric difference turns ≤ 0. Greedy, re-scored each step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO = process.argv[2];
const J = await import(join(REPO, 'eval/lib/judging.mjs'));
const G = await import(join(REPO, 'eval/lib/groups.mjs'));
const S = await import(join(REPO, 'eval/lib/sets.mjs'));
const { queries } = await S.loadQueries(S.layout('dev'));
const qrels = JSON.parse(readFileSync(join(REPO, 'eval/dev/qrels.json'), 'utf8'));
const scored = G.withCorpusGroups(qrels, await G.loadGroups());
const run = (v) => JSON.parse(readFileSync(join(REPO, 'eval/runs', `${v}.json`), 'utf8'));
const base = run('shipped'), cand = run('3a2-v1');
const { graded } = J.readCalibration(readFileSync('3a2-xfam-verified.csv', 'utf8'));
const subset = new Map(graded.map((g) => [`${g.queryId}\t${g.code}`, g.grade]));
const six = [...J.parseCsv(readFileSync('../pairs-6a.csv', 'utf8')).slice(1), ...J.parseCsv(readFileSync('../pairs-6b.csv', 'utf8')).slice(1)];
const top = (r, id) => new Set((r.results[id]?.codes ?? []).slice(0, 10));
const pairs = six.map((r) => {
  const [qid, code] = [r[1], r[7]];
  const a = J.qrelsUnder(qrels, 'A').queries[qid].judgments[code];
  const adv = top(cand, qid).has(code) ? 0 : 2;
  return { key: `${qid}\t${code}`, a, adv };
});
for (const p of pairs) subset.set(p.key, p.a);
const delta = () => J.ndcgDelta(base, cand, queries, J.qrelsUnder(scored, 'human', subset)).delta;
console.log(`519 pairs, chunk 6 at judge A's grades: Δ ${delta().toFixed(3)}`);
const open = pairs.filter((p) => p.a !== p.adv);
console.log(`chunk 6 pairs where A's grade is not already the worst case: ${open.length}`);
let k = 0, d = delta();
while (d > 0 && open.length) {
  let best = -1, bestD = Infinity;
  open.forEach((p, i) => { subset.set(p.key, p.adv); const x = delta(); subset.set(p.key, p.a); if (x < bestD) { bestD = x; best = i; } });
  const [p] = open.splice(best, 1); subset.set(p.key, p.adv); d = bestD; k++;
  if (k <= 3 || d <= 0 || k % 5 === 0) console.log(`  ${k} against: Δ ${d.toFixed(3)}`);
}
console.log(d > 0 ? 'sign never turns' : `sign turns after ${k} of 84 chunk-6 grades go against 3a2-v1 (${(100 * k / 84).toFixed(0)}% disagreement with A on chunk 6; observed on 435 pairs: 6.4%)`);
