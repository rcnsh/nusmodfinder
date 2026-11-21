// @ts-check
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCorpusFile, loadPinnedWith } from './corpus.mjs';
import { rankerIntentParser } from './corrected.mjs';
import { ConstraintFieldsError, CorpusMismatchError, ParseMismatchError, ReferenceParseError, RunFileError } from './errors.mjs';
import { compare, FEATURE_GAP_SHAPES, K, qrelsFor, scoreRun } from './metrics.mjs';
import { REPO, loadStudyMap, studyMapSha256 } from './sets.mjs';

export const REFERENCE_PARSE = Object.freeze({ tag: 'parse-reference', sha: 'fbfae1012af3556a49b67ac4bec1bee88d863b8f' });

export const CONSTRAINT_FIELDS = Object.freeze(['examSemesters', 'su', 'gradingBasis', 'workloadHours', 'prereqNone', 'prereqCohortOnly', 'ngAllow']);

/**
 * @typedef {{ exam?: 0, su?: 1, hoursBelow?: number, prereq?: 'none' }} PhraseConstraints
 * @typedef {{ constraints: Record<string, unknown>, semantics: string | null }} Parse
 * @typedef {{ examSemesters: number[], su: boolean, gradingBasis: string | null, workloadHours: number | null,
 *   prereqNone: boolean, prereqCohortOnly: boolean, ngAllow: number }} ConstraintFields
 * @typedef {{ sem: number | undefined, bit: number }} Exchange
 * @typedef {{ phrase: PhraseConstraints, semantics: string | null, sem: number | undefined, exchange: Exchange | null }} QueryConstraints
 * @typedef {{
 *   reference: (text: string) => Parse & { corrected: string | null },
 *   fieldsOf: (code: string) => ConstraintFields | undefined,
 *   suGrading: (basis: string | null) => boolean,
 *   ngBit: (echo: { ng: true, sem?: number, study: any }) => number | null,
 *   source: { reference: string, vocabularySha256: string, fields: string, lib: string, runTextSha256: string, fieldsSha256: string },
 * }} RuleSources
 */

/**
 * @param {string[]} codes
 * @param {(code: string) => Record<string, unknown> | undefined} fieldsOf
 */
export function constraintFieldsSha256(codes, fieldsOf) {
  const h = createHash('sha256');
  for (const code of [...codes].sort()) {
    const m = fieldsOf(code);
    h.update(`${code}\t${JSON.stringify(CONSTRAINT_FIELDS.map((k) => (m && k in m ? m[k] : null)))}\n`);
  }
  return h.digest('hex');
}

/** @param {unknown} v */
const truthyNg = (v) => v !== undefined && v !== null && v !== false && !['', 'false', '0'].includes(String(v));

/**
 * @param {Pick<ConstraintFields, 'examSemesters' | 'su' | 'gradingBasis' | 'workloadHours' | 'prereqNone' | 'prereqCohortOnly'>} m
 * @param {PhraseConstraints} c
 * @param {{ prereq: 'i' | 'ii' | string | null, suGrading: (basis: string | null) => boolean, sem?: number }} o
 * @returns {'exam' | 'su' | 'hoursBelow' | 'prereq' | null}
 */
export function failedConstraint(m, c, o) {
  if (c.exam === 0 && (o.sem !== undefined ? m.examSemesters.includes(o.sem) : m.examSemesters.length > 0)) return 'exam';
  if (c.su === 1 && !(m.su || o.suGrading(m.gradingBasis))) return 'su';
  if (c.hoursBelow !== undefined && (m.workloadHours === null || m.workloadHours >= c.hoursBelow)) return 'hoursBelow';
  if (c.prereq === 'none' && !(m.prereqNone || (o.prereq === 'ii' && m.prereqCohortOnly))) return 'prereq';
  return null;
}

/**
 * @param {unknown} interpreted
 * @returns {Parse}
 */
export function candidateParse(interpreted) {
  /** @type {Record<string, unknown>} */
  const c = {};
  let semantics = null;
  const i = /** @type {Record<string, any> | null} */ (interpreted && typeof interpreted === 'object' ? interpreted : null);
  if (i) {
    if (i.exam !== null && i.exam !== undefined) c.exam = i.exam;
    if (i.su !== null && i.su !== undefined) c.su = typeof i.su === 'object' ? i.su.value : i.su;
    if (i.hoursBelow !== null && i.hoursBelow !== undefined) c.hoursBelow = i.hoursBelow;
    if (i.prereq !== null && i.prereq !== undefined) {
      c.prereq = typeof i.prereq === 'object' ? i.prereq.value : i.prereq;
      semantics = typeof i.prereq === 'object' ? i.prereq.semantics ?? null : null;
    }
  }
  return { constraints: c, semantics };
}

/** @param {Parse} p */
const canonical = (p) => JSON.stringify([Object.entries(p.constraints).sort(([a], [b]) => a.localeCompare(b)), p.semantics]);

/** @param {Parse} a @param {Parse} b */
export const sameParse = (a, b) => canonical(a) === canonical(b);

/** @param {Parse} p */
export const isParsed = (p) => Object.keys(p.constraints).length > 0;

/**
 * @param {import('./metrics.mjs').EvalQuery} q
 * @param {Parse} ref
 * @param {import('./sets.mjs').StudyMap} studyMap
 * @param {RuleSources['ngBit']} ngBit
 * @returns {QueryConstraints}
 */
export function queryConstraints(q, ref, studyMap, ngBit) {
  const f = /** @type {Record<string, unknown>} */ (q.filters ?? {});
  const sem = f.sem === undefined || f.sem === null || f.sem === '' || f.sem === false ? undefined : Number(f.sem);
  /** @type {Exchange | null} */
  let exchange = null;
  if (truthyNg(f.ng)) {
    const persona = /** @type {{ persona?: string }} */ (q).persona;
    const study = persona === undefined || persona === null ? studyMap.noPersona : studyMap.personas[persona];
    if (!study) throw new RunFileError('an exchange-mode query\'s persona has no study level in eval/study-map.json');
    let bit = 0;
    try {
      bit = ngBit({ ng: true, ...(sem === undefined ? {} : { sem }), study }) ?? 0;
    } catch {
      bit = 0;
    }
    exchange = { sem, bit };
  }
  return { phrase: /** @type {PhraseConstraints} */ (ref.constraints), semantics: ref.semantics, sem, exchange };
}

/** @param {QueryConstraints} c */
const constrained = (c) => Object.keys(c.phrase).length > 0 || c.exchange !== null;

/**
 * @param {ConstraintFields} m
 * @param {QueryConstraints} c
 * @param {RuleSources['suGrading']} suGrading
 * @param {{ phraseOnly?: boolean }} [o]
 */
export function failure(m, c, suGrading, o = {}) {
  const why = failedConstraint(m, c.phrase, { prereq: c.semantics, suGrading, sem: c.sem });
  if (why || o.phraseOnly || !c.exchange) return why;
  return ((m.ngAllow ?? 0) & c.exchange.bit) === 0 ? 'exchange' : null;
}

/**
 * @param {import('./metrics.mjs').RunFile} run
 * @param {string} id
 */
const shown = (run, id) => {
  const r = run.results[id];
  return r && r.status === 200 ? r.codes : [];
};

/**
 * @param {import('./metrics.mjs').RunFile} run
 * @param {{ intents?: boolean, explicit?: boolean }} [o]
 */
export function assertRuleRun(run, o = {}) {
  const c = /** @type {any} */ (run.config) ?? {};
  const what = `run ${run.variant}`;
  if (c.filters !== true) throw new RunFileError(`${what} was not run with the queries' filters; the compliance rule scores filtered runs`);
  if (c.strip?.length) throw new RunFileError(`${what} ran with filters stripped; the compliance rule scores filtered runs`);
  if ((c.mode ?? 'hybrid') !== 'hybrid') throw new RunFileError(`${what} ran mode ${c.mode}; the compliance rule scores hybrid runs`);
  if (c.studyMap !== undefined && c.studyMap !== studyMapSha256()) throw new RunFileError(`${what} used another study map than the committed eval/study-map.json`);
  if (c.explicit !== undefined && !o.explicit) throw new RunFileError(`${what} sent explicit constraint params (the explicit-params diagnostic's baseline); it is never a gate's run`);
  if (o.intents && (!run.intents || typeof run.intents !== 'object')) {
    throw new RunFileError(`${what} records no per-query parse (\`intents\`); re-run it with this runner, which records each query's \`interpreted\``);
  }
}

/**
 * @param {{
 *   queries: import('./metrics.mjs').EvalQuery[],
 *   qrels: import('./metrics.mjs').Qrels,
 *   base: import('./metrics.mjs').RunFile,
 *   cand: import('./metrics.mjs').RunFile,
 *   sources: RuleSources,
 *   studyMap?: import('./sets.mjs').StudyMap,
 *   explicitBaseline?: boolean,
 * }} o
 */
export function applyComplianceRule({ queries, qrels, base, cand, sources, studyMap = loadStudyMap(), explicitBaseline = false }) {
  assertRuleRun(cand, { intents: true });
  assertRuleRun(base, { explicit: explicitBaseline });
  const n = queries.length;
  const recorded = /** @type {{ textSha256?: string, constraintFieldsSha256?: string }} */ (cand.corpus ?? {});
  if (recorded.textSha256 !== sources.source.runTextSha256) {
    throw new CorpusMismatchError(`run ${cand.variant} was made on another corpus text than the one the reference parse's vocabulary is built from`);
  }
  /** @type {Map<string, ReturnType<RuleSources['reference']>>} */
  const ref = new Map(queries.map((q) => [q.id, sources.reference(q.text)]));
  const parsed = queries.filter((q) => isParsed(/** @type {Parse} */ (ref.get(q.id))));
  if (parsed.length === 0) {
    throw new ReferenceParseError(`the reference parse (${REFERENCE_PARSE.tag}) parses none of the ${n} queries; the compliance rule does not run`);
  }
  const intents = /** @type {Record<string, unknown>} */ (cand.intents);
  let mismatched = 0;
  for (const q of queries) {
    const r = cand.results[q.id];
    if (!r) throw new RunFileError(`run ${cand.variant} has no result for one of the ${n} queries`);
    if (!base.results[q.id]) throw new RunFileError(`run ${base.variant} has no result for one of the ${n} queries`);
    if (r.status !== 200) continue;
    if (!sameParse(candidateParse(intents[q.id]), /** @type {Parse} */ (ref.get(q.id)))) mismatched++;
  }
  if (mismatched) {
    throw new ParseMismatchError(`the candidate's parse differs from the reference parse (${REFERENCE_PARSE.tag}) on ${mismatched} of ${n} queries; the rule stops before any verdict, so no look is spent`);
  }

  /** @type {Map<string, QueryConstraints>} */
  const cons = new Map(queries.map((q) => [q.id, queryConstraints(q, /** @type {Parse} */ (ref.get(q.id)), studyMap, sources.ngBit)]));

  /** @type {Set<string>} */
  const codes = new Set();
  queries.forEach((q, i) => {
    for (const code of qrelsFor(qrels, q.id, i).grades.keys()) codes.add(code);
    for (const code of [...shown(base, q.id), ...shown(cand, q.id)]) codes.add(code);
  });
  const missing = [...codes].filter((code) => {
    const m = sources.fieldsOf(code);
    return !m || CONSTRAINT_FIELDS.some((k) => !(k in m));
  }).length;
  if (missing) throw new ConstraintFieldsError(`${missing} of ${codes.size} judged or returned codes have no constraint fields in ${sources.source.fields}`);
  if (!recorded.constraintFieldsSha256) {
    throw new RunFileError(`run ${cand.variant} records no corpus.constraintFieldsSha256; re-run it with this runner`);
  }
  if (recorded.constraintFieldsSha256 !== sources.source.fieldsSha256) {
    throw new CorpusMismatchError(`the constraint fields in ${sources.source.fields} differ from those run ${cand.variant} was seeded with`);
  }
  const fields = (/** @type {string} */ code) => /** @type {ConstraintFields} */ (sources.fieldsOf(code));

  /** @type {import('./metrics.mjs').Qrels['queries']} */
  const filteredQueries = {};
  /** @type {Set<string>} */
  const emptied = new Set();
  /** @type {Record<string, { removed: Record<string, string> }>} */
  const removedBy = {};
  queries.forEach((q, i) => {
    const { grades } = qrelsFor(qrels, q.id, i);
    const c = /** @type {QueryConstraints} */ (cons.get(q.id));
    /** @type {Record<string, number>} */
    const judgments = {};
    /** @type {Record<string, string>} */
    const removed = {};
    for (const [code, g] of grades) {
      const why = g >= 1 && constrained(c) ? failure(fields(code), c, sources.suGrading) : null;
      judgments[code] = why ? 0 : g;
      if (why) removed[code] = why;
    }
    filteredQueries[q.id] = { judgments, groups: qrels.queries[q.id]?.groups ?? [] };
    if (Object.keys(removed).length) removedBy[q.id] = { removed };
    const rawAnswerable = [...grades.values()].some((g) => g >= 1);
    if (rawAnswerable && !Object.values(judgments).some((g) => g >= 1)) emptied.add(q.id);
  });
  const filtered = { ...qrels, queries: filteredQueries };

  /** @param {import('./metrics.mjs').QueryScore[]} scores */
  const unscoreEmptied = (scores) => scores.map((s) => (emptied.has(s.id) ? { ...s, answerable: false, noAnswer: false, unscored: true } : s));
  const baseRaw = scoreRun(base, queries, qrels);
  const candRaw = scoreRun(cand, queries, qrels);
  const baseScores = unscoreEmptied(scoreRun(base, queries, filtered));
  const candScores = unscoreEmptied(scoreRun(cand, queries, filtered));
  const cmp = compare(baseScores, candScores);
  const raw = compare(baseRaw, candRaw);

  const blockIdx = baseScores.flatMap((b, i) => (b.answerable && b.featureGap ? [i] : []));
  const blockDeltas = blockIdx.map((i) => candScores[i].ndcg - baseScores[i].ndcg);
  const mean = (/** @type {number[]} */ xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const block = {
    n: blockIdx.length,
    base: blockIdx.length ? mean(blockIdx.map((i) => baseScores[i].ndcg)) : NaN,
    cand: blockIdx.length ? mean(blockIdx.map((i) => candScores[i].ndcg)) : NaN,
    delta: blockIdx.length ? mean(blockDeltas) : NaN,
  };

  /** @type {{ id: string, code: string, why: string }[]} */
  const violations = [];
  for (const q of parsed) {
    const c = /** @type {QueryConstraints} */ (cons.get(q.id));
    for (const code of shown(cand, q.id)) {
      const why = failure(fields(code), c, sources.suGrading, { phraseOnly: true });
      if (why) violations.push({ id: q.id, code, why });
    }
  }
  const top = (/** @type {import('./metrics.mjs').QueryRun} */ r) => JSON.stringify([r.status, r.codes.slice(0, K)]);
  const unparsed = queries.filter((q) => !isParsed(/** @type {Parse} */ (ref.get(q.id))));
  const differing = unparsed.filter((q) => top(base.results[q.id]) !== top(cand.results[q.id])).map((q) => q.id);
  const newErrors = queries.filter((q) => cand.results[q.id].status !== 200 && base.results[q.id].status === 200).map((q) => q.id);

  return {
    cmp,
    raw,
    block,
    compliance: { queries: parsed.length, violations },
    identity: { queries: unparsed.length, differing },
    newErrors,
    counts: { parsed: parsed.length, primary: cmp.n, block: block.n, unscored: cmp.unscored.n },
    scores: { base: baseScores, cand: candScores },
    detail: {
      parsed: parsed.map((q) => {
        const p = /** @type {ReturnType<RuleSources['reference']>} */ (ref.get(q.id));
        return { id: q.id, text: q.text, constraints: p.constraints, semantics: p.semantics, corrected: p.corrected, exchange: cons.get(q.id)?.exchange ?? null };
      }),
      emptied: [...emptied],
      removed: removedBy,
      featureGapShapes: FEATURE_GAP_SHAPES,
    },
  };
}

/** @typedef {ReturnType<typeof applyComplianceRule>} ComplianceResult */

/**
 * @param {string} sha
 * @param {string[]} paths
 */
async function extract(sha, paths) {
  const dir = await mkdtemp(join(tmpdir(), 'vnm-compliance-'));
  const present = paths.filter((p) => spawnSync('git', ['cat-file', '-e', `${sha}:${p}`], { cwd: REPO }).status === 0);
  const tar = spawnSync('git', ['archive', '--format=tar', sha, '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
  if (tar.status !== 0) throw new RunFileError(`git archive of a ranker commit failed`);
  if (spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout }).status !== 0) throw new RunFileError('extracting a ranker commit failed');
  return dir;
}

export function assertReferenceTag(repo = REPO) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${REFERENCE_PARSE.tag}^{commit}`], { cwd: repo, encoding: 'utf8' });
  const got = r.status === 0 ? r.stdout.trim() : null;
  if (got !== REFERENCE_PARSE.sha) {
    throw new ReferenceParseError(`tag ${REFERENCE_PARSE.tag} resolves to ${got ? got.slice(0, 7) : 'nothing'}, but the compliance rule's reference parse is frozen at ${REFERENCE_PARSE.sha.slice(0, 7)}; restore the tag`);
  }
}

/**
 * @param {{ modules: NormalisedModule[], label: string }} corpus
 * @returns {Promise<{ parse: RuleSources['reference'], vocabularySha256: string, close: () => Promise<void> }>}
 */
export async function referenceParser(corpus) {
  assertReferenceTag();
  const root = await extract(REFERENCE_PARSE.sha, ['src', 'data']);
  try {
    const url = (/** @type {string} */ f) => pathToFileURL(join(root, 'src', f)).href;
    const { buildVocabulary, parseVocabulary, serializeVocabulary } = await import(url('vocabulary.js'));
    const { canonicalQuery } = await import(url('query-intent.js'));
    const { INTENT } = await import(url('intents.js'));
    const file = buildVocabulary(corpus.modules, { corpus: 'eval', dataVersion: corpus.label });
    const vocabularySha256 = createHash('sha256').update(serializeVocabulary(file)).digest('hex');
    const parser = await rankerIntentParser(root, parseVocabulary(file));
    if (!parser || !INTENT) throw new ReferenceParseError(`tag ${REFERENCE_PARSE.tag} has no constraint-phrase parse`);
    return {
      vocabularySha256,
      parse: (text) => {
        const p = parser(canonicalQuery(text.trim()));
        const c = /** @type {Record<string, unknown>} */ (p.constraints);
        return { constraints: { ...c }, semantics: 'prereq' in c ? INTENT.prereq : null, corrected: p.corrected };
      },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

/**
 * @param {import('./metrics.mjs').RunFile} cand
 * @returns {Promise<{ root: string, label: string, close: () => Promise<void> }>}
 */
async function candidateRoot(cand) {
  const r = /** @type {any} */ (cand.ranker) ?? {};
  if (r.ref === 'WORKTREE' || !r.sha) return { root: REPO, label: 'working tree', close: async () => {} };
  if (!/^[0-9a-f]{40}$/.test(String(r.sha))) throw new RunFileError(`run ${cand.variant} records no ranker sha`);
  const root = await extract(r.sha, ['src', 'data', 'scripts/lib.mjs']);
  return { root, label: String(r.sha).slice(0, 7), close: () => rm(root, { recursive: true, force: true }) };
}

/** @param {any} m */
const hasFields = (m) => CONSTRAINT_FIELDS.every((k) => k in m);

/**
 * @param {import('./sets.mjs').SetLayout} set
 * @param {import('./metrics.mjs').RunFile} cand
 * @returns {Promise<RuleSources & { close: () => Promise<void> }>}
 */
export async function loadRuleSources(set, cand) {
  const lib = await candidateRoot(cand);
  /** @type {(() => Promise<void>)[]} */
  const closers = [lib.close];
  const close = async () => { for (const c of closers) await c(); };
  try {
    const setCorpus = join(set.dir, 'corpus.json');
    /** @type {import('./corpus.mjs').Corpus | null} */
    let pinned = null;
    const pinnedCorpus = async () => (pinned ??= await loadPinnedWith(lib.root));
    const runCorpus = existsSync(setCorpus) ? await loadCorpusFile(setCorpus) : await pinnedCorpus();
    const own = existsSync(setCorpus) && runCorpus.modules.every(hasFields);
    const fieldCorpus = own ? runCorpus : await pinnedCorpus();
    const byCode = new Map(fieldCorpus.modules.map((m) => [m.code, /** @type {ConstraintFields} */ (/** @type {unknown} */ (m))]));
    const { suGrading } = await import(pathToFileURL(join(lib.root, 'src/vector-bundle.js')).href);
    const { ngBit } = await import(pathToFileURL(join(lib.root, 'src/ng-bit.js')).href);
    const ref = await referenceParser({ modules: runCorpus.modules, label: runCorpus.info.textSha256.slice(0, 12) });
    closers.push(ref.close);
    const fieldsOf = (/** @type {string} */ code) => byCode.get(code);
    return {
      reference: ref.parse,
      fieldsOf,
      suGrading,
      ngBit,
      source: {
        reference: `${REFERENCE_PARSE.tag} ${REFERENCE_PARSE.sha.slice(0, 7)}`,
        vocabularySha256: ref.vocabularySha256,
        fields: own ? 'the set\'s corpus.json' : `the pinned snapshot normalised by scripts/lib.mjs at ${lib.label}`,
        lib: lib.label,
        runTextSha256: runCorpus.info.textSha256,
        fieldsSha256: constraintFieldsSha256(runCorpus.modules.map((m) => m.code), (c) => /** @type {any} */ (fieldsOf(c))),
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/**
 * @param {Record<string, unknown>} constraints
 * @returns {Record<string, string>}
 */
export function explicitParams(constraints) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of ['exam', 'su', 'hoursBelow', 'prereq']) if (constraints[k] !== undefined) out[k] = String(constraints[k]);
  return out;
}
