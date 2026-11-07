#!/usr/bin/env node
// @ts-check
// 3H-0 (docs/plans/phase3.md 3H "Data", §1 "Corpus facts"): re-runs critic C's
// field counts over the pinned corpus under NORMALISER_VERSION 2, and lists
// the cohort-only prerequisite matches (the P-6 rule). Offline.
//
//   node scripts/intent-counts.mjs            print the counts
//   node scripts/intent-counts.mjs --write    also write docs/evidence/phase3/3h-0-counts.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suGrading } from '../src/vector-bundle.js';
import { NORMALISER_VERSION } from '../src/rowhash.js';
import { MODULE_INFO_PATH, loadPinnedCorpus } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs/evidence/phase3/3h-0-counts.json');

const { modules, acadYear } = await loadPinnedCorpus();
/** @type {any[]} */
const raw = JSON.parse(readFileSync(MODULE_INFO_PATH, 'utf8'));
const rawOf = new Map(raw.map((r) => [r.moduleCode, r]));
const n = (/** @type {(m: NormalisedModule) => boolean} */ p) => modules.filter(p).length;
const allZero = (/** @type {NormalisedModule} */ m) => {
  const w = rawOf.get(m.code)?.workload;
  return Array.isArray(w) && w.length > 0 && w.every((x) => x === 0);
};

const cohortOnly = modules.filter((m) => m.prereqCohortOnly).map((m) => m.code).sort();
const counts = {
  schema: 'vnm-3h0-counts/1',
  corpus: { acadYear, modules: modules.length, normaliserVersion: NORMALISER_VERSION },
  exams: {
    withExamSomeOfferedSemester: n((m) => m.examSemesters.length > 0),
    noExamAnyOfferedSemester: n((m) => m.examSemesters.length === 0),
    mixedAcrossOfferedSemesters: n((m) => m.examSemesters.length > 0 && m.examSemesters.length < m.semesters.length),
  },
  su: {
    attributesSu: n((m) => m.su),
    gradedCsCu: n((m) => suGrading(m.gradingBasis)),
    both: n((m) => m.su && suGrading(m.gradingBasis)),
    either: n((m) => m.su || suGrading(m.gradingBasis)),
    grsuNotStored: modules.filter((m) => rawOf.get(m.code)?.attributes?.grsu === true).length,
  },
  workload: {
    hoursNull: n((m) => m.workloadHours === null),
    allZeroArray: n(allZero),
    missingOrUnparseable: n((m) => m.workloadHours === null && !allZero(m)),
    below10Light: n((m) => m.workloadHours !== null && m.workloadHours < 10),
    fourMc: n((m) => m.credits === 4),
    fourMcExactly10: n((m) => m.credits === 4 && m.workloadHours === 10),
  },
  prerequisites: {
    none: n((m) => m.prereqNone),
    cohortOnly: cohortOnly.length,
    noneOrCohortOnly: n((m) => m.prereqNone || m.prereqCohortOnly),
    cohortOnlyCodes: cohortOnly,
  },
};

console.log(JSON.stringify({ ...counts, prerequisites: { ...counts.prerequisites, cohortOnlyCodes: `${cohortOnly.length} codes` } }, null, 2));
if (process.argv.includes('--write')) writeFileSync(OUT, `${JSON.stringify(counts, null, 2)}\n`);
