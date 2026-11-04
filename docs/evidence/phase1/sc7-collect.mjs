#!/usr/bin/env node
// SC7 sample collector (method: sc7.md). One GET /search per query from
// sc7-queries.tsv, browser User-Agent, no retries, appended to a JSONL file.
//
//   node sc7-collect.mjs warm   <out.jsonl>   # 3 s between request starts; stops at 30 SIN or 33 calls
//   node sc7-collect.mjs sparse <out.jsonl>   # 12 calls, 630 s between request starts
//
// Refuses to send once <out.jsonl> holds 45 calls (the SC7 live-call budget).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const BUDGET = 45;
const PLAN = {
  warm: { gapMs: 3_000, maxCalls: 33, stopAtSin: 30 },
  sparse: { gapMs: 630_000, maxCalls: 12, stopAtSin: Infinity },
};

const [phase, out] = process.argv.slice(2);
if (!PLAN[phase] || !out) {
  console.error('usage: sc7-collect.mjs warm|sparse <out.jsonl>');
  process.exit(2);
}
const plan = PLAN[phase];

const here = dirname(fileURLToPath(import.meta.url));
const queries = readFileSync(join(here, 'sc7-queries.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t')).map(([id, set, q, params = '']) => ({ id, set, q, params }))
  .filter((x) => x.set === phase);

const previous = existsSync(out)
  ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const done = new Set(previous.map((s) => s.id));
let n = previous.length;

/** @param {string} header */
function parseServerTiming(header) {
  /** @type {Record<string, { dur?: number, desc?: string }>} */
  const spans = {};
  for (const part of header.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...attrs] = part.split(';').map((s) => s.trim());
    const span = {};
    for (const a of attrs) {
      const [k, v] = a.split('=');
      if (k === 'dur') span.dur = Number(v);
      else if (k === 'desc') span.desc = v;
    }
    spans[name] = span;
  }
  return spans;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sin = 0;
let calls = 0;
let lastStart = 0;
for (const query of queries) {
  if (done.has(query.id)) continue; // never repeat a query
  if (calls >= plan.maxCalls || sin >= plan.stopAtSin) break;
  if (n >= BUDGET) { console.error(`budget of ${BUDGET} calls reached`); break; }
  const wait = lastStart ? plan.gapMs - (Date.now() - lastStart) : 0;
  if (wait > 0) await sleep(wait);

  const params = new URLSearchParams({ q: query.q });
  for (const [k, v] of new URLSearchParams(query.params)) params.set(k, v);
  const path = `/search?${params}`;
  n += 1;
  calls += 1;
  lastStart = Date.now();
  const utc = new Date(lastStart).toISOString();
  /** @type {Record<string, unknown>} */
  const sample = { n: `s7-${n}`, id: query.id, phase, utc, path };
  try {
    const t0 = performance.now();
    const res = await fetch(ORIGIN + path, { headers: { 'user-agent': UA, accept: 'application/json' } });
    const body = await res.text();
    sample.clientMs = Math.round(performance.now() - t0);
    const ray = res.headers.get('cf-ray') ?? '';
    const st = res.headers.get('server-timing') ?? '';
    Object.assign(sample, {
      status: res.status,
      cfRay: ray,
      colo: ray.split('-').pop() || null,
      appVersion: res.headers.get('x-app-version'),
      serverTiming: st,
      spans: parseServerTiming(st),
    });
    try {
      const j = JSON.parse(body);
      Object.assign(sample, { count: j.count ?? null, degraded: j.degraded ?? null, retrieval: j.retrieval ?? null });
    } catch {
      sample.body = body.slice(0, 200);
    }
  } catch (err) {
    sample.error = String(err?.message ?? err); // recorded, not retried
  }
  appendFileSync(out, `${JSON.stringify(sample)}\n`);
  if (sample.colo === 'SIN' && sample.status === 200) sin += 1;
  console.log(`${sample.n} ${utc} ${sample.colo} ${sample.status} ${sample.serverTiming ?? sample.error}`);
}
console.log(`${phase}: ${calls} calls, ${sin} SIN 200s; file now holds ${n}`);
