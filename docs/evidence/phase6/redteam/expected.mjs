#!/usr/bin/env node
// @ts-check
// Phase 6 red team: every persona's expected answer for every course offered
// in 2026/27 and every NG-listed code with no classes (a 404 of kind
// `ng-listed`), in each of its semesters, from the SC1 oracle and its brief
// alone (rules.mjs). Run and committed before any persona runs, so the
// expected answers are fixed for whatever course a persona picks. Sends
// nothing.
//
//   node docs/evidence/phase6/redteam/expected.mjs
// Reads .data/cache/2026-2027-moduleInfo.json normalised as ingest does (as
// `p5-live --corpus production` and `p6-live` do) and data/ng-unscheduled.json.
// Writes docs/evidence/phase6/redteam/expected.json: per persona and
// semester, every code whose answer isn't "no" (any other code is "no").
import { readFileSync, writeFileSync } from 'node:fs';
import { loadModules as loadOffered } from '../../../../scripts/p5-live-plan.mjs';
import { explainShown } from '../../../../test/sc1/oracle.node.mjs';
import { expected } from './rules.mjs';

const HERE = new URL('.', import.meta.url);
const ROOT = new URL('../../../../', import.meta.url);

/**
 * Production's offered modules, then the NG-listed codes with no classes as
 * the SC1 run models them (test/sc1/paths.test.js: no semesters, NG-listed).
 * @returns {Promise<Map<string, any>>}
 */
export async function loadModules() {
  const offered = await loadOffered('production');
  const byCode = new Map(offered.map((m) => [m.code, m]));
  const file = JSON.parse(readFileSync(new URL('data/ng-unscheduled.json', ROOT), 'utf8'));
  if (file.corpus !== 'production') throw new Error(`data/ng-unscheduled.json is ${file.corpus}'s, not production's`);
  for (const u of file.modules) {
    if (byCode.has(u.code)) continue; // never: the file holds only codes with no offered row
    byCode.set(u.code, { ...u, semesters: [], ng: true, ngListed404: true });
  }
  return byCode;
}

/**
 * @param {Map<string, any>} byCode
 * @param {{ study: string, brief: import('./rules.mjs').Brief }} p a persona (or the advisor's context)
 * @param {string} code
 * @param {number} sem
 */
export function expectedFor(byCode, p, code, sem) {
  const m = byCode.get(code);
  const o = m ? explainShown(m, { sem, study: p.study }) : { result: /** @type {const} */ ('closed'), closed: ['not offered in 2026/27'], notes: [] };
  return { ...expected(o, m ?? { code }, p.brief), oracle: o };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const byCode = await loadModules();
  const personas = JSON.parse(readFileSync(new URL('personas.json', HERE), 'utf8'));
  /** @type {Record<string, Record<string, Record<string, string>>>} */
  const out = {};
  /** @type {Record<string, Record<string, number>>} */
  const counts = {};
  for (const [id, p] of Object.entries(personas)) {
    out[id] = {};
    for (const sem of p.sems) {
      /** @type {Record<string, string>} */
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
  const offered = [...byCode.values()].filter((m) => !m.ngListed404).length;
  writeFileSync(new URL('expected.json', HERE), `${JSON.stringify({
    note: 'Every code not listed for a persona and semester is "no". p3 (the advisor) is at the study level and with the invitations its link gives (rules.mjs advisorBrief); this table is for p2\'s brief level, ug3, with no invitation.',
    modules: offered, ngListed404: byCode.size - offered, expected: out,
  }, null, 1)}\n`);
  console.log(JSON.stringify(counts, null, 1));
}
