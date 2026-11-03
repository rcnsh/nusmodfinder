// Direct check of the lexical half (PR #12 review: decomposing hybrid RRF
// scores cannot pin lexical ranks). For each of the 15 fidelity queries, one
// live `mode=lexical&topK=50` call; the live list must equal the replica's
// depth-50 lexical list (fidelity-local.json `lexical`) up to FTS5 tie-group
// order: same codes, and each code within the positions its rank-value group
// occupies. Raw bodies -> live-lexical/<id>.json; result -> lexical-live-result.json.
//   node docs/evidence/phase2/lexical-live.mjs fetch    (15 live calls, 3 s apart)
//   node docs/evidence/phase2/lexical-live.mjs analyze  (offline)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');
const LIVE = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const local = JSON.parse(readFileSync(join(HERE, 'fidelity-local.json'), 'utf8')).queries;
const OUT = join(HERE, 'live-lexical');
const pathFor = (/** @type {string} */ p) => `${p}&mode=lexical&topK=50`;

async function fetchAll() {
  mkdirSync(OUT, { recursive: true });
  const log = join(REPO, 'docs/evidence/requests.tsv');
  const rows = readFileSync(log, 'utf8').trim().split('\n');
  let n = Number(rows[rows.length - 1].split('\t')[0]);
  let search = Number(rows.filter((r) => r.includes('[search#')).at(-1).match(/\[search#(\d+)\]/)[1]);
  for (const [id, q] of Object.entries(local)) {
    if (existsSync(join(OUT, `${id}.json`))) continue; // never re-call
    const path = pathFor(q.path);
    const t0 = performance.now();
    const res = await fetch(`${LIVE}${path}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
    const text = await res.text();
    const total = ((performance.now() - t0) / 1000).toFixed(3);
    writeFileSync(join(OUT, `${id}.json`), JSON.stringify({ path, status: res.status, body: JSON.parse(text) }, null, 1));
    appendFileSync(log, `${++n}\tfetch\t[search#${++search}] p2c_lex_${id} GET ${path} | http=${res.status} total=${total} | cf-cache-status=${res.headers.get('cf-cache-status') ?? '<absent>'}\tphase2 2c lexical check\n`);
    console.log(id, res.status, total);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function analyze() {
  /** @type {Record<string, unknown>} */
  const out = {};
  let pass = 0;
  for (const [id, q] of Object.entries(local)) {
    const live = JSON.parse(readFileSync(join(OUT, `${id}.json`), 'utf8'));
    // The exact-code pin (score 1) is a separate lookup, not part of the FTS
    // list; it must be the same pin the replica's hybrid response carries.
    const localPin = q.body.results?.[0]?.score === 1 ? q.body.results[0].code : null;
    const livePins = (live.body.results ?? []).filter((/** @type {any} */ r) => r.score === 1).map((/** @type {any} */ r) => r.code);
    const liveCodes = (live.body.results ?? []).filter((/** @type {any} */ r) => r.score !== 1).map((/** @type {any} */ r) => r.code);
    const want = /** @type {string[]} */ (q.lexical);
    const rank = /** @type {Record<string, number>} */ (q.ftsAll);
    // Positions each FTS rank value occupies in the local list.
    /** @type {Map<number, number[]>} */
    const span = new Map();
    want.forEach((c, i) => { const v = rank[c]; if (!span.has(v)) span.set(v, []); span.get(v).push(i); });
    const problems = [];
    if (live.status !== 200) problems.push(`HTTP ${live.status}`);
    if (JSON.stringify(livePins) !== JSON.stringify(localPin ? [localPin] : [])) problems.push(`pin live ${livePins.join(',') || 'none'} vs local ${localPin ?? 'none'}`);
    // A tie group cut at depth 50 may show other members live: compare as sets up to that group.
    const lastVal = rank[want.at(-1)];
    const cutGroup = new Set(Object.entries(rank).filter(([, v]) => v === lastVal).map(([c]) => c));
    const missing = want.filter((c) => !liveCodes.includes(c) && !cutGroup.has(c));
    const extra = liveCodes.filter((c) => !want.includes(c) && !cutGroup.has(c));
    if (missing.length) problems.push(`missing live: ${missing.join(',')}`);
    if (extra.length) problems.push(`extra live: ${extra.join(',')}`);
    if (liveCodes.length !== want.length) problems.push(`count live ${liveCodes.length} vs local ${want.length}`);
    liveCodes.forEach((c, i) => {
      const v = rank[c];
      if (v === undefined) return;
      const pos = v === lastVal ? null : span.get(v);
      if (pos && (i < Math.min(...pos) || i > Math.max(...pos))) problems.push(`${c} at live ${i + 1}, tie group spans ${Math.min(...pos) + 1}-${Math.max(...pos) + 1}`);
    });
    const exactOrder = liveCodes.length === want.length && liveCodes.every((c, i) => c === want[i]);
    if (!problems.length) pass++;
    out[id] = { live: liveCodes.length, local: want.length, pin: localPin, exactOrder, ok: problems.length === 0, problems };
  }
  const verdict = pass === Object.keys(local).length ? 'PASS' : 'FAIL';
  writeFileSync(join(HERE, 'lexical-live-result.json'), JSON.stringify({ verdict, pass, total: Object.keys(local).length, queries: out }, null, 1));
  console.log(verdict, pass, '/', Object.keys(local).length);
  for (const [id, r] of Object.entries(out)) console.log(id, JSON.stringify(r));
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchAll();
else if (cmd === 'analyze') analyze();
else throw new Error('usage: fetch | analyze');
