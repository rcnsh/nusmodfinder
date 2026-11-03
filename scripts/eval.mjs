// Phases 2 and 4: measure retrieval quality against a keyword baseline.
//
//   npm run eval -- --baseline-only              Phase 2: BM25 baseline alone
//   npm run eval -- --url http://localhost:8787  Phase 4: baseline vs retrieval modes
//   npm run eval -- --url ... --json             also dump every returned code list
//
// Metric notes, all of them consequences of a hostile review of the first run:
//
//  * The GATE is MICRO-averaged recall: total relevant retrieved / total
//    relevant, pooled across queries. The first version macro-averaged, which
//    reported +0.6% for two systems that had retrieved an identical 11 of 45
//    documents — the "gain" was entirely an artefact of unequal denominators.
//  * precision@K divides by min(K, |R|), not by the returned list length. The
//    first version divided by list length, so a baseline returning one document
//    scored "100% precision" against a hybrid returning ten.
//  * |R| may exceed K. The relevance sets are now complete rather than
//    truncated, so most exceed 10 and recall@10 is ceilinged at 10/|R|. The
//    ceiling is reported and is identical for every system.
//  * The baseline applies the same porter-ish stemming as the Worker's FTS5
//    index, removing an asymmetry that previously favoured the hybrid.
import { readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_ACAD_YEAR, fetchAcadYearFile, offeredModules, loadNgCourses } from './lib.mjs';
import { buildBaseline } from './baseline.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);

const fixtureName = arg('fixture', 'queries.json');
const fixture = JSON.parse(await readFile(new URL(`../eval/${fixtureName}`, import.meta.url), 'utf8'));
const acadYear = arg('year', fixture.acadYear ?? DEFAULT_ACAD_YEAR);
const K = Number(arg('k', fixture.k ?? 10));
const baselineOnly = has('baseline-only');
const workerUrl = (arg('url', process.env.WORKER_URL) ?? '').replace(/\/$/, '');
const MODES = (arg('modes', 'vector,hybrid')).split(',').filter(Boolean);

const info = await fetchAcadYearFile(acadYear, 'moduleInfo.json');
const { modules } = offeredModules(info.data, acadYear, await loadNgCourses(acadYear));
const byCode = new Map(modules.map((m) => [m.code, m]));
const baseline = buildBaseline(modules);

// --- fixture validation -----------------------------------------------------
const problems = [];
for (const q of fixture.queries) {
  if (!q.relevant?.length) problems.push(`${q.id}: no relevant codes`);
  for (const code of q.relevant ?? []) {
    const m = byCode.get(code);
    if (!m) { problems.push(`${q.id}: relevant code ${code} is not in the ${acadYear} corpus`); continue; }
    const f = q.filters ?? {};
    if (f.sem !== undefined && !m.semesters.includes(f.sem)) problems.push(`${q.id}: ${code} not offered in semester ${f.sem}`);
    if (f.level !== undefined && m.level !== f.level) problems.push(`${q.id}: ${code} is level ${m.level}, filter demands ${f.level}`);
    if (f.credits !== undefined && m.credits !== f.credits) problems.push(`${q.id}: ${code} is ${m.credits}mc, filter demands ${f.credits}`);
    if (f.faculty !== undefined && m.faculty !== f.faculty) problems.push(`${q.id}: ${code} is ${m.faculty}, filter demands ${f.faculty}`);
    if (f.ng === true && m.ng !== true) problems.push(`${q.id}: ${code} is not open to Non-Graduating students`);
  }
}
if (problems.length) {
  console.error('Fixture is invalid:');
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

async function remoteSearch(query, filters, mode, k, attempt = 1) {
  const url = new URL(`${workerUrl}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('topK', String(k));
  url.searchParams.set('mode', mode);
  for (const [key, value] of Object.entries(filters ?? {})) url.searchParams.set(key, String(value));
  const res = await fetch(url);
  // The deployed Worker rate-limits /search. The harness is a burst of ~45
  // requests, so it trips its own guardrail; back off rather than fail the run.
  if (res.status === 429 && attempt <= 6) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return remoteSearch(query, filters, mode, k, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return (body.results ?? []).map((r) => r.code);
}

const hits = (got, rel) => got.filter((c) => rel.includes(c)).length;
const rr = (got, rel) => { const i = got.findIndex((c) => rel.includes(c)); return i === -1 ? 0 : 1 / (i + 1); };
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

const systems = baselineOnly ? ['baseline'] : ['baseline', ...MODES];
if (!baselineOnly && !workerUrl) {
  console.error('Pass --url <worker base url> (or set WORKER_URL) to measure the retrieval modes.');
  process.exit(1);
}

const rows = [];
for (const q of fixture.queries) {
  const row = { id: q.id, kind: q.kind, q: q.q, filters: q.filters, relevantCount: q.relevant.length, got: {}, per: {} };
  // Best recall@K anyone could achieve on this query. Identical for all systems.
  row.ceiling = Math.min(K, q.relevant.length) / q.relevant.length;
  for (const sys of systems) {
    const got = sys === 'baseline' ? baseline.search(q.q, q.filters, K) : await remoteSearch(q.q, q.filters, sys, K);
    const h = hits(got, q.relevant);
    row.got[sys] = got;
    row.per[sys] = {
      hits: h,
      recall: h / q.relevant.length,
      precision: h / Math.min(K, q.relevant.length),
      rr: rr(got, q.relevant),
      firstOk: q.firstMustBe ? got[0] === q.firstMustBe : null,
      violations: got.filter((c) => { const m = byCode.get(c); return !m || !baseline.matchesFilters(m, q.filters); }),
    };
  }
  rows.push(row);
}

// --- report -----------------------------------------------------------------
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);

console.log(`# Evaluation — ${acadYear}, ${modules.length} modules, k=${K}, fixture ${fixtureName}`);
console.log(`# baseline: BM25 (title x3 + description, porter-stemmed, stopword-filtered)`);
if (!baselineOnly) console.log(`# modes measured at ${workerUrl}/search: ${MODES.join(', ')}`);
console.log();

const head = `${pad('id', 5)}${pad('kind', 9)}${pad('query', 34)}${pad('|R|', 5)}${pad('ceil', 7)}` +
  systems.map((s) => pad(`${s} R@${K}`, 14)).join('');
console.log(head);
console.log('-'.repeat(head.length));
for (const r of rows) {
  const q = r.q.length > 31 ? `${r.q.slice(0, 30)}…` : r.q;
  console.log(`${pad(r.id, 5)}${pad(r.kind, 9)}${pad(q, 34)}${pad(r.relevantCount, 5)}${pad(pct(r.ceiling), 7)}` +
    systems.map((s) => pad(`${pct(r.per[s].recall)} (${r.per[s].hits})`, 14)).join(''));
}
console.log();

function summarise(label, rs) {
  const totalRel = rs.reduce((a, r) => a + r.relevantCount, 0);
  const line = systems.map((s) => {
    const h = rs.reduce((a, r) => a + r.per[s].hits, 0);
    return pad(`${pct(h / totalRel)} (${h}/${totalRel})`, 20);
  }).join('');
  console.log(`${pad(label, 22)}${line}`);
}
console.log(`## MICRO-averaged recall@${K} — the gate metric`);
console.log(`${pad('', 22)}${systems.map((s) => pad(s, 20)).join('')}`);
summarise('ALL', rows);
for (const kind of ['topical', 'code', 'title', 'filtered']) {
  const rs = rows.filter((r) => r.kind === kind);
  if (rs.length) summarise(kind, rs);
}
console.log();

console.log(`## precision@${K} (macro mean; divisor min(K,|R|)) and MRR`);
for (const s of systems) {
  console.log(`${pad(s, 22)}P@${K} ${pad(pct(mean(rows.map((r) => r.per[s].precision))), 10)}` +
    `MRR ${mean(rows.map((r) => r.per[s].rr)).toFixed(3)}`);
}
console.log();

if (!baselineOnly) {
  console.log('## Requirement checks (hybrid — the mode that ships)');
  const codeRows = rows.filter((r) => r.firstMustBe ?? fixture.queries.find((q) => q.id === r.id)?.firstMustBe);
  const fails = codeRows.filter((r) => r.per.hybrid && r.per.hybrid.firstOk === false);
  console.log(`- R5 exact code first: ${codeRows.length - fails.length}/${codeRows.length} pass`);
  const viol = rows.filter((r) => r.per.hybrid?.violations.length);
  console.log(`- R4 no filter violations: ${viol.length === 0 ? 'pass' : `FAIL (${viol.map((r) => r.id).join(', ')})`}`);
  console.log();

  const topical = rows.filter((r) => r.kind === 'topical');
  const rel = topical.reduce((a, r) => a + r.relevantCount, 0);
  const bh = topical.reduce((a, r) => a + r.per.baseline.hits, 0);
  console.log(`## Gate: micro recall@${K} on topical queries >= baseline`);
  for (const s of MODES) {
    const sh = topical.reduce((a, r) => a + r.per[s].hits, 0);
    const delta = (sh - bh) / rel;
    console.log(`   ${pad(s, 9)} ${sh}/${rel} vs baseline ${bh}/${rel}  delta ${delta >= 0 ? '+' : ''}${pct(delta)}  ${sh >= bh ? 'PASS' : 'FAIL'}`);
  }
  console.log(`   Smallest change this instrument can register: one document = ${pct(1 / rel)}.`);
}

if (has('json')) {
  const out = new URL(`../eval/raw-${fixtureName}`, import.meta.url);
  await writeFile(out, JSON.stringify({ acadYear, k: K, corpus: modules.length, systems, rows }, null, 2));
  console.log(`\nraw returned code lists written to eval/raw-${fixtureName}`);
}
