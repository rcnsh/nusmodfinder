#!/usr/bin/env node
// @ts-check
// Phase 2d judging CLI. Protocol: eval/JUDGING.md. Commands: eval/README.md.
//
//   npm run eval:judge -- prepare --round <r> --judges <idA>,<idB> [--set dev] [--pool <file>] [--drift-from <qrels>]
//   npm run eval:judge -- collect --round <r> [--slot A|B]
//   npm run eval:judge -- agree --round <r> [--json <file>]
//   npm run eval:judge -- adjudicate prepare --round <r> --adjudicator <id>
//   npm run eval:judge -- adjudicate collect --round <r> --pass 1|2
//   npm run eval:judge -- merge --round <r> [--base <qrels> | --no-base] [--out <file>] [--version <v>]
//   npm run eval:judge -- calibrate export --qrels <file> [--n 150] [--out <csv>]      (dev only)
//   npm run eval:judge -- calibrate import --csv <file> --qrels <file> [--baseline v0 --run <variant>]
//   npm run eval:judge -- status --round <r>
//   npm run eval:judge -- clean --round <r> [--state]
//
// Encrypted sets (holdout, test): the round's state is written encrypted; the
// packets and judge outputs exist in plaintext only in the round's 0700
// directory under .eval-work/judging/<set>/, removed by `clean`. Errors print
// only their class; validation problems (content-free: files, sections, item
// ids, value types) and aggregate numbers are printed.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { agreementBlock, agreementReport } from './lib/agreement.mjs';
import { loadCorpusFile, loadPinnedWith } from './lib/corpus.mjs';
import { readEncryptedJson, updateManifest, writeEncryptedJson } from './lib/crypto.mjs';
import { errorClass } from './lib/errors.mjs';
import {
  ADJUDICATOR, DEFAULT_BATCH, DEFAULT_CALIBRATION_N, DEFAULT_DRIFT_RATE, DEFAULT_REPEAT_RATE, JUDGE_SLOTS,
  agreementUnits, buildAdjudication, buildRound, calibrationCsv, calibrationSample, collectOutputs, driftReport, finalJudgments,
  humanAgreement, judgedPairKeys, mergeQrels, ndcgDelta, outputPath, poolCandidate, qrelsUnder, readCalibration,
  renderAdjudicationPacket, renderJudgePacket, sampleDrift, selfConsistency, sign,
} from './lib/judging.mjs';
import { fmt, table } from './lib/report.mjs';
import { REPO, layout, loadQueries, readSetJson, runFile, setFile, setKey } from './lib/sets.mjs';
import { SEED } from './lib/stats.mjs';

const OPTIONS = /** @type {const} */ ({
  set: { type: 'string', default: 'dev' },
  holdout: { type: 'boolean', default: false },
  'set-dir': { type: 'string' },
  'work-dir': { type: 'string' },
  round: { type: 'string' },
  judges: { type: 'string' },
  adjudicator: { type: 'string' },
  pool: { type: 'string' },
  'batch-size': { type: 'string', default: String(DEFAULT_BATCH) },
  'repeat-rate': { type: 'string', default: String(DEFAULT_REPEAT_RATE) },
  'drift-from': { type: 'string' },
  'drift-rate': { type: 'string', default: String(DEFAULT_DRIFT_RATE) },
  seed: { type: 'string', default: String(SEED) },
  slot: { type: 'string' },
  pass: { type: 'string' },
  base: { type: 'string' },
  'no-base': { type: 'boolean', default: false },
  out: { type: 'string' },
  version: { type: 'string' },
  qrels: { type: 'string' },
  csv: { type: 'string' },
  n: { type: 'string', default: String(DEFAULT_CALIBRATION_N) },
  baseline: { type: 'string' },
  run: { type: 'string' },
  json: { type: 'string' },
  state: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
});

/** @typedef {ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values']} Args */
/** @typedef {import('./lib/judging.mjs').Round} Round */

class UsageError extends Error {}
/** @param {string} msg @returns {never} */
const usage = (msg) => { throw new UsageError(msg); };

/** @param {Args} a */
const setOf = (a) => layout(a.holdout ? 'holdout' : /** @type {string} */ (a.set), a['set-dir'] ? resolve(a['set-dir']) : undefined);

/** @param {Args} a */
function roundName(a) {
  if (!a.round) usage('--round <name> is required');
  if (!/^[A-Za-z0-9._-]+$/.test(a.round)) usage('--round may only use letters, digits, ".", "_" and "-"');
  return a.round;
}

/**
 * Where a round lives. `state` is encrypted for encrypted sets; `plain` (0700)
 * holds the packets and the judges' outputs.
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {Args} a
 */
function paths(set, a) {
  const round = roundName(a);
  const root = a['work-dir'] ? resolve(a['work-dir']) : join(REPO, '.eval-work', 'judging', set.name);
  const plain = join(root, `plain-${round}`);
  return {
    root,
    state: join(root, `state-${round}.json${set.encrypted ? '.enc' : ''}`),
    plain,
    packets: join(plain, 'packets'),
    out: join(plain, 'out'),
  };
}

/** @param {string} dir */
async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {ReturnType<typeof paths>} p
 * @returns {Promise<Round>}
 */
async function readState(set, p) {
  if (!existsSync(p.state)) usage(`no judging round at ${p.state}; run prepare first`);
  return set.encrypted ? readEncryptedJson(p.state, await setKey(), set.name) : JSON.parse(await readFile(p.state, 'utf8'));
}

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {ReturnType<typeof paths>} p
 * @param {Round} round
 */
async function writeState(set, p, round) {
  await privateDir(p.root);
  if (set.encrypted) await writeEncryptedJson(p.state, round, await setKey(), set.name);
  else await writeFile(p.state, `${JSON.stringify(round, null, 1)}\n`);
}

/** @param {string} path */
const readOrNull = async (path) => (existsSync(path) ? readFile(path, 'utf8') : null);

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {ReturnType<typeof paths>} p
 * @param {Args} a
 */
const cleanHint = (set, p, a) => `npm run eval:judge -- clean --set ${set.name}${a['set-dir'] ? ` --set-dir '${a['set-dir']}'` : ''}${a['work-dir'] ? ` --work-dir '${a['work-dir']}'` : ''} --round ${a.round}   (or: rm -rf '${p.plain}')`;

/** @param {import('./lib/sets.mjs').SetLayout} set */
async function corpusModules(set) {
  const file = join(set.dir, 'corpus.json');
  const corpus = existsSync(file) ? await loadCorpusFile(file) : await loadPinnedWith(REPO);
  return new Map(corpus.modules.map((m) => [m.code, m]));
}

/** @param {string} label @param {number} x */
const num = (label, x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) usage(`${label} must be a number`);
  return v;
};

// ---------------------------------------------------------------------------
// prepare

/** @param {Args} a */
async function cmdPrepare(a) {
  const set = setOf(a);
  const p = paths(set, a);
  if (existsSync(p.state)) usage(`round ${a.round} already exists (${p.state}); pick a new --round name`);
  const judges = (a.judges ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (judges.length !== 2) usage('--judges <idA>,<idB> names the two judges (e.g. claude-opus-5-5,gemini-3.1-pro-low)');
  const poolPath = resolve(a.pool ?? join(REPO, '.eval-work', `pool-${set.name}.json${set.encrypted ? '.enc' : ''}`));
  if (!existsSync(poolPath)) usage(`no pool at ${poolPath}; run npm run eval:pool first`);
  const poolBytes = await readFile(poolPath);
  const pool = set.encrypted ? await readEncryptedJson(poolPath, await setKey(), set.name) : JSON.parse(poolBytes.toString('utf8'));
  if (pool.set !== set.name) usage(`the pool is for the ${pool.set} set, not ${set.name}`);
  const querySet = await loadQueries(set);
  if (pool.queriesVersion !== querySet.version) usage(`the pool was made from queries ${pool.queriesVersion}, the set is now ${querySet.version}; re-pool`);
  const seed = num('--seed', Number(a.seed));

  /** @type {Parameters<typeof buildRound>[0]['drift']} */
  let drift = [];
  if (a['drift-from']) {
    const qrels = await readSetJson(set, resolve(a['drift-from']));
    const modules = await corpusModules(set);
    drift = sampleDrift(qrels, { rate: num('--drift-rate', Number(a['drift-rate'])), seed }).flatMap((d) => {
      const m = modules.get(d.code);
      return m ? [{ ...d, candidate: poolCandidate(m) }] : [];
    });
  }
  const round = buildRound({
    pool, poolSha256: createHash('sha256').update(poolBytes).digest('hex'), queries: querySet.queries, set: set.name,
    round: /** @type {string} */ (a.round), judges: { A: judges[0], B: judges[1] }, seed,
    batchSize: num('--batch-size', Number(a['batch-size'])), repeatRate: num('--repeat-rate', Number(a['repeat-rate'])),
    drift, driftFrom: a['drift-from'] ? (set.encrypted ? 'encrypted qrels' : a['drift-from']) : null,
  });
  await privateDir(p.root);
  await privateDir(p.plain);
  await mkdir(p.packets, { recursive: true, mode: 0o700 });
  const judging = await readFile(join(REPO, 'eval', 'JUDGING.md'), 'utf8');
  /** @type {string[]} */
  const written = [];
  for (const slot of JUDGE_SLOTS) {
    for (const b of round.batches[slot]) {
      const file = join(p.packets, `${slot}-${b.id}.md`);
      await writeFile(file, renderJudgePacket(round, slot, b.id, { judging, queries: querySet.queries, outDir: p.out }), { mode: 0o600 });
      for (const s of b.sections) await mkdir(dirname(outputPath(p.out, slot, b.id, s.id)), { recursive: true, mode: 0o700 });
      written.push(file);
    }
  }
  await writeState(set, p, round);
  const items = Object.values(round.items);
  const count = (/** @type {string} */ slot, /** @type {string} */ kind) => items.filter((i) => i.slot === slot && i.kind === kind).length;
  console.log(`round ${round.round} (${set.name}): ${Object.keys(round.queries).length} queries, ${judgedPairKeys(round).length + Object.keys(round.rule).length} pooled pairs, ${Object.keys(round.rule).length} graded 0 by rule (hard constraints)`);
  for (const slot of JUDGE_SLOTS) {
    console.log(`judge ${slot} (${round.judges[slot]}): ${round.batches[slot].length} packets, ${count(slot, 'new')} items + ${count(slot, 'repeat')} planted repeats + ${count(slot, 'drift')} drift`);
  }
  console.log(`state: ${p.state}`);
  console.log(`packets (give each judge run one path; it writes its outputs where the packet says):\n  ${written.join('\n  ')}`);
  if (set.encrypted) console.log(`plaintext holdout content is in ${p.plain} (0700). Delete it once collected:\n  ${cleanHint(set, p, a)}`);
}

// ---------------------------------------------------------------------------
// collect

/**
 * @param {string[]} problems
 */
function report(problems) {
  if (!problems.length) return;
  console.log(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
}

/** @param {Args} a */
async function cmdCollect(a) {
  const set = setOf(a);
  const p = paths(set, a);
  const round = await readState(set, p);
  if (!existsSync(p.plain)) usage(`${p.plain} is gone (cleaned); nothing to collect`);
  // Adjudication was built from the judges' grades as they stood; changing them
  // now could leave a disagreement with no adjudication, or one made against
  // grades that no longer exist.
  if (round.adjudication) usage('this round is already in adjudication; the judges\' grades are frozen (start a new round to re-judge)');
  const slots = a.slot ? [a.slot] : [...JUDGE_SLOTS];
  for (const s of slots) if (!JUDGE_SLOTS.includes(/** @type {any} */ (s))) usage('--slot must be A or B');
  /** @type {string[]} */
  const problems = [];
  for (const slot of slots) {
    const r = await collectAsync(round.batches[slot], round.grades[slot], (b, s) => outputPath(p.out, slot, b, s), slot);
    problems.push(...r.problems);
    const sc = selfConsistency(round, slot);
    const dr = driftReport(round, slot);
    const items = Object.values(round.items).filter((i) => i.slot === slot).length;
    console.log(`judge ${slot}: ${Object.keys(round.grades[slot]).length} of ${items} items graded; planted repeats ${sc.n}: exact agreement ${fmt(sc.exact)}, mean |Δ| ${fmt(sc.meanAbsDiff)}${dr.n ? `; drift ${dr.n}: agreement with stored grade ${fmt(dr.exact)}, mean Δ (new − old) ${fmt(dr.meanDelta)}` : ''}`);
  }
  await writeState(set, p, round);
  report(problems);
}

/**
 * collectOutputs over files (read up front: collectOutputs is synchronous).
 * @param {import('./lib/judging.mjs').Batch[]} batches
 * @param {Record<string, import('./lib/judging.mjs').Grade>} store
 * @param {(batch: string, section: string) => string} pathOf
 * @param {string} who
 */
async function collectAsync(batches, store, pathOf, who) {
  /** @type {Map<string, string | null>} */
  const texts = new Map();
  for (const b of batches) for (const s of b.sections) texts.set(`${b.id}/${s.id}`, await readOrNull(pathOf(b.id, s.id)));
  return collectOutputs(batches, store, (b, s) => texts.get(`${b}/${s}`) ?? null, who);
}

// ---------------------------------------------------------------------------
// agreement

/** @param {import('./lib/agreement.mjs').AgreementBlock} b */
const agreementRow = (b) => [String(b.n), fmt(b.raw), fmt(b.alpha), fmt(b.binaryKappa), fmt(b.quadraticKappa)];
const AGREEMENT_HEADER = ['n', 'raw', 'Krippendorff α (ordinal)', 'κ binary (≥ 1)', 'κ quadratic'];

/** @param {Args} a */
async function cmdAgree(a) {
  const set = setOf(a);
  const p = paths(set, a);
  const round = await readState(set, p);
  const units = agreementUnits(round);
  const r = agreementReport(units);
  console.log(`agreement, judge A (${round.judges.A}) vs judge B (${round.judges.B}), round ${round.round}: ${units.length} pairs graded by both`);
  console.log(table([['scope', ...AGREEMENT_HEADER], ['overall', ...agreementRow(r.overall)], ...Object.entries(r.shapes).map(([s, b]) => [s, ...agreementRow(b)])]));
  const deg = [r.overall, ...Object.values(r.shapes)].some((b) => b.degenerate.length);
  if (deg) console.log('— = undefined: no chance variation (every grade in one category).');
  console.log(`disagreements (|A − B| ≥ 1): ${units.filter((u) => u.a !== u.b).length}`);
  if (a.json) {
    if (set.encrypted) usage('--json is not allowed for encrypted sets');
    await writeFile(resolve(a.json), `${JSON.stringify({ round: round.round, judges: round.judges, ...r, disagreements: units.filter((u) => u.a !== u.b).length }, null, 1)}\n`);
  }
}

// ---------------------------------------------------------------------------
// adjudication

/** @param {Args} a @param {string | undefined} sub */
async function cmdAdjudicate(a, sub) {
  const set = setOf(a);
  const p = paths(set, a);
  const round = await readState(set, p);
  const judging = await readFile(join(REPO, 'eval', 'JUDGING.md'), 'utf8');
  const { queries } = await loadQueries(set);
  const writePackets = async (/** @type {1 | 2} */ pass) => {
    const adj = /** @type {import('./lib/judging.mjs').Adjudication} */ (round.adjudication);
    if (!existsSync(p.plain)) usage(`${p.plain} is gone (cleaned); adjudication packets need it`);
    const files = [];
    for (const b of adj.batches) {
      const file = join(p.packets, `adj-p${pass}-${b.id}.md`);
      await writeFile(file, renderAdjudicationPacket(round, b.id, pass, { judging, queries, outDir: p.out }), { mode: 0o600 });
      for (const s of b.sections) await mkdir(dirname(outputPath(p.out, `${ADJUDICATOR}/p${pass}`, b.id, s.id)), { recursive: true, mode: 0o700 });
      files.push(file);
    }
    return files;
  };
  if (sub === 'prepare') {
    if (!a.adjudicator) usage('--adjudicator <id> names the adjudicator (e.g. claude-sonnet-5-5)');
    if (round.adjudication) usage('this round already has an adjudication');
    round.adjudication = buildAdjudication(round, { adjudicator: a.adjudicator, batchSize: num('--batch-size', Number(a['batch-size'])) });
    const files = round.adjudication.batches.length ? await writePackets(1) : [];
    await writeState(set, p, round);
    console.log(`adjudication: ${Object.keys(round.adjudication.items).length} disagreements in ${files.length} pass-1 (blind) packets${files.length ? `:\n  ${files.join('\n  ')}` : ''}`);
    if (files.length) console.log('After collecting pass 1, `adjudicate collect --pass 1` writes the pass-2 packets.');
    return;
  }
  if (sub !== 'collect') usage('adjudicate takes prepare or collect');
  const adj = round.adjudication;
  if (!adj) usage('no adjudication yet; run adjudicate prepare');
  const pass = a.pass === '1' ? 1 : a.pass === '2' ? 2 : usage('--pass 1 or --pass 2');
  if (!existsSync(p.plain)) usage(`${p.plain} is gone (cleaned); nothing to collect`);
  if (pass === 2 && !adj.pass2Issued) usage('pass-2 packets have not been written; collect pass 1 first');
  // Pass 1 is blind only until the pass-2 packets (both judges' grades) exist.
  if (pass === 1 && adj.pass2Issued) usage('pass 1 is closed: the pass-2 packets showing both judges\' grades are out, so a new pass-1 grade would not be blind');
  const store = pass === 1 ? adj.pass1 : adj.pass2;
  const r = await collectAsync(adj.batches, store, (b, s) => outputPath(p.out, `${ADJUDICATOR}/p${pass}`, b, s), `adjudicator pass ${pass}`);
  const total = Object.keys(adj.items).length;
  console.log(`adjudicator pass ${pass}: ${Object.keys(store).length} of ${total} items graded`);
  if (pass === 1 && !r.problems.length && Object.keys(adj.pass1).length === total) {
    const files = await writePackets(2);
    adj.pass2Issued = true;
    console.log(`pass-2 packets (both grades shown):\n  ${files.join('\n  ')}`);
  }
  if (pass === 2) {
    const changed = Object.keys(adj.pass2).filter((id) => adj.pass1[id] && adj.pass1[id].grade !== adj.pass2[id].grade).length;
    console.log(`pass 2 changed ${changed} of ${Object.keys(adj.pass2).length} blind grades`);
  }
  await writeState(set, p, round);
  report(r.problems);
}

// ---------------------------------------------------------------------------
// merge

/** @param {Args} a */
async function cmdMerge(a) {
  const set = setOf(a);
  const p = paths(set, a);
  const round = await readState(set, p);
  const target = a.out ? resolve(a.out) : setFile(set, 'qrels.json');
  if (set.encrypted && !target.endsWith('.enc')) usage('encrypted-set qrels must be written to a .enc path');
  if (a.base && a['no-base']) usage('--base and --no-base exclude each other');
  const basePath = a['no-base'] ? null : a.base ? resolve(a.base) : existsSync(target) ? target : null;
  const base = basePath ? await readSetJson(set, basePath) : null;
  const qrels = mergeQrels(round, { base, version: a.version });
  if (set.encrypted) {
    await writeEncryptedJson(target, qrels, await setKey(), set.name);
    if (!a['set-dir'] && !a.out) await updateManifest(set.dir);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(qrels, null, 1)}\n`);
  }
  const sources = { rule: 0, agreed: 0, adjudicated: 0 };
  for (const j of finalJudgments(round).values()) sources[j.source]++;
  console.log(`qrels ${qrels.version} -> ${target}${base ? ` (base ${base.version})` : ''}: ${sources.rule} rule, ${sources.agreed} agreed, ${sources.adjudicated} adjudicated`);
}

// ---------------------------------------------------------------------------
// calibration (dev only)

/** @param {import('./lib/sets.mjs').SetLayout} set */
function devOnly(set) {
  if (set.encrypted) usage('human calibration is dev-only: Jacob is not custodian-briefed for holdout plaintext');
}

/** @param {Args} a @param {string | undefined} sub */
async function cmdCalibrate(a, sub) {
  const set = setOf(a);
  devOnly(set);
  const qrelsPath = resolve(a.qrels ?? setFile(set, 'qrels.json'));
  if (!existsSync(qrelsPath)) usage(`no qrels at ${qrelsPath}`);
  /** @type {import('./lib/metrics.mjs').Qrels} */
  const qrels = JSON.parse(await readFile(qrelsPath, 'utf8'));
  const { queries } = await loadQueries(set);
  if (sub === 'export') {
    const s = calibrationSample(qrels, queries, { n: num('--n', Number(a.n)), seed: num('--seed', Number(a.seed)) });
    const modules = await corpusModules(set);
    const out = resolve(a.out ?? join(REPO, '.eval-work', `calibration-${set.name}.csv`));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, calibrationCsv(s.pairs, queries, new Map([...modules].map(([k, m]) => [k, poolCandidate(m)]))));
    await writeFile(`${out}.meta.json`, `${JSON.stringify({ qrels: qrels.version, seed: Number(a.seed), n: s.pairs.length, available: s.available, strata: s.strata }, null, 1)}\n`);
    console.log(`${s.pairs.length} pairs (of ${s.available} judged, rule pairs excluded) -> ${out}\nstrata (shape/grade): ${Object.entries(s.strata).map(([k, v]) => `${k} ${v}`).join(', ')}\nFill in your_grade (0, 1, 2) per row; leave a row blank to skip it.`);
    return;
  }
  if (sub !== 'import') usage('calibrate takes export or import');
  if (!a.csv) usage('--csv <file> is the filled-in calibration sheet');
  const { graded, blank } = readCalibration(await readFile(resolve(a.csv), 'utf8'));
  const h = humanAgreement(graded, qrels, agreementBlock);
  console.log(`human calibration: ${graded.length} graded rows (${blank} blank, ${h.unknown} not in qrels ${qrels.version})`);
  console.log(table([['human vs', ...AGREEMENT_HEADER], ...['A', 'B', 'final'].map((s) => [s, ...agreementRow(/** @type {any} */ (h.bySource[s]))])]));
  if (!a.run || !a.baseline) {
    console.log('(pass --baseline <variant> --run <variant> for the sign of Δ nDCG@10 under each grader)');
    return;
  }
  const readRun = async (/** @type {string} */ v) => JSON.parse(await readFile(v.includes('/') || v.endsWith('.json') ? resolve(v) : runFile(set, v), 'utf8'));
  const base = await readRun(a.baseline), cand = await readRun(a.run);
  const subset = new Map(graded.map((g) => [`${g.queryId}\t${g.code}`, g.grade]));
  const rows = [['grades', 'Δ nDCG@10 (all judged)', 'sign', 'n', 'Δ nDCG@10 (calibrated subset)', 'sign', 'n']];
  for (const source of ['A', 'B', 'final', 'human']) {
    const full = source === 'human' ? null : ndcgDelta(base, cand, queries, qrelsUnder(qrels, source));
    const sub = ndcgDelta(base, cand, queries, qrelsUnder(qrels, source, subset));
    rows.push([source === 'final' ? 'final (adjudicated)' : source, full ? fmt(full.delta) : '', full ? sign(full.delta) : '', full ? String(full.n) : '', fmt(sub.delta), sign(sub.delta), String(sub.n)]);
  }
  console.log(`\nΔ = ${cand.variant} − ${base.variant}`);
  console.log(table(rows));
}

// ---------------------------------------------------------------------------
// status, clean

/** @param {Args} a */
async function cmdStatus(a) {
  const set = setOf(a);
  const p = paths(set, a);
  const round = await readState(set, p);
  const items = Object.values(round.items);
  const lines = [`round ${round.round} (${set.name}), created ${round.createdAt}, seed ${round.seed}`, `rule-graded: ${Object.keys(round.rule).length}; pairs for judges: ${judgedPairKeys(round).length}`];
  for (const slot of JUDGE_SLOTS) lines.push(`judge ${slot} (${round.judges[slot]}): ${Object.keys(round.grades[slot]).length} of ${items.filter((i) => i.slot === slot).length} items graded`);
  const adj = round.adjudication;
  lines.push(adj ? `adjudication (${adj.adjudicator}): ${Object.keys(adj.items).length} items; pass 1 ${Object.keys(adj.pass1).length}, pass 2 ${Object.keys(adj.pass2).length}` : 'adjudication: not started');
  lines.push(`plaintext directory: ${existsSync(p.plain) ? p.plain : 'cleaned'}`);
  console.log(lines.join('\n'));
}

/** @param {Args} a */
async function cmdClean(a) {
  const set = setOf(a);
  const p = paths(set, a);
  await rm(p.plain, { recursive: true, force: true });
  console.log(`removed ${p.plain}`);
  if (a.state) {
    await rm(p.state, { force: true });
    console.log(`removed ${p.state}`);
  }
}

// ---------------------------------------------------------------------------

const { positionals, values } = parseArgs({ options: OPTIONS, allowPositionals: true });
if (values.help || !positionals[0]) {
  const src = await readFile(new URL(import.meta.url), 'utf8');
  console.log(src.split('\n').slice(2, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(values.help ? 0 : 1);
}
/** @type {Record<string, (a: Args, sub: string | undefined) => Promise<void>>} */
const commands = { prepare: cmdPrepare, collect: cmdCollect, agree: cmdAgree, adjudicate: cmdAdjudicate, merge: cmdMerge, calibrate: cmdCalibrate, status: cmdStatus, clean: cmdClean };
const fn = commands[positionals[0]];

/** The encrypted set this invocation touches, if any. */
function encryptedSet() {
  try {
    const set = setOf(values);
    return set.encrypted ? set.name : null;
  } catch {
    return null;
  }
}

try {
  if (!fn) usage(`unknown command "${positionals[0]}"; expected ${Object.keys(commands).join(', ')}`);
  await fn(values, positionals[1]);
} catch (err) {
  // Usage errors carry no set content (they name flags and paths).
  if (err instanceof UsageError) {
    console.error(`eval:judge: ${err.message}`);
    process.exit(1);
  }
  const hidden = encryptedSet();
  if (hidden) {
    console.error(`eval:judge: ${hidden} judging failed (${errorClass(err)}); details withheld`);
    process.exit(1);
  }
  console.error(`eval:judge: ${/** @type {Error} */ (err).message}`);
  process.exit(1);
}
