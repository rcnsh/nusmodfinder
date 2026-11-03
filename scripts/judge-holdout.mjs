// A HELD-OUT topical fixture, written after the RRF + stopword tuning was
// already frozen. The original 15 queries can no longer settle anything: the
// retriever was modified in response to them failing, which is overfitting
// through a different door than editing the fixture. These twelve queries were
// never seen by any tuning decision, and are judged by the same rule method.
import { writeFile } from 'node:fs/promises';
import { DEFAULT_ACAD_YEAR, fetchAcadYearFile, offeredModules } from './lib.mjs';

const info = await fetchAcadYearFile(DEFAULT_ACAD_YEAR, 'moduleInfo.json');
const { modules } = offeredModules(info.data, DEFAULT_ACAD_YEAR);
const byCode = new Map(modules.map((m) => [m.code, m]));

const QUERIES = [
  { id: 'h1', q: 'learning a foreign language',
    criterion: 'A course that TEACHES a foreign language, owned by the Centre for Language Studies. Excludes literature and culture courses that merely name a language.',
    rule: (m) => m.department === 'Centre for Language Studies' && !/Design Your Own Course/i.test(m.title) },
  { id: 'h2', q: 'how the brain works',
    criterion: 'A course on neuroscience, the nervous system, or the biological basis of cognition.',
    rule: (m) => /neuroscience|neurobiolog|neural (basis|circuit|system)|\bbrain\b|nervous system|cognitive (science|neuro)|neurotechnolog/i.test(m.title) },
  { id: 'h3', q: 'diseases and how they spread',
    criterion: 'A course on epidemiology, infectious disease, or microbial pathogens.',
    rule: (m) => /epidemiolog|infectious|communicable disease|pathogen|virolog|microbio/i.test(m.title) },
  { id: 'h4', q: 'photography and film making',
    criterion: 'A course on photography, cinematography, film production or moving image practice.',
    rule: (m) => /photograph|cinema(tic|tograph)?|film[- ]?(making|production|studies|theory)|videograph|moving image|screen (media|production)/i.test(m.title) },
  { id: 'h5', q: 'keeping computer systems secure',
    criterion: 'A course on computer, information, network or cyber security, including cryptography.',
    rule: (m) => /security|cryptograph|cyber|forensic/i.test(m.title) && /Computing|Design and Engineering/.test(m.faculty) },
  { id: 'h6', q: 'music theory and composition',
    criterion: 'A course on musical composition, theory, harmony or analysis.',
    rule: (m) => /composition|music theory|harmony|counterpoint|orchestration|musicianship/i.test(m.title) && /Music/.test(m.faculty) },
  { id: 'h7', q: 'understanding modern chinese history',
    criterion: 'A history course about China or Chinese society in the modern period.',
    rule: (m) => /china|chinese/i.test(m.title) && /histor|modern|contemporary|society|politic/i.test(m.title) },
  { id: 'h8', q: 'buildings and urban design',
    criterion: 'A course on architecture, urban design, city planning or the built environment.',
    rule: (m) => /architect|urban (design|planning|studies)|city|built environment|landscape/i.test(m.title) },
  { id: 'h9', q: 'statistics and probability',
    criterion: 'A course whose primary subject is statistics, probability or statistical inference.',
    rule: (m) => /statistic|probabilit|stochastic|bayesian|regression|inference/i.test(m.title) },
  { id: 'h10', q: 'mental health and wellbeing',
    criterion: 'A course on mental health, psychological wellbeing, psychiatry or counselling.',
    rule: (m) => /mental health|wellbeing|well-being|psychiatr|counsell|psychotherap|resilience and|mindful/i.test(m.title) },
  { id: 'h11', q: 'ethics and moral philosophy',
    criterion: 'A course on ethics, moral philosophy or applied normative reasoning.',
    rule: (m) => /\bethic|moral (philosophy|reasoning|psychology)|bioethic/i.test(m.title) },
  { id: 'h12', q: 'renewable energy and power systems',
    criterion: 'A course on renewable or sustainable energy generation, storage, or electrical power systems.',
    rule: (m) => /renewable|solar|photovoltaic|power system|energy (system|storage|conversion|efficien|technolog)|smart grid/i.test(m.title) },
];

const out = { acadYear: DEFAULT_ACAD_YEAR, k: 10,
  howRelevanceWasChosen: 'Same rule method as eval/queries.json, but these queries were written AFTER the RRF and stopword tuning was frozen, so no retrieval decision was made with sight of them. Rules are lexical, biasing the fixture toward the keyword baseline.',
  queries: [] };

for (const spec of QUERIES) {
  const relevant = modules.filter(spec.rule).map((m) => m.code).sort();
  console.log(`${spec.id.padEnd(4)} ${String(relevant.length).padStart(4)} relevant  "${spec.q}"`);
  if (relevant.length < 3) console.log(`     !! too few — ${relevant.join(', ')}`);
  else console.log(`     e.g. ${relevant.slice(0, 4).map((c) => byCode.get(c).title.slice(0, 34)).join(' | ')}`);
  out.queries.push({ id: spec.id, kind: 'topical', q: spec.q, criterion: spec.criterion, relevant });
}
await writeFile(new URL('../eval/holdout.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('\nwrote eval/holdout.json');
