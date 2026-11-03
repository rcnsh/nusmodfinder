// Builds a TREC-style judging pool for the topical queries: the union of the
// top-N from every retrieval system under test (offline BM25, vector-only,
// lexical-only, hybrid), presented in a fixed order with NO indication of which
// system returned a document or at what rank. Judging the pool rather than
// grep hits is what stops the relevance set from being biased toward whichever
// retrieval method happened to build it.
import { readFile } from 'node:fs/promises';
import { DEFAULT_ACAD_YEAR, fetchAcadYearFile, offeredModules, loadNgCourses } from './lib.mjs';
import { buildBaseline } from './baseline.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const base = (arg('url', 'http://localhost:8787')).replace(/\/$/, '');
const DEPTH = Number(arg('depth', 20));

const fixture = JSON.parse(await readFile(new URL('../eval/queries.json', import.meta.url), 'utf8'));
const info = await fetchAcadYearFile(DEFAULT_ACAD_YEAR, 'moduleInfo.json');
const { modules } = offeredModules(info.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));
const byCode = new Map(modules.map((m) => [m.code, m]));
const baseline = buildBaseline(modules);

async function remote(q, filters, mode) {
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('topK', String(DEPTH));
  url.searchParams.set('mode', mode);
  for (const [k, v] of Object.entries(filters ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${mode} ${q}: HTTP ${res.status}`);
  return (await res.json()).results.map((r) => r.code);
}

const only = arg('id', null);
for (const query of fixture.queries.filter((q) => q.kind === 'topical' && (!only || q.id === only))) {
  const pool = new Set([
    ...baseline.search(query.q, query.filters, DEPTH),
    ...(await remote(query.q, query.filters, 'vector')),
    ...(await remote(query.q, query.filters, 'lexical')),
    ...(await remote(query.q, query.filters, 'hybrid')),
  ]);
  // Sorted by code so the presentation order carries no ranking information.
  const sorted = [...pool].sort();
  console.log(`\n########## ${query.id} — "${query.q}"  (${sorted.length} pooled)`);
  for (const code of sorted) {
    const m = byCode.get(code);
    if (!m) continue;
    console.log(`${code}\t${m.faculty}\t${m.title}`);
  }
}
