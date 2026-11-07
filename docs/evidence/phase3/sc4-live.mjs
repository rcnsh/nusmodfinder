#!/usr/bin/env node
// SC4's live confirmation (docs/plans/phase3.md §4): at most 20 calls on the
// deployed Worker, with fresh texts written at the freeze (not the suite's),
// each checking the rule of an SC4 item type the frozen ranker runs. Code rules
// use only codes offered in both the pinned 2026-09-04 catalogue and the live
// one. Prints one line per check and appends nothing remote beyond the calls.
//
//   node docs/evidence/phase3/sc4-live.mjs [base-url]
const BASE = process.argv[2] ?? 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const T = 5; // the typo overlap threshold fixed at P-6 (test/sc4/queries.json thresholds.T)
const M = 3; // the mixed-query count fixed at P-6
let calls = 0;
/** @type {{ id: string, text: string, pass: boolean, detail: string, colo: string }[]} */
const out = [];
async function search(text, extra = '') {
  if (++calls > 20) throw new Error('call budget (20) exceeded');
  const res = await fetch(`${BASE}/search?q=${encodeURIComponent(text)}${extra}`);
  const body = await res.json();
  return { status: res.status, body, colo: (res.headers.get('cf-ray') ?? '').split('-').pop() };
}
const codes = (b) => (b.results ?? []).map((r) => r.code);
const shown = (b) => (b.results ?? []).flatMap((r) => [r.code, ...(r.variants ?? []).map((v) => v.code)]);
const letters = (c) => /^[A-Z]+/.exec(c)[0];
async function check(id, text, extra, rule) {
  const r = await search(text, extra);
  const [pass, detail] = r.status === 200 ? rule(r.body) : [false, `HTTP ${r.status}`];
  out.push({ id, text: `${text}${extra}`, pass, detail, colo: r.colo });
  return r;
}

await check('L01 space code', 'ec 1101e', '', (b) => [codes(b)[0] === 'EC1101E', `rank 1 ${codes(b)[0]}`]);
await check('L02 space code', 'ma 2001', '', (b) => [codes(b)[0] === 'MA2001', `rank 1 ${codes(b)[0]}`]);
await check('L03 exact code', 'st2334', '', (b) => [codes(b)[0] === 'ST2334' && b.interpreted.level === null, `rank 1 ${codes(b)[0]}, level ${b.interpreted.level}`]);
await check('L04 code join', 'cs2100 or cs2106', '', (b) => [codes(b)[0] === 'CS2100' && codes(b)[1] === 'CS2106', `ranks 1-2 ${codes(b).slice(0, 2)}`]);
await check('L05 partial code', 'MA21', '&topK=50', (b) => [b.count > 0 && shown(b).every((c) => c.startsWith('MA21')), `${b.count} results, all MA21: ${shown(b).every((c) => c.startsWith('MA21'))}`]);
await check('L06 pillar', 'GEN', '&topK=50', (b) => [b.count > 0 && codes(b).every((c) => c.startsWith('GEN')), `${b.count} results, all GEN: ${codes(b).every((c) => c.startsWith('GEN'))}`]);
await check('L07 code in a longer query', 'ma21 linear algebra', '', (b) => {
  const n = codes(b).slice(0, 10).filter((c) => c.startsWith('MA21')).length;
  return [n >= M, `${n} MA21 members in the top 10 (M ${M})`];
});
await check('L08 unknown code in a longer query', 'PHYS 2010 quantum mechanics', '', (b) => [
  b.count > 0 && b.interpreted.pin === null && b.interpreted.prefix === null && b.noMatch === undefined,
  `count ${b.count}, pin ${JSON.stringify(b.interpreted.pin)}, prefix ${JSON.stringify(b.interpreted.prefix)}, noMatch ${JSON.stringify(b.noMatch)}`]);
await check('L09 GE in a longer query', 'gec course about society and ethics', '', (b) => [b.count > 0 && codes(b).every((c) => c.startsWith('GEC')), `${b.count} results, all GEC: ${codes(b).every((c) => c.startsWith('GEC'))}`]);
const clean = await search('macroeconomics intro');
await check('L10 typo', 'macroeconmics intro', '', (b) => {
  const ref = new Set(codes(clean.body).slice(0, 10));
  const overlap = codes(b).slice(0, 10).filter((c) => ref.has(c)).length;
  return [overlap >= T && JSON.stringify(b.interpreted) === JSON.stringify(clean.body.interpreted), `overlap@10 with the clean form ${overlap} (T ${T}); interpreted equal`];
});
await check('L11 gibberish', 'zqxw vbnmpl', '', (b) => [b.count === 0 && b.noMatch?.reason === 'no-signal', `count ${b.count}, noMatch ${JSON.stringify(b.noMatch)}`]);
await check('L12 gibberish', 'flrrbt kwazz qq', '', (b) => [b.count === 0 && b.noMatch?.reason === 'no-signal', `count ${b.count}, noMatch ${JSON.stringify(b.noMatch)}`]);
await check('L13 non-existent code', 'CS9871', '', (b) => [b.count === 0 && b.noMatch?.reason === 'unknown-code', `count ${b.count}, noMatch ${b.noMatch?.reason}`]);
await check('L14 not-offered code', 'ACC4761F', '', (b) => [
  b.count === 0 && b.noMatch?.reason === 'not-offered' && b.noMatch?.title === 'Seminars in Accounting: Advanced Corporate Governance',
  `count ${b.count}, noMatch ${b.noMatch?.reason}, title ${JSON.stringify(b.noMatch?.title)}`]);
await check('L15 guard (collision token)', 'js frameworks for web apps', '', (b) => [b.count > 0 && b.interpreted.prefix === null && b.interpreted.pin === null, `count ${b.count}, prefix ${JSON.stringify(b.interpreted.prefix)}`]);
await check('L16 guard (letter token)', 'law and society in asia', '', (b) => {
  const n = codes(b).slice(0, 10).filter((c) => letters(c) === 'LAW').length;
  return [b.count > 0 && b.interpreted.prefix === null && n <= 2, `count ${b.count}, prefix ${JSON.stringify(b.interpreted.prefix)}, LAW codes in the top 10 ${n}`];
});
await check('L17 guard (collision token)', 'ai for healthcare', '', (b) => [b.count > 0 && b.interpreted.prefix === null, `count ${b.count}, prefix ${JSON.stringify(b.interpreted.prefix)}`]);

for (const r of out) console.log(`${r.pass ? 'PASS' : 'FAIL'}\t${r.id}\t${JSON.stringify(r.text)}\t${r.detail}\t${r.colo}`);
console.log(`${out.filter((r) => r.pass).length}/${out.length} pass; ${calls} calls`);
