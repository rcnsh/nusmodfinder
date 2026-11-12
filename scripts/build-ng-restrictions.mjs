#!/usr/bin/env node
// @ts-check
// Builds data/ng-restrictions-<year>.json, the rules src/eligibility.js reads
// (docs/plans/phase4.md 4B). Inputs:
//   - docs/evidence/phase4/transcription-b.json: the restrictions PDF as
//     transcribed (diffed against transcription A, docs/evidence/phase4/transcription.md);
//     every code, title and quote below comes from it;
//   - OVERLAY below: how each transcribed rule matches NUSMods fields, per the
//     interpretations register (docs/evidence/phase4/interpretations.md);
//   - the sources outside the repo (~/.config/vnm/sources/<date>/, hashes in
//     docs/evidence/phase4/sources.md): the self-funded course list and the
//     YST elective lists are extracted here.
//
//   node scripts/build-ng-restrictions.mjs [--sources <dir>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ACAD_YEAR } from './lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Phase 7 7D, one year source: DEFAULT_ACAD_YEAR. The sources folder is the newest revision's
// (7E moves it to the year's source manifest, data/ng-sources-<year>.json).
const ACAD_YEAR = DEFAULT_ACAD_YEAR;
const SOURCES_DIR = '2026-11-10';
const OUT = join(ROOT, `data/ng-restrictions-${ACAD_YEAR}.json`);
const args = process.argv.slice(2);
const SOURCES = args.includes('--sources') ? args[args.indexOf('--sources') + 1]
  : join(homedir(), '.config/vnm/sources', SOURCES_DIR);

/** @typedef {import('../src/eligibility.js').Study} Study */
/** @typedef {import('../src/eligibility.js').RuleMatch} RuleMatch */
/** @type {Study[]} */ const UG = ['ug1', 'ug2', 'ug3', 'ug4'];
/** @type {Study[]} */ const GRAD = ['grad'];
/** @type {Study[]} */ const UG12 = ['ug1', 'ug2'];
/** @type {Study[]} */ const UG4_GRAD = ['ug4', 'grad'];

// PDF department headings -> NUSMods `department` (register: "Department map").
const DEPT = /** @type {const} */ ({
  cls: 'Centre for Language Studies', chinese: 'Chinese Studies', cnm: 'Communications and New Media', econ: 'Economics',
  elts: 'English,Ling.andTheatre Studies', geog: 'Geography', hist: 'History', js: 'Japanese Studies', malay: 'Malay Studies',
  polsci: 'Political Science', psych: 'Psychology', socwork: 'Social Work', socanth: 'Sociology and Anthropology',
  sas: 'South Asian Studies', sea: 'Southeast Asian Studies', socDean: "SoC Dean's Office", mdp: 'Computing and Engineering Programme',
  cs: 'Computer Science', isa: 'Information Systems and Analytics', arch: 'Architecture', bme: 'Biomedical Engineering',
  be: 'Built Environment', cbe: 'Chemical and Biomolecular Engineering', cee: 'Civil and Environmental Engineering',
  ece: 'Electrical and Computer Engineering', isem: 'Industrial Systems Engineering and Management',
  mse: 'Materials Science and Engineering', me: 'Mechanical Engineering', design: 'Design', fosDean: "FoS Dean's Office",
  bio: 'Biological Sciences', chem: 'Chemistry', fst: 'Food Science and Technology', math: 'Mathematics',
  pharm: 'PharmacyandPharmaceuticalScience', phys: 'Physics', stats: 'Statistics and Data Science',
  nursing: 'Alice Lee Center for Nursing Studies', rmi: 'Risk Management Institute',
});
const FAC = /** @type {const} */ ({
  fass: 'Arts and Social Science', biz: 'NUS Business School', cde: 'College of Design and Engineering', law: 'Law',
  yst: 'YST Conservatory of Music', dentistry: 'Dentistry', medicine: 'Yong Loo Lin Sch of Medicine',
  sph: 'SSH School of Public Health', lkyspp: 'LKY School of Public Policy', iss: 'NUS-ISS', scale: 'Cont and Lifelong Education', tli: 'Logistics Inst-Asia Pac',
});

// Dual-coded Architecture pairs, linked by preclusion (register C2-2): a code
// rule on one applies to its twin.
const TWINS = /** @type {Record<string, string>} */ ({ AR4220: 'AR5221', AR4321: 'AR5321', AR4601: 'AR5601' });

// Compulsory LLB courses (restrictions §5 "See HERE"), transcribed from
// law-compulsory-llb-courses.png. None is on the NG list (sources.md).
const LAW_COMPULSORY = ('LC1001A LC1001B LC1001C LC1001D LC1001E LC1001F LC1001H LC1002A LC1002B LC1002C LC1002D LC1002E ' +
  'LC1002F LC1002G LC1002H LC1003 LC1004 LC1016 LC2009 LC1025 LC2018 LC2008A LC2008C LC2008D LC2008E LC2008F LC2008G ' +
  'LC2008H LC2007 LC2013 LC2006A LC2006B LC2006C LC2006D LC2006E LC2006F LC2006G LC2006H LC2010A LC2010B LC2010C ' +
  'LC2010E LC2010F LC2010H LC2004 LC2012 LC3001A LC2017').split(' ');

/**
 * One output rule per entry: `codes: true` takes the transcribed codes. An
 * entry `{ info }` records the rule as `info` (no eligibility effect), with the
 * register row that says why. Phase 6 6A: an info rule about courses off the
 * exchange list also gets `offList`, the scope its quote states (departments
 * and levels, or a faculty, matched on a row's fields, never by code prefix;
 * `{}` for every course); its entry then carries the quote as `text` and that
 * scope, which build-ng-reasons.mjs passes to /facets as `offListRules`.
 * @typedef {{ suffix?: string, effect: 'closed' | 'note' | 'open', note?: string, studies?: Study[], codes?: boolean,
 *   match?: RuleMatch, reason: string }} Part
 * @typedef {{ departments?: string[], faculties?: string[], levels?: number[] }} OffListScope
 * @type {Record<string, Part[] | { info: string, offList?: OffListScope }>}
 */
const OVERLAY = {
  'A-dentistry': [{ effect: 'closed', match: { faculties: [FAC.dentistry] }, reason: 'Faculty of Dentistry courses are not open to exchange students.' }],
  'A-medicine': [{ effect: 'closed', match: { faculties: [FAC.medicine], notCodeRe: '^LSM' }, reason: 'Medicine courses are not open to exchange students. This rule does not cover courses whose code starts with LSM.' }],
  'A-public-health': [{ effect: 'closed', match: { faculties: [FAC.sph], levels: [5, 6] }, reason: 'Public Health graduate courses are not open to exchange students.' }],
  'A-nursing': [{ effect: 'closed', match: { departments: [DEPT.nursing] }, reason: 'Nursing courses are not open to exchange students.' }],
  'A-iss': [{ effect: 'closed', match: { faculties: [FAC.iss] }, reason: 'Institute of Systems Science courses are not open to exchange students.' }],
  'A-self-funded': [{ effect: 'closed', match: { codes: [] /* filled from the self-funded list below */ }, reason: 'Courses in NUS self-funded programmes are not open to exchange students.' }],
  'A-fee': { info: 'applies only after an exceptional approval of a closed course' },
  'B-suffix-x': [{ effect: 'closed', codes: true, reason: 'This X-suffix course is not open to exchange students.' }],
  'C-urop-fass': [{ effect: 'closed', match: { faculties: [FAC.fass], titleRe: '\\bUROPS?\\b|Undergraduate Research Opportunit' }, reason: 'Undergraduate research courses (UROP) in Arts & Social Sciences are not open to exchange students.' }],
  'C-urop-cde': [{ effect: 'closed', match: { faculties: [FAC.cde], titleRe: '\\bUROPS?\\b|Undergraduate Research Opportunit' }, reason: 'Undergraduate research courses (UROP) in Design & Engineering are not open to exchange students.' }],
  'D-level-digit': { info: 'definition' },
  'D-ug-levels': { info: 'definition' },
  'D-grad-levels-closed-exchange': { info: 'built into src/eligibility.js as the level default (plan §2 step 2)' },
  'E-case-by-case': { info: "Jacob's Q7: courses off the NG list are hidden" },
  'E-offerings-list': { info: "Jacob's Q7", offList: {} },
  'F-links': { info: 'links only' },
  '1-cls-table': [{ effect: 'closed', codes: true, reason: 'Listed by the Centre for Language Studies as not available to exchange students.' }],
  '1-cls-graded': [{ effect: 'note', note: 'graded', match: { departments: [DEPT.cls] }, reason: 'You must take it for a grade. You cannot audit it (attend without a grade).' }],
  '1-chinese-l456-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.chinese], levels: [4, 5, 6] }, reason: 'Chinese Studies level 4000+ courses are not open to exchange undergraduates.' }],
  '1-cnm-table': [{ effect: 'closed', codes: true, reason: 'Listed by Communications and New Media as not available to exchange students.' }],
  '1-cnm-l4': [{ effect: 'closed', match: { departments: [DEPT.cnm], levels: [4] }, reason: 'Communications and New Media level 4000 courses are not open to exchange students.' }],
  '1-cnm-suffix-y': [{ effect: 'closed', match: { departments: [DEPT.cnm], codeRe: 'Y$' }, reason: "Communications and New Media 'Y' courses are not open to exchange students." }],
  '1-econ-l456': [{ effect: 'closed', match: { departments: [DEPT.econ], levels: [4, 5, 6] }, reason: 'Economics level 4000+ courses are not open to exchange students.' }],
  '1-econ-l123-grad': [{ effect: 'closed', studies: GRAD, match: { departments: [DEPT.econ], levels: [1, 2, 3] }, reason: 'Economics level 1000-3000 courses are not open to exchange graduate students.' }],
  '1-elts-table': [{ effect: 'closed', codes: true, reason: 'Listed by English, Linguistics & Theatre Studies as not available to exchange students.' }],
  '1-elts-l456-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.elts], levels: [4, 5, 6] }, reason: 'English, Linguistics & Theatre Studies level 4000+ courses are not open to exchange undergraduates.' }],
  '1-elts-grad-approval': [{ effect: 'note', note: 'approval', studies: GRAD, match: { departments: [DEPT.elts], levels: [5, 6] }, reason: 'You need approval to take a graduate course. NUS decides each request separately; ask NUS how to apply.' }],
  '1-elts-grad-only': [{ effect: 'open', studies: GRAD, match: { departments: [DEPT.elts], levels: [5, 6] }, reason: 'Graduate courses are open to exchange graduate students.' }],
  '1-geog-quota': [{ effect: 'note', note: 'quota', codes: true, reason: 'The number of places is limited, so you may not get one.' }],
  '1-geog-l1234-grad': [{ effect: 'closed', studies: GRAD, match: { departments: [DEPT.geog], levels: [1, 2, 3, 4] }, reason: 'Geography level 1000-4000 courses are not open to exchange graduate students.' }],
  '1-geog-l456-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.geog], levels: [4, 5, 6] }, reason: 'Geography level 4000+ courses are not open to exchange undergraduates.' }],
  '1-hist-quota': [{ effect: 'note', note: 'quota', codes: true, reason: 'The number of places is limited, so you may not get one.' }],
  '1-hist-l4-honours-fma': [
    { effect: 'closed', match: { departments: [DEPT.hist], levels: [4] }, reason: 'History Honours level 4000 courses are not open to exchange students.' },
    { suffix: 'fma', effect: 'closed', match: { codeRe: '^FMA120\\dH$' }, reason: 'History first-year seminars are not open to exchange students.' },
  ],
  '1-js-table': [{ effect: 'closed', codes: true, reason: 'Listed by Japanese Studies as not available to exchange students.' }],
  '1-js-l4-approval': [{ effect: 'note', note: 'approval', match: { departments: [DEPT.js], levels: [4] }, reason: 'You need approval to take a level 4000 course. NUS decides each request separately; ask NUS how to apply.' }],
  '1-malay-no-audit': [{ effect: 'note', note: 'graded', match: { departments: [DEPT.malay] }, reason: 'You cannot audit it (attend without a grade).' }],
  '1-malay-l4-yr34': [{ effect: 'closed', studies: UG12, match: { departments: [DEPT.malay], levels: [4] }, reason: 'Malay Studies level 4000 courses are open only to 3rd and 4th-year undergraduates and graduate students.' }],
  '1-malay-grad-approval': [
    { effect: 'note', note: 'approval', studies: GRAD, match: { departments: [DEPT.malay], levels: [5, 6] }, reason: 'You need approval to take a graduate course. NUS decides each request separately; ask NUS how to apply.' },
    { suffix: 'open', effect: 'open', studies: GRAD, match: { departments: [DEPT.malay], levels: [5, 6] }, reason: 'Graduate courses are open to exchange graduate students by approval.' },
  ],
  '1-malay-grad-ug-closed': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.malay], levels: [5, 6] }, reason: 'Undergraduates may not take Malay Studies graduate courses.' }],
  '1-polsci-l456-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.polsci], levels: [4, 5, 6] }, reason: 'Political Science level 4000+ courses are not open to exchange undergraduates.' }],
  '1-psych-l4-appeal': [{ effect: 'note', note: 'approval', match: { departments: [DEPT.psych], levels: [4] }, reason: 'You can get a place in a level 4000 course only by appeal, and only if places are left. Appeal when NUS opens the “Unable to secure Course” appeal; an appeal sent earlier is rejected.' }],
  '1-psych-closed': [
    { effect: 'closed', codes: true, reason: 'Listed by Psychology as not available to exchange students.' },
    { suffix: 'pl328x', effect: 'closed', match: { codeRe: '^PL328\\d' }, reason: 'Psychology lab courses are not available to exchange students.' },
    { suffix: 'levels', effect: 'closed', match: { departments: [DEPT.psych], levels: [4, 5, 6] }, reason: 'Psychology level 4000+ courses are not available to exchange students.' },
  ],
  '1-socwork-l456-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.socwork], levels: [4, 5, 6] }, reason: 'Social Work level 4000+ courses are not open to exchange undergraduates.' }],
  '1-socanth-l456-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.socanth], levels: [4, 5, 6] }, reason: 'Sociology and Anthropology level 4000+ courses are not open to exchange undergraduates.' }],
  '1-socanth-grad-only': [{ effect: 'open', studies: GRAD, match: { departments: [DEPT.socanth], levels: [5, 6] }, reason: 'Graduate courses are open to exchange graduate students, subject to approval.' }],
  '1-socanth-grad-approval': [{ effect: 'note', note: 'approval', studies: GRAD, match: { departments: [DEPT.socanth], levels: [5, 6] }, reason: 'You need approval to take a graduate course; ask NUS how to apply.' }],
  '1-sas-no-audit': [{ effect: 'note', note: 'graded', match: { departments: [DEPT.sas] }, reason: 'You cannot audit it (attend without a grade).' }],
  '1-sas-l4-yr34': [{ effect: 'closed', studies: UG12, match: { departments: [DEPT.sas], levels: [4] }, reason: 'South Asian Studies level 4000 courses are open only to 3rd and 4th-year undergraduates and graduate students.' }],
  '1-sas-grad-approval': [
    { effect: 'note', note: 'approval', studies: GRAD, match: { departments: [DEPT.sas], levels: [5, 6] }, reason: 'You need approval to take a graduate course. NUS decides each request separately; ask NUS how to apply.' },
    { suffix: 'open', effect: 'open', studies: GRAD, match: { departments: [DEPT.sas], levels: [5, 6] }, reason: 'Graduate courses are open to exchange graduate students by approval.' },
  ],
  '1-sas-grad-ug-closed': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.sas], levels: [5, 6] }, reason: 'Undergraduates may not take South Asian Studies graduate courses.' }],
  '1-sea-closed': [
    { effect: 'closed', codes: true, reason: 'Listed by Southeast Asian Studies as not available to exchange students.' },
    { suffix: 'sea', effect: 'closed', match: { codeRe: '^SEA\\d' }, reason: 'SEA-coded courses are not available to exchange students.' },
  ],
  '1-sea-no-audit': [{ effect: 'note', note: 'graded', match: { departments: [DEPT.sea] }, reason: 'You cannot audit it (attend without a grade).' }],
  '1-sea-se3234-form': [{ effect: 'note', note: 'approval', codes: true, reason: "You cannot choose this course in NUS's online course registration. Apply with the Southeast Asian Studies department's application form, in the application period of the semester it runs (email fasbox59@nus.edu.sg for details)." }],
  '1-sea-l4-yr34': [{ effect: 'closed', studies: UG12, match: { departments: [DEPT.sea], levels: [4] }, reason: 'Southeast Asian Studies level 4000 courses are open only to 3rd and 4th-year undergraduates and graduate students.' }],
  '1-sea-l5-yr4-pg': [{ effect: 'open', studies: UG4_GRAD, match: { departments: [DEPT.sea], levels: [5] }, reason: 'Southeast Asian Studies level 5000 courses are open to 4th-year and graduate students.' }],
  '1-sea-l6-pg': [{ effect: 'open', studies: GRAD, match: { departments: [DEPT.sea], levels: [6] }, reason: 'Southeast Asian Studies level 6000 courses are open to graduate students.' }],
  '2-biz-l1234-priority': [{ effect: 'note', note: 'quota', match: { faculties: [FAC.biz], levels: [1, 2, 3, 4] }, reason: 'Business courses are very popular, so a place is not guaranteed. NUS students who need them for their degree, and students from the Business School\'s own exchange partners, get places first.' }],
  '2-biz-major': [{ effect: 'note', note: 'major', match: { faculties: [FAC.biz] }, reason: 'Only for students majoring in business at their home university.' }],
  '2-biz-no-late-add': { info: "why rule E can't apply to Business (plan §2 step 1); off-list courses are hidden anyway", offList: { faculties: [FAC.biz] } },
  '2-biz-bma-ug-closed': [{ effect: 'closed', studies: UG, match: { codeRe: '^BMA\\d' }, reason: 'Undergraduates may not take MBA courses.' }],
  '2-biz-bma-partner': [
    { effect: 'note', note: 'partner', studies: GRAD, match: { codeRe: '^BMA\\d' }, reason: 'Only for graduate students from a university that is an exchange partner of NUS Business School, with at least 1.5 years of work experience after their bachelor\'s degree.' },
    { suffix: 'open', effect: 'open', studies: GRAD, match: { codeRe: '^BMA5' }, reason: 'MBA courses are open to eligible exchange graduate students.' },
  ],
  '2-biz-bms-cems': [
    { effect: 'note', note: 'partner', match: { codeRe: '^BMS\\d' }, reason: 'Only for students whom a CEMS member school has nominated for the CEMS Master\'s in International Management. Ask your exchange office if this applies to you.' },
    { suffix: 'open', effect: 'open', studies: GRAD, match: { codeRe: '^BMS5' }, reason: 'CEMS courses are open to CEMS nominees.' },
  ],
  '3-soc-dean-closed': [{ effect: 'closed', codes: true, reason: 'Listed by the School of Computing as not available to exchange students.' }],
  '3-soc-cg': [
    { effect: 'closed', match: { departments: [DEPT.socDean], codeRe: '^CG\\d' }, reason: 'CG-coded courses are not open to exchange students.' },
    { suffix: 'elsewhere', effect: 'note', note: 'restricted-elsewhere', match: { codeRe: '^CG\\d' }, reason: "The NG list offers this course to exchange students, but the School of Computing says no course whose code starts with CG is open to them. Ask NUS before you choose it." },
  ],
  '3-soc-dean-l56': [{ effect: 'closed', match: { codeRe: '^(FT|IT|BT|CS|IS|CP)\\d', levels: [5, 6] }, reason: 'Computing level 5000+ courses are not open to exchange students.' }],
  '3-mdp-closed': [{ effect: 'closed', codes: true, reason: 'Listed by the Multidisciplinary Programme as not available to exchange students.' }],
  '3-cs-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Computer Science as not available to exchange students.' }],
  '3-cs-l56': [{ effect: 'closed', match: { codeRe: '^(FT|IT|BT|CS|IS|CP)\\d', levels: [5, 6] }, reason: 'Computing level 5000+ courses are not open to exchange students.' }],
  '3-isa-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Information Systems and Analytics as not available to exchange students.' }],
  '3-isa-l56': [{ effect: 'closed', match: { codeRe: '^(FT|IT|BT|CS|IS|CP)\\d', levels: [5, 6] }, reason: 'Computing level 5000+ courses are not open to exchange students.' }],
  '4-arch-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Architecture as not available to exchange students.' }],
  '4-arch-dep5102-no-audit': [{ effect: 'note', note: 'graded', codes: true, reason: 'You cannot audit it (attend without a grade).' }],
  '4-arch-design-letter': [{ effect: 'note', note: 'letter', codes: true, reason: 'You need a letter from your home university saying which year\'s design course you should take at NUS.' }],
  '4-arch-major-architecture': [{ effect: 'note', note: 'major', codes: true, reason: 'Only for students majoring in Architecture or a related discipline.' }],
  '4-arch-ar4321-no-audit': [{ effect: 'note', note: 'graded', codes: true, reason: 'You cannot audit it (attend without a grade).' }],
  '4-arch-major-landscape': [{ effect: 'note', note: 'major', codes: true, reason: 'Only for students majoring in Landscape Architecture or a related discipline.' }],
  '4-bme-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Biomedical Engineering as not available to exchange students.' }],
  '4-bme-l56-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.bme], levels: [5, 6] }, reason: 'Biomedical Engineering graduate courses are not open to exchange undergraduates.' }],
  '4-be-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Built Environment as not available to exchange students.' }],
  '4-be-l56-ug': [{ effect: 'closed', studies: UG, match: { departments: [DEPT.be], levels: [5, 6] }, reason: 'Built Environment graduate courses are not open to exchange undergraduates.' }],
  '4-be-bps': [{ effect: 'closed', match: { codeRe: '^BPS5' }, reason: 'MSc Building Performance and Sustainability courses are not offered to exchange students.' }],
  '4-be-quota': [{ effect: 'note', note: 'quota', codes: true, reason: 'The number of places is limited, so you may not get one.' }],
  '4-be-l1234-grad': [{ effect: 'closed', studies: GRAD, match: { departments: [DEPT.be], levels: [1, 2, 3, 4] }, reason: 'Built Environment level 1000-4000 courses are not open to exchange graduate students.' }],
  '4-be-graded': [{ effect: 'note', note: 'graded', match: { departments: [DEPT.be], levels: [1, 2, 3, 4] }, reason: 'You must take it for a grade.' }],
  '4-cbe-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Chemical and Biomolecular Engineering as not available to exchange students.' }],
  '4-cbe-cn5': [{ effect: 'closed', match: { codeRe: '^CN5' }, reason: 'CN level 5000 courses are not open to exchange students.' }],
  '4-cee-no-appeal': { info: "about courses off the NG list, which Jacob's Q7 hides", offList: { departments: [DEPT.cee], levels: [1, 2, 3, 4] } },
  '4-cee-l56': [{ effect: 'closed', match: { codeRe: '^(CE|ESE)\\d', levels: [5, 6] }, reason: 'CE and ESE graduate courses are not open to exchange students.' }],
  '4-ece-closed': [
    { effect: 'closed', codes: true, reason: 'Listed by Electrical and Computer Engineering as not available to exchange students.' },
    { suffix: 'l56', effect: 'closed', match: { codeRe: '^(EE[56]|CEG5|EEK5)\\d' }, reason: 'EE, CEG and EEK graduate courses are not open to exchange students.' },
  ],
  '4-isem-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Industrial Systems Engineering as not available to exchange students.' }],
  '4-isem-no-appeal': { info: "about courses off the NG list, which Jacob's Q7 hides", offList: { departments: [DEPT.isem], levels: [1, 2, 3, 4] } },
  '4-isem-l56': [{ effect: 'closed', match: { codeRe: '^(IE|MT|SDM)\\d', levels: [5, 6] }, reason: 'IE, MT and SDM graduate courses are not open to exchange students.' }],
  '4-mse-closed-1': [{ effect: 'closed', codes: true, reason: 'Listed by Materials Science and Engineering as not available to exchange students.' }],
  '4-mse-closed-2': [{ effect: 'closed', codes: true, reason: 'Listed by Materials Science and Engineering as not available to exchange students.' }],
  '4-mse-l56': [{ effect: 'closed', match: { departments: [DEPT.mse], levels: [5, 6] }, reason: 'Materials Science graduate courses are not open to exchange students.' }],
  '4-me-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Mechanical Engineering as not available to exchange students.' }],
  '4-me-l56': [{ effect: 'closed', match: { departments: [DEPT.me], levels: [5, 6] }, reason: 'Mechanical Engineering graduate courses are not open to exchange students.' }],
  '4-id-major': [{ effect: 'note', note: 'major', codes: true, reason: 'Only for students taking Industrial Design at their home university.' }],
  '4-id-id4106': [{ effect: 'closed', codes: true, reason: 'Not open to exchange students.' }],
  '4-id-graded': [{ effect: 'note', note: 'graded', match: { codeRe: '^ID\\d' }, reason: 'You must take it for a grade.' }],
  '5-law-closed': [{ effect: 'closed', codes: true, reason: 'Listed by the Faculty of Law as not open to exchange students.' }],
  '5-law-major': [{ effect: 'note', note: 'major', match: { faculties: [FAC.law] }, reason: 'Only for students majoring in Law at their home university.' }],
  '5-law-double-major': { info: 'a condition on double majors, covered by the Law major note' },
  '5-law-compulsory-llb': [{ effect: 'closed', match: { codes: LAW_COMPULSORY }, reason: 'Compulsory LLB courses are not open to exchange students.' }],
  '5-law-ll4-electives-only': [{ effect: 'closed', match: { faculties: [FAC.law], notCodeRe: '^LL4' }, reason: 'Only LL4 Law electives are open to exchange students.' }],
  '6-music-core-partner': { info: "applied through the electives whitelist (6-music-electives-whitelist): what isn't a listed elective is a core course" },
  '6-music-electives-whitelist': [{ effect: 'note', note: 'partner', match: { faculties: [FAC.yst], notInList: 'ystElectives' }, reason: "Only for students from universities that partner with NUS's Yong Siew Toh Conservatory of Music. Ask your exchange office if yours is one." }],
  '6-music-audition': [{ effect: 'note', note: 'audition', codes: true, reason: 'You must pass an audition or placement test, and you can\'t choose it in the normal application. You get a place only after you pass.' }],
  '7-pp-ug-closed': [{ effect: 'closed', studies: UG, match: { faculties: [FAC.lkyspp], codeRe: '^PP' }, reason: 'Undergraduates may not take Public Policy (PP) courses.' }],
  '7-pp-partner': [
    { effect: 'note', note: 'partner', studies: GRAD, match: { faculties: [FAC.lkyspp], codeRe: '^PP' }, reason: "Only for graduate students from universities that partner with NUS's Lee Kuan Yew School of Public Policy. Ask your exchange office if yours is one." },
    { suffix: 'open', effect: 'open', studies: GRAD, match: { faculties: [FAC.lkyspp], codeRe: '^PP' }, reason: 'PP graduate courses are open to eligible exchange graduate students.' },
  ],
  '7-pp-graded': [{ effect: 'note', note: 'graded', match: { faculties: [FAC.lkyspp], codeRe: '^PP' }, reason: 'You must take it for a grade.' }],
  '8-dean-table': [{ effect: 'closed', codes: true, reason: 'Listed by the Faculty of Science as not available to exchange students.' }],
  '8-bio-closed': [
    { effect: 'closed', codes: true, reason: 'Listed by Biological Sciences as not available to exchange students.' },
    { suffix: 'lsm33', effect: 'closed', match: { codeRe: '^LSM33\\d\\d' }, reason: 'Internship programme courses are not available to exchange students.' },
  ],
  '8-bio-fsc': [{ effect: 'closed', match: { codeRe: '^FSC\\d' }, reason: 'FSC-coded courses are not open to exchange students.' }],
  '8-chem-table': [{ effect: 'closed', codes: true, reason: 'Listed by Chemistry as not available to exchange students.' }],
  '8-fst-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Food Science and Technology as not available to exchange students.' }],
  '8-fst-l5': [{ effect: 'closed', match: { codeRe: '^FST5' }, reason: 'FST level 5000 courses are not open to exchange students.' }],
  '8-math-closed': [
    { effect: 'closed', codes: true, reason: 'Listed by Mathematics as not available to exchange students.' },
    { suffix: 'fms', effect: 'closed', match: { codeRe: '^FMS12\\d\\dM$' }, reason: 'First-year seminars are not available to exchange students.' },
  ],
  '8-math-ma15': [{ effect: 'closed', match: { codeRe: '^MA15\\d\\d' }, reason: 'MA15xx courses are not open to exchange students.' }],
  '8-math-qf5': [{ effect: 'closed', match: { codeRe: '^QF5' }, reason: 'QF level 5000 courses are not open to exchange students.' }],
  '8-math-dsa': [
    { effect: 'closed', match: { departments: [DEPT.math], codeRe: '^DSA\\d' }, reason: 'DSA-coded courses are not open to exchange students.' },
    { suffix: 'elsewhere', effect: 'note', note: 'restricted-elsewhere', match: { codeRe: '^DSA\\d' }, reason: "The NG list offers this course to exchange students, but the Department of Mathematics says no course whose code starts with DSA is open to them. Ask NUS before you choose it." },
  ],
  '8-math-geh': [
    { effect: 'closed', match: { departments: [DEPT.math], codeRe: '^GEH\\d' }, reason: 'GEH-coded courses are not open to exchange students.' },
    { suffix: 'elsewhere', effect: 'note', note: 'restricted-elsewhere', match: { codeRe: '^GEH\\d' }, reason: "The NG list offers this course to exchange students, but the Department of Mathematics says no course whose code starts with GEH is open to them. Ask NUS before you choose it." },
  ],
  '8-math-ma56': [{ effect: 'closed', match: { codeRe: '^MA[56]' }, reason: 'MA graduate courses are not open to exchange students.' }],
  '8-pharm-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Pharmacy as not available to exchange students.' }],
  '8-phys-closed': [
    { effect: 'closed', codes: true, reason: 'Listed by Physics as not available to exchange students.' },
    { suffix: 'patterns', effect: 'closed', match: { codeRe: '^(AIS5|PC33)\\d' }, reason: 'Listed by Physics as not available to exchange students.' },
  ],
  '8-stats-closed': [{ effect: 'closed', codes: true, reason: 'Listed by Statistics and Data Science as not available to exchange students.' }],
  '8-stats-l56': [{ effect: 'closed', match: { codeRe: '^(ST|DSS)\\d', levels: [5, 6] }, reason: 'ST and DSS graduate courses are not open to exchange students.' }],
  '9-usp-partner': { info: "Jacob's Q6: NUS College courses are open" },
  '10-rmi-approval': [{ effect: 'note', note: 'approval', match: { departments: [DEPT.rmi] }, reason: 'Only some of these courses are open to exchange students, and you need approval: NUS decides each request separately. Ask NUS how to apply.' }],
  '10-rmi-fee': [{ effect: 'note', note: 'fee', match: { departments: [DEPT.rmi] }, reason: 'You must pay a tuition fee for each of these courses you take.' }],
  '11-scale-closed': [{ effect: 'closed', match: { faculties: [FAC.scale] }, reason: 'SCALE courses are not open to exchange students.' }],
  '12-tli-closed': [{ effect: 'closed', match: { faculties: [FAC.tli] }, reason: 'Logistics Institute courses are not open to exchange students.' }],
};

// Rules that come from Jacob's answers rather than from a transcribed rule.
/** @type {{ id: string, effect: 'open', match: RuleMatch, reason: string, cite: string }[]} */
const DECIDED = [
  { id: 'Q1c-ar-dual-coded', effect: 'open', match: { codes: Object.values(TWINS) }, cite: "Jacob's Q1c; register: dual-coded pairs",
    reason: "Dual-coded with an undergraduate Architecture course that is open to Architecture majors." },
];

/** @param {string} file */
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

// The hashes the sources must have (docs/evidence/phase4/sources.md).
const sourcesMd = readFileSync(join(ROOT, 'docs/evidence/phase4/sources.md'), 'utf8');
/** @type {Record<string, string>} */
const expected = {};
for (const m of sourcesMd.matchAll(/^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$/gm)) expected[m[1]] = m[2];
/** @type {Record<string, string>} */
const computed = {};
/** Every file the builder reads from the sources directory goes through here. @param {string} name */
function source(name) {
  const file = join(SOURCES, name);
  const got = sha256(file);
  if (got !== expected[name]) throw new Error(`${name}: sha256 ${got} does not match sources.md (${expected[name] ?? 'missing'})`);
  computed[name] = got;
  return file;
}

const CODE_RE = /\b[A-Z]{2,4}\d{4}[A-Z]{0,3}\b/g;
// The .txt files are pdftotext's output of the PDFs (and the HTML pages' text);
// each is hashed in sources.md like its original, so a changed extraction fails.
source('self-funded-graduate-courses.pdf');
const selfFunded = [...new Set(readFileSync(source('self-funded-graduate-courses.txt'), 'utf8').match(CODE_RE) ?? [])].sort();
// A YST page offers the courses its headings name, and the pages mark
// headings two ways, neither complete: the heading line carries "(N Units"
// (its codes start that line, or the nearest line above it within three, as
// titles wrap), and the heading's code is in an orange (#ff5200) span. The
// union of the two is the list. Codes in Pre-requisite, Co-requisite and
// Preclusion lines are in neither (audit 4B).
const LEAD = /^\*?([A-Z]{2,4}\d{4}[A-Z]?(?:\/[A-Z]{2,4}\d{4}[A-Z]?)*)\b/;
/** @param {string} htmlName */
const ystCodes = (htmlName) => {
  const codes = new Set();
  /** @param {string} text */
  const add = (text) => { const head = LEAD.exec(text.trim()); if (head) for (const c of head[1].split('/')) if (!/^AY\d/.test(c)) codes.add(c); return !!head; };
  const lines = readFileSync(source(htmlName.replace(/\.html$/, '.txt')), 'utf8').split('\n').map((l) => l.trim());
  lines.forEach((line, i) => {
    if (!/\(\d+ units?\b/i.test(line)) return;
    for (let j = i; j >= Math.max(0, i - 3); j--) if (add(lines[j])) return;
    throw new Error(`${htmlName}: no course code above line ${i + 1}: ${line}`);
  });
  const html = readFileSync(source(htmlName), 'utf8');
  for (const m of html.matchAll(/<span[^>]*color:\s*#ff5200[^>]*>([\s\S]*?)<\/span>/gi)) add(m[1].replace(/<[^>]+>/g, ''));
  return [...codes].sort();
};
source('non-graduating-course-restrictions.pdf'); source('law-compulsory-llb-courses.png'); source('ng-courses.pdf');

const transcription = JSON.parse(readFileSync(join(ROOT, 'docs/evidence/phase4/transcription-b.json'), 'utf8'));
const missing = transcription.rules.map((/** @type {any} */ r) => r.id).filter((/** @type {string} */ id) => !(id in OVERLAY));
const extra = Object.keys(OVERLAY).filter((id) => !transcription.rules.some((/** @type {any} */ r) => r.id === id));
if (missing.length || extra.length) throw new Error(`overlay out of step with the transcription: missing ${missing.join(', ')}; extra ${extra.join(', ')}`);

/** @type {any[]} */
const rules = [];
/** @type {{ id: string, why: string, text?: string, scope?: OffListScope }[]} */
const info = [];
for (const r of transcription.rules) {
  const o = OVERLAY[r.id];
  const cite = `restrictions PDF §${r.section}${r.department ? ` (${r.department})` : ''}, p${r.page}`;
  if (!Array.isArray(o)) { info.push({ id: r.id, why: o.info, ...(o.offList ? { text: r.quote, scope: o.offList } : {}) }); continue; }
  for (const part of o) {
    /** @type {RuleMatch} */
    const match = { ...(part.match ?? {}) };
    /** @type {{ code: string, title: string }[] | undefined} */
    let titled;
    if (part.codes) {
      const codes = new Set((r.scope?.codes ?? []).map((/** @type {{ code: string }} */ c) => c.code));
      for (const c of [...codes]) if (TWINS[c]) codes.add(TWINS[c]);
      match.codes = [...codes].sort();
      titled = (r.scope?.codes ?? []).map((/** @type {{ code: string, title: string }} */ c) => ({ code: c.code, title: c.title }));
    }
    rules.push({
      id: part.suffix ? `${r.id}:${part.suffix}` : r.id,
      effect: part.effect,
      ...(part.note ? { note: part.note } : {}),
      ...(part.studies ? { studies: part.studies } : {}),
      match,
      reason: part.reason,
      cite,
      quote: r.quote,
      ...(titled ? { titles: titled } : {}),
    });
  }
}
for (const d of DECIDED) rules.push({ ...d });

const ystElectives = { 1: ystCodes('yst-sem1-non-music-majors.html'), 2: ystCodes('yst-sem2-non-music-majors.html') };
const out = {
  acadYear: ACAD_YEAR,
  generator: 'scripts/build-ng-restrictions.mjs',
  sourceSha256: /** @type {Record<string, string>} */ ({}),
  register: 'docs/evidence/phase4/interpretations.md',
  rules,
  lists: {
    ystElectives,
  },
  info,
};
rules.find((r) => r.id === 'A-self-funded').match = { codes: selfFunded };
const unread = Object.keys(expected).filter((name) => !(name in computed));
if (unread.length) throw new Error(`sources.md lists files the builder never read: ${unread.join(', ')}`);
out.sourceSha256 = Object.fromEntries(Object.entries(computed).sort());

writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${rules.length} rules (${info.length} info-only) to ${OUT.replace(ROOT, '')}; self-funded ${selfFunded.length} codes; YST electives S1 ${out.lists.ystElectives[1].length}, S2 ${out.lists.ystElectives[2].length}`);
