// Record of how eval/v2 queries were assembled (run once by the holdout custodian on 2026-11-04).
// Inputs: persona outputs (custodian-held, they include holdout queries), the pinned corpus and the NG list.
// Usage: TH=0.35 node eval/v2/build-queries.mjs <repo>. Outputs dev + holdout files; holdout is encrypted before commit.
// Assemble the v2 query pool: persona queries + mechanical code/typo queries; ids; split.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const SEED = 'vnm-2026-11-04';
let ctr = 0; const rnd = () => createHash('sha256').update(`${SEED}:${ctr++}`).digest().readUInt32BE(0) / 2 ** 32;
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const repo = process.argv[2];
const ng = JSON.parse(readFileSync(`${repo}/data/ng-courses-2026-2027.json`, 'utf8'));
const info = JSON.parse(readFileSync(`${repo}/.data/2026-2027-moduleInfo.json`, 'utf8'));
const offered = new Set(info.filter((r) => (r.semesterData ?? []).length).map((r) => r.moduleCode));
const ngSem = new Map();
for (const [s, codes] of Object.entries(ng.semesters)) for (const c of codes) { if (!ngSem.has(c)) ngSem.set(c, []); ngSem.get(c).push(Number(s)); }
const level = (c) => Number(c.match(/\d/)[0]);

// persona queries
const persona = [];
for (const p of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
  for (const q of JSON.parse(readFileSync(`/tmp/vnm-2b/out-${p}.json`, 'utf8'))) persona.push({ persona: p, ...q, origin: 'persona' });
}

// codes: distinct NG codes, offered, undergrad level 1-4
const pool = shuffle([...ngSem.keys()].filter((c) => offered.has(c) && level(c) <= 4 && /^[A-Z]{2,4}\d{4}[A-Z]?$/.test(c)));
const picks = pool.slice(0, 11);
const codeQs = [];
picks.slice(0, 6).forEach((c) => codeQs.push({ text: c, code: c, form: 'exact' }));
picks.slice(6, 11).forEach((c) => { const m = c.match(/^([A-Z]+)(\d.*)$/); codeQs.push({ text: `${m[1].toLowerCase()} ${m[2].toLowerCase()}`, code: c, form: 'space' }); });
// partial prefixes: 2 from code families, 2 GE pillars
const fam = shuffle(pool.slice(11, 60)).slice(0, 2).map((c) => c.match(/^[A-Z]+\d\d/)[0]);
const ge = shuffle(['GEA', 'GEC', 'GEN', 'GESS', 'GEX', 'GEI']).slice(0, 2);
[...fam, ...ge].forEach((p) => codeQs.push({ text: p, prefix: p, form: 'partial' }));
// non-existent
let fake = []; while (fake.length < 3) { const c = `${shuffle(['CS', 'MA', 'EC', 'BT', 'LSM', 'PH'])[0]}${1000 + Math.floor(rnd() * 3999)}`; if (!offered.has(c) && !info.some((r) => r.moduleCode === c)) fake.push(c); }
fake.forEach((c, i) => codeQs.push({ text: i === 1 ? c.toLowerCase() : c, code: c, form: 'nonexistent' }));
const codeRecords = codeQs.map((q) => {
  const sems = q.code ? ngSem.get(q.code) : null;
  const filters = { ng: true, ...(sems?.length === 1 ? { sem: sems[0] } : {}) };
  const narr = q.form === 'nonexistent'
    ? { relevant: `Nothing: ${q.code} is not an NUS course this year; the tool should say so rather than show unrelated courses.`, partial: 'none', notRelevant: 'any course' }
    : q.form === 'partial'
      ? { relevant: `Courses whose code starts with ${q.prefix}, open to exchange students.`, partial: `Courses with a similar code family or subject.`, notRelevant: 'Courses unrelated to that code prefix.' }
      : { relevant: `The course ${q.code} itself.`, partial: `Variants or cross-listings of ${q.code} (same base code with a letter suffix).`, notRelevant: `Any other course.` };
  return { persona: 'mech', shapes: q.form === 'nonexistent' ? ['code', 'noanswer'] : (q.prefix?.startsWith('GE') ? ['code', 'ge'] : ['code']), text: q.text, filters, narrative: narr, origin: 'code', codeForm: q.form, target: q.code ?? q.prefix };
});

// typos: noise model on 15 seeded short persona queries
const kb = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const near = (ch) => { for (let r = 0; r < 3; r++) { const i = kb[r].indexOf(ch); if (i >= 0) { const opts = [kb[r][i - 1], kb[r][i + 1], kb[r - 1]?.[i], kb[r + 1]?.[i]].filter(Boolean); return opts[Math.floor(rnd() * opts.length)]; } } return ch; };
const edit = (w) => {
  const k = Math.floor(rnd() * 4), i = 1 + Math.floor(rnd() * (w.length - 2));
  if (k === 0) return w.slice(0, i) + near(w[i]) + w.slice(i + 1);         // adjacent key
  if (k === 1) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);     // transposition
  if (k === 2) return w.slice(0, i) + w.slice(i + 1);                       // deletion
  return w.slice(0, i) + w[i] + w.slice(i);                                 // doubling
};
const typoSrc = shuffle(persona.map((q, i) => ({ q, i })).filter(({ q }) => q.text.length <= 60 && q.shapes.some((s) => ['topical', 'abbreviation', 'level', 'language', 'sea'].includes(s)))).slice(0, 15);
const typoRecords = typoSrc.map(({ q, i }) => {
  const words = q.text.split(' ');
  const cands = words.map((w, j) => ({ w, j })).filter(({ w }) => /^[a-z]{4,}$/i.test(w));
  const nEdits = Math.min(cands.length, rnd() < 0.5 ? 1 : 2);
  for (const { j } of shuffle(cands).slice(0, nEdits)) words[j] = edit(words[j]);
  return { persona: q.persona, shapes: ['typo'], text: words.join(' '), filters: q.filters, narrative: q.narrative, origin: 'typo', sourceIndex: i };
});

const all = [...persona, ...codeRecords, ...typoRecords].map((q, n) => ({ ...q, _n: n }));
// provenance groups: typo joins its source
const group = all.map((q) => (q.origin === 'typo' ? q.sourceIndex : q._n));

// TF-IDF on text + narrative.relevant, average-linkage agglomerative within threshold
const tok = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((t) => t.length > 2);
const docs = all.map((q) => tok(`${q.text} ${q.narrative?.relevant ?? ''}`));
const df = new Map(); docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1)));
const vec = docs.map((d) => { const m = new Map(); d.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)); let n = 0; for (const [t, c] of m) { const w = c * Math.log(all.length / df.get(t)); m.set(t, w); n += w * w; } n = Math.sqrt(n) || 1; for (const [t, w] of m) m.set(t, w / n); return m; });
const cos = (a, b) => { let s = 0; for (const [t, w] of a) s += w * (b.get(t) ?? 0); return s; };
// union-find over provenance first
const parent = all.map((_, i) => i); const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i]))); const union = (a, b) => { parent[find(a)] = find(b); };
all.forEach((q, i) => union(i, group[i]));
const TH = Number(process.env.TH ?? 0.30);
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (cos(vec[i], vec[j]) >= TH) union(i, j);
const clusters = new Map(); all.forEach((q, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(i); });
// stratify: sort clusters by dominant shape, alternate assignment to hit 55/45
const dom = (ids) => all[ids[0]].shapes[0];
const byShape = new Map(); for (const ids of clusters.values()) { const s = dom(ids); if (!byShape.has(s)) byShape.set(s, []); byShape.get(s).push(ids); }
const split = new Array(all.length);
let dev = 0, hold = 0;
for (const [, cl] of [...byShape].sort()) for (const ids of shuffle(cl).sort((a, b) => b.length - a.length)) {
  const target = (dev + ids.length) / (dev + hold + ids.length) <= 0.55 ? 'dev' : (hold + ids.length) / (dev + hold + ids.length) <= 0.45 ? 'holdout' : (rnd() < 0.55 ? 'dev' : 'holdout');
  ids.forEach((i) => (split[i] = target)); if (target === 'dev') dev += ids.length; else hold += ids.length;
}
// ids
const out = { dev: [], holdout: [] }; let d = 0, h = 0;
all.forEach((q, i) => {
  const s = split[i]; const id = s === 'dev' ? `d-${String(++d).padStart(3, '0')}` : `h-${String(++h).padStart(3, '0')}`;
  q.id = id;
});
all.forEach((q, i) => { const { _n: _drop, sourceIndex, ...rest } = q; void _drop; if (q.origin === 'typo') rest.source = all[sourceIndex].id; out[split[i]].push(rest); });
const meta = { version: 'v2', seed: SEED, created: '2026-11-04', clusterMethod: `tfidf(text+narrative.relevant) single-link union at cos>=${TH} (lowest of 0.30..0.50 step 0.05 giving every shape >=2 per split), provenance-first`, clusters: clusters.size, largestCluster: Math.max(...[...clusters.values()].map((c) => c.length)) };
writeFileSync('/tmp/vnm-2b/queries.dev.v2.json', JSON.stringify({ ...meta, set: 'dev', queries: out.dev }, null, 1));
writeFileSync('/tmp/vnm-2b/queries.holdout.v2.json', JSON.stringify({ ...meta, set: 'holdout', queries: out.holdout }, null, 1));
const cnt = (arr) => { const m = {}; arr.forEach((q) => q.shapes.forEach((s) => (m[s] = (m[s] ?? 0) + 1))); return m; };
console.log(JSON.stringify({ ...meta, dev: out.dev.length, holdout: out.holdout.length, devShapes: cnt(out.dev), holdShapes: cnt(out.holdout) }, null, 1));
console.log('codes:', codeRecords.map((q) => `${q.text}(${q.codeForm})`).join(', '));
console.log('typos:', typoRecords.slice(0, 6).map((q) => q.text).join(' | '));
