#!/usr/bin/env node
// @ts-check
// Phase 5 red team: every persona's expected answer for every course offered
// this year, in each of its semesters, from the oracle and its brief alone
// (rules.mjs). Run and committed before any persona runs, so the expected
// answers are fixed for whatever course a persona picks. Sends nothing.
//
//   node docs/evidence/phase5/redteam/expected.mjs [.data/cache/2026-2027-moduleInfo.json]
// Writes docs/evidence/phase5/redteam/expected.json: per persona and
// semester, every code whose answer isn't "no" (any other offered code is
// "no"; a code not offered this year is "no").
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from '../../../../scripts/lib.mjs';
import { explain } from '../../../../test/sc1/oracle.node.mjs';
import { expected } from './rules.mjs';

const HERE = new URL('.', import.meta.url);

/** @param {string} [path] */
export async function loadModules(path = `.data/cache/${DEFAULT_ACAD_YEAR}-moduleInfo.json`) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const { modules } = offeredModules(Array.isArray(raw) ? raw : raw.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));
  return new Map(modules.map((m) => [m.code, m]));
}

/**
 * @param {Map<string, any>} byCode
 * @param {any} p personas.json entry
 * @param {string} code
 * @param {number} sem
 */
export function expectedFor(byCode, p, code, sem) {
  const m = byCode.get(code);
  const o = m ? explain(m, { sem, study: p.study }) : { result: /** @type {const} */ ('closed'), closed: ['not offered this year'], notes: [] };
  return { ...expected(o, p.brief), oracle: o };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const byCode = await loadModules(process.argv[2]);
  const personas = JSON.parse(readFileSync(new URL('personas.json', HERE), 'utf8'));
  /** @type {Record<string, Record<string, Record<string, string>>>} */
  const out = {};
  const counts = {};
  for (const [id, p] of Object.entries(personas)) {
    out[id] = {};
    for (const sem of p.sems) {
      const bySem = {};
      const c = { yes: 0, 'yes-if': 0, ask: 0, no: 0 };
      for (const code of [...byCode.keys()].sort()) {
        const e = expectedFor(byCode, p, code, sem);
        c[e.answer]++;
        if (e.answer !== 'no') bySem[code] = `${e.answer} [${e.kinds.join(', ')}]`;
      }
      out[id][String(sem)] = bySem;
      counts[`${id} Sem ${sem}`] = c;
    }
  }
  writeFileSync(new URL('expected.json', HERE), `${JSON.stringify({ note: 'Every offered code not listed for a persona and semester is "no".', modules: byCode.size, expected: out }, null, 1)}\n`);
  console.log(JSON.stringify(counts, null, 1));
}
