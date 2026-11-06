#!/usr/bin/env node
// Phase 3 step 3-0.0 (plan §2, 3-0.0): one warm burst of at most 12 fresh queries on the
// current deployment, on one keep-alive connection that reached SIN.
//   node embed-burst.mjs <out.jsonl> [queries.tsv]   (default embed-burst-queries.tsv)
// 1. Probe /health (no binding touched) on the connection, at most 20 times, until cf-ray ends in SIN.
// 2. Send the burst on that connection, >= 2 s between request starts, no retries.
// Records time to response headers (ttfbMs) and to the end of the body (clientMs).
import https from 'node:https';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'vector-nusmods.jacobjameswiltshire.workers.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const out = process.argv[2];
if (!out) { console.error('usage: embed-burst.mjs <out.jsonl>'); process.exit(2); }
if (existsSync(out)) { console.error(`${out} exists; the burst runs once`); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const queries = readFileSync(process.argv[3] ?? join(here, 'embed-burst-queries.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t')).map(([id, q]) => ({ id, q })).slice(0, 12);

let agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
/** @param {string} path */
function get(path) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = https.get({ host: HOST, path, agent, headers: { 'user-agent': UA, accept: 'application/json' } }, (res) => {
      const ttfbMs = Math.round(performance.now() - t0);
      const socket = res.socket;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ res, body, ttfbMs, clientMs: Math.round(performance.now() - t0), socket }));
    });
    req.on('error', reject);
  });
}
/** @param {string} header */
const spansOf = (header) => Object.fromEntries(header.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
  const [name, ...attrs] = part.split(';').map((s) => s.trim());
  const span = {};
  for (const a of attrs) { const [k, v] = a.split('='); if (k === 'dur') span.dur = Number(v); else if (k === 'desc') span.desc = v; }
  return [name, span];
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let socket = null;
let colo = null;
for (let i = 1; i <= 20; i++) {
  const r = await get('/health');
  socket = r.socket;
  colo = (r.res.headers['cf-ray'] ?? '').split('-').pop();
  appendFileSync(out, `${JSON.stringify({ kind: 'probe', i, utc: new Date().toISOString(), colo, status: r.res.statusCode, appVersion: r.res.headers['x-app-version'] })}\n`);
  console.log(`probe ${i}: ${colo}`);
  if (colo === 'SIN') break;
  // A non-SIN connection: drop the agent so the next probe opens a fresh connection.
  agent.destroy();
  agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  await sleep(500);
}
if (colo !== 'SIN') { console.error('no SIN connection after 20 probes; burst not sent'); process.exit(1); }

let last = 0;
for (const q of queries) {
  const wait = last ? 2_000 - (Date.now() - last) : 0;
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const path = `/search?${new URLSearchParams({ q: q.q })}`;
  /** @type {Record<string, unknown>} */
  const s = { kind: 'search', id: q.id, utc: new Date(last).toISOString(), path };
  try {
    const r = await get(path);
    const st = r.res.headers['server-timing'] ?? '';
    const ray = r.res.headers['cf-ray'] ?? '';
    Object.assign(s, { status: r.res.statusCode, ttfbMs: r.ttfbMs, clientMs: r.clientMs, cfRay: ray, colo: ray.split('-').pop(),
      sameSocket: r.socket === socket, appVersion: r.res.headers['x-app-version'], serverTiming: st, spans: spansOf(st) });
    try { const j = JSON.parse(r.body); Object.assign(s, { count: j.count ?? null, degraded: j.degraded ?? null }); } catch { s.body = r.body.slice(0, 200); }
  } catch (err) { s.error = String(err?.message ?? err); }
  appendFileSync(out, `${JSON.stringify(s)}\n`);
  console.log(`${s.id} ${s.colo} ${s.status} ttfb=${s.ttfbMs} ${s.serverTiming ?? s.error}`);
}
agent.destroy();
