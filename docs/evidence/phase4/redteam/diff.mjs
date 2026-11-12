#!/usr/bin/env node
// @ts-check
// Persona red team, step 3 (docs/plans/phase4.md §7): diffs every persona's
// open/note/closed call against the independent oracle over the
// production-normalised modules, and checks every course the live searches
// showed is one the oracle shows, with the oracle's status on its card.
// Sends nothing.
//
//   node docs/evidence/phase4/redteam/diff.mjs <kit dir> [.data/cache/2026-2027-moduleInfo.json]
// Writes <kit dir>/diff.json; prints counts and every disagreement.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from '../../../../scripts/lib.mjs';
import { explain } from '../../../../test/sc1/oracle.mjs';

const kit = process.argv[2];
if (!kit) { console.error('usage: diff.mjs <kit dir> [catalogue]'); process.exit(2); }
const path = process.argv[3] ?? `.data/cache/${DEFAULT_ACAD_YEAR}-moduleInfo.json`;
const raw = JSON.parse(readFileSync(path, 'utf8'));
const { modules } = offeredModules(Array.isArray(raw) ? raw : raw.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));
const byCode = new Map(modules.map((m) => [m.code, m]));
const personas = JSON.parse(readFileSync(`${kit}/personas.json`, 'utf8'));
const sample = JSON.parse(readFileSync(`${kit}/sample.json`, 'utf8'));

/** @type {any[]} */
const out = [];
const totals = { calls: 0, agree: 0, leak: 0, overHide: 0, noteDiff: 0, liveShownClosed: 0, liveStatusDiff: 0, cards: 0, searches: 0, missingSample: 0 };
for (const [id, p] of Object.entries(personas)) {
  const ctx = { sem: p.sem, study: p.study };
  const calls = JSON.parse(readFileSync(`${kit}/calls/${id}.json`, 'utf8'));
  const called = new Set(calls.map((/** @type {any} */ c) => c.code));
  for (const c of sample.codes) if (!called.has(c)) { totals.missingSample++; out.push({ persona: id, code: c, kind: 'missing-sample-call' }); }
  // Live: every course shown (results and variants) must be one the oracle shows.
  const shown = new Set();
  const log = `${kit}/raw/${id}.jsonl`;
  for (const line of existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) {
    const r = JSON.parse(line);
    if (r.status !== 200) continue;
    totals.searches++;
    for (const res of r.body.results ?? []) {
      totals.cards++;
      const m = byCode.get(res.code);
      const want = m ? explain(m, ctx).result : 'closed';
      if (res.exchange?.status !== want) { totals.liveStatusDiff++; out.push({ persona: id, code: res.code, kind: 'live-status', live: res.exchange?.status, oracle: want }); }
    }
    for (const res of r.body.results ?? []) for (const code of [res.code, ...(res.variants ?? []).map((/** @type {any} */ v) => v.code)]) {
      shown.add(code);
      const m = byCode.get(code);
      if (!m || explain(m, ctx).result === 'closed') { totals.liveShownClosed++; out.push({ persona: id, code, kind: 'live-shown-closed' }); }
    }
  }
  for (const c of calls) {
    totals.calls++;
    const m = byCode.get(c.code);
    const o = m ? explain(m, ctx) : { result: 'closed', closed: ['not offered this year'], notes: [] };
    if (o.result === c.call) { totals.agree++; continue; }
    const kind = c.call === 'closed' ? 'leak' : o.result === 'closed' ? 'overHide' : 'noteDiff';
    totals[kind]++;
    out.push({ persona: id, ctx, code: c.code, kind, shown: shown.has(c.code), persona_call: c.call, persona_why: c.why, oracle: o.result, oracle_closed: o.closed, oracle_notes: o.notes });
  }
}
writeFileSync(`${kit}/diff.json`, `${JSON.stringify({ totals, disagreements: out }, null, 1)}\n`);
console.log(JSON.stringify(totals));
for (const d of out) console.log(`${d.persona} ${d.kind} ${d.code}${d.shown ? ' (shown)' : ''}: persona ${d.persona_call ?? '-'} | oracle ${d.oracle ?? '-'} ${[...(d.oracle_closed ?? []), ...(d.oracle_notes ?? [])].join('; ').slice(0, 140)} || ${String(d.persona_why ?? '').slice(0, 160)}`);
