#!/usr/bin/env node
// @ts-check
// Phase 6 red team: diffs every persona answer (answers/<id>.json) against
// the expected answer from the oracle and the brief (rules.mjs, expected.mjs),
// mechanically, as Phase 5's diff.mjs did, and the advisor's (p3) answers
// against advisor.mjs over the link it was given. Sends nothing.
//
//   node docs/evidence/phase6/redteam/diff.mjs
// Writes docs/evidence/phase6/redteam/diff.json; prints a table per persona
// and every disagreement. Checks each p1/p2 answer against expected.json
// (the table pushed before the run), so the rules can't have moved since.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { advisorExpected } from './advisor.mjs';
import { expectedFor, loadModules } from './expected.mjs';
import { normalise } from './rules.mjs';

const HERE = new URL('.', import.meta.url);
const byCode = await loadModules();
const personas = JSON.parse(readFileSync(new URL('personas.json', HERE), 'utf8'));
const frozen = JSON.parse(readFileSync(new URL('expected.json', HERE), 'utf8')).expected;
const read = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(rel, HERE), 'utf8'));
const code = (/** @type {unknown} */ c) => String(c).toUpperCase().replace(/\s+/g, '');
const num = (/** @type {unknown} */ v) => { const m = /-?\d+(\.\d+)?/.exec(String(v ?? '')); return m ? Number(m[0]) : null; };

/** @type {any[]} */
const rows = [];
/** @type {Record<string, { answers: number, agree: number, disagree: number }>} */
const totals = {};

for (const id of ['p1', 'p2']) {
  const p = personas[id];
  if (!existsSync(new URL(`answers/${id}.json`, HERE))) { console.log(`${id}: no answers file`); continue; }
  const t = (totals[id] = { answers: 0, agree: 0, disagree: 0 });
  for (const a of read(`answers/${id}.json`)) {
    const c = code(a.code);
    const sem = Number(a.sem ?? (p.sems.length === 1 ? p.sems[0] : NaN));
    const got = normalise(a.answer);
    const e = expectedFor(byCode, p, c, sem);
    const frozenAnswer = (frozen[id]?.[String(sem)]?.[c] ?? 'no').split(' ')[0];
    if (frozenAnswer !== e.answer) throw new Error(`${id} ${c} Sem ${sem}: expected ${e.answer} now, ${frozenAnswer} in expected.json`);
    t.answers++;
    const agree = got === e.answer;
    if (agree) t.agree++; else t.disagree++;
    rows.push({ persona: id, code: c, sem, persona_answer: a.answer, persona_norm: got, expected: e.answer, agree, kinds: e.kinds,
      oracle: e.oracle.result, oracle_closed: e.oracle.closed, oracle_notes: e.oracle.notes, page_said: a.page_said, where: a.where, confidence: a.confidence });
  }
}

// ---------- the advisor ----------
/** @type {any} */
let advisor = null;
if (existsSync(new URL('answers/p3.json', HERE)) && existsSync(new URL('artifacts/link.txt', HERE))) {
  const link = readFileSync(new URL('artifacts/link.txt', HERE), 'utf8').trim();
  const want = await advisorExpected(link);
  const got = read('answers/p3.json');
  const t = (totals.p3 = { answers: 0, agree: 0, disagree: 0 });
  /** @type {any[]} */
  const facts = [];
  /** @param {string} what @param {unknown} g @param {unknown} w @param {boolean} ok */
  const fact = (what, g, w, ok) => facts.push({ what, got: g, want: w, agree: ok });
  const gotRows = Array.isArray(got.courses) ? got.courses : [];
  for (const w of want.rows) {
    const g = gotRows.find((/** @type {any} */ x) => code(x.code) === w.code && String(x.sem ?? '') === String(w.sem ?? '') && /^b/i.test(String(x.list ?? '')) === (w.list === 'backup'))
      ?? gotRows.find((/** @type {any} */ x) => code(x.code) === w.code && String(x.sem ?? '') === String(w.sem ?? ''));
    const at = `${w.list} ${w.rank} ${w.code} Sem ${w.sem}`;
    if (!g) { fact(`${at}: answered`, null, 'an entry', false); continue; }
    fact(`${at}: rank`, g.rank, w.rank, Number(g.rank) === w.rank);
    const gForm = String(g.form ?? '');
    const formOk = w.form === null ? !/\d/.test(gForm.replace(/sem(ester)?\s*[12]/i, '')) : w.form.startsWith('won') ? /fit/i.test(gForm) : num(gForm.replace(/sem(ester)?\s*[12]\D*/i, '')) === num(w.form.replace(/^Sem [12]: /, ''));
    fact(`${at}: form number`, g.form, w.form ?? 'no number', formOk);
    fact(`${at}: department`, g.department, w.department, String(g.department ?? '').toLowerCase().includes(String(w.department).toLowerCase()));
    fact(`${at}: level`, g.level, w.level, num(g.level) === w.level || num(g.level) === (w.level ?? 0) / 1000);
    fact(`${at}: units`, g.units, w.units, num(g.units) === w.units);
    const h = num(g.study_time ?? g.hours_per_week);
    fact(`${at}: study time`, g.study_time ?? g.hours_per_week, `${w.hoursAtNusRate} at NUS's rate; NUSMods ${w.nusmodsHoursPerWeek}`, h === w.hoursAtNusRate || h === w.nusmodsHoursPerWeek);
    const n = normalise(g.answer);
    t.answers++;
    if (n === w.open) t.agree++; else t.disagree++;
    rows.push({ persona: 'p3', code: w.code, sem: Number(w.sem), list: w.list, persona_answer: g.answer, persona_norm: n, expected: w.open, agree: n === w.open, kinds: w.kinds, page_said: g.page_said, where: g.where, covers: g.covers, description: w.description });
  }
  for (const s of ['1', '2']) {
    const g = (Array.isArray(got.semesters) ? got.semesters : []).find((/** @type {any} */ x) => String(x.sem) === s);
    const w = want.semesters[s];
    if (!g) { fact(`Sem ${s}: totals`, null, w, w.counted === 0 && w.confirm === 0 && w.invite === 0); continue; }
    fact(`Sem ${s}: units counted`, g.units, w.counted, num(g.units) === w.counted);
    fact(`Sem ${s}: units to confirm`, g.units_to_confirm ?? 0, w.confirm, (num(g.units_to_confirm) ?? 0) === w.confirm);
    fact(`Sem ${s}: units only if invited`, g.units_if_invited ?? 0, w.invite, (num(g.units_if_invited) ?? 0) === w.invite);
    fact(`Sem ${s}: hours a week`, g.hours_per_week, w.hoursPerWeekAtNusRate, num(g.hours_per_week) === w.hoursPerWeekAtNusRate);
  }
  fact('year of the courses', got.year?.courses, want.year.courses, /2026\s*\/\s*(20)?27/.test(String(got.year?.courses ?? '')));
  fact('year of the exams', got.year?.exams, want.year.exams, /2026\s*\/\s*(20)?27/.test(String(got.year?.exams ?? '')));
  const extra = gotRows.filter((/** @type {any} */ x) => !want.rows.some((w) => w.code === code(x.code)));
  for (const x of extra) fact(`${code(x.code)}: an entry the link doesn't hold`, x.code, null, false);
  advisor = { link, want, facts, factsAgree: facts.filter((f) => f.agree).length, factsDisagree: facts.filter((f) => !f.agree).length };
}

writeFileSync(new URL('diff.json', HERE), `${JSON.stringify({ totals, rows, advisor }, null, 1)}\n`);
for (const [id, t] of Object.entries(totals)) console.log(`${id}: ${t.answers} answers, ${t.agree} agree, ${t.disagree} disagree`);
console.log('\n| persona | code | sem | persona | expected | kinds | agree |\n|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.persona} | ${r.code} | ${r.sem} | ${r.persona_answer} | ${r.expected} | ${r.kinds.join(', ')} | ${r.agree ? 'yes' : '**no**'} |`);
for (const r of rows) if (!r.agree) console.log(`\nDISAGREE ${r.persona} ${r.code} Sem ${r.sem}: persona "${r.persona_answer}" vs expected ${r.expected} (${[...(r.oracle_closed ?? []), ...(r.oracle_notes ?? []), ...r.kinds].join('; ')})\n  page said: ${r.page_said}`);
if (advisor) {
  console.log(`\nadvisor facts: ${advisor.factsAgree} agree, ${advisor.factsDisagree} disagree`);
  for (const f of advisor.facts) if (!f.agree) console.log(`  FACT ${f.what}: advisor ${JSON.stringify(f.got)} vs ${JSON.stringify(f.want)}`);
  if (advisor.want.flags.length) console.log(`  flags: ${advisor.want.flags.join('; ')}`);
}
