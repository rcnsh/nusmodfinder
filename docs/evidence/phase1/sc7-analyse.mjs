#!/usr/bin/env node
// SC7 analysis (method: sc7.md). Reads sc7-samples.jsonl and sc7-logs.jsonl
// next to this script and prints the report.
//
//   node sc7-analyse.mjs                       # report (markdown)
//   node sc7-analyse.mjs --tsv                 # sc7-requests.tsv rows
//   node sc7-analyse.mjs --extract <tail.out>  # writes sc7-logs.jsonl from raw `wrangler tail --format json`
//   node sc7-analyse.mjs --exclude <fromISO>/<toISO>[,...]  # drop samples in lead-declared ingest windows
//
// --extract keeps only the Worker's own `"event":"search"` log lines for the
// pre-registered queries (never request headers, IPs or other people's searches).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, 'sc7-samples.jsonl');
const LOGS = join(here, 'sc7-logs.jsonl');
const QUERIES = join(here, 'sc7-queries.tsv');
const THRESHOLD_MS = 250;
const BOOT = 10_000;
const SEED = 7;

const args = process.argv.slice(2);
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const queries = readFileSync(QUERIES, 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t')).map(([id, set, q, params = '']) => ({ id, set, q, params }));

/** Filters as the Worker logs them (`log.filters`), for matching a log line to a query. */
function filterKey(params) {
  const p = new URLSearchParams(params);
  const o = {};
  if (p.has('sem')) o.sem = Number(p.get('sem'));
  if (p.has('level')) o.level = Number(p.get('level'));
  if (p.has('ng')) o.ng = true;
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}
const logFilterKey = (f = {}) => JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k]]));

/** Splits a stream of concatenated (possibly pretty-printed) JSON values. */
function* jsonValues(text) {
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && --depth === 0) yield text.slice(start, i + 1);
  }
}

if (args[0] === '--extract') {
  const raw = readFileSync(args[1], 'utf8');
  const wanted = new Map(queries.map((q) => [`${q.q}\t${filterKey(q.params)}`, q.id]));
  const out = [];
  for (const chunk of jsonValues(raw)) {
    let ev;
    try { ev = JSON.parse(chunk); } catch { continue; }
    for (const log of ev.logs ?? []) {
      for (const m of log.message ?? []) {
        let line;
        try { line = typeof m === 'string' ? JSON.parse(m) : m; } catch { continue; }
        if (line?.event !== 'search') continue;
        const id = wanted.get(`${line.q}\t${logFilterKey(line.filters)}`);
        if (!id) continue;
        out.push({
          id, ts: new Date(log.timestamp ?? ev.eventTimestamp).toISOString(),
          scriptVersion: ev.scriptVersion?.id ?? null, ...line,
        });
      }
    }
  }
  writeFileSync(LOGS, out.map((o) => JSON.stringify(o)).join('\n') + (out.length ? '\n' : ''));
  console.log(`wrote ${out.length} search log lines to ${LOGS}`);
  process.exit(0);
}

const samples = readJsonl(SAMPLES);
const logs = readJsonl(LOGS);
const logById = new Map(logs.map((l) => [l.id, l]));

if (args[0] === '--tsv') {
  for (const s of samples) {
    const st = s.serverTiming || '<absent>';
    const detail = s.error
      ? `error=${s.error}`
      : `http=${s.status} colo=${s.colo} cf-ray=${s.cfRay} x-app-version=${s.appVersion} | server-timing=${st}`;
    console.log([s.n, 'fetch', `[sc7 ${s.id}] ${s.utc} GET ${s.path} | ${detail}`, `phase1 SC7 ${s.phase}`].join('\t'));
  }
  process.exit(0);
}

const windows = [];
const ex = args.indexOf('--exclude');
if (ex !== -1) {
  for (const w of args[ex + 1].split(',')) {
    const [a, b] = w.split('/').map((t) => Date.parse(t));
    windows.push([a, b]);
  }
}
const excluded = (s) => windows.some(([a, b]) => Date.parse(s.utc) >= a && Date.parse(s.utc) <= b);

// Quantile, linear interpolation between order statistics (R type 7); p50 is the usual median.
function quantile(xs, p) {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  return v[lo] + (h - lo) * ((v[lo + 1] ?? v[lo]) - v[lo]);
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Percentile bootstrap CI (95%) of the median.
function bootstrapMedianCI(xs) {
  const rnd = mulberry32(SEED);
  const meds = [];
  for (let b = 0; b < BOOT; b++) {
    const r = Array.from(xs, () => xs[Math.floor(rnd() * xs.length)]);
    meds.push(quantile(r, 0.5));
  }
  return [quantile(meds, 0.025), quantile(meds, 0.975)];
}
const f1 = (x) => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');

const ok = samples.filter((s) => s.status === 200 && s.spans?.cache?.desc === 'miss');
const pooled = ok.filter((s) => s.colo === 'SIN' && !excluded(s));
const total = (s) => s.spans.total.dur;
const lines = [];
const p = (...a) => lines.push(a.join(''));

p(`Samples: ${samples.length} calls; ${ok.length} HTTP 200 cache misses; ${pooled.length} pooled (SIN, outside excluded windows).`);
const colos = {};
for (const s of samples) colos[s.colo ?? 'error'] = (colos[s.colo ?? 'error'] ?? 0) + 1;
p(`Colos: ${Object.entries(colos).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
const versions = {};
for (const s of samples) versions[s.appVersion ?? 'none'] = [...(versions[s.appVersion ?? 'none'] ?? []), s.n];
p(`x-app-version: ${Object.entries(versions).map(([k, v]) => `${k} ${v.length} (${v[0]}–${v[v.length - 1]})`).join(', ')}.`);
const notMiss = samples.filter((s) => s.status === 200 && s.spans?.cache?.desc !== 'miss');
if (notMiss.length) p(`Not cache misses (excluded): ${notMiss.map((s) => s.n).join(', ')}.`);
const bad = samples.filter((s) => s.status !== 200);
if (bad.length) p(`Non-200 (excluded): ${bad.map((s) => `${s.n} ${s.status ?? s.error}`).join(', ')}.`);
if (windows.length) p(`Excluded windows: ${args[ex + 1]} → ${ok.filter(excluded).map((s) => s.n).join(', ') || 'none'}.`);
const degraded = pooled.filter((s) => s.degraded);
p(`Degraded (keyword-only) among pooled: ${degraded.length}.`);
p('');

const t = pooled.map(total);
const [lo, hi] = bootstrapMedianCI(t);
const verdict = quantile(t, 0.5) < THRESHOLD_MS ? 'PASS' : 'FAIL';
p('| set | n | p50 total | p90 total | 95% bootstrap CI of p50 |');
p('|---|---|---|---|---|');
for (const [name, set] of [['pooled (rule)', pooled], ['warm', pooled.filter((s) => s.phase === 'warm')], ['sparse', pooled.filter((s) => s.phase === 'sparse')]]) {
  const xs = set.map(total);
  const [a, b] = xs.length ? bootstrapMedianCI(xs) : [NaN, NaN];
  p(`| ${name} | ${xs.length} | ${f1(quantile(xs, 0.5))} | ${f1(quantile(xs, 0.9))} | ${f1(a)}–${f1(b)} |`);
}
const nonSin = ok.filter((s) => s.colo !== 'SIN');
if (nonSin.length) {
  const xs = nonSin.map(total);
  p(`| non-SIN (reported, not judged) | ${xs.length} | ${f1(quantile(xs, 0.5))} | ${f1(quantile(xs, 0.9))} | — |`);
}
p('');
p(`**Verdict: ${verdict}** — pooled SIN p50 of \`total\` = ${f1(quantile(t, 0.5))} ms (95% CI ${f1(lo)}–${f1(hi)}, n = ${t.length}); rule: < ${THRESHOLD_MS} ms.`);
p('');

const SPANS = ['cache', 'limit', 'pin', 'embed', 'vector', 'fts', 'hydrate', 'total'];
p('Per-span medians over pooled samples (ms; n = samples where the span ran):');
p('');
p('| span | warm p50 | sparse p50 | pooled p50 | pooled p90 | n |');
p('|---|---|---|---|---|---|');
for (const name of SPANS) {
  const get = (set) => set.map((s) => s.spans?.[name]?.dur).filter((x) => typeof x === 'number');
  const all = get(pooled);
  if (!all.length) continue;
  p(`| ${name} | ${f1(quantile(get(pooled.filter((s) => s.phase === 'warm')), 0.5))} | ${f1(quantile(get(pooled.filter((s) => s.phase === 'sparse')), 0.5))} | ${f1(quantile(all, 0.5))} | ${f1(quantile(all, 0.9))} | ${all.length} |`);
}
p('');

// Replication and rows read, from the Worker's structured log.
p(`Structured log lines matched: ${samples.filter((s) => logById.has(s.id)).length} of ${samples.length}.`);
p('');
p('| n | id | phase | utc | colo (header) | colo (log) | filters | total | fts | hydrate | D1 queries | rows read | servedByRegion | servedByPrimary |');
p('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of samples) {
  const l = logById.get(s.id);
  const fl = new URLSearchParams(s.path.split('?')[1]); fl.delete('q');
  p(`| ${s.n} | ${s.id} | ${s.phase} | ${s.utc.slice(11, 19)} | ${s.colo} | ${l?.colo ?? '—'} | ${fl.toString() || '—'} | ${f1(s.spans?.total?.dur)} | ${f1(s.spans?.fts?.dur)} | ${f1(s.spans?.hydrate?.dur)} | ${l?.d1?.queries ?? '—'} | ${l?.d1?.rowsRead ?? '—'} | ${l ? (l.d1.servedByRegion.join(', ') || '(none)') : '—'} | ${l ? String(l.d1.servedByPrimary) : '—'} |`);
}
p('');
const withLog = samples.filter((s) => logById.has(s.id));
const regions = {};
for (const s of withLog) {
  const key = `${logById.get(s.id).d1.servedByRegion.join('+') || '(none)'} primary=${logById.get(s.id).d1.servedByPrimary}`;
  regions[key] = (regions[key] ?? 0) + 1;
}
p(`Serving region (primary is WEUR): ${Object.entries(regions).map(([k, v]) => `${k}: ${v}`).join('; ') || 'no log lines'}.`);
const rows = (set) => set.map((s) => logById.get(s.id)?.d1?.rowsRead).filter((x) => typeof x === 'number');
const isFiltered = (s) => { const u = new URLSearchParams(s.path.split('?')[1]); u.delete('q'); return [...u].length > 0; };
p('');
p('| rows read per search | n | min | p50 | p90 | max | mean |');
p('|---|---|---|---|---|---|---|');
for (const [name, set] of [['all', withLog], ['unfiltered', withLog.filter((s) => !isFiltered(s))], ['filtered', withLog.filter(isFiltered)]]) {
  const xs = rows(set);
  if (!xs.length) continue;
  p(`| ${name} | ${xs.length} | ${Math.min(...xs)} | ${quantile(xs, 0.5)} | ${f1(quantile(xs, 0.9))} | ${Math.max(...xs)} | ${f1(xs.reduce((a, b) => a + b, 0) / xs.length)} |`);
}
console.log(lines.join('\n'));
