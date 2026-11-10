#!/usr/bin/env node
// @ts-check
// Ship step 5 (docs/plans/phase4.md §5, 4E A2-6): the independent oracle
// (test/sc1/oracle.node.mjs) over the production-normalised modules, against
// the ng_allow ingest computes, locally, before any D1 write. Reads the cached
// production catalogue ingest reads (.data/cache, `npm run ingest`'s download);
// sends nothing. Exit 1 on any disagreement.
//
//   node docs/evidence/phase4/ship-oracle.mjs [.data/cache/2026-2027-moduleInfo.json]
import { readFileSync } from 'node:fs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from '../../../scripts/lib.mjs';
import { NG_SEMS, STUDIES, bitOf } from '../../../src/ng-bit.js';
import { oracle } from '../../../test/sc1/oracle.node.mjs';

const path = process.argv[2] ?? `.data/cache/${DEFAULT_ACAD_YEAR}-moduleInfo.json`;
const raw = JSON.parse(readFileSync(path, 'utf8'));
const records = Array.isArray(raw) ? raw : raw.data;
const { modules } = offeredModules(records, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));
/** @type {string[]} */
const differ = [];
let cases = 0, shown = 0;
for (const m of modules) {
  for (const sem of NG_SEMS) {
    for (const study of STUDIES) {
      cases++;
      const stored = (m.ngAllow & bitOf(sem, study)) !== 0;
      const want = oracle(m, { sem, study }) !== 'closed';
      if (stored) shown++;
      if (stored !== want) differ.push(`${m.code} sem ${sem} ${study}: ingest ${stored ? 'shown' : 'closed'}, oracle ${want ? 'shown' : 'closed'}`);
    }
  }
}
console.log(`ship oracle: ${modules.length} production modules (${path}), ${cases} cases, ${shown} shown, ${differ.length} differences`);
for (const d of differ.slice(0, 50)) console.log(`  ${d}`);
process.exit(differ.length ? 1 : 0);
