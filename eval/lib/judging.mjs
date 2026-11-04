// @ts-check
// Phase 2d judging: pure functions over a pool file and a round's state.
// eval/judge.mjs does the I/O (files, encryption); eval/JUDGING.md is the
// protocol. A round:
//   pool --preGrade--> rule grades (hard-constraint violations, judge `rule`)
//        --buildRound--> per-judge batches of ~12 queries, candidates shuffled
//                        with recorded seeds, ~5% planted repeats, drift items
//        --renderJudgePacket--> one self-contained Markdown file per batch
//   judge outputs --collectOutputs--> grades per item, validated
//        --agreementUnits--> A vs B (agreement.mjs)
//        --buildAdjudication--> pass 1 (blind) and pass 2 (both grades) packets
//        --finalJudgments/mergeQrels--> vnm-eval-qrels/1 with a judges object
// A single-judge round (judges { A } only, from prepare or dropJudge) skips
// agreement and adjudication: its final grade is rule, else A's.
// Packets never carry a query id, shape, persona, system, rank or score.
// Validation messages never quote judge-written text (it may carry holdout
// content): they name files, sections, item ids and value types only.
import { createHash } from 'node:crypto';
import { CODE_RULE, applyCodeRule } from './code-rule.mjs';
import { CorpusMismatchError, QrelsError } from './errors.mjs';
import { K, gradeOf, scoreRun, semesterName, violationReason } from './metrics.mjs';
import { mean, rng } from './stats.mjs';

export const STATE_SCHEMA = 'vnm-eval-judging/1';
export const QRELS_SCHEMA = 'vnm-eval-qrels/1';
export const JUDGE_SLOTS = /** @type {const} */ (['A', 'B']);
export const RULE = 'rule';
export const ADJUDICATOR = 'adjudicator';
export const DEFAULT_BATCH = 12;
export const DEFAULT_REPEAT_RATE = 0.05;
export const DEFAULT_DRIFT_RATE = 0.05;
export const DEFAULT_CALIBRATION_N = 150;

/**
 * @typedef {import('./metrics.mjs').EvalQuery} EvalQuery
 * @typedef {import('./metrics.mjs').Qrels} Qrels
 * @typedef {'A' | 'B'} Slot
 * @typedef {{
 *   code: string, title: string, level: number | null, credits: number | null, semesters: number[],
 *   ng: boolean, ngSemesters: number[], faculty: string | null, department: string | null,
 *   description: string | null, prerequisite?: string | null,
 * }} Candidate
 * @typedef {{
 *   id: string, text: string, narrative: unknown, filters: Record<string, unknown>,
 *   constraints: Record<string, unknown>, candidates: Candidate[],
 * }} PoolQuery
 * @typedef {{
 *   schema: string, set: string, queriesVersion: string, seed?: number, depth?: number, sourceRuns?: number,
 *   corpus?: { moduleInfoSha256?: string, ngSha256?: string }, embedding?: string | null, queries: PoolQuery[],
 * }} Pool
 * @typedef {{ grade: number, rationale: string }} Grade
 * @typedef {{ slot: string, batch: string, section: string, queryId: string, code: string, kind: 'new' | 'repeat' | 'drift', repeatOf?: string }} Item
 * @typedef {{ id: string, queryId: string, seed: number, items: string[] }} Section
 * @typedef {{ id: string, seed: number, sections: Section[] }} Batch
 * @typedef {{ A: string, B?: string }} Judges
 * @typedef {{ slot: Slot, judge: string, reason: string, at: string }} DroppedJudge
 */

// ---------------------------------------------------------------------------
// helpers

/** @param {string} queryId @param {string} code */
export const pairKey = (queryId, code) => `${queryId}\t${code}`;
/** @param {string} key */
export const splitKey = (key) => /** @type {[string, string]} */ (key.split('\t'));

/**
 * A uint32 seed derived from a base seed and labels, so every shuffle in a
 * round is reproducible from the round seed alone.
 * @param {number} seed
 * @param {...(string | number)} parts
 */
export function deriveSeed(seed, ...parts) {
  return createHash('sha256').update([seed, ...parts].join('|')).digest().readUInt32BE(0);
}

/**
 * Fisher-Yates with a seeded generator.
 * @template T
 * @param {T[]} xs
 * @param {() => number} rand
 */
export function shuffle(xs, rand) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Opaque item ids ("i" + 6 base-36 characters), unique within `used`.
 * @param {() => number} rand
 * @param {Set<string>} used
 */
function newItemId(rand, used) {
  for (;;) {
    let id = 'i';
    for (let i = 0; i < 6; i++) id += Math.floor(rand() * 36).toString(36);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

/** @param {string} prefix @param {number} i */
const label = (prefix, i) => `${prefix}${String(i + 1).padStart(2, '0')}`;

/**
 * Splits `xs` into ceil(n / size) chunks whose sizes differ by at most one.
 * @template T
 * @param {T[]} xs
 * @param {number} size
 */
export function chunkEvenly(xs, size) {
  if (xs.length === 0) return [];
  const n = Math.ceil(xs.length / size);
  const base = Math.floor(xs.length / n), extra = xs.length % n;
  /** @type {T[][]} */
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const len = base + (i < extra ? 1 : 0);
    out.push(xs.slice(at, at + len));
    at += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pool candidates and mechanical pre-grading

/**
 * A pool candidate from a normalised corpus module (cmdPool, drift items).
 * @param {any} m
 * @returns {Candidate}
 */
export function poolCandidate(m) {
  return {
    code: m.code, title: m.title, level: m.level ?? null, credits: m.credits ?? null, semesters: m.semesters ?? [],
    ng: m.ng === true || (m.ngSemesters ?? []).length > 0, ngSemesters: m.ngSemesters ?? [],
    faculty: m.faculty ?? null, department: m.department ?? null, description: m.description ?? null, prerequisite: m.prerequisite ?? null,
  };
}

/**
 * What a judge may see of a candidate (no prerequisite: JUDGING.md).
 * @param {any} c a pool candidate (older pools carry `units` instead of `credits`)
 */
export function judgeView(c) {
  const ngSemesters = c.ngSemesters ?? [];
  return {
    code: String(c.code), title: c.title ?? '', level: c.level ?? null, credits: c.credits ?? c.units ?? null,
    semesters: c.semesters ?? [], ng: c.ng === true || ngSemesters.length > 0, ngSemesters,
    faculty: c.faculty ?? null, department: c.department ?? null, description: c.description ?? null,
  };
}

/**
 * Splits a pool into rule grades (hard-constraint violations: grade 0, judge
 * `rule`) and the candidates judges see.
 * @param {Pool} pool
 */
export function preGrade(pool) {
  /** @type {Record<string, Grade>} */
  const rule = {};
  /** @type {Record<string, Candidate[]>} */
  const toJudge = {};
  for (const q of pool.queries) {
    const constraints = /** @type {import('./metrics.mjs').Constraints} */ (q.constraints ?? q.filters ?? {});
    toJudge[q.id] = [];
    for (const c of q.candidates) {
      const v = judgeView(c);
      const reason = violationReason({ level: v.level, semesters: v.semesters, ng: v.ng, ngSemesters: v.ngSemesters, credits: v.credits, faculty: v.faculty }, constraints);
      if (reason) rule[pairKey(q.id, v.code)] = { grade: 0, rationale: `hard constraint: ${reason}` };
      else toJudge[q.id].push(c);
    }
  }
  return { rule, toJudge };
}

// ---------------------------------------------------------------------------
// rounds and batches

/**
 * @typedef {{
 *   pool: Pool, poolSha256: string, queries: EvalQuery[], set: string, round: string,
 *   judges: Judges, seed: number, batchSize?: number, repeatRate?: number,
 *   drift?: { queryId: string, code: string, grade: number, candidate: Candidate }[], driftFrom?: string | null,
 *   createdAt?: string,
 * }} RoundOptions
 */

/**
 * The judge slots a round (or its judges object) uses: A, or A and B.
 * @param {{ judges: Judges }} round
 * @returns {Slot[]}
 */
export const judgeSlots = (round) => JUDGE_SLOTS.filter((s) => round.judges[s]);

/**
 * Is this a single-judge round (judge A only)?
 * @param {{ judges: Judges }} round
 */
export const isSingleJudge = (round) => !round.judges.B;

/**
 * Builds a judging round: rule grades, then for each judge slot its own
 * shuffled batches of ~batchSize queries with planted repeats and drift items.
 * With judges { A } only it is a single-judge round: A's batches are the same
 * as in a two-judge round with the same seed.
 * @param {RoundOptions} o
 */
export function buildRound(o) {
  const batchSize = o.batchSize ?? DEFAULT_BATCH;
  const repeatRate = o.repeatRate ?? DEFAULT_REPEAT_RATE;
  if (!(batchSize >= 1)) throw new Error('batch size must be at least 1');
  if (!(repeatRate >= 0 && repeatRate < 1)) throw new Error('repeat rate must be in [0, 1)');
  if (!o.judges.A) throw new Error('a round needs judge A');
  if (o.judges.A === o.judges.B) throw new Error('judges A and B must be different judges');
  const slots = judgeSlots(o);
  for (const slot of slots) assertJudgeId(/** @type {string} */ (o.judges[slot]));
  const byId = new Map(o.queries.map((q) => [q.id, q]));
  for (const q of o.pool.queries) if (!byId.has(q.id)) throw new Error(`the pool has a query that is not in the ${o.set} query set; re-pool from current runs`);
  const { rule, toJudge } = preGrade(o.pool);

  /** @type {Record<string, ReturnType<typeof judgeView>>} */
  const modules = {};
  /** @type {Record<string, { shapes: string[], candidates: string[] }>} */
  const queries = {};
  for (const q of o.pool.queries) {
    queries[q.id] = { shapes: byId.get(q.id)?.shapes ?? [], candidates: q.candidates.map((c) => String(c.code)) };
    for (const c of q.candidates) modules[c.code] = judgeView(c);
  }
  /** @type {Record<string, { grade: number }>} */
  const drift = {};
  /** @type {Map<string, string[]>} */
  const driftByQuery = new Map();
  for (const d of o.drift ?? []) {
    if (!byId.has(d.queryId)) continue;
    const key = pairKey(d.queryId, d.code);
    if (rule[key] || toJudge[d.queryId]?.some((c) => c.code === d.code)) continue; // already in this round
    drift[key] = { grade: d.grade };
    modules[d.code] ??= judgeView(d.candidate);
    queries[d.queryId] ??= { shapes: byId.get(d.queryId)?.shapes ?? [], candidates: [] };
    driftByQuery.set(d.queryId, [...(driftByQuery.get(d.queryId) ?? []), d.code]);
  }

  /** @type {Record<string, Item>} */
  const items = {};
  /** @type {Set<string>} */
  const used = new Set();
  const idRand = rng(deriveSeed(o.seed, 'ids'));
  /** @type {Record<string, Batch[]>} */
  const batches = {};
  for (const slot of slots) {
    const order = rng(deriveSeed(o.seed, 'order', slot));
    const qids = [...new Set([...Object.keys(toJudge).filter((id) => toJudge[id].length), ...driftByQuery.keys()])].sort();
    batches[slot] = chunkEvenly(shuffle(qids, order), batchSize).map((chunk, b) => {
      const batchId = label('b', b);
      const batchSeed = deriveSeed(o.seed, 'batch', slot, batchId);
      const rand = rng(batchSeed);
      /** @type {Section[]} */
      const sections = chunk.map((qid) => {
        const seed = deriveSeed(o.seed, 'section', slot, batchId, qid);
        const entries = [
          ...(toJudge[qid] ?? []).map((c) => ({ code: String(c.code), kind: /** @type {const} */ ('new') })),
          ...(driftByQuery.get(qid) ?? []).map((code) => ({ code, kind: /** @type {const} */ ('drift') })),
        ];
        const ids = shuffle(entries, rng(seed)).map((e) => {
          const id = newItemId(idRand, used);
          items[id] = { slot, batch: batchId, section: '', queryId: qid, code: e.code, kind: e.kind };
          return id;
        });
        return { id: '', queryId: qid, seed, items: ids };
      });
      // Planted repeats: ~repeatRate of the batch's new items, shown again in a
      // later section of the same query under new item ids.
      const fresh = sections.flatMap((s) => s.items.filter((id) => items[id].kind === 'new'));
      const count = repeatRate > 0 && fresh.length >= 2 ? Math.max(1, Math.round(repeatRate * fresh.length)) : 0;
      const picked = shuffle(fresh, rand).slice(0, count);
      /** @type {Map<string, string[]>} */
      const byQuery = new Map();
      for (const id of picked) byQuery.set(items[id].queryId, [...(byQuery.get(items[id].queryId) ?? []), id]);
      for (const [qid, originals] of [...byQuery].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const seed = deriveSeed(o.seed, 'repeat', slot, batchId, qid);
        const ids = shuffle(originals, rng(seed)).map((orig) => {
          const id = newItemId(idRand, used);
          items[id] = { slot, batch: batchId, section: '', queryId: qid, code: items[orig].code, kind: 'repeat', repeatOf: orig };
          return id;
        });
        const at = sections.findIndex((s) => s.queryId === qid);
        // At least one other section between the original and its repeat when the batch allows.
        const lo = Math.min(at + 2, sections.length);
        const pos = lo + Math.floor(rand() * (sections.length - lo + 1));
        sections.splice(pos, 0, { id: '', queryId: qid, seed, items: ids });
      }
      sections.forEach((s, i) => {
        s.id = label('S', i);
        for (const id of s.items) {
          items[id].section = s.id;
        }
      });
      return { id: batchId, seed: batchSeed, sections };
    });
  }
  return {
    schema: STATE_SCHEMA,
    set: o.set,
    round: o.round,
    createdAt: o.createdAt ?? new Date().toISOString(),
    seed: o.seed,
    batchSize,
    repeatRate,
    judges: o.judges,
    pool: {
      sha256: o.poolSha256, queriesVersion: o.pool.queriesVersion, corpus: o.pool.corpus ?? null,
      embedding: o.pool.embedding ?? null, sourceRuns: o.pool.sourceRuns ?? null, depth: o.pool.depth ?? K,
    },
    driftFrom: o.driftFrom ?? null,
    queries,
    modules,
    rule,
    drift,
    items,
    batches,
    grades: /** @type {Record<string, Record<string, Grade>>} */ (Object.fromEntries(slots.map((s) => [s, {}]))),
    adjudication: /** @type {Adjudication | null} */ (null),
  };
}

/** @typedef {ReturnType<typeof buildRound> & { dropped?: DroppedJudge[] }} Round */

/**
 * Turns a two-judge round into a single-judge round by removing judge B:
 * its batches, items and grades go; A's batches, items (same ids) and grades
 * stay untouched. Records { slot, judge, reason, at } in `round.dropped`.
 * Refuses once adjudication has started, and when B has collected grades
 * unless `force`. Mutates and returns the round.
 * @param {Round} round
 * @param {{ slot: string, reason: string, force?: boolean, at?: string }} o
 */
export function dropJudge(round, o) {
  if (!JUDGE_SLOTS.includes(/** @type {any} */ (o.slot))) throw new Error(`unknown judge slot "${o.slot}"; expected ${JUDGE_SLOTS.join(' or ')}`);
  const slot = /** @type {Slot} */ (o.slot);
  if (slot === 'A') throw new Error('cannot drop judge A: a round always keeps judge A');
  const judge = round.judges[slot];
  if (!judge) throw new Error(`round ${round.round} has no judge in slot ${slot}`);
  if (typeof o.reason !== 'string' || !o.reason.trim()) throw new Error('dropping a judge needs a reason');
  if (round.adjudication) throw new Error('this round is already in adjudication; a judge cannot be dropped');
  const graded = Object.keys(round.grades[slot] ?? {}).length;
  if (graded && !o.force) throw new Error(`judge ${slot} has ${graded} collected grade(s); pass force to drop them`);
  delete round.judges[slot];
  delete round.batches[slot];
  delete round.grades[slot];
  for (const [id, it] of Object.entries(round.items)) if (it.slot === slot) delete round.items[id];
  round.dropped = [...(round.dropped ?? []), { slot, judge, reason: o.reason.trim(), at: o.at ?? new Date().toISOString() }];
  return round;
}

// ---------------------------------------------------------------------------
// packets

/**
 * The text between `<!-- BEGIN name -->` and `<!-- END name -->` in JUDGING.md.
 * @param {string} doc
 * @param {string} name
 */
export function verbatimBlock(doc, name) {
  const start = `<!-- BEGIN ${name} -->`, end = `<!-- END ${name} -->`;
  const i = doc.indexOf(start), j = doc.indexOf(end);
  if (i < 0 || j < i) throw new Error(`JUDGING.md has no ${name} block`);
  return doc.slice(i + start.length, j).replace(/^\n/, '').replace(/\n$/, '');
}

/** @param {unknown} narrative */
function intentLines(narrative) {
  if (narrative && typeof narrative === 'object') {
    const n = /** @type {Record<string, unknown>} */ (narrative);
    return [
      `- Relevant: ${n.relevant ?? '(not stated)'}`,
      `- Partially relevant: ${n.partial ?? '(not stated)'}`,
      `- Not relevant: ${n.notRelevant ?? '(not stated)'}`,
    ];
  }
  return [typeof narrative === 'string' && narrative.trim() ? `- ${narrative}` : '- (no intent written)'];
}

/**
 * Hard constraints in words.
 * @param {Record<string, unknown>} c
 */
export function constraintText(c) {
  const ng = c.ng === true || c.ng === 1 || c.ng === '1' || c.ng === 'true';
  const parts = [];
  const sem = c.sem !== undefined && c.sem !== '' ? Number(c.sem) : null;
  if (sem !== null) parts.push(`offered in ${semesterName(sem)}`);
  if (ng) parts.push(sem !== null ? `open to non-graduating (exchange) students in ${semesterName(sem)}` : 'open to non-graduating (exchange) students');
  if (c.level !== undefined && c.level !== '') parts.push(`level ${(Array.isArray(c.level) ? c.level : [c.level]).map((l) => `${l}000`).join(' or ')}`);
  if (c.credits !== undefined && c.credits !== '') parts.push(`${c.credits} credits`);
  if (c.faculty !== undefined && c.faculty !== '') parts.push(`faculty: ${c.faculty}`);
  return parts.length ? parts.join('; ') : 'none';
}

/** @param {number[]} sems */
const semList = (sems) => (sems.length ? sems.map((s) => semesterName(s)).join(', ') : 'none');

/** @param {ReturnType<typeof judgeView>} m */
function candidateLines(m) {
  return [
    `- Code: ${m.code}`,
    `- Title: ${m.title}`,
    `- Level: ${m.level === null ? 'unknown' : `${m.level}000-level`}`,
    `- Credits: ${m.credits ?? 'unknown'}`,
    `- Offered in: ${semList(m.semesters)}`,
    `- Open to non-graduating (exchange) students: ${m.ngSemesters.length ? `yes, in ${semList(m.ngSemesters)}` : 'no'}`,
    `- Faculty / department: ${m.faculty ?? 'unknown'} / ${m.department ?? 'unknown'}`,
    `- Description: ${(m.description ?? '(no description)').replace(/\s*\n\s*/g, ' ')}`,
  ];
}

/**
 * @param {Round} round
 * @param {EvalQuery} q
 * @param {string} heading
 */
function queryHeader(round, q, heading) {
  return [
    `## ${heading}`,
    '',
    `**Query:** ${q.text}`,
    '',
    '**Intent** (written by the student before any results existed):',
    ...intentLines(q.narrative),
    '',
    `**Hard constraints:** ${constraintText(/** @type {Record<string, unknown>} */ (q.constraints ?? q.filters ?? {}))}`,
    '',
  ];
}

/** @param {string[]} ids */
const template = (ids) => `{\n${ids.map((id) => `  ${JSON.stringify(id)}: { "grade": null, "rationale": null }`).join(',\n')}\n}`;

/**
 * Output path of one section's file.
 * @param {string} outDir
 * @param {string} who slot (A, B) or adjudicator pass dir (adjudicator/p1)
 * @param {string} batch
 * @param {string} section
 */
export const outputPath = (outDir, who, batch, section) => `${outDir}/${who}/${batch}/${section}.json`;

/**
 * One self-contained judge packet (Markdown) for a slot's batch.
 * @param {Round} round
 * @param {Slot} slot
 * @param {string} batchId
 * @param {{ judging: string, queries: EvalQuery[], outDir: string }} o judging = JUDGING.md text
 */
export function renderJudgePacket(round, slot, batchId, o) {
  const batch = round.batches[slot].find((b) => b.id === batchId);
  if (!batch) throw new Error(`no batch ${batchId} for judge ${slot}`);
  const byId = new Map(o.queries.map((q) => [q.id, q]));
  const nItems = batch.sections.reduce((n, s) => n + s.items.length, 0);
  const lines = [
    `# Relevance judging packet ${round.round}-${slot}-${batch.id}`,
    '',
    verbatimBlock(o.judging, 'judge-instructions'),
    '',
    verbatimBlock(o.judging, 'judge-examples'),
    '',
    '---',
    '',
    `This packet has ${batch.sections.length} sections and ${nItems} items. Write one file per section, at the path under "Write to".`,
    '',
  ];
  for (const s of batch.sections) {
    const q = /** @type {EvalQuery} */ (byId.get(s.queryId));
    lines.push(...queryHeader(round, q, `Section ${s.id}`), `**Write to:** \`${outputPath(o.outDir, slot, batch.id, s.id)}\``, '', '### Candidates', '');
    for (const id of s.items) lines.push(`#### Item ${id}`, ...candidateLines(round.modules[round.items[id].code]), '');
    lines.push(`**Template for ${s.id}:**`, '', '```json', template(s.items), '```', '');
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// validation and collection

/**
 * A judge-written key, printed only when it has the item-id form: any other
 * key may be words of the query (an encrypted set's content).
 */
const safeKey = (/** @type {string} */ k) => (/^i[0-9a-z]{6}$/.test(k) ? `"${k}"` : '(a key that is not an item id)');

/** Ids the qrels' `judges` objects reserve; a judge may not be named after them. */
export const RESERVED_JUDGE_IDS = ['rule', 'adjudicator'];
/** @param {string} id */
function assertJudgeId(id) {
  if (RESERVED_JUDGE_IDS.includes(id)) throw new Error(`"${id}" is reserved and cannot name a judge`);
}

/**
 * Problems with one section's output; empty means valid. Messages name item
 * ids and value types, never judge-written text.
 * @param {string[]} expected the section's item ids
 * @param {string | null} text the file's contents, or null when it is missing
 * @returns {{ problems: string[], grades: Record<string, Grade> }}
 */
export function validateSectionOutput(expected, text) {
  if (text === null) return { problems: ['file missing'], grades: {} };
  /** @type {unknown} */
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    return { problems: ['not valid JSON'], grades: {} }; // the parser's message quotes the text
  }
  if (!out || typeof out !== 'object' || Array.isArray(out)) return { problems: ['not a JSON object of item ids'], grades: {} };
  const o = /** @type {Record<string, unknown>} */ (out);
  const want = new Set(expected);
  const problems = [];
  /** @type {Record<string, Grade>} */
  const grades = {};
  for (const k of Object.keys(o)) if (!want.has(k)) problems.push(`unknown item id ${safeKey(k)}`);
  for (const id of expected) {
    if (!(id in o)) { problems.push(`item ${id} not graded`); continue; }
    const e = o[id];
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`item ${id}: entry is not an object`); continue; }
    const entry = /** @type {Record<string, unknown>} */ (e);
    const extra = Object.keys(entry).filter((k) => k !== 'grade' && k !== 'rationale');
    if (extra.length) problems.push(`item ${id}: ${extra.length} unexpected key${extra.length > 1 ? 's' : ''}`);
    const g = entry.grade;
    const gradeOk = typeof g === 'number' && Number.isInteger(g) && g >= 0 && g <= 2;
    if (!gradeOk) problems.push(`item ${id}: grade ${typeof g === 'number' ? String(g) : g === null ? 'null' : `is a ${typeof g}`}, must be 0, 1 or 2`);
    const r = entry.rationale;
    const rationaleOk = typeof r === 'string' && r.trim() !== '';
    if (!rationaleOk) problems.push(`item ${id}: rationale missing or empty`);
    if (gradeOk && rationaleOk && !extra.length) grades[id] = { grade: /** @type {number} */ (g), rationale: /** @type {string} */ (r).trim() };
  }
  return { problems, grades: problems.length ? {} : grades };
}

/**
 * Validates and stores every section of `batches` from `read`. A valid file
 * replaces the section's grades; an invalid one drops them; a missing file
 * keeps what an earlier collect stored (and is a problem if there is none).
 * @param {Batch[]} batches
 * @param {Record<string, Grade>} store mutated
 * @param {(batch: string, section: string) => string | null} read
 * @param {string} who for messages
 */
export function collectOutputs(batches, store, read, who) {
  /** @type {string[]} */
  const problems = [];
  let sections = 0, fresh = 0;
  for (const b of batches) {
    for (const s of b.sections) {
      sections++;
      const text = read(b.id, s.id);
      if (text === null && s.items.every((id) => store[id])) continue;
      const r = validateSectionOutput(s.items, text);
      for (const id of s.items) delete store[id];
      if (r.problems.length) {
        problems.push(...r.problems.map((p) => `${who} ${b.id}/${s.id}: ${p}`));
        continue;
      }
      Object.assign(store, r.grades);
      fresh++;
    }
  }
  return { problems, sections, collected: fresh };
}

/**
 * Exact agreement between each planted repeat and its original, per slot.
 * @param {Round} round
 * @param {string} slot
 */
export function selfConsistency(round, slot) {
  const g = round.grades[slot] ?? {};
  const pairs = Object.entries(round.items)
    .filter(([id, it]) => it.slot === slot && it.kind === 'repeat' && g[id] && it.repeatOf && g[it.repeatOf])
    .map(([id, it]) => [g[/** @type {string} */ (it.repeatOf)].grade, g[id].grade]);
  return {
    n: pairs.length,
    exact: pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : NaN,
    meanAbsDiff: mean(pairs.map(([a, b]) => Math.abs(a - b))),
  };
}

/**
 * Agreement of a slot's drift re-grades with the stored final grades.
 * @param {Round} round
 * @param {string} slot
 */
export function driftReport(round, slot) {
  const g = round.grades[slot] ?? {};
  const pairs = Object.entries(round.items)
    .filter(([id, it]) => it.slot === slot && it.kind === 'drift' && g[id])
    .map(([id, it]) => [round.drift[pairKey(it.queryId, it.code)].grade, g[id].grade]);
  return {
    n: pairs.length,
    exact: pairs.length ? pairs.filter(([old, now]) => old === now).length / pairs.length : NaN,
    meanDelta: mean(pairs.map(([old, now]) => now - old)),
  };
}

/**
 * A slot's grade for each pair it judged as a new item (repeats and drift excluded).
 * @param {Round} round
 * @param {string} slot
 * @returns {Map<string, Grade>}
 */
export function slotPairGrades(round, slot) {
  const g = round.grades[slot] ?? {};
  /** @type {Map<string, Grade>} */
  const out = new Map();
  for (const [id, it] of Object.entries(round.items)) {
    if (it.slot === slot && it.kind === 'new' && g[id]) out.set(pairKey(it.queryId, it.code), g[id]);
  }
  return out;
}

/**
 * Pairs both judges graded: A's and B's grade with the query's shapes.
 * @param {Round} round
 */
export function agreementUnits(round) {
  const a = slotPairGrades(round, 'A'), b = slotPairGrades(round, 'B');
  return [...a.keys()].filter((k) => b.has(k)).sort().map((key) => ({
    key,
    a: /** @type {Grade} */ (a.get(key)).grade,
    b: /** @type {Grade} */ (b.get(key)).grade,
    shapes: round.queries[splitKey(key)[0]]?.shapes ?? [],
  }));
}

/**
 * The pairs judges must grade (pool pairs not graded by `rule`).
 * @param {Round} round
 */
export function judgedPairKeys(round) {
  return Object.entries(round.queries).flatMap(([qid, q]) => q.candidates.map((c) => pairKey(qid, c))).filter((k) => !round.rule[k]);
}

// ---------------------------------------------------------------------------
// adjudication

/**
 * @typedef {{ queryId: string, code: string, batch: string, section: string, first: Slot }} AdjItem
 * @typedef {{
 *   adjudicator: string, seed: number, items: Record<string, AdjItem>, batches: Batch[],
 *   pass1: Record<string, Grade>, pass2: Record<string, Grade>, pass2Issued: boolean,
 * }} Adjudication
 */

/**
 * Adjudication items for every pair where A and B differ (|A − B| ≥ 1).
 * @param {Round} round
 * @param {{ adjudicator: string, batchSize?: number }} o
 */
export function buildAdjudication(round, o) {
  if (isSingleJudge(round)) throw new Error('a single-judge round has no adjudication: its final grade is rule, else judge A');
  const missing = judgedPairKeys(round).filter((k) => !slotPairGrades(round, 'A').has(k) || !slotPairGrades(round, 'B').has(k));
  if (missing.length) throw new Error(`${missing.length} pair(s) lack a grade from judge A or B; collect both judges first`);
  if (Object.values(round.judges).includes(o.adjudicator)) throw new Error('the adjudicator must not be one of the judges');
  assertJudgeId(o.adjudicator);
  const seed = deriveSeed(round.seed, 'adjudication');
  const disagreements = agreementUnits(round).filter((u) => Math.abs(u.a - u.b) >= 1);
  /** @type {Map<string, string[]>} */
  const byQuery = new Map();
  for (const u of disagreements) {
    const [qid, code] = splitKey(u.key);
    byQuery.set(qid, [...(byQuery.get(qid) ?? []), code]);
  }
  /** @type {Set<string>} */
  const used = new Set(Object.keys(round.items));
  const idRand = rng(deriveSeed(seed, 'ids'));
  const sideRand = rng(deriveSeed(seed, 'sides'));
  /** @type {Record<string, AdjItem>} */
  const items = {};
  const batches = chunkEvenly(shuffle([...byQuery.keys()].sort(), rng(seed)), o.batchSize ?? DEFAULT_BATCH).map((chunk, b) => {
    const batchId = label('b', b);
    const sections = chunk.map((qid, i) => {
      const sectionSeed = deriveSeed(seed, 'section', batchId, qid);
      const ids = shuffle(/** @type {string[]} */ (byQuery.get(qid)).sort(), rng(sectionSeed)).map((code) => {
        const id = newItemId(idRand, used);
        items[id] = { queryId: qid, code, batch: batchId, section: label('S', i), first: sideRand() < 0.5 ? 'A' : 'B' };
        return id;
      });
      return { id: label('S', i), queryId: qid, seed: sectionSeed, items: ids };
    });
    return { id: batchId, seed: deriveSeed(seed, 'batch', batchId), sections };
  });
  return /** @type {Adjudication} */ ({ adjudicator: o.adjudicator, seed, items, batches, pass1: {}, pass2: {}, pass2Issued: false });
}

/**
 * An adjudication packet. Pass 1 is blind; pass 2 adds the adjudicator's own
 * pass-1 grade and both judges' grades and rationales as Grader 1 / Grader 2.
 * @param {Round} round
 * @param {string} batchId
 * @param {1 | 2} pass
 * @param {{ judging: string, queries: EvalQuery[], outDir: string }} o
 */
export function renderAdjudicationPacket(round, batchId, pass, o) {
  const adj = round.adjudication;
  if (!adj) throw new Error('no adjudication in this round');
  const batch = adj.batches.find((b) => b.id === batchId);
  if (!batch) throw new Error(`no adjudication batch ${batchId}`);
  if (pass === 2) {
    const blind = batch.sections.flatMap((s) => s.items).filter((id) => !adj.pass1[id]);
    if (blind.length) throw new Error(`pass 2 needs every pass-1 grade of ${batchId}; ${blind.length} missing`);
  }
  const byId = new Map(o.queries.map((q) => [q.id, q]));
  const a = slotPairGrades(round, 'A'), b = slotPairGrades(round, 'B');
  const one = (/** @type {Grade} */ g) => `${g.grade}: "${g.rationale.replace(/\s*\n\s*/g, ' ')}"`;
  const lines = [
    `# Adjudication packet ${round.round}-pass${pass}-${batch.id}`,
    '',
    verbatimBlock(o.judging, pass === 1 ? 'adjudicator-pass1' : 'adjudicator-pass2'),
    '',
    verbatimBlock(o.judging, 'judge-instructions'),
    '',
    verbatimBlock(o.judging, 'judge-examples'),
    '',
    '---',
    '',
  ];
  for (const s of batch.sections) {
    const q = /** @type {EvalQuery} */ (byId.get(s.queryId));
    lines.push(...queryHeader(round, q, `Section ${s.id}`), `**Write to:** \`${outputPath(o.outDir, `${ADJUDICATOR}/p${pass}`, batch.id, s.id)}\``, '', '### Candidates', '');
    for (const id of s.items) {
      const it = adj.items[id];
      lines.push(`#### Item ${id}`, ...candidateLines(round.modules[it.code]));
      if (pass === 2) {
        const key = pairKey(it.queryId, it.code);
        const [g1, g2] = it.first === 'A' ? [a.get(key), b.get(key)] : [b.get(key), a.get(key)];
        lines.push(`- Your first-pass grade ${one(adj.pass1[id])}`, `- Grader 1: grade ${one(/** @type {Grade} */ (g1))}`, `- Grader 2: grade ${one(/** @type {Grade} */ (g2))}`);
      }
      lines.push('');
    }
    lines.push(`**Template for ${s.id}:**`, '', '```json', template(s.items), '```', '');
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// final grades and qrels

/**
 * The final judgment of every pool pair: `rule` where it applies, else the
 * agreed A = B grade, else the adjudicator's pass-2 grade. In a single-judge
 * round: `rule`, else A's grade (source `judged`). Throws, with counts only,
 * when a pair has no final grade yet.
 * @param {Round} round
 * @returns {Map<string, { grade: number, source: 'rule' | 'agreed' | 'adjudicated' | 'judged', judges: Record<string, unknown> }>}
 */
export function finalJudgments(round) {
  const a = slotPairGrades(round, 'A'), b = slotPairGrades(round, 'B');
  if (isSingleJudge(round)) {
    /** @type {ReturnType<typeof finalJudgments>} */
    const out = new Map();
    let ungraded = 0;
    for (const [key, g] of Object.entries(round.rule)) out.set(key, { grade: 0, source: 'rule', judges: { [RULE]: { slot: RULE, grade: g.grade, rationale: g.rationale } } });
    for (const key of judgedPairKeys(round)) {
      const ga = a.get(key);
      if (!ga) { ungraded++; continue; }
      out.set(key, { grade: ga.grade, source: 'judged', judges: { [round.judges.A]: { slot: 'A', grade: ga.grade, rationale: ga.rationale } } });
    }
    if (ungraded) throw new Error(`not every pair has a final grade: ${ungraded} without judge A's grade`);
    return out;
  }
  const adj = round.adjudication;
  /** @type {Map<string, string>} pair -> adjudication item */
  const adjByPair = new Map(Object.entries(adj?.items ?? {}).map(([id, it]) => [pairKey(it.queryId, it.code), id]));
  /** @type {ReturnType<typeof finalJudgments>} */
  const out = new Map();
  let ungraded = 0, unadjudicated = 0;
  for (const [key, g] of Object.entries(round.rule)) out.set(key, { grade: 0, source: 'rule', judges: { [RULE]: { slot: RULE, grade: g.grade, rationale: g.rationale } } });
  for (const key of judgedPairKeys(round)) {
    const ga = a.get(key), gb = b.get(key);
    if (!ga || !gb) { ungraded++; continue; }
    /** @type {Record<string, unknown>} */
    const judges = {
      [round.judges.A]: { slot: 'A', grade: ga.grade, rationale: ga.rationale },
      [/** @type {string} */ (round.judges.B)]: { slot: 'B', grade: gb.grade, rationale: gb.rationale },
    };
    if (ga.grade === gb.grade) {
      out.set(key, { grade: ga.grade, source: 'agreed', judges });
      continue;
    }
    const id = adjByPair.get(key);
    const final = id ? adj?.pass2[id] : undefined;
    if (!adj || !id || !final) { unadjudicated++; continue; }
    judges[adj.adjudicator] = { slot: ADJUDICATOR, grade: final.grade, rationale: final.rationale, blind: adj.pass1[id] };
    out.set(key, { grade: final.grade, source: 'adjudicated', judges });
  }
  if (ungraded || unadjudicated) {
    throw new Error(`not every pair has a final grade: ${ungraded} without both judges' grades, ${unadjudicated} disagreement(s) without a pass-2 adjudication`);
  }
  return out;
}

/**
 * The next qrels version: "<x>-v<n>" becomes "<x>-v<n+1>"; no base gives
 * "qrels-<set>-v1".
 * @param {string | undefined} base
 * @param {string} set
 */
export function nextVersion(base, set) {
  if (!base) return `qrels-${set}-v1`;
  const m = /^(.*-v)(\d+)$/.exec(base);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${base}-v2`;
}

/**
 * Merges a round's final judgments into qrels (vnm-eval-qrels/1). With
 * `codeRule` (code-rule.mjs `codeRuleGrades` over the set's queries and
 * corpus) the code-target rule grades are applied last: they replace the
 * round's grade for a pair they name and add pairs nobody pooled. Their
 * counts ride on the round's `judging` entry.
 * @param {Round} round
 * @param {{ base?: Qrels | null, version?: string, createdAt?: string, codeRule?: Map<string, import('./code-rule.mjs').RuleGrade> }} [o]
 * @returns {Qrels & { embedding?: string | null, judging: unknown[] }}
 */
export function mergeQrels(round, o = {}) {
  const base = o.base ?? null;
  const corpus = round.pool.corpus;
  if (!corpus?.moduleInfoSha256) throw new CorpusMismatchError('the pool records no corpus.moduleInfoSha256; re-pool with this version of eval:pool');
  if (base?.corpus?.moduleInfoSha256 && (base.corpus.moduleInfoSha256 !== corpus.moduleInfoSha256 || (base.corpus.ngSha256 && base.corpus.ngSha256 !== corpus.ngSha256))) {
    throw new CorpusMismatchError(`base qrels ${base.version} were judged on another corpus than this round's pool`);
  }
  const finals = finalJudgments(round);
  /** @type {Record<string, import('./metrics.mjs').QueryQrels>} */
  let queries = JSON.parse(JSON.stringify(base?.queries ?? {}));
  let conflicts = 0;
  for (const [key, j] of [...finals].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const [qid, code] = splitKey(key);
    queries[qid] ??= { judgments: {} };
    if (code in queries[qid].judgments) { conflicts++; continue; }
    queries[qid].judgments[code] = { grade: j.grade, source: j.source, round: round.round, judges: j.judges };
  }
  if (conflicts) throw new QrelsError(`${conflicts} pair(s) of this round are already judged in the base qrels; pool with --unjudged against them`);
  /** @type {Record<string, unknown> | null} */
  let codeRule = null;
  if (o.codeRule?.size) {
    const applied = applyCodeRule({ queries }, o.codeRule);
    queries = applied.queries;
    codeRule = { rule: CODE_RULE, pairs: o.codeRule.size, queries: applied.stats.queries, added: applied.stats.added, changed: applied.stats.changed, overrides: applied.stats.overrides };
  }
  const version = o.version ?? nextVersion(base?.version, round.set);
  if (base && version === base.version) throw new QrelsError('the merged qrels need a new version string');
  const qrels = {
    schema: QRELS_SCHEMA,
    set: round.set,
    version,
    corpus: { moduleInfoSha256: corpus.moduleInfoSha256, ...(corpus.ngSha256 ? { ngSha256: corpus.ngSha256 } : {}) },
    embedding: round.pool.embedding ?? /** @type {any} */ (base)?.embedding ?? null,
    groups: base?.groups ?? [],
    judging: [
      .../** @type {any} */ (base)?.judging ?? [],
      {
        round: round.round,
        ...(isSingleJudge(round) ? { mode: 'single' } : {}),
        judges: round.judges,
        adjudicator: round.adjudication?.adjudicator ?? null,
        ...(round.dropped?.length ? { dropped: round.dropped } : {}),
        pairs: finals.size, pool: round.pool.sha256,
        ...(codeRule ? { codeRule } : {}),
        createdAt: o.createdAt ?? new Date().toISOString(),
      },
    ],
    queries,
  };
  // Every grade must pass the scorer's own check.
  Object.values(qrels.queries).forEach((q, i) => Object.values(q.judgments).forEach((j, k) => gradeOf(j, `query #${i + 1}, judgment #${k + 1}`)));
  return qrels;
}

// ---------------------------------------------------------------------------
// drift sampling

/**
 * Was a qrels judgment graded by the mechanical rule? (Sources: rule, agreed,
 * adjudicated, and judged for a single-judge round's A grade.)
 * @param {import('./metrics.mjs').Judgment} j
 */
export const isRuleJudgment = (j) => typeof j === 'object' && (j.source === RULE || (!!j.judges && typeof j.judges === 'object' && RULE in /** @type {object} */ (j.judges)));

/**
 * A seeded sample of already-judged pairs to re-judge (rule-graded pairs
 * excluded): round(rate × n), at least one when there are any.
 * @param {Qrels} qrels
 * @param {{ rate?: number, seed: number }} o
 */
export function sampleDrift(qrels, o) {
  const rate = o.rate ?? DEFAULT_DRIFT_RATE;
  const pairs = Object.entries(qrels.queries).flatMap(([qid, q]) => Object.entries(q.judgments)
    .filter(([, j]) => !isRuleJudgment(j))
    .map(([code, j]) => ({ queryId: qid, code, grade: gradeOf(j) })));
  pairs.sort((x, y) => (pairKey(x.queryId, x.code) < pairKey(y.queryId, y.code) ? -1 : 1));
  const count = rate > 0 && pairs.length ? Math.max(1, Math.round(rate * pairs.length)) : 0;
  return shuffle(pairs, rng(deriveSeed(o.seed, 'drift'))).slice(0, count);
}

// ---------------------------------------------------------------------------
// human calibration

/**
 * Greedy allocation of `total` across strata of `sizes`, toward targets
 * proportional to `weights`, never above a stratum's size.
 * @param {number[]} sizes
 * @param {number} total
 * @param {number[]} weights
 * @param {number} [minEach] given first to every non-empty stratum
 */
export function allocate(sizes, total, weights, minEach = 0) {
  const alloc = sizes.map(() => 0);
  let left = Math.min(total, sizes.reduce((s, x) => s + x, 0));
  for (let i = 0; i < sizes.length && minEach; i++) {
    const give = Math.min(minEach, sizes[i], left);
    alloc[i] += give;
    left -= give;
  }
  const wsum = weights.reduce((s, x) => s + x, 0) || 1;
  const target = weights.map((w) => (Math.min(total, sizes.reduce((s, x) => s + x, 0)) * w) / wsum);
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < sizes.length; i++) {
      if (alloc[i] >= sizes[i]) continue;
      if (best < 0 || target[i] - alloc[i] > target[best] - alloc[best]) best = i;
    }
    if (best < 0) break;
    alloc[best]++;
    left--;
  }
  return alloc;
}

/**
 * About `n` judged pairs (rule-graded excluded) stratified by final grade
 * (equal shares where available) and, within a grade, by the query's first
 * shape (proportional, at least one per shape where possible). Seeded.
 * @param {Qrels} qrels
 * @param {EvalQuery[]} queries
 * @param {{ n?: number, seed: number }} o
 */
export function calibrationSample(qrels, queries, o) {
  const n = o.n ?? DEFAULT_CALIBRATION_N;
  const shapeOf = new Map(queries.map((q) => [q.id, (q.shapes ?? [])[0] ?? 'none']));
  const pool = Object.entries(qrels.queries).flatMap(([qid, q]) => Object.entries(q.judgments)
    .filter(([, j]) => !isRuleJudgment(j) && shapeOf.has(qid))
    .map(([code, j]) => ({ queryId: qid, code, grade: gradeOf(j), shape: /** @type {string} */ (shapeOf.get(qid)) })));
  pool.sort((x, y) => (pairKey(x.queryId, x.code) < pairKey(y.queryId, y.code) ? -1 : 1));
  const rand = rng(deriveSeed(o.seed, 'calibration'));
  const grades = [...new Set(pool.map((p) => p.grade))].sort();
  const perGrade = allocate(grades.map((g) => pool.filter((p) => p.grade === g).length), n, grades.map(() => 1));
  /** @type {typeof pool} */
  const picked = [];
  /** @type {Record<string, number>} */
  const strata = {};
  grades.forEach((g, gi) => {
    const these = pool.filter((p) => p.grade === g);
    const shapes = [...new Set(these.map((p) => p.shape))].sort();
    const sizes = shapes.map((s) => these.filter((p) => p.shape === s).length);
    const alloc = allocate(sizes, perGrade[gi], sizes, perGrade[gi] >= shapes.length ? 1 : 0);
    shapes.forEach((s, si) => {
      const chosen = shuffle(these.filter((p) => p.shape === s), rand).slice(0, alloc[si]);
      picked.push(...chosen);
      if (chosen.length) strata[`${s}/${g}`] = chosen.length;
    });
  });
  return { pairs: shuffle(picked, rand), strata, available: pool.length };
}

/**
 * RFC 4180 CSV.
 * @param {(string | number | null | undefined)[][]} rows
 */
export function toCsv(rows) {
  const cell = (/** @type {unknown} */ v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/**
 * Parses RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF, optional BOM).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, '');
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '', quoted = false, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; i++;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export const CALIBRATION_COLUMNS = [
  'pair_id', 'query_id', 'query', 'relevant', 'partially_relevant', 'not_relevant', 'hard_constraints',
  'code', 'title', 'level', 'credits', 'offered_in', 'ng_semesters', 'faculty', 'department', 'description',
  'your_grade', 'your_note',
];

/**
 * The calibration sheet Jacob fills in: one row per pair, no judge grades.
 * @param {ReturnType<typeof calibrationSample>['pairs']} pairs
 * @param {EvalQuery[]} queries
 * @param {Map<string, Candidate>} modules
 */
export function calibrationCsv(pairs, queries, modules) {
  const byId = new Map(queries.map((q) => [q.id, q]));
  const rows = pairs.map((p, i) => {
    const q = /** @type {EvalQuery} */ (byId.get(p.queryId));
    const m = modules.get(p.code);
    if (!m) throw new Error(`calibration pair code ${p.code} is not in the corpus`);
    const v = judgeView(m);
    const n = /** @type {Record<string, unknown>} */ (q.narrative && typeof q.narrative === 'object' ? q.narrative : { relevant: q.narrative ?? '' });
    return [
      `c${String(i + 1).padStart(3, '0')}`, q.id, q.text, String(n.relevant ?? ''), String(n.partial ?? ''), String(n.notRelevant ?? ''),
      constraintText(/** @type {Record<string, unknown>} */ (q.constraints ?? q.filters ?? {})),
      v.code, v.title, v.level ?? '', v.credits ?? '', semList(v.semesters), semList(v.ngSemesters), v.faculty ?? '', v.department ?? '', v.description ?? '',
      '', '',
    ];
  });
  return toCsv([CALIBRATION_COLUMNS, ...rows]);
}

/**
 * Jacob's grades from a filled-in sheet. Blank grades are skipped (counted);
 * any other value outside 0/1/2 is an error naming its row.
 * @param {string} text
 */
export function readCalibration(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('the calibration CSV is empty');
  const col = (/** @type {string} */ name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`the calibration CSV has no ${name} column`);
    return i;
  };
  const qi = col('query_id'), ci = col('code'), gi = col('your_grade');
  /** @type {{ queryId: string, code: string, grade: number }[]} */
  const graded = [];
  /** @type {string[]} */
  const errors = [];
  let blank = 0;
  rows.forEach((r, i) => {
    const raw = (r[gi] ?? '').trim();
    if (raw === '') { blank++; return; }
    if (!/^[012]$/.test(raw)) { errors.push(`row ${i + 2}: your_grade must be 0, 1 or 2`); return; }
    graded.push({ queryId: r[qi], code: r[ci], grade: Number(raw) });
  });
  if (errors.length) throw new Error(`calibration CSV: ${errors.join('; ')}`);
  return { graded, blank };
}

/**
 * The grade a source gives a qrels judgment: `final` (the qrels grade), a
 * judge slot (A, B), or `adjudicator` (its pass-2 grade). Rule pairs are 0
 * for every source; a judgment without that source's grade gives null.
 * @param {import('./metrics.mjs').Judgment} j
 * @param {string} source
 */
export function gradeBy(j, source) {
  if (source === 'final') return gradeOf(j);
  if (typeof j !== 'object') return null;
  const judges = /** @type {Record<string, any>} */ (j.judges ?? {});
  if (isRuleJudgment(j)) return 0;
  const hit = Object.values(judges).find((x) => x && x.slot === source);
  return hit ? gradeOf(hit) : null;
}

/**
 * How the calibration report names its graders, from the slots the qrels
 * record: two judges are adjudicated, A alone is "rule, else A", none is just
 * the qrels grade. `mixed`: the qrels also hold a single-judge round.
 * @param {Slot[]} slots
 * @param {boolean} [mixed]
 */
export function graderLabels(slots, mixed = false) {
  if (slots.includes('B') && mixed) return { note: '; mixes single- and two-judge rounds', final: 'final (adjudicated, or rule, else A)' };
  if (slots.includes('B')) return { note: '', final: 'final (adjudicated)' };
  if (slots.length === 1 && slots[0] === 'A') return { note: '; single-judge qrels (judge A only)', final: 'final (rule, else A)' };
  return { note: '; the qrels record no judge grades', final: 'final' };
}

/**
 * The judge slots (A, B) whose grades the qrels record, in slot order. A
 * single-judge qrels gives ['A'].
 * @param {Qrels} qrels
 * @returns {Slot[]}
 */
export function qrelsSlots(qrels) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const q of Object.values(qrels.queries)) {
    for (const j of Object.values(q.judgments)) {
      if (typeof j !== 'object' || !j.judges || typeof j.judges !== 'object') continue;
      for (const x of Object.values(/** @type {Record<string, any>} */ (j.judges))) if (x && typeof x.slot === 'string') seen.add(x.slot);
    }
  }
  return JUDGE_SLOTS.filter((s) => seen.has(s));
}

/**
 * Agreement of Jacob's grades with each judge the qrels record (A, and B in
 * a two-judge qrels) and the final grade.
 * @param {{ queryId: string, code: string, grade: number }[]} graded
 * @param {Qrels} qrels
 * @param {(a: number[], b: number[]) => unknown} block agreement.mjs agreementBlock
 */
export function humanAgreement(graded, qrels, block) {
  /** @type {Record<string, unknown>} */
  const out = {};
  let unknown = 0;
  for (const source of [...qrelsSlots(qrels), 'final']) {
    const h = [], o = [];
    for (const g of graded) {
      const j = qrels.queries[g.queryId]?.judgments[g.code];
      if (j === undefined) { if (source === 'final') unknown++; continue; }
      const x = gradeBy(j, source);
      if (x === null) continue;
      h.push(g.grade);
      o.push(x);
    }
    out[source] = block(h, o);
  }
  return { bySource: out, unknown };
}

/**
 * The qrels re-graded by one source. With `subset` (pair key -> grade, e.g.
 * Jacob's), only those pairs are kept: graded by the subset itself when
 * `source` is "human", else by `source`. A judge slot the qrels hold no
 * grades from (B in a single-judge qrels) is refused rather than silently
 * falling back to the final grade; in qrels that mix rounds, pairs a slot did
 * not grade are left out of its column (rule pairs are 0 for every slot).
 * @param {Qrels} qrels
 * @param {string} source final | A | B | human
 * @param {Map<string, number>} [subset]
 * @returns {Qrels}
 */
export function qrelsUnder(qrels, source, subset) {
  if (JUDGE_SLOTS.includes(/** @type {any} */ (source)) && !qrelsSlots(qrels).includes(/** @type {Slot} */ (source))) {
    throw new Error(`the qrels hold no grades from judge ${source}`);
  }
  /** @type {Record<string, import('./metrics.mjs').QueryQrels>} */
  const queries = {};
  for (const [qid, q] of Object.entries(qrels.queries)) {
    /** @type {Record<string, number>} */
    const judgments = {};
    for (const [code, j] of Object.entries(q.judgments)) {
      const key = pairKey(qid, code);
      if (subset && !subset.has(key)) continue;
      const g = source === 'human' ? subset?.get(key)
        : JUDGE_SLOTS.includes(/** @type {any} */ (source)) ? gradeBy(j, source)
          : gradeBy(j, source) ?? gradeOf(j);
      if (g === undefined || g === null) continue;
      judgments[code] = g;
    }
    queries[qid] = { judgments, groups: q.groups ?? [] };
  }
  return { ...qrels, queries };
}

/**
 * Δ nDCG@10 (candidate − baseline) over the primary answerable queries,
 * paired: the same number compare() reports, without the bootstrap.
 * @param {import('./metrics.mjs').RunFile} base
 * @param {import('./metrics.mjs').RunFile} cand
 * @param {EvalQuery[]} queries
 * @param {Qrels} qrels
 */
export function ndcgDelta(base, cand, queries, qrels) {
  const b = scoreRun(base, queries, qrels), c = scoreRun(cand, queries, qrels);
  const deltas = b.flatMap((s, i) => (s.answerable && !s.featureGap ? [c[i].ndcg - s.ndcg] : []));
  return { n: deltas.length, delta: mean(deltas) };
}

/** @param {number} x */
export const sign = (x) => (Number.isNaN(x) ? '—' : x > 0 ? '+' : x < 0 ? '−' : '0');
