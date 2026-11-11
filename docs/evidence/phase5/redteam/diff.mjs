#!/usr/bin/env node
// @ts-check
// Phase 5 red team: diffs every persona answer (answers/<id>.json) against
// the expected answer from the oracle and the persona's brief (rules.mjs,
// expected.mjs), mechanically, as Phase 4's diff.mjs did. Sends nothing.
//
//   node docs/evidence/phase5/redteam/diff.mjs [.data/cache/2026-2027-moduleInfo.json]
// Writes docs/evidence/phase5/redteam/diff.json; prints a table per persona
// and every disagreement. Also checks each answer against expected.json (the
// table committed before the run), so the rules can't have moved since.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expectedFor, loadModules } from './expected.mjs';
import { normalise } from './rules.mjs';

const HERE = new URL('.', import.meta.url);
const byCode = await loadModules(process.argv[2]);
const personas = JSON.parse(readFileSync(new URL('personas.json', HERE), 'utf8'));
const frozen = JSON.parse(readFileSync(new URL('expected.json', HERE), 'utf8')).expected;

/** @type {any[]} */
const rows = [];
/** @type {Record<string, { answers: number, agree: number, disagree: number, missing: number }>} */
const totals = {};
for (const [id, p] of Object.entries(personas)) {
  const file = new URL(`answers/${id}.json`, HERE);
  if (!existsSync(file)) { console.log(`${id}: no answers file`); continue; }
  const answers = JSON.parse(readFileSync(file, 'utf8'));
  const t = (totals[id] = { answers: 0, agree: 0, disagree: 0, missing: 0 });
  const seen = new Set();
  for (const a of answers) {
    const code = String(a.code).toUpperCase().replace(/\s+/g, '');
    const sem = Number(a.sem ?? (p.sems.length === 1 ? p.sems[0] : NaN));
    const got = normalise(a.answer);
    const e = expectedFor(byCode, p, code, sem);
    const frozenAnswer = (frozen[id]?.[String(sem)]?.[code] ?? 'no').split(' ')[0];
    if (frozenAnswer !== e.answer) throw new Error(`${id} ${code} Sem ${sem}: expected ${e.answer} now, ${frozenAnswer} in expected.json`);
    seen.add(code);
    t.answers++;
    const agree = got === e.answer;
    if (agree) t.agree++; else t.disagree++;
    rows.push({
      persona: id, code, sem, persona_answer: a.answer, persona_norm: got, expected: e.answer, agree,
      kinds: e.kinds, oracle: e.oracle.result, oracle_closed: e.oracle.closed, oracle_notes: e.oracle.notes,
      page_said: a.page_said, where: a.where, confidence: a.confidence,
    });
  }
  for (const code of p.list ?? []) if (!seen.has(code)) { t.missing++; rows.push({ persona: id, code, kind: 'missing-list-answer' }); }
}
writeFileSync(new URL('diff.json', HERE), `${JSON.stringify({ totals, rows }, null, 1)}\n`);
for (const [id, t] of Object.entries(totals)) console.log(`${id}: ${t.answers} answers, ${t.agree} agree, ${t.disagree} disagree${t.missing ? `, ${t.missing} list codes unanswered` : ''}`);
console.log('\n| persona | code | sem | persona | expected | kinds | agree |\n|---|---|---|---|---|---|---|');
for (const r of rows) if (r.code && !r.kind) console.log(`| ${r.persona} | ${r.code} | ${r.sem} | ${r.persona_answer} | ${r.expected} | ${r.kinds.join(', ')} | ${r.agree ? 'yes' : '**no**'} |`);
for (const r of rows) if (r.kind) console.log(`\nMISSING ${r.persona} ${r.code}: a list code with no answer`);
for (const r of rows) if (!r.kind && !r.agree) console.log(`\nDISAGREE ${r.persona} ${r.code} Sem ${r.sem}: persona "${r.persona_answer}" vs expected ${r.expected} (${[...(r.oracle_closed ?? []), ...(r.oracle_notes ?? [])].join('; ')})\n  page said: ${r.page_said}`);
