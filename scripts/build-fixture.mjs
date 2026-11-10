// @ts-check
// Builds test/fixtures/corpus.json: ~430 normalised modules from the pinned
// snapshot, chosen to cover the Phase 0 findings, plus a deterministic filler
// sample. Output is stable for a given snapshot, so a rebuild with no input
// change produces no diff. Usage: npm run fixture
import { writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOf } from './lib.mjs';
import { loadPinnedCorpus, MODULE_INFO_PATH, NG_PATH, PINNED_RELEASE } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('../test/fixtures/corpus.json', import.meta.url));
const TARGET = 400;

// Named because a finding, criterion or code path refers to them directly.
const NAMED = [
  'CS1010S', 'CS2109S', 'CS3244', 'CG3201', 'PC3270', 'PL1101E', 'CE5316QA', 'LAK1201', 'LAK2201',
  // Long variant codes that motivated the widened MODULE_CODE_RE (lib.mjs).
  'ACC1701XA', 'DMA1401L01', 'DMR1201GEQA', 'LC6009GRSII',
];

/** @type {[string, (m: NormalisedModule) => boolean][]} */
const RULES = [
  ['named', (m) => NAMED.includes(m.code)],
  ['cs1010-variant', (m) => m.code.startsWith('CS1010')],
  ['management-sem3', (m) => /management/i.test(`${m.title} ${m.description}`) && m.semesters.includes(3)],
  ['gea', (m) => m.code.startsWith('GEA')],
  ['tr3202', (m) => m.code.startsWith('TR3202')],
  ['non-ascii-title', (m) => /[\u0080-\uffff]/.test(m.title)],
  ['ai-level-5-6', (m) => m.level !== null && m.level >= 5 && m.level <= 6 &&
    /artificial intelligence|machine learning|deep learning|\bAI\b/i.test(m.title)],
  ['intro-level-1-2', (m) => m.level !== null && m.level <= 2 &&
    /machine learning|artificial intelligence|programming|data science/i.test(m.title)],
  ['ng-semester-mismatch', (m) => m.ng && m.ngSemesters.some((s) => !m.semesters.includes(s))],
  ['level-8', (m) => m.level === 8],
];

/**
 * Stable pseudo-random order, so the filler sample does not favour
 * early-alphabet codes and does not change between runs.
 * @param {NormalisedModule} m
 */
const order = (m) => hashOf(`fixture:${m.code}`);

async function main() {
  const corpus = await loadPinnedCorpus();
  const modules = [...corpus.modules].sort((a, b) => a.code.localeCompare(b.code));

  /** @type {Map<string, Set<string>>} */
  const reasons = new Map();
  /** @param {NormalisedModule} m @param {string} why */
  const pick = (m, why) => {
    if (!reasons.has(m.code)) reasons.set(m.code, new Set());
    /** @type {Set<string>} */ (reasons.get(m.code)).add(why);
  };

  for (const m of modules) for (const [why, test] of RULES) if (test(m)) pick(m, why);
  const missing = NAMED.filter((c) => !reasons.has(c));
  if (missing.length) throw new Error(`named modules missing from the pinned corpus: ${missing.join(', ')}`);

  // Coverage: two modules per faculty (so /facets lists every faculty), and
  // some special-term (sem 3/4) and NG modules.
  const shuffled = [...modules].sort((a, b) => order(a).localeCompare(order(b)));
  /** @type {Map<string | null, number>} */
  const perFaculty = new Map();
  for (const m of shuffled) {
    const n = perFaculty.get(m.faculty) ?? 0;
    if (n < 2) { perFaculty.set(m.faculty, n + 1); pick(m, 'faculty-coverage'); }
  }
  shuffled.filter((m) => m.semesters.some((s) => s >= 3)).slice(0, 20).forEach((m) => pick(m, 'special-term'));
  shuffled.filter((m) => m.ng).slice(0, 30).forEach((m) => pick(m, 'ng-sample'));

  for (const m of shuffled) {
    if (reasons.size >= TARGET) break;
    if (!reasons.has(m.code)) pick(m, 'filler');
  }

  // Phase 4 coverage (docs/plans/phase4.md 4A), added after the filler so the
  // filler sample is unchanged: every NG module at level 5000+ and every NG
  // module also offered in a special term.
  for (const m of modules) {
    if (m.ng && m.level !== null && m.level >= 5) pick(m, 'ng-level-5');
    if (m.ng && m.semesters.some((s) => s >= 3)) pick(m, 'ng-special-term');
  }

  const selected = modules.filter((m) => reasons.has(m.code));
  /** @type {Record<string, number>} */
  const counts = {};
  for (const set of reasons.values()) for (const why of set) counts[why] = (counts[why] ?? 0) + 1;

  const header = {
    source: {
      release: PINNED_RELEASE,
      moduleInfo: relative(ROOT, MODULE_INFO_PATH),
      moduleInfoSha256: corpus.moduleInfoSha256,
      ng: relative(ROOT, NG_PATH),
      ngSha256: corpus.ngSha256,
      acadYear: corpus.acadYear,
      generator: 'scripts/build-fixture.mjs',
    },
    count: selected.length,
    reasonCounts: Object.fromEntries(Object.entries(counts).sort()),
    reasons: Object.fromEntries(selected.map((m) => [m.code, [.../** @type {Set<string>} */ (reasons.get(m.code))].sort()])),
  };

  // One module per line keeps diffs reviewable.
  const body = [
    '{',
    `  "source": ${JSON.stringify(header.source)},`,
    `  "count": ${header.count},`,
    `  "reasonCounts": ${JSON.stringify(header.reasonCounts)},`,
    `  "reasons": ${JSON.stringify(header.reasons)},`,
    '  "modules": [',
    selected.map((m) => `    ${JSON.stringify(m)}`).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
  await writeFile(OUT, body);
  console.log(`wrote ${selected.length} modules to ${OUT}`);
  console.log(header.reasonCounts);
}

await main();
