// Rebuilds the topical relevance judgements after a hostile review found the
// original sets were built from a TRUNCATED grep (the first 30 alphabetical
// hits), which silently omitted whole programmes — most glaringly all 15 CCS
// "Climate Change and Sustainability" modules from the climate query.
//
// Each query now carries an explicit RULE applied to the entire 6,771-module
// corpus, so the set is complete and reproducible, plus explicit ADDITIONS and
// EXCLUSIONS judged from the blind pool (scripts/pool.mjs) where the rule is
// wrong. Every judgement is written down and can be argued with.
//
// The rules are lexical, which biases the fixture TOWARD the keyword baseline.
// That is the conservative direction for a test of semantic search, and it is
// stated rather than hidden.
import { writeFile } from 'node:fs/promises';
import { DEFAULT_ACAD_YEAR, fetchAcadYearFile, offeredModules, loadNgCourses } from './lib.mjs';

const info = await fetchAcadYearFile(DEFAULT_ACAD_YEAR, 'moduleInfo.json');
const { modules } = offeredModules(info.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));

const AIML = /artificial intelligence|\bAI\b|machine learning|deep learning|neural network/i;

const RULES = {
  t1: {
    criterion: 'A School of Computing course whose primary subject is artificial intelligence or machine learning. Faculty-scoped, because "computer science ai" names a discipline; excludes AI applied inside chemistry, materials, medicine or engineering faculties.',
    rule: (m) => m.faculty === 'Computing' && (AIML.test(m.title) || /intelligent robot|uncertainty modelling/i.test(m.title)),
    // Rule misses: current-generation AI courses whose titles predate the vocabulary.
    add: ['CP4284', 'CS3227'],
  },
  t2: {
    criterion: 'An introductory (level 1 or 2) course in machine learning or AI, any faculty. "For beginners" makes course level the discriminating attribute, so conceptual and societal introductions count alongside technical ones.',
    rule: (m) => m.level <= 2 && AIML.test(m.title),
    add: [],
  },
  t3: {
    criterion: 'A course on founding or running a new venture: entrepreneurship, start-ups, new venture creation, innovation-and-enterprise practicums.',
    rule: (m) => /entrepreneur|start[- ]?up|new venture|venture creation|innovation (&|and) enterprise/i.test(m.title),
    add: ['CDE4301A'],  // "Ideas to Start-up" — hyphen variant the rule's word boundary misses
  },
  t4: {
    criterion: 'A course substantially about climate change, sustainability or the environment. Includes the entire CCS "Climate Change and Sustainability" programme, which the original fixture omitted completely.',
    rule: (m) => /^CCS/.test(m.code) || /climate|sustainab|environmental (studies|science|system|management)/i.test(m.title),
    add: [],
  },
  t5: {
    criterion: 'A course teaching academic or scholarly writing and communication. Excludes creative writing, journalism and literature courses that merely contain the word "writing".',
    rule: (m) => /writing academically|academic (english|writing|communication)|english for academic|scientific writing|writing for publication|grant writing|second language writing|graduate english|foundation academic/i.test(m.title),
    add: [],
  },
  t6: {
    criterion: 'A course on financial investment analysis or portfolio management. Excludes investment LAW and arbitration, and geography "field investigation" false positives.',
    rule: (m) => /investment|investing|portfolio/i.test(m.title) && m.faculty !== 'Law' && !/investigation/i.test(m.title),
    add: [],
  },
};

const byCode = new Map(modules.map((m) => [m.code, m]));
const out = {};
for (const [id, spec] of Object.entries(RULES)) {
  const set = new Set(modules.filter(spec.rule).map((m) => m.code));
  for (const c of spec.add) {
    if (!byCode.has(c)) throw new Error(`${id}: added code ${c} is not in the corpus`);
    set.add(c);
  }
  out[id] = [...set].sort();
  console.log(`\n########## ${id} — ${out[id].length} relevant`);
  console.log(`criterion: ${spec.criterion}`);
  for (const c of out[id]) console.log(`  ${c.padEnd(10)} ${byCode.get(c).faculty.padEnd(26)} ${byCode.get(c).title.slice(0, 58)}`);
}
await writeFile(new URL('../eval/topical-relevance.json', import.meta.url),
  JSON.stringify(Object.fromEntries(Object.entries(RULES).map(([id, s]) => [id, { criterion: s.criterion, relevant: out[id] }])), null, 2));
console.log('\nwrote eval/topical-relevance.json');
