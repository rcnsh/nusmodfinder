// @ts-check
// Second live fidelity check: production after the Phase 1 forced re-ingest
// against a replica of the Phase 1 Worker (method and acceptance rule in
// fidelity-2.md, written and committed before the live calls).
//
//   node docs/evidence/phase2/fidelity-2.mjs local     head replica -> fidelity-2-local.json
//   node docs/evidence/phase2/fidelity-2.mjs selftest  analyse local stand-ins for "live" (clean, corrupted, identity)
//   node docs/evidence/phase2/fidelity-2.mjs live      the 30 live /search calls (once; refuses to repeat)
//   node docs/evidence/phase2/fidelity-2.mjs analyze   compare -> fidelity-2-result.json
//
// The check logic follows fidelity.mjs (the first check), which stays as it
// ran. What changes for the Phase 1 ranker is marked "head:".
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO } from '../../../eval/lib/sets.mjs';
import { HASHED, treeHash } from '../../../eval/lib/workspace.mjs';
import { FIDELITY } from './ids.mjs';
import { HEAD_SPEC, runProbe, searchPath } from './probe.mjs';
import { overlap, rbo } from './rank.mjs';

const DIR = join(REPO, 'docs/evidence/phase2');
const LIVE_DIR = join(DIR, 'live-2');
const LIVE_LEX_DIR = join(DIR, 'live-2-lexical');
const LOG = join(DIR, 'fidelity-2-requests.tsv');
const LIVE = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// At least 3 s between the end of one call and the start of the next.
const SPACING_MS = 3500;
const MAX_CALLS = 30;
const RRF_K = 60;
const DEPTH = 50;
/** The Phase 1 Worker production runs (src/ identical to c2d37d5 except src/data-version.json). */
export const REF = '8d94982';

const queries = JSON.parse(await readFile(join(REPO, 'eval/dev/queries.json'), 'utf8')).queries;
const byId = new Map(queries.map((/** @type {any} */ q) => [q.id, q]));
/** The exact path sent live and locally (production defaults + filters when `filtered`). */
const pathOf = (/** @type {{ id: string, filtered: boolean }} */ f) => searchPath(byId.get(f.id), { unfiltered: !f.filtered });
const lexPathOf = (/** @type {{ id: string, filtered: boolean }} */ f) => `${pathOf(f)}&mode=lexical&topK=50`;

/** @param {any} body */
const pinOf = (body) => (body?.results?.[0]?.score === 1 ? body.results[0].code : null);

/** The cache span's description in a Server-Timing value (`hit`/`miss`), or null. @param {string | null | undefined} st */
export function cacheDesc(st) {
  const part = (st ?? '').split(',').map((s) => s.trim()).find((s) => s === 'cache' || s.startsWith('cache;'));
  return part ? (/;desc=([^;]+)/.exec(part)?.[1] ?? null) : null;
}

async function local() {
  const requests = FIDELITY.flatMap((f) => [
    { id: `hybrid|${f.id}`, path: pathOf(f), fts: true, lex: true },
    { id: `lexical|${f.id}`, path: lexPathOf(f) },
    // topK=50: the whole dense list (depth stays 50).
    { id: `vector|${f.id}`, path: `${pathOf(f)}&mode=vector&topK=50` },
  ]);
  const name = 'fidelity-2-local';
  const res = await runProbe({ ref: REF, spec: HEAD_SPEC, name, requests });
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of FIDELITY) {
    const h = /** @type {any} */ (res.get(`hybrid|${f.id}`));
    const l = /** @type {any} */ (res.get(`lexical|${f.id}`));
    const v = /** @type {any} */ (res.get(`vector|${f.id}`));
    const pinned = pinOf(h.body);
    // Sanity: the lexical list from lexicalSearch is what mode=lexical returns
    // ([pin, ...list minus pin] cut to topK = 50).
    const lexMode = (l.body?.results ?? []).map((/** @type {any} */ x) => x.code).filter((/** @type {string} */ c) => c !== pinOf(l.body));
    if (pinOf(l.body) !== pinned) throw new Error(`${f.id}: lexical-mode pin differs from hybrid`);
    if (lexMode.join() !== lexicalWant(h.lex, pinned).join()) throw new Error(`${f.id}: lexicalSearch list differs from mode=lexical`);
    if (h.body?.retrieval?.lexical !== h.lex.length) throw new Error(`${f.id}: retrieval.lexical ${h.body?.retrieval?.lexical} vs lexicalSearch ${h.lex.length}`);
    out[f.id] = {
      path: pathOf(f),
      status: h.status,
      body: h.body,
      serverTiming: h.serverTiming,
      lexical: h.lex,
      lexicalMode: { path: lexPathOf(f), status: l.status, body: l.body, serverTiming: l.serverTiming },
      // Vector rank from the RRF score of a one-list fusion (1 / (60 + rank)).
      vectorRanks: Object.fromEntries((v.body?.results ?? []).filter((/** @type {any} */ x) => x.score !== 1).map((/** @type {any} */ x) => [x.code, Math.round(1 / x.score - RRF_K)])),
      vectorCount: v.body?.retrieval?.vector ?? null,
      ftsRank: Object.fromEntries(h.lex.map((/** @type {string} */ c) => [c, h.fts?.[c] ?? null])),
      // head: rank values of every match that passes the request's filters.
      ftsAll: h.fts,
    };
  }
  const wsHash = await treeHash(join(REPO, '.eval-work', `ws-${name}`));
  const worktreeHash = await treeHash(REPO, HASHED);
  await writeFile(join(DIR, 'fidelity-2-local.json'), `${JSON.stringify({
    schema: 'vnm-phase2-fidelity-local/2', ranker: REF, rankerTreeHash: wsHash,
    // `npm run eval` without --ref runs the working tree; equal hashes mean the same ranker.
    worktreeTreeHash: worktreeHash, createdAt: new Date().toISOString(), queries: out,
  }, null, 1)}\n`);
  console.log(`wrote fidelity-2-local.json (ranker ${REF}, tree ${wsHash.slice(0, 12)}, working tree ${worktreeHash.slice(0, 12)})`);
}

/**
 * What mode=lexical&topK=50 returns after the pin: the depth-50 lexical list
 * without the pinned code, cut to 50 minus the pin.
 * @param {string[]} list @param {string | null} pinned
 */
function lexicalWant(list, pinned) {
  return list.filter((c) => c !== pinned).slice(0, pinned ? DEPTH - 1 : DEPTH);
}

async function live() {
  if (existsSync(LIVE_DIR) || existsSync(LIVE_LEX_DIR) || existsSync(LOG)) throw new Error('live-2/, live-2-lexical/ or the request log exists: the live calls are made once');
  const calls = [
    ...FIDELITY.map((f) => ({ kind: 'hybrid', f, path: pathOf(f), dir: LIVE_DIR })),
    ...FIDELITY.map((f) => ({ kind: 'lexical', f, path: lexPathOf(f), dir: LIVE_LEX_DIR })),
  ];
  if (calls.length > MAX_CALLS) throw new Error(`${calls.length} calls planned; at most ${MAX_CALLS}`);
  await mkdir(LIVE_DIR);
  await mkdir(LIVE_LEX_DIR);
  await writeFile(LOG, 'n\tkind\tpath_or_name\tnote\n');
  let n = 0;
  let lastEnd = 0;
  for (const c of calls) {
    const wait = lastEnd + SPACING_MS - Date.now();
    // Spacing between live calls is a rate rule for production, not a wait on work.
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    n++;
    const at = new Date().toISOString();
    const t0 = performance.now();
    /** @type {any} */
    let rec;
    try {
      // One attempt, no retry; a hung call is recorded as an error after 30 s.
      const res = await fetch(`${LIVE}${c.path}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      const ttfb = performance.now() - t0;
      const text = await res.text();
      const total = performance.now() - t0;
      /** @type {any} */
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      rec = { n: `f2-${n}`, id: c.f.id, kind: c.kind, path: c.path, status: res.status, ttfbMs: Math.round(ttfb), totalMs: Math.round(total), at, headers: Object.fromEntries(res.headers), bodyText: text, body };
    } catch (err) {
      rec = { n: `f2-${n}`, id: c.f.id, kind: c.kind, path: c.path, status: 0, error: String(err), at };
    }
    lastEnd = Date.now();
    await writeFile(join(c.dir, `${c.f.id}.json`), `${JSON.stringify(rec, null, 1)}\n`);
    const h = rec.headers ?? {};
    await appendFile(LOG, `f2-${n}\tfetch\tp2f2_${c.kind === 'lexical' ? 'lex_' : ''}${c.f.id} GET ${c.path} | http=${rec.status} ttfb=${((rec.ttfbMs ?? 0) / 1000).toFixed(3)} total=${((rec.totalMs ?? 0) / 1000).toFixed(3)} | cf-cache-status=${h['cf-cache-status'] ?? '<absent>'} | x-app-version=${h['x-app-version'] ?? '<absent>'} | server-timing=${h['server-timing'] ?? '<absent>'}${rec.error ? ` | error=${rec.error}` : ''}\tphase2 fidelity-2 ${c.kind} (${at})\n`);
    console.log(`f2-${n} ${c.kind} ${c.f.id} ${rec.status} ${rec.totalMs ?? '-'}ms results=${rec.body?.results?.length ?? '-'} cache=${cacheDesc(h['server-timing'])}`);
  }
  console.log(`LIVE CALLS DONE ${new Date().toISOString()} (${n} calls)`);
}

/**
 * Every (vector rank, lexical rank) pair, each in {null, 1..DEPTH}, whose RRF
 * score fuse() computes bit-for-bit as `score` (vector list first, then
 * lexical, accumulated from 0). Unchanged in Phase 1.
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
 * @param {Record<string, number>} fts rank value of every (filtered) match
 */
function lexicalSlots(list, fts) {
  /** @type {Map<string, Set<number | null>>} */
  const slots = new Map();
  const value = (/** @type {string} */ c) => fts[c];
  for (const c of list) {
    slots.set(c, new Set(list.map((x, j) => [x, j + 1]).filter(([x]) => value(/** @type {string} */ (x)) === value(c)).map(([, j]) => /** @type {number} */ (j))));
  }
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
 * head: the src/ of a deployed version tag equals REF's apart from
 * src/data-version.json (which only changes the cache key).
 * @param {string | null | undefined} tag
 */
function sameRanker(tag) {
  if (!tag || !/^[0-9a-f]{7,40}$/.test(tag)) return false;
  const r = spawnSync('git', ['diff', '--quiet', tag, REF, '--', 'src', ':(exclude)src/data-version.json'], { cwd: REPO });
  return r.status === 0;
}

/**
 * Direct lexical check (first check: after the fact; here: part of check 2).
 * The live mode=lexical&topK=50 list against the replica's, up to FTS5
 * tie-group order.
 * @param {any} L live lexical-mode record
 * @param {any} R local record
 */
function directLexical(L, R) {
  /** @type {string[]} */
  const problems = [];
  const rank = /** @type {Record<string, number>} */ (R.ftsAll ?? {});
  const localPin = pinOf(R.body);
  const results = L.body?.results ?? [];
  const livePins = results.filter((/** @type {any} */ r) => r.score === 1).map((/** @type {any} */ r) => r.code);
  const liveCodes = results.filter((/** @type {any} */ r) => r.score !== 1).map((/** @type {any} */ r) => r.code);
  const full = /** @type {string[]} */ (R.lexical ?? []);
  const want = lexicalWant(full, localPin);
  if (L.status !== 200) problems.push(`HTTP ${L.status}`);
  if (L.body?.degraded) problems.push('degraded');
  if (cacheDesc(L.headers?.['server-timing']) !== 'miss') problems.push(`cache ${cacheDesc(L.headers?.['server-timing']) ?? 'unknown'}`);
  if (JSON.stringify(livePins) !== JSON.stringify(localPin ? [localPin] : [])) problems.push(`pin live ${livePins.join(',') || 'none'} vs local ${localPin ?? 'none'}`);
  if (L.body?.retrieval?.lexical !== full.length) problems.push(`retrieval.lexical live ${L.body?.retrieval?.lexical} vs local ${full.length}`);
  // Each live score is 1/(60 + its position in the lexical list after the pin is lifted out).
  // head: lexical mode fuses one list, so the score is the lexical rank; it must agree with the order.
  // Groups cut at depth 50 (and at the topK cut below it, when a pin shortens the page) compare as sets.
  /** @type {Set<number>} */
  const cutValues = new Set();
  if (full.length === DEPTH) cutValues.add(rank[full[DEPTH - 1]]);
  if (want.length && want.length < full.filter((c) => c !== localPin).length) cutValues.add(rank[want[want.length - 1]]);
  const inCut = (/** @type {string} */ c) => cutValues.has(rank[c]);
  const missing = want.filter((c) => !liveCodes.includes(c) && !inCut(c));
  const extra = liveCodes.filter((/** @type {string} */ c) => !want.includes(c) && !inCut(c));
  if (missing.length) problems.push(`missing live: ${missing.join(',')}`);
  if (extra.length) problems.push(`extra live: ${extra.join(',')}`);
  if (liveCodes.length !== want.length) problems.push(`count live ${liveCodes.length} vs local ${want.length}`);
  /** @type {Map<number, number[]>} */
  const span = new Map();
  want.forEach((c, i) => { const v = rank[c]; if (!span.has(v)) span.set(v, []); /** @type {number[]} */ (span.get(v)).push(i); });
  liveCodes.forEach((/** @type {string} */ c, /** @type {number} */ i) => {
    const v = rank[c];
    if (v === undefined || inCut(c)) return;
    const pos = /** @type {number[] | undefined} */ (span.get(v));
    if (pos && (i < Math.min(...pos) || i > Math.max(...pos))) problems.push(`${c} at live ${i + 1}, tie group spans ${Math.min(...pos) + 1}-${Math.max(...pos) + 1}`);
  });
  const exactOrder = liveCodes.length === want.length && liveCodes.every((/** @type {string} */ c, /** @type {number} */ i) => c === want[i]);
  return { ok: problems.length === 0, exactOrder, live: liveCodes.length, local: want.length, problems };
}

/**
 * @param {any} L live hybrid record
 * @param {any} LL live lexical-mode record
 * @param {any} R local record
 * @param {Record<string, number>} envelope
 */
function compareOne(L, LL, R, envelope) {
  const id = R.id;
  /** @type {string[]} */
  const problems = [];
  const lb = L.body ?? {}, rb = R.body ?? {};
  if (L.status !== R.status) problems.push(`status ${L.status} vs ${R.status}`);
  if (lb.count !== rb.count) problems.push(`count ${lb.count} vs ${rb.count}`);
  if (lb.retrieval?.lexical !== rb.retrieval?.lexical) problems.push(`retrieval.lexical ${lb.retrieval?.lexical} vs ${rb.retrieval?.lexical}`);
  if (lb.retrieval?.vector !== rb.retrieval?.vector) problems.push(`retrieval.vector ${lb.retrieval?.vector} vs ${rb.retrieval?.vector}`);
  const liveRes = lb.results ?? [], localRes = rb.results ?? [];
  const liveCodes = liveRes.map((/** @type {any} */ x) => x.code), localCodes = localRes.map((/** @type {any} */ x) => x.code);
  const livePinned = pinOf(lb), localPinned = pinOf(rb);
  if (livePinned !== localPinned) problems.push(`pinned ${livePinned} vs ${localPinned}`);
  // head: a degraded answer, a cache hit or a different ranker is not a fresh full answer of this code.
  if (lb.degraded) problems.push(`degraded ${JSON.stringify(lb.degraded)}`);
  const cache = cacheDesc(L.headers?.['server-timing']);
  if (cache !== 'miss') problems.push(`cache ${cache ?? 'unknown'}`);
  const version = L.headers?.['x-app-version'] ?? null;
  if (!sameRanker(version)) problems.push(`version ${version ?? 'absent'} is not ${REF}'s ranker`);

  // Lexical decomposition: every live score must decompose with a lexical
  // rank the local list allows (up to tie-group order).
  const slots = lexicalSlots(R.lexical ?? [], R.ftsAll ?? {});
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
  const floor = liveRes.length >= 20 ? liveRes[19].score : 0;
  /** @type {string[]} */
  const missing = [];
  for (const [c, s] of slots) {
    if (c === livePinned || liveCodes.includes(c)) continue;
    const ranks = [...s].filter((x) => x !== null);
    if (s.has(null) || !ranks.length) continue;
    const guaranteed = Math.min(...ranks.map((x) => 1 / (RRF_K + /** @type {number} */ (x))));
    if (guaranteed > floor) missing.push(`${c} (local lexical ${ranks.join('/')})`);
  }
  if (lexMismatch.length) problems.push(`lexical mismatch: ${lexMismatch.join(', ')}`);
  if (missing.length) problems.push(`lexical hits missing live: ${missing.join(', ')}`);
  const direct = directLexical(LL, R);
  if (!direct.ok) problems.push(`direct lexical: ${direct.problems.join('; ')}`);

  // Dense half (reported only): inferred live vector ranks vs the local dense list.
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
  const rowsOk = !problems.some((p) => /^(status|count|retrieval|pinned|degraded|cache|version)/.test(p));
  const decompOk = !lexMismatch.length && !missing.length;
  const lexOk = decompOk && direct.ok;
  return {
    id, path: L.path, status: L.status, count: lb.count, retrieval: { live: lb.retrieval, local: rb.retrieval },
    cache, version, ms: { ttfb: L.ttfbMs ?? null, total: L.totalMs ?? null }, serverTiming: L.headers?.['server-timing'] ?? null,
    overlap10: ov, rbo10: r10, envelopeMinOverlap10: env ?? null, withinEnvelope,
    rowsOk, decompOk, directLexical: direct, lexOk,
    pass: rowsOk && lexOk && withinEnvelope === true,
    // The first check's rule read literally (check 2 = the decomposition only); reported, does not decide.
    passFirstRule: rowsOk && decompOk && withinEnvelope === true,
    problems, ambiguousVectorRank: ambiguous,
    vectorRankShifts: vecShift.length, vectorRankShiftExamples: vecShift.slice(0, 5),
    liveVectorRanks: liveVectorRank,
    liveTop10: liveCodes.slice(0, 10), localTop10: localCodes.slice(0, 10),
  };
}

/**
 * Per-query envelope: the lowest overlap@10 any batch-level noise condition
 * produced for the head replica (noise-2.json, fid params; q9996, the
 * same-text-two-calls level, excluded as in the first check).
 * @param {string} file
 */
async function envelopeOf(file = join(DIR, 'noise-2.json')) {
  const noise = JSON.parse(await readFile(file, 'utf8'));
  if (noise.ranker !== REF) throw new Error(`${file} is for ranker ${noise.ranker}, not ${REF}`);
  /** @type {Record<string, number>} */
  const env = {};
  for (const [k, per] of Object.entries(noise.perQuery)) {
    if (!k.startsWith('fid:') || k.startsWith('fid:q9996')) continue;
    for (const [id, m] of Object.entries(/** @type {Record<string, any>} */ (per))) env[id] = Math.min(env[id] ?? 10, m.overlap10);
  }
  return env;
}

/**
 * @param {Record<string, any>} liveById
 * @param {Record<string, any>} liveLexById
 * @param {string} out
 * @param {{ extra?: (rows: any[]) => Promise<Record<string, unknown>> }} [o]
 */
async function analyze(liveById, liveLexById, out, o = {}) {
  const localFile = JSON.parse(await readFile(join(DIR, 'fidelity-2-local.json'), 'utf8'));
  const env = await envelopeOf();
  const rows = FIDELITY.map((f) => compareOne(liveById[f.id], liveLexById[f.id], { id: f.id, ...localFile.queries[f.id] }, env));
  const verdict = rows.every((r) => r.pass) ? 'PASS' : 'FAIL';
  const verdictFirstRule = rows.every((r) => r.passFirstRule) ? 'PASS' : 'FAIL';
  const ov = rows.map((r) => r.overlap10);
  const summary = {
    meanOverlap10: ov.reduce((a, b) => a + b, 0) / ov.length, minOverlap10: Math.min(...ov),
    rbo10AtLeast08: rows.filter((r) => r.rbo10 >= 0.8).length, directLexicalOk: rows.filter((r) => r.directLexical.ok).length,
    directLexicalExactOrder: rows.filter((r) => r.directLexical.exactOrder).length,
    failing: rows.filter((r) => !r.pass).map((r) => r.id),
  };
  const extra = o.extra ? await o.extra(rows) : {};
  await writeFile(out, `${JSON.stringify({ schema: 'vnm-phase2-fidelity/2', createdAt: new Date().toISOString(), ranker: REF, verdict, verdictFirstRule, summary, rows, ...extra }, null, 1)}\n`);
  for (const r of rows) {
    console.log(`${r.id} ${String(r.status).padEnd(3)} rows ${r.rowsOk ? 'ok' : 'NO'} decomp ${r.decompOk ? 'ok' : 'NO'} direct ${r.directLexical.ok ? 'ok' : 'NO'} overlap@10 ${r.overlap10} (envelope ≥ ${r.envelopeMinOverlap10}) RBO ${r.rbo10.toFixed(3)} vecShifts ${r.vectorRankShifts} ${r.pass ? 'PASS' : 'FAIL'} ${r.problems.join('; ')}`);
  }
  console.log(`verdict ${verdict} (first rule literally: ${verdictFirstRule}) · mean overlap@10 ${summary.meanOverlap10.toFixed(2)} · min ${summary.minOverlap10} · RBO≥0.8: ${summary.rbo10AtLeast08}/${rows.length} · direct lexical ${summary.directLexicalOk}/${rows.length}`);
  return verdict;
}

/**
 * Candidate vector ranks of each non-pinned result, by decomposition against a
 * lexical list (a code with no fitting pair is left out).
 * @param {any[]} results @param {string[]} lexical @param {Record<string, number>} ftsAll
 */
function inferVectorRanks(results, lexical, ftsAll) {
  const slots = lexicalSlots(lexical ?? [], ftsAll ?? {});
  /** @type {Record<string, (number | null)[]>} */
  const out = {};
  for (const r of results) {
    if (r.score === 1) continue;
    const allowed = slots.get(r.code) ?? new Set([null]);
    const vs = [...new Set(decompose(r.score).filter(([, l]) => allowed.has(l)).map(([v]) => v))];
    if (vs.length) out[r.code] = vs;
  }
  return out;
}

/**
 * Report-only comparisons with the first check (pre-registered in
 * fidelity-2.md): old production vs new production, the v0 replica vs the
 * head replica, and the dense ranks old vs new production.
 * @param {any[]} rows
 */
async function againstFirstCheck(rows) {
  const v0Local = JSON.parse(await readFile(join(DIR, 'fidelity-local.json'), 'utf8')).queries;
  const first = JSON.parse(await readFile(join(DIR, 'fidelity-result.json'), 'utf8')).rows;
  const local2 = JSON.parse(await readFile(join(DIR, 'fidelity-2-local.json'), 'utf8')).queries;
  /** @type {Record<string, unknown>} */
  const per = {};
  for (const r of rows) {
    const live1 = JSON.parse(await readFile(join(DIR, 'live', `${r.id}.json`), 'utf8')).body.results.map((/** @type {any} */ x) => x.code);
    const live2 = JSON.parse(await readFile(join(LIVE_DIR, `${r.id}.json`), 'utf8')).body?.results?.map((/** @type {any} */ x) => x.code) ?? [];
    const v0 = v0Local[r.id].body.results.map((/** @type {any} */ x) => x.code);
    const head = local2[r.id].body.results.map((/** @type {any} */ x) => x.code);
    const f1 = first.find((/** @type {any} */ x) => x.id === r.id);
    // Dense ranks old vs new production: each live answer's vector ranks,
    // inferred by decomposition against its own replica's lexical list; codes
    // both answers return with one candidate rank each.
    const oldRanks = inferVectorRanks(JSON.parse(await readFile(join(DIR, 'live', `${r.id}.json`), 'utf8')).body.results, v0Local[r.id].lexical, v0Local[r.id].ftsAll);
    /** @type {Record<string, (number | null)[]>} */
    const newRanks = r.liveVectorRanks;
    const both = Object.keys(oldRanks).filter((c) => newRanks[c] && oldRanks[c].length === 1 && newRanks[c].length === 1);
    const same = both.filter((c) => oldRanks[c][0] === newRanks[c][0]);
    per[r.id] = {
      firstCheck: { overlap10: f1?.overlap10 ?? null, envelope: f1?.envelopeMinOverlap10 ?? null, pass: f1?.pass ?? null },
      liveOldVsNew: { overlap10: overlap(live1, live2, 10), rbo10: rbo(live1, live2, 10) },
      replicaV0VsHead: { overlap10: overlap(v0, head, 10), rbo10: rbo(v0, head, 10) },
      liveNewVsReplicaV0: { overlap10: overlap(v0, live2, 10) },
      denseOldVsNew: { comparable: both.length, sameRank: same.length },
    };
  }
  return { againstFirstCheck: per };
}

const cmd = process.argv[2];
if (cmd === 'local') await local();
else if (cmd === 'live') await live();
else if (cmd === 'analyze') {
  /** @type {Record<string, any>} */
  const liveById = {};
  /** @type {Record<string, any>} */
  const liveLexById = {};
  for (const f of FIDELITY) {
    liveById[f.id] = JSON.parse(await readFile(join(LIVE_DIR, `${f.id}.json`), 'utf8'));
    liveLexById[f.id] = JSON.parse(await readFile(join(LIVE_LEX_DIR, `${f.id}.json`), 'utf8'));
  }
  await analyze(liveById, liveLexById, join(DIR, 'fidelity-2-result.json'), { extra: againstFirstCheck });
} else if (cmd === 'selftest') {
  await selftest();
} else {
  console.error('usage: fidelity-2.mjs local|live|analyze|selftest');
  process.exitCode = 2;
}

/**
 * Stand-ins for "live", built from the head replica:
 *  A. clean: hybrid with the 20 re-embedded query vectors (real Workers AI
 *     noise) + the replica's own lexical-mode bodies; must PASS.
 *  B. corrupted, one defect per query on five queries; must FAIL on exactly
 *     those five.
 *  C. identity: the replica against itself; must PASS with every vector rank
 *     inferred exactly.
 */
async function selftest() {
  const re = JSON.parse(await readFile(join(DIR, 'reembed-20.json'), 'utf8'));
  const { base64ToF32, embeddingKey, queryTextForms, MODEL, DIMS } = await import('../../../eval/lib/embeddings.mjs');
  /** @type {[string, Float32Array][]} */
  const entries = Object.entries(re.vectors).flatMap(([id, b64]) => queryTextForms(byId.get(id).text).map((t) => /** @type {[string, Float32Array]} */ ([t, base64ToF32(/** @type {string} */ (b64))])));
  const vectors = new Float32Array(entries.length * DIMS);
  entries.forEach(([, v], i) => vectors.set(v, i * DIMS));
  const part = { keys: entries.map(([t]) => embeddingKey(MODEL, t)), vectors };
  const res = await runProbe({ ref: REF, spec: HEAD_SPEC, name: 'fidelity-2-selftest', overrides: { real: part }, requests: FIDELITY.map((f) => ({ id: f.id, path: `${pathOf(f)}&_p=real`, override: 'real' })) });
  const localFile = JSON.parse(await readFile(join(DIR, 'fidelity-2-local.json'), 'utf8'));
  const headers = (/** @type {string | null} */ st) => ({ 'server-timing': st, 'x-app-version': REF });
  /** @type {Record<string, any>} */
  const lexStand = {};
  for (const f of FIDELITY) {
    const m = localFile.queries[f.id].lexicalMode;
    lexStand[f.id] = { id: f.id, path: m.path, status: m.status, body: m.body, headers: headers(m.serverTiming) };
  }
  /** @type {Record<string, any>} */
  const fake = {};
  for (const f of FIDELITY) {
    const r = /** @type {any} */ (res.get(f.id));
    fake[f.id] = { id: f.id, path: pathOf(f), status: r.status, body: r.body, headers: headers(r.serverTiming) };
  }
  const work = join(REPO, '.eval-work');
  await mkdir(work, { recursive: true });
  const vA = await analyze(fake, lexStand, join(work, 'fidelity-2-selftest-a.json'));

  // B: five defects on five different queries.
  const clone = (/** @type {any} */ x) => JSON.parse(JSON.stringify(x));
  const fB = clone(fake), lB = clone(lexStand);
  const [q1, q2, q3, q4, q5] = FIDELITY.map((f) => f.id);
  const victim = fB[q1].body.results.find((/** @type {any} */ x) => x.score > 1 / (RRF_K + 1) + 1e-9 && x.score < 1);
  if (!victim) throw new Error(`${q1}: no fused result to nudge`);
  victim.score += 1e-6; // a score no rank pair gives
  fB[q2].body.retrieval.lexical -= 1;
  fB[q3].headers['server-timing'] = String(fB[q3].headers['server-timing']).replace('desc=miss', 'desc=hit');
  fB[q4].body.degraded = { source: 'workers-ai', reason: 'timeout' };
  // q5: swap the first and last lexical-mode results that sit in different, uncut tie groups.
  const rank = localFile.queries[q5].ftsAll;
  const lr = lB[q5].body.results.filter((/** @type {any} */ x) => x.score !== 1);
  const i = 0, j = lr.findIndex((/** @type {any} */ x, /** @type {number} */ k) => k > 10 && rank[x.code] !== rank[lr[0].code]);
  if (j < 0) throw new Error(`${q5}: no swap across tie groups`);
  [lr[i].code, lr[j].code] = [lr[j].code, lr[i].code];
  const vB = await analyze(fB, lB, join(work, 'fidelity-2-selftest-b.json'));
  const b = JSON.parse(await readFile(join(work, 'fidelity-2-selftest-b.json'), 'utf8'));
  const failedB = b.rows.filter((/** @type {any} */ r) => !r.pass).map((/** @type {any} */ r) => r.id);
  const wantB = [q1, q2, q3, q4, q5];

  // C: identity.
  /** @type {Record<string, any>} */
  const self = {};
  for (const f of FIDELITY) {
    const q = localFile.queries[f.id];
    self[f.id] = { id: f.id, path: q.path, status: q.status, body: q.body, headers: headers(q.serverTiming) };
  }
  const vC = await analyze(self, lexStand, join(work, 'fidelity-2-selftest-c.json'));
  const c = JSON.parse(await readFile(join(work, 'fidelity-2-selftest-c.json'), 'utf8'));
  const shifts = c.rows.reduce((n, /** @type {any} */ r) => n + r.vectorRankShifts, 0);
  const okB = vB === 'FAIL' && failedB.join() === wantB.join();
  console.log(`selftest: clean ${vA} (want PASS), corrupted ${vB} on ${failedB.join(',')} (want FAIL on ${wantB.join(',')}), identity ${vC} with ${shifts} vector-rank shifts (want PASS, 0)`);
  await writeFile(join(DIR, 'fidelity-2-selftest.json'), `${JSON.stringify({
    schema: 'vnm-phase2-fidelity-selftest/2', createdAt: new Date().toISOString(), ranker: REF,
    clean: { verdict: vA, want: 'PASS', overlap10: JSON.parse(await readFile(join(work, 'fidelity-2-selftest-a.json'), 'utf8')).rows.map((/** @type {any} */ r) => [r.id, r.overlap10, r.envelopeMinOverlap10]) },
    corrupted: { verdict: vB, failing: failedB, want: wantB, problems: b.rows.filter((/** @type {any} */ r) => !r.pass).map((/** @type {any} */ r) => [r.id, r.problems]) },
    identity: { verdict: vC, vectorRankShifts: shifts, want: 'PASS, 0' },
    ok: vA === 'PASS' && okB && vC === 'PASS' && shifts === 0,
  }, null, 1)}\n`);
  if (vA !== 'PASS' || !okB || vC !== 'PASS' || shifts !== 0) process.exitCode = 1;
}
