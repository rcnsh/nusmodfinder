// @ts-check
// Phase 5 5F's compliance-aware rule (docs/plans/phase5.md §3 5F; ADR 0003's
// draft amendment "Phase 5 5F"). `--change-kind compliance`, on dev and the
// holdout, never the test set.
//
// - The reference parse is frozen: pass A of tag `3h` (2476012, which
//   predates PARSE_PHRASES, so its phrases always compile), run over the
//   vocabulary its own builder makes from the run corpus. It decides every
//   query's constraints for scoring, independent of the candidate.
// - The candidate's parse is what its Worker answered (`interpreted`, recorded
//   per query in the run file's `intents`). Any difference from the reference
//   on any query throws ParseMismatchError; the CLI computes all of this
//   before it writes a ledger row, so a mismatch spends no look.
// - A query is constrained when the reference parses a phrase in it, or it is
//   an exchange-mode query (`ng`, with its `sem` and the study map's `study`).
//   Its qrels are filtered: a judged document counts as relevant only if it
//   satisfies every constraint, in DCG and IDCG alike (a failing document's
//   grade becomes 0). A query the filter leaves with no relevant document is
//   unscored. The candidate and the baseline are scored on the same filtered
//   qrels; the exact-code check stays on the raw qrels.
// - The constraint fields (exam semesters, S/U, workload, prerequisite, the
//   allow mask) come from the pinned snapshot normalised by the candidate's
//   scripts/lib.mjs, and the exchange bit from its src/ng-bit.js with
//   eval/study-map.json. A judged or returned code without them throws
//   ConstraintFieldsError. (A synthetic set whose own corpus.json carries
//   every field is its own source; the eval fixture's does not.)
// - Compliance: every result the candidate shows for a parsed query satisfies
//   the parsed constraints. Identity: every query the reference leaves
//   unparsed has its top 10 (status and codes) byte-identical to the baseline's.
// Errors name counts, never a query id, text or code: on the holdout only the
// class is printed, but a message must be safe either way.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCorpusFile, loadPinnedWith } from './corpus.mjs';
import { rankerIntentParser } from './corrected.mjs';
import { ConstraintFieldsError, CorpusMismatchError, GateRuleError, ParseMismatchError, ReferenceParseError, RunFileError } from './errors.mjs';
import { compare, FEATURE_GAP_SHAPES, K, qrelsFor, scoreRun } from './metrics.mjs';
import { REPO, loadStudyMap, studyMapSha256 } from './sets.mjs';

/** The frozen reference parse: 3H's pass A at this tag, which must still resolve to this commit. */
export const REFERENCE_PARSE = Object.freeze({ tag: '3h', sha: '24760122a489dac6e4c604c1bacb8cd002624391' });

/** ADR 0003, whose 5F amendment states the rule; while it is a draft no custody set takes it. */
export const ADR_0003 = join(REPO, 'docs', 'decisions', '0003-eval-holdout-and-gate.md');
/** The line that marks the amendment a draft. The lead's adoption removes it. */
export const DRAFT_MARKER = '**Draft, not yet in force: the lead adopts it before any count or look.**';

/**
 * Throws GateRuleError while ADR 0003's 5F amendment is still a draft, for
 * every encrypted set but the throwaway `selftest` (the tests' set).
 * @param {{ name: string, encrypted: boolean }} set
 * @param {string} [adr] the ADR's text
 */
export function assertRuleAdopted(set, adr = readFileSync(ADR_0003, 'utf8')) {
  if (!set.encrypted || set.name === 'selftest') return;
  if (adr.includes(DRAFT_MARKER)) {
    throw new GateRuleError(`--change-kind compliance is refused on the ${set.name} set: ADR 0003's 5F amendment is still a draft, and the lead adopts it before any count or look`);
  }
}

/** The fields the rule reads per module (scripts/lib.mjs normalise and offeredModules). */
export const CONSTRAINT_FIELDS = Object.freeze(['examSemesters', 'su', 'gradingBasis', 'workloadHours', 'prereqNone', 'prereqCohortOnly', 'ngAllow']);

/**
 * @typedef {{ exam?: 0, su?: 1, hoursBelow?: number, prereq?: 'none' }} PhraseConstraints
 * @typedef {{ constraints: Record<string, unknown>, semantics: string | null }} Parse
 *   `semantics`: the prerequisite semantics (`i`, `ii`) when `prereq` is set, else null.
 * @typedef {{ examSemesters: number[], su: boolean, gradingBasis: string | null, workloadHours: number | null,
 *   prereqNone: boolean, prereqCohortOnly: boolean, ngAllow: number }} ConstraintFields
 * @typedef {{ sem: number | undefined, bit: number }} Exchange `bit` 0 when the semester has none (closed)
 * @typedef {{ phrase: PhraseConstraints, semantics: string | null, sem: number | undefined, exchange: Exchange | null }} QueryConstraints
 * @typedef {{
 *   reference: (text: string) => Parse & { corrected: string | null },
 *   fieldsOf: (code: string) => ConstraintFields | undefined,
 *   suGrading: (basis: string | null) => boolean,
 *   ngBit: (echo: { ng: true, sem?: number, study: any }) => number | null,
 *   source: { reference: string, vocabularySha256: string, fields: string, lib: string, runTextSha256: string, fieldsSha256: string },
 * }} RuleSources `runTextSha256`: the run corpus the reference's vocabulary was
 *   built from; `fieldsSha256`: constraintFieldsSha256 of the fields the rule
 *   reads, over the run corpus's codes. Both must equal what the candidate run
 *   recorded (its `corpus`), so the rule reads what the candidate was seeded with.
 */

/**
 * A digest of every module's constraint fields, by code: what a run records
 * as `corpus.constraintFieldsSha256` (the fields it seeded the Worker with),
 * and what the rule recomputes from its own source.
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
 * The first parsed constraint a module fails, or null. As src/search.js
 * applies them: exam=0 with a semester means no exam in that semester.
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
 * The candidate's parse from its Worker's `interpreted` echo (3H keys only).
 * Values pass through as answered, so an unexpected one reads as a mismatch.
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
 * A query's constraints for scoring: the reference's phrases, and in exchange
 * mode its semester and study level's allow-mask bit.
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
      bit = 0; // a special term in exchange mode: /search refuses it, so nothing is open
    }
    exchange = { sem, bit };
  }
  return { phrase: /** @type {PhraseConstraints} */ (ref.constraints), semantics: ref.semantics, sem, exchange };
}

/** @param {QueryConstraints} c */
const constrained = (c) => Object.keys(c.phrase).length > 0 || c.exchange !== null;

/**
 * Why a module fails a query's constraints (a phrase kind, or `exchange`), or null.
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
 * Each query's codes a run returned, status 200 only.
 * @param {import('./metrics.mjs').RunFile} run @param {string} id
 */
const shown = (run, id) => {
  const r = run.results[id];
  return r && r.status === 200 ? r.codes : [];
};

/**
 * Throws RunFileError unless a run may be scored under the rule: filtered,
 * nothing stripped, hybrid, the committed study map, and (`intents`) the
 * per-query parse recorded.
 * @param {import('./metrics.mjs').RunFile} run
 * @param {{ intents?: boolean, explicit?: boolean }} [o] `explicit`: the run may carry explicit 3H params (the B2-4 diagnostic's baseline)
 */
export function assertRuleRun(run, o = {}) {
  const c = /** @type {any} */ (run.config) ?? {};
  const what = `run ${run.variant}`;
  if (c.filters !== true) throw new RunFileError(`${what} was not run with the queries' filters; the compliance rule scores filtered runs`);
  if (c.strip?.length) throw new RunFileError(`${what} ran with filters stripped; the compliance rule scores filtered runs`);
  if ((c.mode ?? 'hybrid') !== 'hybrid') throw new RunFileError(`${what} ran mode ${c.mode}; the compliance rule scores hybrid runs`);
  if (c.studyMap !== undefined && c.studyMap !== studyMapSha256()) throw new RunFileError(`${what} used another study map than the committed eval/study-map.json`);
  if (c.explicit !== undefined && !o.explicit) throw new RunFileError(`${what} sent explicit 3H params (the B2-4 diagnostic's baseline); it is never a gate's run`);
  if (o.intents && (!run.intents || typeof run.intents !== 'object')) {
    throw new RunFileError(`${what} records no per-query parse (\`intents\`); re-run it with this runner, which records each query's \`interpreted\``);
  }
}

/**
 * The rule over one candidate and baseline. Pure: every source comes in.
 * Throws (before any verdict) ReferenceParseError when the reference parses
 * no query, ParseMismatchError when the candidate's parse differs on any
 * query, ConstraintFieldsError when a judged or returned code has no fields.
 * @param {{
 *   queries: import('./metrics.mjs').EvalQuery[],
 *   qrels: import('./metrics.mjs').Qrels,
 *   base: import('./metrics.mjs').RunFile,
 *   cand: import('./metrics.mjs').RunFile,
 *   sources: RuleSources,
 *   studyMap?: import('./sets.mjs').StudyMap,
 *   explicitBaseline?: boolean,
 * }} o `qrels` with the corpus groups already joined (withCorpusGroups)
 */
export function applyComplianceRule({ queries, qrels, base, cand, sources, studyMap = loadStudyMap(), explicitBaseline = false }) {
  assertRuleRun(cand, { intents: true });
  assertRuleRun(base, { explicit: explicitBaseline });
  const n = queries.length;
  const recorded = /** @type {{ textSha256?: string, constraintFieldsSha256?: string }} */ (cand.corpus ?? {});
  // The reference's vocabulary is built from the run corpus: it must be the candidate's.
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
    // A non-200 answer echoes no parse; it shows nothing and is scored as an error.
    if (r.status !== 200) continue;
    if (!sameParse(candidateParse(intents[q.id]), /** @type {Parse} */ (ref.get(q.id)))) mismatched++;
  }
  if (mismatched) {
    throw new ParseMismatchError(`the candidate's parse differs from the reference parse (${REFERENCE_PARSE.tag}) on ${mismatched} of ${n} queries; the rule stops before any verdict, so no look is spent`);
  }

  /** @type {Map<string, QueryConstraints>} */
  const cons = new Map(queries.map((q) => [q.id, queryConstraints(q, /** @type {Parse} */ (ref.get(q.id)), studyMap, sources.ngBit)]));

  // Every judged and every returned code must have its constraint fields.
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
  // The fields the rule reads are the ones the candidate's Worker was seeded with.
  if (!recorded.constraintFieldsSha256) {
    throw new RunFileError(`run ${cand.variant} records no corpus.constraintFieldsSha256; re-run it with this runner`);
  }
  if (recorded.constraintFieldsSha256 !== sources.source.fieldsSha256) {
    throw new CorpusMismatchError(`the constraint fields in ${sources.source.fields} differ from those run ${cand.variant} was seeded with`);
  }
  const fields = (/** @type {string} */ code) => /** @type {ConstraintFields} */ (sources.fieldsOf(code));

  // Constraint-filtered qrels: a failing document's grade becomes 0.
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

  // The constraint block (FEATURE_GAP_SHAPES): its scored queries' ΔnDCG@10.
  const blockIdx = baseScores.flatMap((b, i) => (b.answerable && b.featureGap ? [i] : []));
  const blockDeltas = blockIdx.map((i) => candScores[i].ndcg - baseScores[i].ndcg);
  const mean = (/** @type {number[]} */ xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const block = {
    n: blockIdx.length,
    base: blockIdx.length ? mean(blockIdx.map((i) => baseScores[i].ndcg)) : NaN,
    cand: blockIdx.length ? mean(blockIdx.map((i) => candScores[i].ndcg)) : NaN,
    delta: blockIdx.length ? mean(blockDeltas) : NaN,
  };

  // Compliance: every shown result of a parsed query satisfies the parsed constraints.
  /** @type {{ id: string, code: string, why: string }[]} */
  const violations = [];
  for (const q of parsed) {
    const c = /** @type {QueryConstraints} */ (cons.get(q.id));
    for (const code of shown(cand, q.id)) {
      const why = failure(fields(code), c, sources.suGrading, { phraseOnly: true });
      if (why) violations.push({ id: q.id, code, why });
    }
  }
  // Identity: an unparsed query's top 10 is the baseline's, byte for byte.
  const top = (/** @type {import('./metrics.mjs').QueryRun} */ r) => JSON.stringify([r.status, r.codes.slice(0, K)]);
  const unparsed = queries.filter((q) => !isParsed(/** @type {Parse} */ (ref.get(q.id))));
  const differing = unparsed.filter((q) => top(base.results[q.id]) !== top(cand.results[q.id])).map((q) => q.id);
  // No new errors, per query: a candidate error where the baseline answered 200
  // (a parsed query's error also hides its parse from the mismatch check).
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
    // Dev only: ids, texts and per-query detail never leave an encrypted set's verdict path.
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

// ---------------------------------------------------------------------------
// Sources (I/O): the reference parse at its tag, and the constraint fields.

/**
 * `git archive <sha> -- <paths>` into a fresh temporary directory (never
 * .eval-work/). The caller removes it.
 * @param {string} sha @param {string[]} paths
 */
async function extract(sha, paths) {
  const dir = await mkdtemp(join(tmpdir(), 'vnm-compliance-'));
  const present = paths.filter((p) => spawnSync('git', ['cat-file', '-e', `${sha}:${p}`], { cwd: REPO }).status === 0);
  const tar = spawnSync('git', ['archive', '--format=tar', sha, '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
  if (tar.status !== 0) throw new RunFileError(`git archive of a ranker commit failed`);
  if (spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout }).status !== 0) throw new RunFileError('extracting a ranker commit failed');
  return dir;
}

/** Throws ReferenceParseError unless the tag still resolves to the frozen commit. */
export function assertReferenceTag(repo = REPO) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${REFERENCE_PARSE.tag}^{commit}`], { cwd: repo, encoding: 'utf8' });
  const got = r.status === 0 ? r.stdout.trim() : null;
  if (got !== REFERENCE_PARSE.sha) {
    throw new ReferenceParseError(`tag ${REFERENCE_PARSE.tag} resolves to ${got ? got.slice(0, 7) : 'nothing'}, but the compliance rule's reference parse is frozen at ${REFERENCE_PARSE.sha.slice(0, 7)}; restore the tag`);
  }
}

/**
 * The reference parse over `modules` (the run corpus), with its vocabulary
 * built by the reference's own builder, labelled as a run labels it.
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
    if (!parser || !INTENT) throw new ReferenceParseError(`tag ${REFERENCE_PARSE.tag} has no 3H parse`);
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
 * The candidate's scripts/lib.mjs and src/ (for the constraint fields, suGrading
 * and ngBit): the working tree for a WORKTREE run, else its commit, extracted.
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
 * Every source the rule reads, for a set and its candidate run. The run
 * corpus (the set's corpus.json, else the pinned snapshot normalised by the
 * candidate's scripts/lib.mjs) feeds the reference's vocabulary, as a run's
 * own vocabulary is built; the constraint fields come from the pinned
 * snapshot, unless the set's corpus.json carries every field itself.
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
 * The explicit /search params a parse maps to (the B2-4 diagnostic's baseline).
 * @param {Record<string, unknown>} constraints
 * @returns {Record<string, string>}
 */
export function explicitParams(constraints) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of ['exam', 'su', 'hoursBelow', 'prereq']) if (constraints[k] !== undefined) out[k] = String(constraints[k]);
  return out;
}
