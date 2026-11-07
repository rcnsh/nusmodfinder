// Builds the 519-row verified sheet (chunk 6 blank) and the worst-case sheet
// (chunk 6 graded against the candidate: 0 if only in 3a2-v1's top-10, 2 if only in shipped's).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO = process.argv[2];
const { parseCsv } = await import(join(REPO, 'eval/lib/judging.mjs'));
const rd = (f) => parseCsv(readFileSync(f, 'utf8'));
const q = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const csv = (rows) => rows.map((r) => r.map((x) => q(String(x ?? ''))).join(',')).join('\n') + '\n';
const [hdr, ...interim] = rd('../verified-interim.csv');
const six = [...rd('../pairs-6a.csv').slice(1), ...rd('../pairs-6b.csv').slice(1)];
const gi = hdr.indexOf('your_grade'), qi = hdr.indexOf('query_id'), ci = hdr.indexOf('code'), ni = hdr.indexOf('your_note');
const run = (v) => JSON.parse(readFileSync(join(REPO, 'eval/runs', `${v}.json`), 'utf8'));
const base = run('shipped'), cand = run('3a2-v1');
const top = (r, id) => new Set((r.results[id]?.codes ?? []).slice(0, 10));
let toCand = 0, toBase = 0;
const worst = six.map((r) => {
  const inC = top(cand, r[qi]).has(r[ci]), inB = top(base, r[qi]).has(r[ci]);
  if (inC === inB) throw new Error(`pair ${r[qi]} ${r[ci]} is not in the symmetric difference`);
  const o = [...r]; o[gi] = inC ? 0 : 2; o[ni] = 'worst case (not graded)'; inC ? toCand++ : toBase++; return o;
});
const blank = six.map((r) => { const o = [...r]; o[gi] = ''; o[ni] = ''; return o; });
const all = [...interim, ...blank];
if (all.length !== 519 || new Set(all.map((r) => r[0])).size !== 519) throw new Error('expected 519 distinct pairs');
const ungraded = interim.filter((r) => !/^[012]$/.test(r[gi])).length;
if (ungraded) throw new Error(`${ungraded} interim rows lack a grade`);
writeFileSync('3a2-xfam-verified.csv', csv([hdr, ...all]));
writeFileSync('3a2-xfam-worstcase.csv', csv([hdr, ...interim, ...worst]));
console.log(`interim ${interim.length}, chunk 6 ${six.length} (${toCand} only in 3a2-v1 top-10 -> 0, ${toBase} only in shipped top-10 -> 2)`);
