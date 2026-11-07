// 3F identity on dev (plan 3F gate): every candidate list starts with the
// group-first projection of the shipped list. Usage:
//   node docs/evidence/phase3/3f-identity.mjs eval/runs/shipped-89cb10e.json eval/runs/3f.json .eval-work/ws-dev-3f/data/groups.json
import { readFileSync } from 'node:fs';
import { parseGroupsFile, groupKeyOf } from '../../../src/groups.js';
const [base, cand, groupsPath] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const gf = read(groupsPath); const groupOf = parseGroupsFile(gf);
const B = read(base).results, C = read(cand).results;
let n = 0, same = 0, changed = 0; const bad = [];
for (const id of Object.keys(B)) {
  const b = B[id], c = C[id];
  if (b.status !== 200 || c.status !== 200) { if (b.status !== c.status) bad.push([id, 'status', b.status, c.status]); continue; }
  n++;
  const seen = new Set(); const want = b.codes.filter((x) => { const k = groupKeyOf(groupOf, x); return seen.has(k) ? false : (seen.add(k), true); });
  const got = c.codes.slice(0, want.length);
  if (JSON.stringify(got) !== JSON.stringify(want)) bad.push([id, want.join(' '), '|', c.codes.join(' ')]);
  else if (want.length !== b.codes.length) changed++; else same++;
  if (c.codes.length < Math.min(20, b.codes.length)) bad.push([id, 'short', c.codes.length, b.codes.length]);
}
console.log({ groups: gf.version, corpus: gf.corpus, n, identical: same, collapsed: changed, failures: bad.length });
for (const x of bad) console.log(x.join(' '));
