// Seeded assignment of shape quotas to personas, with affinity weights.
import { createHash } from 'node:crypto';
const seed = process.argv[2] ?? 'vnm-2026-11-04';
let ctr = 0; const rnd = () => { const h = createHash('sha256').update(`${seed}:${ctr++}`).digest(); return h.readUInt32BE(0) / 2 ** 32; };
const P = ['P1','P2','P3','P4','P5','P6'];
const shapes = { topical:45, mapping:20, alternatives:10, language:8, sea:8, equivalence:8, abbreviation:12, ge:6, level:12, constraint:10, noanswer:8 };
const aff = { // persona affinity (default 1)
  language: { P3:3, P5:3, P1:1, P2:1, P4:1.5, P6:0.5 }, sea: { P4:4, P1:1, P3:0.5, P5:0.5, P2:0.5, P6:0.5 },
  alternatives: { P6:4, P2:2 }, equivalence: { P2:2, P5:2, P1:1.5 }, abbreviation: { P2:2, P6:2, P3:1.5 },
  constraint: { P4:2, P6:2, P1:1.5 }, ge: { P4:1.5, P6:1.5 },
};
const counts = Object.fromEntries(P.map((p) => [p, {}]));
const load = Object.fromEntries(P.map((p) => [p, 0]));
for (const [s, n] of Object.entries(shapes)) for (let i = 0; i < n; i++) {
  // weight = affinity / (1 + load) to balance totals
  const w = P.map((p) => (aff[s]?.[p] ?? 1) / (1 + load[p] / 10));
  let r = rnd() * w.reduce((a, b) => a + b, 0), k = 0;
  while (r > w[k]) r -= w[k++];
  const p = P[Math.min(k, 5)]; counts[p][s] = (counts[p][s] ?? 0) + 1; load[p]++;
}
console.log(JSON.stringify({ seed, counts, load }, null, 1));
