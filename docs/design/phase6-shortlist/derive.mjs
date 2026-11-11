#!/usr/bin/env node
// @ts-check
// Phase 6 6-0: the mockup's course data, derived, never typed by hand
// (docs/plans/phase6.md §2). Every offered course comes from the test fixture
// (test/fixtures/corpus.json, the pinned 2026-09-04 release), its exchange
// status from the stored mask and rule ids through the Worker's own
// exchangeAt() (src/ng-reasons.js), and its wording through the page's own
// explain.js and format.js. EE4407, the NG-listed course with no classes, is
// not a fixture row: its fields come from production's moduleInfo cache, and
// its status from eligibility() over the committed rules, as 6A's
// ng-unscheduled.json will hold it.
//
//   node --import ./docs/design/phase6-shortlist/json-hook.mjs docs/design/phase6-shortlist/derive.mjs [moduleInfo cache]
//
// Writes docs/design/phase6-shortlist/a/data.js (window.P6).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const at = (p) => `${ROOT}${p}`;
const { exchangeAt } = await import(at('src/ng-reasons.js'));
const { bitOf } = await import(at('src/ng-bit.js'));
const { storedEligibility } = await import(at('src/eligibility.js'));
const { moduleWorkload } = await import(at('src/workload.js'));
const { noteText, reasonLine, stampText, noteLead } = await import(at('public/explain.js'));
const { examParts, examLines, workloadText, cleanPrereq } = await import(at('public/format.js'));

const fixture = JSON.parse(readFileSync(at('test/fixtures/corpus.json'), 'utf8'));
const groups = JSON.parse(readFileSync(at('test/fixtures/groups.json'), 'utf8')).groups;
const reasonsFile = JSON.parse(readFileSync(at('data/ng-reasons.json'), 'utf8'));
const ngCourses = JSON.parse(readFileSync(at('data/ng-courses-2026-2027.json'), 'utf8'));
const restrictions = JSON.parse(readFileSync(at('data/ng-restrictions-2026-2027.json'), 'utf8'));
const SOURCES = reasonsFile.sources;

const STUDY = 'ug2';
const OFFERED = ['ACC1701XA', 'ACC1701XB', 'ACC1701XC', 'CS2030', 'CS2030DE', 'CS2113', 'GE2101', 'PC3270', 'CS3244',
  'HY1101E', 'EN3264', 'PS3251', 'MA3220', 'ST2137', 'GES1034', 'LSM2212', 'CM3267', 'PC3232', 'GESS1007', 'PC4262', 'TS2239'];
const UNSCHEDULED = ['EE4407'];

const byCode = new Map(fixture.modules.map((m) => [m.code, m]));

/** @param {{ ng: number, ng_allow: number, ng_rules: string | null, prerequisite: string | null }} row */
function exchange(row) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const sem of [1, 2]) {
    const e = exchangeAt(row, bitOf(sem, STUDY));
    out[sem] = {
      status: e.status,
      stamp: stampText(e.status, sem, e.reasons.length),
      stampShort: stampText(e.status, sem, e.reasons.length, true),
      reasons: e.reasons.map((r) => ({ id: r.id, kind: r.kind, lead: noteLead(r.kind), text: noteText(r, sem), line: reasonLine(r, sem, SOURCES) })),
    };
  }
  return out;
}

/** @param {any} m @param {any} row */
function entry(m, row, extra = {}) {
  const wl = moduleWorkload(m.workload ?? null);
  const group = groups.find((g) => g.includes(m.code)) ?? [];
  return {
    code: m.code, title: m.title, description: m.description, credits: m.credits, department: m.department,
    faculty: m.faculty, level: m.level, semesters: m.semesters, ngSemesters: m.ngSemesters ?? [],
    examDates: m.examDates ?? [], exams: { both: examParts(m.examDates, ''), 1: examParts(m.examDates, '1'), 2: examParts(m.examDates, '2'), lines: examLines(m.examDates) },
    workload: wl, workloadText: workloadText(wl), prerequisite: m.prerequisite ?? null, preclusion: m.preclusion ?? null,
    prerequisiteText: m.prerequisite ? cleanPrereq(m.prerequisite) : null, preclusionText: m.preclusion ? cleanPrereq(m.preclusion) : null,
    otherCodes: group.filter((c) => c !== m.code),
    exchange: exchange(row), ...extra,
  };
}

/** @type {Record<string, any>} */
const courses = {};
for (const code of OFFERED) {
  const m = byCode.get(code);
  if (!m) throw new Error(`${code} is not in the fixture`);
  courses[code] = entry(m, { ng: m.ng ? 1 : 0, ng_allow: m.ngAllow, ng_rules: m.ngRules ? JSON.stringify(m.ngRules) : null, prerequisite: m.prerequisite ?? null });
}

const cache = process.argv[2] ?? `${process.env.HOME}/dev/vector-nusmods/.data/cache/2026-2027-moduleInfo.json`;
const info = new Map(JSON.parse(readFileSync(cache, 'utf8')).map((/** @type {any} */ x) => [x.moduleCode, x]));
for (const code of UNSCHEDULED) {
  const x = info.get(code);
  if (!x) throw new Error(`${code} is not in ${cache}`);
  const ngSemesters = [1, 2].filter((s) => ngCourses.semesters[String(s)].includes(code));
  const m = {
    code, title: x.title, description: x.description, credits: Number(x.moduleCredit), department: x.department,
    faculty: x.faculty, level: Number(code.match(/\d/)[0]), semesters: [], ng: true, ngSemesters, examDates: [],
    workload: JSON.stringify(x.workload), prerequisite: x.prerequisite ?? null, preclusion: x.preclusion ?? null,
  };
  const stored = storedEligibility(m, restrictions);
  courses[code] = entry(m, { ng: 1, ng_allow: stored.ngAllow, ng_rules: JSON.stringify(stored.ngRules), prerequisite: m.prerequisite },
    { kind: 'ng-listed', gradingBasis: x.gradingBasisDescription });
}

const out = {
  derivedBy: 'docs/design/phase6-shortlist/derive.mjs',
  fixture: fixture.source.release,
  acadYear: fixture.source.acadYear,
  study: STUDY,
  ngList: { updatedAsAt: ngCourses.updatedAsAt },
  sources: SOURCES,
  courses,
};
const dest = fileURLToPath(new URL('./a/data.js', import.meta.url));
writeFileSync(dest, `// Generated by docs/design/phase6-shortlist/derive.mjs; do not edit.\nwindow.P6 = ${JSON.stringify(out, null, 1)};\n`);
console.log(`wrote ${dest}: ${Object.keys(courses).length} courses`);
for (const [code, c] of Object.entries(courses)) {
  console.log(code.padEnd(10), c.credits, 'L' + c.level, '| S1', c.exchange[1].stamp, c.exchange[1].reasons.map((r) => r.id).join(','), '| S2', c.exchange[2].stamp, c.exchange[2].reasons.map((r) => r.id).join(','), '|', c.exams.lines.join('; '));
}
