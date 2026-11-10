#!/usr/bin/env node
// @ts-check
// Ship step 9, the SC1 live check (docs/plans/phase4.md 4E): 30 GET /search
// calls on the live Worker, 2 per (sem, study) combination, with texts not used
// anywhere before, and every module shown (results and variants) checked
// against the independent oracle over the production-normalised modules. One
// call each, browser User-Agent; each call appended to
// <out.jsonl>, at least 4 s apart (the rate limiter). A 429 is re-sent on the next run.
// Refuses to send past 30 checked calls. Exit 1 on any leak.
//
//   node docs/evidence/phase4/sc1-live.mjs <out.jsonl> [.data/cache/2026-2027-moduleInfo.json]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from '../../../scripts/lib.mjs';
import { NG_SEMS, STUDIES } from '../../../src/ng-bit.js';
import { oracle } from '../../../test/sc1/oracle.node.mjs';

const ORIGIN = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BUDGET = 30;
// Fresh texts: none is in dev, the holdout's public shapes, SC4, SC7 or requests.tsv.
const TEXTS = [
  'sustainable architecture and the tropical city', 'derivatives pricing for traders', 'korean pop culture and media',
  'neural networks for language', 'water quality and public health', 'game theory in politics',
  'ethics of artificial intelligence', 'shipping and port logistics', 'contemporary chinese literature',
  'robot motion planning', 'urban heat and climate adaptation', 'consumer behaviour research methods',
  'operating systems internals', 'biodiversity of coral reefs', 'philosophy of science and evidence',
  'entrepreneurial finance for startups', 'photonics and lasers', 'migration and citizenship in asia',
  'statistical learning with r', 'materials for batteries', 'music composition with technology',
  'international human rights law', 'protein structure and function', 'visual communication design studio',
  'econometrics of panel data', 'cybersecurity and network defence', 'tropical medicine and infectious disease',
  'interaction design for mobile apps', 'history of science and empire', 'quantitative trading strategies',
];

const [out, path = `.data/cache/${DEFAULT_ACAD_YEAR}-moduleInfo.json`] = process.argv.slice(2);
if (!out) { console.error('usage: sc1-live.mjs <out.jsonl> [moduleInfo.json]'); process.exit(2); }
const raw = JSON.parse(readFileSync(path, 'utf8'));
const { modules } = offeredModules(Array.isArray(raw) ? raw : raw.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));
const moduleOf = new Map(modules.map((m) => [m.code, m]));
const previous = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
// A 429 is the Worker's own per-IP limiter answering before any search runs (no
// quota spent, nothing to check); it is re-sent on the next run.
const done = new Set(previous.filter((p) => p.status !== 429).map((p) => p.n));
/** Calls start at least this far apart, under the limiter's rate. */
const GAP_MS = 4_000;
let last = 0;

const combos = NG_SEMS.flatMap((sem) => STUDIES.map((study) => ({ sem, study })));
let n = 0, leaks = 0;
for (const [i, { sem, study }] of combos.entries()) {
  for (const k of [0, 1]) {
    n++;
    if (done.has(n)) continue;
    if (n > BUDGET) { console.error("budget reached"); process.exit(1); }
    const q = TEXTS[i * 2 + k];
    const params = new URLSearchParams({ q, ng: '1', study, ...(sem === 'any' ? {} : { sem: String(sem) }) });
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const at = new Date().toISOString();
    const res = await fetch(`${ORIGIN}/search?${params}`, { headers: { 'user-agent': UA } });
    const body = /** @type {any} */ (await res.json().catch(() => null));
    const shown = (body?.results ?? []).flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)]);
    const closed = shown.filter((c) => { const m = moduleOf.get(c); return !m || oracle(m, { sem, study }) === 'closed'; });
    leaks += closed.length;
    const row = { n, at, path: `/search?${params}`, status: res.status, cache: res.headers.get('cf-cache-status'), version: res.headers.get('x-app-version'), count: body?.count ?? null, shown: shown.length, closed };
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(`${n}\t${res.status}\t${row.count}\t${closed.length ? `LEAK ${closed.join(',')}` : 'ok'}\t${q} (${sem}, ${study})`);
    if (res.status !== 200) leaks++;
  }
}
console.log(`SC1 live: ${n} calls, ${leaks} leaks or non-200s`);
process.exit(leaks ? 1 : 0);
