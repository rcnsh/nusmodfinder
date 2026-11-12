#!/usr/bin/env node
// @ts-check
// Phase 3 step 3B-0 (docs/plans/phase3.md 3B-0, docs/plans/phase3-prereg.md §3):
// the corpus data the 3B code parser reads, never built from the network.
//
// Per corpus (Phase 7 7D: they follow the corpus, as the vocabulary and groups do):
//   prefixes.json        the letter parts of offered codes, with their module counts;
//   catalogue-codes.json the catalogue-only codes (in moduleInfo.json, no offering
//                        in the corpus's year), sorted: what the Worker bundles
//                        (`catalogue-codes-data`, `prefixes-data`);
//   catalogue-only.json  the same codes with their titles and descriptions (noMatch
//                        `not-offered`): the rows ingest loads into D1 `catalogue_only`.
// `--corpus production` builds them under data/ from `current` (data/corpus.json,
// scripts/corpus-manifest.mjs), what wrangler.jsonc ships. `--corpus pinned` builds the
// prefixes and catalogue codes under data/pinned/ from the pinned corpus
// (scripts/pinned-corpus.mjs, sha-checked): what the Worker tests, test/full and every eval
// run search with; the pinned catalogue-only.json is built in memory for test/full
// (pinnedCatalogueOnlyPath). The pinned build also writes the files that are no corpus's:
//   ge-pillars.json      the GE pillar table, from eval/prereg/ge-pillars.json;
//   collision-list.json  the P-6 collision list and its exempt pillar prefixes, from
//                        eval/prereg/collision-list.json (the Worker cannot read eval/);
//   constraint-phrases.json  3H's P-6 phrase lists (no exam, S/U, workload, prerequisite),
//                        from eval/prereg/intent-phrases.json `constraints`, for parse pass A;
//   cohort-only-prereq.json  3H-0's P-6 cohort-only prerequisite rule, from
//                        eval/prereg/cohort-only-prereq.json (normalise() reads it, and
//                        the eval workspace has data/ but not eval/).
// and docs/evidence/phase3/3b-0-counts.json, critic C's corpus counts (plan §1)
// re-run on the pinned corpus.
//
//   node scripts/build-3b-data.mjs --corpus production|pinned            write the corpus's files
//   node scripts/build-3b-data.mjs --corpus production|pinned --check    exit 1 if a committed one differs
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { queryTokens } from '../src/fts-query.js';
import { productionCorpus } from './corpus-manifest.mjs';
import { catalogueOnlyRecords } from './lib.mjs';
import { loadPinnedCorpus, PINNED_RELEASE } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The per-corpus files, relative to the repo root. The pinned catalogue-only rows are never committed. */
export const CORPUS_OUTPUTS = Object.freeze({
  production: Object.freeze({ prefixes: 'data/prefixes.json', catalogueCodes: 'data/catalogue-codes.json', catalogueOnly: 'data/catalogue-only.json' }),
  pinned: Object.freeze({ prefixes: 'data/pinned/prefixes.json', catalogueCodes: 'data/pinned/catalogue-codes.json' }),
});

/** The files that are no corpus's (written by the pinned build), relative to the repo root. */
export const SHARED_OUTPUTS = Object.freeze({
  gePillars: 'data/ge-pillars.json',
  collisionList: 'data/collision-list.json',
  cohortOnly: 'data/cohort-only-prereq.json',
  constraintPhrases: 'data/constraint-phrases.json',
  counts: 'docs/evidence/phase3/3b-0-counts.json',
});

/**
 * @typedef {{ release: string, acadYear: string, moduleInfoSha256: string }} CorpusSource
 */

/** @param {string} rel */
const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
/** @param {string} code */
const lettersOf = (code) => /** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(code))[0];
const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/** The PK range of a partial code: [P(+'0' when P is letters only), P + ':'). @param {string} p */
export const partialRange = (p) => [/\d$/.test(p) ? p : `${p}0`, `${p}:`];

/**
 * A corpus's prefixes, catalogue codes and catalogue-only rows, as the bytes each file holds.
 * @param {{ records: import('./lib.mjs').NusModsRecord[], modules: { code: string }[], source: CorpusSource, label?: string }} c
 *   `label` names the corpus in the files' rule lines ('pinned' keeps the pinned files' wording).
 */
export function corpusFiles({ records, modules, source, label = 'production' }) {
  const offered = modules.map((m) => m.code).sort(byCode);
  /** @type {Record<string, number>} */
  const prefixCounts = {};
  for (const c of offered) prefixCounts[lettersOf(c)] = (prefixCounts[lettersOf(c)] ?? 0) + 1;
  const prefixes = Object.keys(prefixCounts).sort(byCode);
  const catalogue = catalogueOnlyRecords(records).sort((a, b) => byCode(a.code, b.code));
  const year = label === 'pinned' ? 'the pinned year' : 'the corpus\'s year';
  return {
    prefixes: `${JSON.stringify({
      schema: 'vnm-3b-prefixes/1', source, rule: `the letter part of every offered code in the ${label} corpus, with its offered-module count`,
      count: prefixes.length, prefixes: Object.fromEntries(prefixes.map((p) => [p, prefixCounts[p]])),
    }, null, 1)}\n`,
    catalogueCodes: `${JSON.stringify({
      schema: 'vnm-3b-catalogue-codes/1', source, rule: `codes in moduleInfo.json with no offering in ${year} (catalogue-only), sorted`,
      count: catalogue.length, codes: catalogue.map((r) => r.code),
    })}\n`,
    // One row per line, so a catalogue change diffs by row.
    catalogueOnly: `{"schema":"vnm-3b-catalogue-only/1","source":${JSON.stringify(source)},"columns":["code","title","description"],"count":${catalogue.length},"rows":[\n${
      catalogue.map((r) => JSON.stringify([r.code, r.title, r.description])).join(',\n')}\n]}\n`,
  };
}

/**
 * The committed files, of `byPath` (repo-relative path -> the bytes it should hold), that differ
 * or are missing under `root`, in `byPath`'s order.
 * @param {Record<string, string>} byPath
 * @param {string} [root]
 */
export async function staleFiles(byPath, root = ROOT) {
  const stale = [];
  for (const [rel, want] of Object.entries(byPath)) {
    const have = await readFile(join(root, rel), 'utf8').catch(() => null);
    if (have !== want) stale.push(rel);
  }
  return stale;
}

/**
 * Every file a corpus's build owns, as repo-relative path -> bytes.
 * @param {'production' | 'pinned'} corpus
 * @returns {Promise<Record<string, string>>}
 */
export async function build(corpus) {
  if (corpus === 'production') {
    const c = await productionCorpus();
    const out = corpusFiles({ records: c.records, modules: c.modules, source: { release: c.entry.release, acadYear: c.acadYear, moduleInfoSha256: c.entry.sha256 } });
    return Object.fromEntries(Object.entries(CORPUS_OUTPUTS.production).map(([k, rel]) => [rel, out[/** @type {keyof typeof out} */ (k)]]));
  }
  const { files, shared } = await pinnedBuild();
  return {
    ...Object.fromEntries(Object.entries(CORPUS_OUTPUTS.pinned).map(([k, rel]) => [rel, files[/** @type {keyof typeof files} */ (k)]])),
    ...Object.fromEntries(Object.entries(SHARED_OUTPUTS).map(([k, rel]) => [rel, shared[/** @type {keyof typeof shared} */ (k)]])),
  };
}

/**
 * The pinned catalogue-only rows as a file (.data/catalogue/, git-ignored), rebuilt if absent or
 * stale: what vitest.config.mjs aliases `catalogue-only-data` to for test/full.
 */
export async function pinnedCatalogueOnlyPath() {
  const { files } = await pinnedBuild();
  const path = join(ROOT, '.data/catalogue/catalogue-only-pinned.json');
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== files.catalogueOnly) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, files.catalogueOnly);
  }
  return path;
}

/** The pinned corpus's files and the shared files. */
async function pinnedBuild() {
  const corpus = await loadPinnedCorpus();
  const source = { release: PINNED_RELEASE, acadYear: corpus.acadYear, moduleInfoSha256: corpus.moduleInfoSha256 };
  const offered = corpus.modules.map((m) => m.code).sort(byCode);
  const offeredSet = new Set(offered);
  const moduleOf = new Map(corpus.modules.map((m) => [m.code, m]));
  const recordOf = new Map(corpus.records.map((r) => [String(r.moduleCode), r]));

  /** @type {Record<string, number>} */
  const prefixCounts = {};
  for (const c of offered) prefixCounts[lettersOf(c)] = (prefixCounts[lettersOf(c)] ?? 0) + 1;
  const prefixes = Object.keys(prefixCounts).sort(byCode);

  const catalogue = catalogueOnlyRecords(corpus.records).sort((a, b) => byCode(a.code, b.code));
  const catalogueSet = new Set(catalogue.map((r) => r.code));

  const ge = await readJson('eval/prereg/ge-pillars.json');
  const collision = await readJson('eval/prereg/collision-list.json');
  const cohort = await readJson('eval/prereg/cohort-only-prereq.json');
  const phrases = await readJson('eval/prereg/intent-phrases.json');

  // groups-v1, a singleton counting as its own group (A2-5).
  const groups = (await readJson('eval/groups.json')).groups;
  /** @type {Map<string, number>} */
  const groupOf = new Map();
  groups.forEach((/** @type {string[]} */ g, /** @type {number} */ i) => g.forEach((m) => groupOf.set(m, i)));
  /** @param {string[]} codes */
  const groupCount = (codes) => new Set(codes.map((c) => (groupOf.has(c) ? `g${groupOf.get(c)}` : c))).size;
  /** @param {string} p */
  const members = (p) => {
    const [lo, hi] = partialRange(p);
    return offered.filter((c) => c >= lo && c < hi);
  };
  /** @param {string} p */
  const partial = (p) => ({ members: members(p).length, groups: groupCount(members(p)) });

  /** @type {Map<string, number>} */
  const df = new Map();
  for (const m of corpus.modules) for (const t of new Set(queryTokens(`${m.title} ${m.description}`))) df.set(t, (df.get(t) ?? 0) + 1);

  const prefixPairs = [];
  for (const a of prefixes) for (const b of prefixes) if (a !== b && b.startsWith(a)) prefixPairs.push(`${a}/${b}`);
  const strictN000 = (/** @type {string} */ c) => /^[A-Z]+[1-9]000$/.test(c);
  const suffixedN000 = (/** @type {string} */ c) => /^[A-Z]+[1-9]000[A-Z]*$/.test(c);
  const withAndWithoutS = offered.filter((c) => !c.endsWith('S') && offeredSet.has(`${c}S`));
  const pillarMembers = offered.filter((c) => ge.prefixes.includes(lettersOf(c)));

  const counts = {
    schema: 'vnm-3b0-counts/1',
    source: { ...source, offered: offered.length, catalogueRecords: corpus.records.length },
    plan: 'docs/plans/phase3.md §1 "Corpus facts for 3B–3H" (critic C), re-run by 3B-0',
    prefixes: {
      count: prefixes.length,
      byLength: prefixes.reduce((n, p) => ({ ...n, [p.length]: (n[p.length] ?? 0) + 1 }), /** @type {Record<number, number>} */ ({})),
      notPrefixes: Object.fromEntries(['ART', 'LAW', 'COMP', 'MATH', 'ECON'].map((p) => [p, prefixCounts[p] ?? 0])),
      collisionSeed: Object.fromEntries(collision.seed.map((/** @type {string} */ p) => [p, prefixCounts[p] ?? 0])),
      prefixPairs: { count: prefixPairs.length, examples: prefixPairs.filter((p) => ['CS/CSA', 'SE/SEA', 'PH/PHS', 'LA/LAJ', 'GES/GESS'].includes(p)) },
      dfPositive: { count: prefixes.filter((p) => (df.get(p.toLowerCase()) ?? 0) > 0).length, of: prefixes.length,
        examples: ['CS', 'GEN', 'GET', 'GEX'].filter((p) => (df.get(p.toLowerCase()) ?? 0) > 0) },
    },
    ranges: {
      naiveCS: offered.filter((c) => c >= 'CS' && c < 'CT' && c.startsWith('CSA')),
      digitBoundedCS: offered.filter((c) => c >= 'CS0' && c < 'CS:' && !/^CS\d/.test(c)),
      digitBoundedGES: members('GES').filter((c) => c.startsWith('GESS')),
    },
    partialCodes: Object.fromEntries(['GEA', 'CS101', 'DAO17', 'MUL21', 'CS32', 'GEC', 'GEX', 'GESS', 'PL32'].map((p) => [p, partial(p)])),
    xxN000: {
      offeredStrict: offered.filter(strictN000).length,
      offeredWithSuffix: offered.filter(suffixedN000).length,
      offeredWithSuffixCodes: offered.filter(suffixedN000),
      catalogueStrict: catalogue.filter((r) => strictN000(r.code)).length,
      catalogueWithSuffix: catalogue.filter((r) => suffixedN000(r.code)).length,
    },
    trailingS: {
      count: withAndWithoutS.length,
      cs1231: { offered: offeredSet.has('CS1231'), offeredS: offeredSet.has('CS1231S'), su: recordOf.get('CS1231')?.attributes?.su === true },
    },
    cs4400: { offered: offeredSet.has('CS4400'), catalogue: recordOf.has('CS4400') },
    catalogueOnly: {
      count: catalogue.length,
      examples: Object.fromEntries(['GEQ1000', 'GEH1001', 'IS1103', 'ACC1701X'].map((c) => [c, catalogueSet.has(c) ? recordOf.get(c)?.title : null])),
    },
    pillars: {
      byPrefix: Object.fromEntries(ge.prefixes.map((/** @type {string} */ p) => [p, prefixCounts[p] ?? 0])),
      members: pillarMembers.length,
      groups: groupCount(pillarMembers),
    },
    meCodes: { ME3000: offeredSet.has('ME3000'), IS6000: offeredSet.has('IS6000'), GEA1000: offeredSet.has('GEA1000'), ES1000: offeredSet.has('ES1000') },
    level: { CS3000offered: offeredSet.has('CS3000'), cs3Level3: offered.filter((c) => /^CS\d/.test(c) && moduleOf.get(c)?.level === 3).length },
  };

  const json = (/** @type {unknown} */ v) => `${JSON.stringify(v, null, 1)}\n`;
  return {
    files: corpusFiles({ records: corpus.records, modules: corpus.modules, source, label: 'pinned' }),
    shared: {
      gePillars: json({
        schema: 'vnm-3b-ge-pillars/1', from: 'eval/prereg/ge-pillars.json (P-6, unchanged)',
        source: { url: ge.source.url, check: 'docs/evidence/phase3/3b-0.md "GE page"' },
        prefixes: ge.prefixes, genericPhrases: ge.genericPhrases, pillars: ge.pillars,
      }),
      collisionList: json({
        schema: 'vnm-3b-collision-list/1', from: 'eval/prereg/collision-list.json (P-6, unchanged)',
        list: collision.list, exempt: collision.exempt,
      }),
      cohortOnly: json({
        schema: 'vnm-3h-cohort-only/1', from: 'eval/prereg/cohort-only-prereq.json (P-6, unchanged)',
        normalise: cohort.normalise, remove: cohort.remove, remainder: cohort.remainder, remainderFlags: cohort.remainderFlags,
      }),
      constraintPhrases: json({
        schema: 'vnm-3h-constraint-phrases/1', from: 'eval/prereg/intent-phrases.json `constraints` (P-6, unchanged)',
        exam: phrases.constraints.exam.phrases, su: phrases.constraints.su.phrases,
        hoursBelow: phrases.constraints.hoursBelow.phrases, light: phrases.constraints.hoursBelow.light,
        prereq: phrases.constraints.prereq.phrases,
      }),
      counts: json(counts),
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, corpus: { type: 'string' } } });
  const corpus = values.corpus;
  if (corpus !== 'production' && corpus !== 'pinned') {
    console.error('usage: node scripts/build-3b-data.mjs --corpus production|pinned [--check]');
    process.exit(1);
  }
  try {
    const out = await build(corpus);
    if (values.check) {
      const stale = await staleFiles(out);
      if (stale.length) { console.error(`out of date: ${stale.join(', ')} (node scripts/build-3b-data.mjs --corpus ${corpus})`); process.exitCode = 1; }
      else console.log(`3B data (${corpus}) up to date`);
    } else {
      for (const [rel, bytes] of Object.entries(out)) {
        await mkdir(dirname(join(ROOT, rel)), { recursive: true });
        await writeFile(join(ROOT, rel), bytes);
        console.log(`wrote ${rel}`);
      }
    }
  } catch (err) {
    console.error(`build-3b-data: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}
