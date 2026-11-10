import { readFileSync } from 'node:fs';
const A = JSON.parse(readFileSync(new URL('../transcription-a.json', import.meta.url), 'utf8')).rules;
const B = JSON.parse(readFileSync(new URL('../transcription-b.json', import.meta.url), 'utf8')).rules;
const lv = (r) => (r.scope?.levels ?? []).join('/') || '-';
// facts: (code|pattern|school, kind, students, levels)
const facts = (rs) => {
  const m = new Map();
  for (const r of rs) {
    const items = [
      ...(r.scope?.codes ?? []).map((c) => `code:${c.code}`),
      ...(r.scope?.patterns ?? []).map((p) => `pat:${p.toLowerCase().replace(/\s+/g, ' ')}`),
      ...(r.scope?.school ? [`school:${r.scope.school}`] : []),
    ];
    if (!items.length) items.push(`dept:${r.department ?? r.section}`);
    for (const it of items) {
      const k = `${it} | ${r.kind} | ${r.students} | L${lv(r)}`;
      m.set(k, [...(m.get(k) ?? []), `${r.id}@p${r.page}`]);
    }
  }
  return m;
};
const fa = facts(A), fb = facts(B);
const onlyA = [...fa.keys()].filter((k) => !fb.has(k)), onlyB = [...fb.keys()].filter((k) => !fa.has(k));
console.log(`facts A ${fa.size}, B ${fb.size}, shared ${[...fa.keys()].filter((k) => fb.has(k)).length}`);
console.log(`\n== only A (${onlyA.length})`); for (const k of onlyA) console.log(k, fa.get(k).join(','));
console.log(`\n== only B (${onlyB.length})`); for (const k of onlyB) console.log(k, fb.get(k).join(','));
// title disagreements on the same code
const titles = (rs) => { const m = new Map(); for (const r of rs) for (const c of r.scope?.codes ?? []) m.set(`${c.code}`, [...(m.get(c.code) ?? []), c.title]); return m; };
const ta = titles(A), tb = titles(B);
const norm = (t) => (t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
console.log('\n== title differences');
for (const [c, t] of ta) { const u = tb.get(c); if (u && norm([...new Set(t)].sort().join('|')) !== norm([...new Set(u)].sort().join('|'))) console.log(c, JSON.stringify(t), 'vs', JSON.stringify(u)); }
