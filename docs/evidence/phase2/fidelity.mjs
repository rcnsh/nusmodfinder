// @ts-check
// Phase 2c item 4: live fidelity check of the eval-v0 replica (method and
// acceptance rule in fidelity.md, written before the live calls).
//
//   node docs/evidence/phase2/fidelity.mjs local     local replica: hybrid, lexical list, vector list, FTS ranks
//   node docs/evidence/phase2/fidelity.mjs live      the 15 live /search calls (once; refuses to repeat)
//   node docs/evidence/phase2/fidelity.mjs analyze   compare -> fidelity-result.json
//   node docs/evidence/phase2/fidelity.mjs selftest  analyze a local stand-in for "live" (re-embedded queries; then a corrupted lexical list)
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO } from '../../../eval/lib/sets.mjs';
import { FIDELITY } from './ids.mjs';
import { runProbe, searchPath } from './probe.mjs';
import { overlap, rbo } from './rank.mjs';

const DIR = join(REPO, 'docs/evidence/phase2');
const LIVE_DIR = join(DIR, 'live');
const LIVE = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SPACING_MS = 3000;
const RRF_K = 60;
const DEPTH = 50;

const queries = JSON.parse(await readFile(join(REPO, 'eval/dev/queries.json'), 'utf8')).queries;
const byId = new Map(queries.map((/** @type {any} */ q) => [q.id, q]));
/** The exact path sent live and locally (production defaults + filters when `filtered`). */
const pathOf = (/** @type {{ id: string, filtered: boolean }} */ f) => searchPath(byId.get(f.id), { unfiltered: !f.filtered });
const withMode = (/** @type {string} */ p, /** @type {string} */ mode) => `${p}&mode=${mode}`;

async function local() {
  const requests = FIDELITY.flatMap((f) => [
    { id: `hybrid|${f.id}`, path: pathOf(f), fts: true, lex: true },
    { id: `lexical|${f.id}`, path: withMode(pathOf(f), 'lexical') },
    // topK=50: the whole dense list (depth stays 50).
    { id: `vector|${f.id}`, path: `${withMode(pathOf(f), 'vector')}&topK=50` },
  ]);
  const res = await runProbe({ name: 'fidelity-local', requests });
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of FIDELITY) {
    const h = /** @type {import('./probe.mjs').ProbeResult} */ (res.get(`hybrid|${f.id}`));
    const l = /** @type {import('./probe.mjs').ProbeResult} */ (res.get(`lexical|${f.id}`));
    const v = /** @type {import('./probe.mjs').ProbeResult} */ (res.get(`vector|${f.id}`));
    const pinned = h.body?.results?.[0]?.score === 1 ? h.body.results[0].code : null;
    // Sanity: the replicated SQL list is what the Worker's lexical mode fuses.
    // mode=lexical returns [pinned, ...lexical minus pinned] cut to 20.
    const lexMode = (l.body?.results ?? []).map((/** @type {any} */ x) => x.code).filter((/** @type {string} */ c) => c !== pinned);
    const lexNoPin = (h.lex ?? []).filter((c) => c !== pinned).slice(0, pinned ? 19 : 20);
    if (lexMode.join() !== lexNoPin.join()) throw new Error(`${f.id}: replicated lexical list differs from mode=lexical`);
    out[f.id] = {
      path: pathOf(f),
      status: h.status,
      body: h.body,
      lexical: h.lex,
      // Vector rank from the RRF score of a one-list fusion (1 / (60 + rank)),
      // which fuse() computes before the pinned code is lifted out.
      vectorRanks: Object.fromEntries((v.body?.results ?? []).filter((/** @type {any} */ x) => x.score !== 1).map((/** @type {any} */ x) => [x.code, Math.round(1 / x.score - RRF_K)])),
      vectorCount: v.body?.retrieval?.vector ?? null,
      ftsRank: Object.fromEntries((h.lex ?? []).map((c) => [c, h.fts?.[c] ?? null])),
      ftsAll: h.fts,
    };
  }
  await writeFile(join(DIR, 'fidelity-local.json'), `${JSON.stringify({ schema: 'vnm-phase2-fidelity-local/1', ranker: 'eval-v0', createdAt: new Date().toISOString(), queries: out }, null, 1)}\n`);
  console.log(`wrote ${join(DIR, 'fidelity-local.json')}`);
}

async function live() {
  if (existsSync(LIVE_DIR)) throw new Error(`${LIVE_DIR} exists: the live calls are made once`);
  await mkdir(LIVE_DIR);
  const log = join(REPO, 'docs/evidence/requests.tsv');
  const lines = (await readFile(log, 'utf8')).trim().split('\n');
  let n = Math.max(...lines.map((l) => Number(l.split('\t')[0])).filter(Number.isFinite));
  let s = Math.max(...lines.map((l) => Number(/\[search#(\d+)\]/.exec(l)?.[1])).filter(Number.isFinite));
  let last = 0;
  for (const f of FIDELITY) {
    const wait = last + SPACING_MS - Date.now();
    // Spacing between live calls is a rate rule for production, not a wait on work.
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const path = pathOf(f);
    const t0 = performance.now();
    last = Date.now();
    /** @type {any} */
    let rec;
    try {
      const res = await fetch(`${LIVE}${path}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
      const ttfb = performance.now() - t0;
      const text = await res.text();
      const total = performance.now() - t0;
      /** @type {any} */
      let body = null;
      try { body = JSON.parse(text); } catch { body = { nonJson: text.slice(0, 500) }; }
      rec = {
        id: f.id, path, status: res.status, ttfbMs: Math.round(ttfb), totalMs: Math.round(total), at: new Date(last).toISOString(),
        headers: { 'cf-cache-status': res.headers.get('cf-cache-status'), 'cf-ray': res.headers.get('cf-ray'), age: res.headers.get('age'), 'server-timing': res.headers.get('server-timing') },
        body,
      };
    } catch (err) {
      rec = { id: f.id, path, status: 0, error: String(err), at: new Date(last).toISOString() };
    }
    await writeFile(join(LIVE_DIR, `${f.id}.json`), `${JSON.stringify(rec, null, 1)}\n`);
    n++; s++;
    await appendFile(log, `${n}\tfetch\t[search#${s}] p2c_${f.id} GET ${path} | http=${rec.status} ttfb=${((rec.ttfbMs ?? 0) / 1000).toFixed(3)} total=${((rec.totalMs ?? 0) / 1000).toFixed(3)} | cf-cache-status=${rec.headers?.['cf-cache-status'] ?? '<absent>'} | server-timing=${rec.headers?.['server-timing'] ?? '<absent>'}\tphase2 2c fidelity\n`);
    console.log(`${f.id} ${rec.status} ${rec.totalMs ?? '-'}ms results=${rec.body?.results?.length ?? '-'}`);
  }
}

/**
 * Every (vector rank, lexical rank) pair, each in {null, 1..DEPTH}, whose
 * RRF score v0 computes bit-for-bit as `score` (vector list first, then
 * lexical, accumulated from 0 as fuse() does).
 * @param {number} score
 */
function decompose(score) {
  /** @type {[number | null, number | null][]} */
  const out = [];
  const ranks = [null, ...Array.from({ length: DEPTH }, (_, i) => i + 1)];
  for (const v of ranks) {
    for (const l of ranks) {
      if (v === null && l === null) continue;
      let s = 0;
      if (v !== null) s += 1 / (RRF_K + v);
      if (l !== null) s += 1 / (RRF_K + l);
      if (s === score) out.push([v, l]);
    }
  }
  return out;
}

/**
 * Allowed lexical ranks per code: the positions its FTS5 rank-value tie group
 * occupies in the local list. A group cut by the depth limit lets members
 * outside the list stand in for members inside it (and vice versa).
 * @param {string[]} list local lexical list (pinned code included)
 * @param {Record<string, number>} fts rank value of every match
 */
function lexicalSlots(list, fts) {
  /** @type {Map<string, Set<number | null>>} */
  const slots = new Map();
  const value = (/** @type {string} */ c) => fts[c];
  list.forEach((c, i) => {
    const group = list.map((x, j) => [x, j]).filter(([x]) => value(/** @type {string} */ (x)) === value(c)).map(([, j]) => Number(j) + 1);
    slots.set(c, new Set(group));
    void i;
  });
  if (list.length === DEPTH) {
    const cut = value(list[DEPTH - 1]);
    const tail = list.map((c, j) => [c, j + 1]).filter(([c]) => value(/** @type {string} */ (c)) === cut).map(([, j]) => /** @type {number} */ (j));
    for (const [c, r] of Object.entries(fts)) {
      if (r !== cut) continue;
      const s = slots.get(c) ?? new Set();
      tail.forEach((j) => s.add(j));
      s.add(null); // may fall outside the list
      slots.set(c, s);
    }
    for (const c of list) if (value(c) === cut) /** @type {Set<number | null>} */ (slots.get(c)).add(null);
  }
  return slots;
}

/**
 * @param {any} L live record
 * @param {any} R local record
 * @param {Record<string, number>} envelope
 */
function compareOne(L, R, envelope) {
  const id = L.id;
  /** @type {string[]} */
  const problems = [];
  const lb = L.body ?? {}, rb = R.body ?? {};
  if (L.status !== R.status) problems.push(`status ${L.status} vs ${R.status}`);
  if (lb.count !== rb.count) problems.push(`count ${lb.count} vs ${rb.count}`);
  if (lb.retrieval?.lexical !== rb.retrieval?.lexical) problems.push(`retrieval.lexical ${lb.retrieval?.lexical} vs ${rb.retrieval?.lexical}`);
  if (lb.retrieval?.vector !== rb.retrieval?.vector) problems.push(`retrieval.vector ${lb.retrieval?.vector} vs ${rb.retrieval?.vector}`);
  const liveRes = lb.results ?? [], localRes = rb.results ?? [];
  const liveCodes = liveRes.map((/** @type {any} */ x) => x.code), localCodes = localRes.map((/** @type {any} */ x) => x.code);
  const livePinned = liveRes[0]?.score === 1 ? liveRes[0].code : null;
  const localPinned = localRes[0]?.score === 1 ? localRes[0].code : null;
  if (livePinned !== localPinned) problems.push(`pinned ${livePinned} vs ${localPinned}`);

  // Lexical: every live score must decompose with a lexical rank the local
  // list allows (up to tie-group order).
  const slots = lexicalSlots(R.lexical ?? [], R.ftsAll ?? {});
  /** Candidate live vector ranks per code (several when a tie group allows several lexical ranks). */
  /** @type {Record<string, (number | null)[]>} */
  const liveVectorRank = {};
  /** @type {string[]} */
  const lexMismatch = [];
  /** @type {string[]} */
  const ambiguous = [];
  for (const r of liveRes) {
    if (r.code === livePinned && r.score === 1) continue;
    const allowed = slots.get(r.code) ?? new Set([null]);
    const fits = decompose(r.score).filter(([, l]) => allowed.has(l));
    if (!fits.length) { lexMismatch.push(`${r.code} (score ${r.score}; local lexical ${[...allowed].join('/') || 'absent'})`); continue; }
    const vs = [...new Set(fits.map(([v]) => v))];
    if (vs.length > 1) ambiguous.push(r.code);
    liveVectorRank[r.code] = vs;
  }
  // A local lexical hit whose lexical score alone beats the live 20th result
  // must be in the live results.
  const floor = liveRes.length >= 20 ? liveRes[19].score : 0;
  /** @type {string[]} */
  const missing = [];
  for (const [c, s] of slots) {
    if (c === livePinned || liveCodes.includes(c)) continue;
    const ranks = [...s].filter((x) => x !== null);
    if (s.has(null) || !ranks.length) continue;
    // Worst slot of its tie group: the lexical score it is guaranteed.
    const guaranteed = Math.min(...ranks.map((x) => 1 / (RRF_K + /** @type {number} */ (x))));
    if (guaranteed > floor) missing.push(`${c} (local lexical ${ranks.join('/')})`);
  }
  if (lexMismatch.length) problems.push(`lexical mismatch: ${lexMismatch.join(', ')}`);
  if (missing.length) problems.push(`lexical hits missing live: ${missing.join(', ')}`);

  // Dense half: inferred live vector ranks vs the local vector list.
  /** @type {Record<string, number>} */
  const localVec = R.vectorRanks ?? {};
  /** @type {{ code: string, live: (number | null)[], local: number | null }[]} */
  const vecShift = [];
  for (const [c, vs] of Object.entries(liveVectorRank)) {
    const loc = localVec[c] ?? null;
    if (!vs.includes(loc)) vecShift.push({ code: c, live: vs, local: loc });
  }
  const ov = overlap(localCodes, liveCodes, 10);
  const r10 = rbo(localCodes, liveCodes, 10);
  const env = envelope[id];
  const withinEnvelope = env === undefined ? null : ov >= env;
  const rowsOk = !problems.some((p) => /^(status|count|retrieval|pinned)/.test(p));
  const lexOk = !lexMismatch.length && !missing.length;
  return {
    id, path: L.path, status: L.status, count: lb.count, retrieval: { live: lb.retrieval, local: rb.retrieval },
    overlap10: ov, rbo10: r10, envelopeMinOverlap10: env ?? null, withinEnvelope,
    rowsOk, lexOk, pass: rowsOk && lexOk && withinEnvelope === true,
    problems, ambiguousVectorRank: ambiguous,
    vectorRankShifts: vecShift.length, vectorRankShiftExamples: vecShift.slice(0, 5),
    liveTop10: liveCodes.slice(0, 10), localTop10: localCodes.slice(0, 10),
  };
}

/** Per-query envelope: the lowest overlap@10 any batch-level noise condition produced (noise.json, fid params). */
async function envelopeOf() {
  const noise = JSON.parse(await readFile(join(DIR, 'noise.json'), 'utf8'));
  /** @type {Record<string, number>} */
  const env = {};
  for (const [k, per] of Object.entries(noise.perQuery)) {
    if (!k.startsWith('fid:') || k.startsWith('fid:q9996')) continue;
    for (const [id, m] of Object.entries(/** @type {Record<string, any>} */ (per))) env[id] = Math.min(env[id] ?? 10, m.overlap10);
  }
  return env;
}

/** @param {Record<string, any>} liveById @param {string} out */
async function analyze(liveById, out) {
  const localFile = JSON.parse(await readFile(join(DIR, 'fidelity-local.json'), 'utf8'));
  const env = await envelopeOf();
  const rows = FIDELITY.map((f) => compareOne(liveById[f.id], { ...localFile.queries[f.id] }, env));
  const verdict = rows.every((r) => r.pass) ? 'PASS' : 'FAIL';
  await writeFile(out, `${JSON.stringify({ schema: 'vnm-phase2-fidelity/1', createdAt: new Date().toISOString(), verdict, rows }, null, 1)}\n`);
  for (const r of rows) {
    console.log(`${r.id} ${String(r.status).padEnd(3)} rows ${r.rowsOk ? 'ok' : 'NO'} lex ${r.lexOk ? 'ok' : 'NO'} overlap@10 ${r.overlap10} (envelope ≥ ${r.envelopeMinOverlap10}) RBO ${r.rbo10.toFixed(3)} vecShifts ${r.vectorRankShifts} ${r.pass ? 'PASS' : 'FAIL'} ${r.problems.join('; ')}`);
  }
  const ov = rows.map((r) => r.overlap10);
  console.log(`verdict ${verdict} · mean overlap@10 ${(ov.reduce((a, b) => a + b, 0) / ov.length).toFixed(2)} · min ${Math.min(...ov)} · RBO≥0.8: ${rows.filter((r) => r.rbo10 >= 0.8).length}/${rows.length}`);
  return verdict;
}

const cmd = process.argv[2];
if (cmd === 'local') await local();
else if (cmd === 'live') await live();
else if (cmd === 'analyze') {
  /** @type {Record<string, any>} */
  const liveById = {};
  for (const f of FIDELITY) liveById[f.id] = JSON.parse(await readFile(join(LIVE_DIR, `${f.id}.json`), 'utf8'));
  await analyze(liveById, join(DIR, 'fidelity-result.json'));
} else if (cmd === 'selftest') {
  // Stand-in for live: the replica with the 20 re-embedded query vectors
  // (real Workers AI noise), which must pass; then the same with one lexical
  // list perturbed, which must fail.
  const re = JSON.parse(await readFile(join(DIR, 'reembed-20.json'), 'utf8'));
  const { base64ToF32, embeddingKey, MODEL, DIMS } = await import('../../../eval/lib/embeddings.mjs');
  const ids = Object.keys(re.vectors);
  const vectors = new Float32Array(ids.length * DIMS);
  ids.forEach((id, i) => vectors.set(base64ToF32(re.vectors[id]), i * DIMS));
  const part = { keys: ids.map((id) => embeddingKey(MODEL, byId.get(id).text)), vectors };
  const res = await runProbe({ name: 'fidelity-selftest', overrides: { real: part }, requests: FIDELITY.map((f) => ({ id: f.id, path: `${pathOf(f)}&_p=real`, override: 'real' })) });
  /** @type {Record<string, any>} */
  const fake = {};
  for (const f of FIDELITY) { const r = /** @type {any} */ (res.get(f.id)); fake[f.id] = { id: f.id, path: pathOf(f), status: r.status, body: r.body }; }
  const v1 = await analyze(fake, join(REPO, '.eval-work/fidelity-selftest-a.json'));
  // Corrupt: swap the lexical contribution of one result in the first query with any lexical hit.
  const victim = fake[FIDELITY[0].id].body.results.find((/** @type {any} */ x) => x.score > 1 / (RRF_K + 1) + 1e-9 && x.score < 1);
  if (victim) victim.score += 1e-6;
  fake[FIDELITY[1].id].body.retrieval.lexical -= 1;
  const v2 = await analyze(fake, join(REPO, '.eval-work/fidelity-selftest-b.json'));
  // Identity: the replica against itself must infer every vector rank exactly.
  const localFile = JSON.parse(await readFile(join(DIR, 'fidelity-local.json'), 'utf8'));
  /** @type {Record<string, any>} */
  const self = {};
  for (const f of FIDELITY) self[f.id] = { id: f.id, path: pathOf(f), status: localFile.queries[f.id].status, body: localFile.queries[f.id].body };
  await analyze(self, join(REPO, '.eval-work/fidelity-selftest-c.json'));
  const c = JSON.parse(await readFile(join(REPO, '.eval-work/fidelity-selftest-c.json'), 'utf8'));
  const shifts = c.rows.reduce((n, /** @type {any} */ r) => n + r.vectorRankShifts, 0);
  console.log(`selftest: clean ${v1} (want PASS), corrupted ${v2} (want FAIL), identity ${c.verdict} with ${shifts} vector-rank shifts (want PASS, 0)`);
  if (v1 !== 'PASS' || v2 !== 'FAIL' || c.verdict !== 'PASS' || shifts !== 0) process.exitCode = 1;
} else {
  console.error('usage: fidelity.mjs local|live|analyze|selftest');
  process.exitCode = 2;
}
