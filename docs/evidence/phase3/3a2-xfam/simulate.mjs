// Chunk 6 graded by resampling: each pair's grade is drawn from the observed
// P(verified grade | A's grade) on the 435 verified pairs. Reports P(Δ ≤ 0). Seed 20261107.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO = process.argv[2], N = Number(process.argv[3] ?? 4000);
const J = await import(join(REPO, 'eval/lib/judging.mjs'));
const G = await import(join(REPO, 'eval/lib/groups.mjs'));
const S = await import(join(REPO, 'eval/lib/sets.mjs'));
const { queries } = await S.loadQueries(S.layout('dev'));
const qrels = JSON.parse(readFileSync(join(REPO, 'eval/dev/qrels.json'), 'utf8'));
const scored = G.withCorpusGroups(qrels, await G.loadGroups());
const A = J.qrelsUnder(qrels, 'A').queries;
const run = (v) => JSON.parse(readFileSync(join(REPO, 'eval/runs', `${v}.json`), 'utf8'));
const base = run('shipped'), cand = run('3a2-v1');
const { graded } = J.readCalibration(readFileSync('3a2-xfam-verified.csv', 'utf8'));
const conf = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (const g of graded) conf[A[g.queryId].judgments[g.code]][g.grade]++;
console.log('observed A grade (row) → verified grade (col):', JSON.stringify(conf));
const subset = new Map(graded.map((g) => [`${g.queryId}\t${g.code}`, g.grade]));
const six = [...J.parseCsv(readFileSync('../pairs-6a.csv', 'utf8')).slice(1), ...J.parseCsv(readFileSync('../pairs-6b.csv', 'utf8')).slice(1)].map((r) => ({ key: `${r[1]}\t${r[7]}`, a: A[r[1]].judgments[r[7]] }));
let s = 20261107; const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const draw = (a) => { const row = conf[a], t = row[0] + row[1] + row[2]; let u = rnd() * t; for (let g = 0; g < 3; g++) { if ((u -= row[g]) < 0) return g; } return 2; };
const ds = [];
for (let i = 0; i < N; i++) {
  for (const p of six) subset.set(p.key, draw(p.a));
  ds.push(J.ndcgDelta(base, cand, queries, J.qrelsUnder(scored, 'human', subset)).delta);
}
ds.sort((x, y) => x - y);
const q = (p) => ds[Math.floor(p * (N - 1))];
console.log(`${N} draws: P(Δ ≤ 0) = ${(ds.filter((d) => d <= 0).length / N).toFixed(4)}; median ${q(0.5).toFixed(3)}; 2.5% ${q(0.025).toFixed(3)}; 0.5% ${q(0.005).toFixed(3)}; min ${ds[0].toFixed(3)}`);
