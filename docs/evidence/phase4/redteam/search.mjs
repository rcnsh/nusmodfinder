#!/usr/bin/env node
// Red-team search helper. Usage: node ~/.config/vnm/redteam/search.mjs <persona-id> "<query>"
// Sends one exchange-mode search for your persona to the live course planner and prints
// every course it shows (results and their variants) with the NUSMods facts for each.
// At most 10 searches per persona. Calls are spaced across all personas; just wait.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const K = dirname(fileURLToPath(import.meta.url));
const [id, q] = process.argv.slice(2);
const personas = JSON.parse(readFileSync(`${K}/personas.json`, 'utf8'));
const p = personas[id];
if (!p || !q) { console.error('usage: search.mjs <persona-id> "<query>"'); process.exit(2); }
const facts = JSON.parse(readFileSync(`${K}/facts.json`, 'utf8'));
const log = `${K}/raw/${id}.jsonl`;
const used = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === 200).length : 0;
if (used >= 10) { console.error(`persona ${id} has used its 10 searches`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lock() {
  for (;;) {
    try { mkdirSync(`${K}/.lock`); return; } catch { /* held */ }
    try { if (Date.now() - Number(readFileSync(`${K}/.lock-at`, 'utf8')) > 60_000) rmSync(`${K}/.lock`, { recursive: true, force: true }); } catch { /* none */ }
    await sleep(200);
  }
}
const url = `https://vector-nusmods.jacobjameswiltshire.workers.dev/search?${new URLSearchParams({ q, ng: '1', sem: String(p.sem), study: p.study })}`;
let body, status;
for (let attempt = 0; attempt < 5; attempt++) {
  await lock();
  writeFileSync(`${K}/.lock-at`, String(Date.now()));
  try {
    const last = existsSync(`${K}/.last`) ? Number(readFileSync(`${K}/.last`, 'utf8')) : 0;
    const wait = last + 4000 - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (vnm red team)' } });
    writeFileSync(`${K}/.last`, String(Date.now()));
    status = res.status; body = await res.json().catch(() => null);
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), q, url, status, body })}\n`);
  } finally { rmSync(`${K}/.lock`, { recursive: true, force: true }); }
  if (status !== 429) break;
  await sleep(6000);
}
if (status !== 200) { console.error(`search failed: HTTP ${status} ${JSON.stringify(body)?.slice(0, 200)}`); process.exit(1); }
console.log(`search ${used + 1}/10 for ${id} (Sem ${p.sem}, ${p.study}): "${q}"`);
if (body.noMatch) console.log(`no match: ${JSON.stringify(body.noMatch)}`);
const line = (code, indent) => { const f = facts[code] ?? {}; console.log(`${indent}${code}  ${f.title}  | dept: ${f.department} | faculty: ${f.faculty} | NUSMods semesters: ${(f.nusmodsSemesters ?? []).join(',') || 'none'}`); };
for (const r of body.results ?? []) { line(r.code, ''); for (const v of r.variants ?? []) line(v.code, '    variant: '); }
console.log(`${(body.results ?? []).length} results shown`);
