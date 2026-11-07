#!/usr/bin/env node
// @ts-check
// Record of how the sealed SC5 test set was assembled (ADR 0003 "Test set,
// pre-registered now"; docs/plans/phase3.md §5). Run by the custodian after
// the Phase 3 freeze (`phase3-final`). Prints counts only, never query text.
//
//   node eval/test-build/build-test.mjs --writers <custody>/test --seed-file <custody>/test/code-seed \
//     --out <custody>/test/queries.test.v1.json [--round 1]
//
// - Persona queries: the six writer outputs (eval/v2/writer-prompt.md and
//   PERSONAS.md, unchanged; shape quotas from eval/v2/assign-shapes.mjs with
//   the seed `vnm-test-<freeze date>`, eval/test-build/shape-assignment.json).
// - Code queries (round 1 only; 18, the v2 forms): 6 exact, 5 space, 4 partial
//   (code families, never a GE pillar), 3 non-existent. Drawn from a secret seed
//   held in custody (only its sha256 is recorded). A drawn target may not
//   overlap, as a prefix either way, any dev or holdout code target, any SC4
//   suite code or prefix, a writer example (CS3244, CS32, GEA) or another draw.
//   They carry the v2.1 form shapes and noAnswerByRule.
// - Typo queries (round 1 only; 15): eval/v2's noise model on seeded persona
//   sources of a typo-able shape, at most 60 characters, with a word of 4+
//   letters; a variant equal to its source is dropped.
// The leak filter (cosine >= 0.9 to dev, holdout, the SC4 suite or the
// gibberish set, or a shared source) runs after the texts are embedded
// (eval/test-build/leak-filter.mjs).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { layout, loadQueries, REPO } from '../lib/sets.mjs';

const { values: a } = parseArgs({ options: {
  writers: { type: 'string' }, 'seed-file': { type: 'string' }, out: { type: 'string' },
  round: { type: 'string', default: '1' }, previous: { type: 'string' },
} });
for (const k of /** @type {const} */ (['writers', 'seed-file', 'out'])) if (!a[k]) throw new Error(`--${k} is required`);
const WRITERS = /** @type {string} */ (a.writers);
const SEED_FILE = /** @type {string} */ (a['seed-file']);
const OUT = /** @type {string} */ (a.out);
const ROUND = Number(a.round);
const assignment = JSON.parse(readFileSync(join(REPO, ROUND === 1 ? 'eval/test-build/shape-assignment.json' : `eval/test-build/shape-assignment-r${ROUND}.json`), 'utf8'));
const PUBLIC_SEED = assignment.seed;
const WRITER_EXAMPLES = ['CS3244', 'CS32', 'GEA'];
const PERSONAS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

/** @param {string} seed */
const rng = (seed) => {
  let ctr = 0;
  const rnd = () => createHash('sha256').update(`${seed}:${ctr++}`).digest().readUInt32BE(0) / 2 ** 32;
  /** @template T @param {T[]} xs */
  const shuffle = (xs) => { xs = xs.slice(); for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
  return { rnd, shuffle };
};

// ── persona queries
/** @type {any[]} */
const persona = [];
for (const p of PERSONAS) {
  const file = join(WRITERS, ROUND === 1 ? `out-${p}.json` : `out-r${ROUND}-${p}.json`);
  for (const q of JSON.parse(readFileSync(file, 'utf8'))) persona.push({ persona: p, shapes: q.shapes, text: q.text, filters: q.filters ?? {}, narrative: q.narrative, origin: 'persona' });
}
const quota = Object.values(assignment.counts).reduce((s, c) => s + Object.values(/** @type {Record<string, number>} */ (c)).reduce((x, y) => x + y, 0), 0);
if (persona.length !== quota) throw new Error(`persona queries ${persona.length} != quota ${quota}`);

/** @type {any[]} */
let codeRecords = [];
/** @type {any[]} */
let typoRecords = [];
let codeSeedSha256 = null;
if (ROUND === 1) {
  // ── code queries, from the secret seed
  if (!existsSync(SEED_FILE)) writeFileSync(SEED_FILE, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  const secret = readFileSync(SEED_FILE, 'utf8').trim();
  codeSeedSha256 = createHash('sha256').update(secret).digest('hex');
  const { rnd, shuffle } = rng(secret);
  const ng = JSON.parse(readFileSync(join(REPO, 'data/ng-courses-2026-2027.json'), 'utf8'));
  const info = JSON.parse(readFileSync(join(REPO, '.data/2026-2027-moduleInfo.json'), 'utf8'));
  const offered = new Set(info.filter((/** @type {any} */ r) => (r.semesterData ?? []).length).map((/** @type {any} */ r) => r.moduleCode));
  const known = new Set(info.map((/** @type {any} */ r) => r.moduleCode));
  /** @type {Map<string, number[]>} */
  const ngSem = new Map();
  for (const [s, codes] of Object.entries(ng.semesters)) for (const c of /** @type {string[]} */ (codes)) { if (!ngSem.has(c)) ngSem.set(c, []); ngSem.get(c)?.push(Number(s)); }
  const level = (/** @type {string} */ c) => Number(/** @type {RegExpMatchArray} */ (c.match(/\d/))[0]);
  const dev = await loadQueries(layout('dev'));
  const hold = await loadQueries(layout('holdout'));
  const evalTargets = [...dev.queries, ...hold.queries].filter((q) => /** @type {any} */ (q).origin === 'code').map((q) => String(/** @type {any} */ (q).target));
  const sc4 = JSON.parse(readFileSync(join(REPO, 'test/sc4/queries.json'), 'utf8'));
  /** @type {string[]} */
  const sc4Targets = [];
  for (const item of sc4.items) {
    const p = item.params ?? {};
    for (const v of [p.code, p.prefix, ...(p.codes ?? []), ...(p.prefixes ?? []), ...(p.answers ?? []), ...(p.mustInclude ?? [])]) if (typeof v === 'string') sc4Targets.push(v.toUpperCase());
    for (const m of String(item.text).toUpperCase().matchAll(/\b[A-Z]{2,4}\s?\d{2,4}[A-Z]?\b/g)) sc4Targets.push(m[0].replace(/\s/g, ''));
  }
  const banned = [...evalTargets, ...sc4Targets, ...WRITER_EXAMPLES];
  const overlaps = (/** @type {string} */ x, /** @type {string} */ y) => x.startsWith(y) || y.startsWith(x);
  /** @type {Set<string>} */
  const used = new Set();
  const clashes = (/** @type {string} */ t) => banned.some((e) => overlaps(t, e)) || [...used].some((u) => overlaps(t, u));
  const pool = shuffle([...ngSem.keys()].filter((c) => offered.has(c) && level(c) <= 4 && /^[A-Z]{2,4}\d{4}[A-Z]?$/.test(c) && !clashes(c)));
  const take = (/** @type {(c: string) => boolean} */ ok) => { const c = pool.find((x) => !clashes(x) && ok(x)); if (!c) throw new Error('code pool exhausted'); used.add(c); return c; };
  const famOf = (/** @type {string} */ c) => /** @type {RegExpMatchArray} */ (c.match(/^[A-Z]+\d\d/))[0];
  /** @param {string} form @param {string} target @param {string} text */
  const record = (form, target, text) => {
    const sems = form === 'exact' || form === 'space' ? ngSem.get(target) : null;
    const filters = { ng: true, ...(sems?.length === 1 ? { sem: sems[0] } : {}) };
    const narrative = form === 'nonexistent'
      ? { relevant: `Nothing: ${target} is not an NUS course this year; the tool should say so rather than show unrelated courses.`, partial: 'none', notRelevant: 'any course' }
      : form === 'partial'
        ? { relevant: `Courses whose code starts with ${target}, open to exchange students.`, partial: 'Courses with a similar code family or subject.', notRelevant: 'Courses unrelated to that code prefix.' }
        : { relevant: `The course ${target} itself.`, partial: `Variants or cross-listings of ${target} (same base code with a letter suffix).`, notRelevant: 'Any other course.' };
    const shapes = form === 'nonexistent' ? ['code', 'noanswer', 'code-nonexistent'] : ['code', `code-${form}`];
    return { persona: 'mech', shapes, text, filters, narrative, origin: 'code', codeForm: form, target, ...(form === 'nonexistent' ? { noAnswerByRule: true } : {}) };
  };
  for (let i = 0; i < 6; i++) { const c = take(() => true); codeRecords.push(record('exact', c, c)); }
  for (let i = 0; i < 5; i++) {
    const c = take(() => true);
    const m = /** @type {RegExpMatchArray} */ (c.match(/^([A-Z]+)(\d.*)$/));
    codeRecords.push(record('space', c, `${m[1].toLowerCase()} ${m[2].toLowerCase()}`));
  }
  for (let i = 0; i < 4; i++) {
    const fam = famOf(take((c) => !c.startsWith('GE') && !clashes(famOf(c))));
    used.add(fam);
    codeRecords.push(record('partial', fam, fam));
  }
  for (let i = 0; i < 3;) {
    const c = `${shuffle(['CS', 'MA', 'EC', 'BT', 'LSM', 'PH'])[0]}${1000 + Math.floor(rnd() * 3999)}`;
    if (offered.has(c) || known.has(c) || clashes(c)) continue;
    used.add(c);
    codeRecords.push(record('nonexistent', c, i === 1 ? c.toLowerCase() : c));
    i++;
  }

  // ── typo queries, eval/v2's noise model, public seed
  const pub = rng(PUBLIC_SEED);
  const kb = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const near = (/** @type {string} */ ch) => {
    for (let r = 0; r < 3; r++) {
      const i = kb[r].indexOf(ch);
      if (i >= 0) { const opts = [kb[r][i - 1], kb[r][i + 1], kb[r - 1]?.[i], kb[r + 1]?.[i]].filter(Boolean); return opts[Math.floor(pub.rnd() * opts.length)]; }
    }
    return ch;
  };
  const edit = (/** @type {string} */ w) => {
    const k = Math.floor(pub.rnd() * 4), i = 1 + Math.floor(pub.rnd() * (w.length - 2));
    if (k === 0) return w.slice(0, i) + near(w[i]) + w.slice(i + 1);
    if (k === 1) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    if (k === 2) return w.slice(0, i) + w.slice(i + 1);
    return w.slice(0, i) + w[i] + w.slice(i);
  };
  const typoable = ['topical', 'abbreviation', 'level', 'language', 'sea'];
  const sources = pub.shuffle(persona.map((q, i) => ({ q, i })).filter(({ q }) => q.text.length <= 60
    && q.shapes.some((/** @type {string} */ s) => typoable.includes(s)) && q.text.split(' ').some((/** @type {string} */ w) => /^[a-z]{4,}$/i.test(w)))).slice(0, 15);
  typoRecords = sources.map(({ q, i }) => {
    const words = q.text.split(' ');
    const cands = words.map((/** @type {string} */ w, /** @type {number} */ j) => ({ w, j })).filter((/** @type {{ w: string }} */ { w }) => /^[a-z]{4,}$/i.test(w));
    const nEdits = Math.min(cands.length, pub.rnd() < 0.5 ? 1 : 2);
    for (const { j } of pub.shuffle(cands).slice(0, nEdits)) words[j] = edit(words[j]);
    return { persona: q.persona, shapes: ['typo'], text: words.join(' '), filters: q.filters, narrative: q.narrative, origin: 'typo', sourceIndex: i };
  }).filter((t) => t.text !== persona[t.sourceIndex].text);
}

// ── ids (continuing a previous round's numbering)
const start = a.previous ? JSON.parse(readFileSync(a.previous, 'utf8')).queries.length : 0;
const all = [...persona, ...codeRecords, ...typoRecords];
all.forEach((q, n) => { q.id = `t-${String(start + n + 1).padStart(3, '0')}`; });
const queries = all.map((q) => {
  const { sourceIndex, ...rest } = q;
  return q.origin === 'typo' ? { ...rest, source: persona[sourceIndex].id } : rest;
});
const prev = a.previous ? JSON.parse(readFileSync(a.previous, 'utf8')) : null;
const out = {
  version: prev ? prev.version : 'test-v1', set: 'test', created: '2026-11-08',
  seeds: [...(prev?.seeds ?? []), { round: ROUND, shapes: PUBLIC_SEED, ...(codeSeedSha256 ? { codeSeedSha256 } : {}) }],
  frozenRanker: 'phase3-final',
  queries: [...(prev?.queries ?? []), ...queries],
};
writeFileSync(OUT, JSON.stringify(out, null, 1), { mode: 0o600 });
const shapes = /** @type {Record<string, number>} */ ({});
for (const q of queries) for (const s of q.shapes) shapes[s] = (shapes[s] ?? 0) + 1;
console.log(JSON.stringify({ round: ROUND, added: queries.length, total: out.queries.length, persona: persona.length, code: codeRecords.length, typo: typoRecords.length, codeSeedSha256, shapes }));
