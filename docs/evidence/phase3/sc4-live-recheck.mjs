#!/usr/bin/env node
// The two re-checks of SC4's live confirmation (sc4-live.txt, L05b and L09b), run once on
// 2026-11-07 18:54 UTC as the last 2 of the 20 calls, after L05 and L09 failed for reasons in
// the checks themselves:
// - L05 checked 3F variants against the prefix; the suite's partial-mask rule checks results
//   (a variant may be a cross-listing outside the range).
// - L09 used a bare pillar code inside a longer query (`gec course …`), which by design is not
//   a GE route; the suite's GE-in-a-longer-query items use a generic phrase. L09b therefore
//   uses a new text, chosen after L09 failed.
const BASE = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const get = async (q, x = '') => { const r = await fetch(`${BASE}/search?q=${encodeURIComponent(q)}${x}`); return { s: r.status, b: await r.json(), colo: (r.headers.get('cf-ray') ?? '').split('-').pop() }; };
const PILLARS = ['GEA', 'GEC', 'GEH', 'GEI', 'GEN', 'GEQ', 'GES', 'GESS', 'GET', 'GEX'];
const a = await get('MA21', '&topK=50');
const res = a.b.results.map((r) => r.code);
console.log(`${res.every((c) => c.startsWith('MA21')) ? 'PASS' : 'FAIL'}\tL05b partial code (results only, as the suite's partial-mask rule)\t"MA21&topK=50"\t${a.b.count} results, all MA21: ${res.every((c) => c.startsWith('MA21'))}; variants outside MA21: ${a.b.results.flatMap((r) => (r.variants ?? []).map((v) => v.code)).filter((c) => !c.startsWith('MA21')).join(',') || 'none'}\t${a.colo}`);
const g = await get('general education module on climate change');
const gc = g.b.results.map((r) => r.code);
const ok = g.b.count >= 10 && gc.every((c) => PILLARS.some((p) => c.startsWith(p)));
console.log(`${ok ? 'PASS' : 'FAIL'}\tL09b GE in a longer query (generic phrase, as the suite's ge-mask items)\t"general education module on climate change"\t${g.b.count} results, all pillar members: ${gc.every((c) => PILLARS.some((p) => c.startsWith(p)))}; interpreted.ge ${g.b.interpreted.ge ? 'all pillars' : 'null'}\t${g.colo}`);
