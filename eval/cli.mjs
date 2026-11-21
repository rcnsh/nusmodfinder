#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpusFile, loadPinnedWith } from './lib/corpus.mjs';
import { assertBaselineAt, baselinePinFor, pinLabel } from './lib/baseline.mjs';
import { applyComplianceRule, loadRuleSources } from './lib/compliance.mjs';
import { devComplianceReport } from './lib/compliance-report.mjs';
import { assertInManifest, manifestFiles, MANIFEST, recordInManifest, removeFromManifest, sha256, writeEncryptedJson } from './lib/crypto.mjs';
import { EmbeddingError, errorClass, RunFailedError, RunFileError } from './lib/errors.mjs';
import { assertTruncation, CHANGE_KINDS, DEV_ONLY_KINDS, gateFor, ruleOf } from './lib/gate.mjs';
import { loadGroups, withCorpusGroups } from './lib/groups.mjs';
import { poolCandidate } from './lib/judging.mjs';
import { appendLook, assertLookAllowed, finaliseLook, reserveLook, withLedgerLock } from './lib/ledger.mjs';
import { assertSameCorpus, byShape, compare, K, scoreRun, summarise, unscoredIds } from './lib/metrics.mjs';
import { comparisonTable, complianceVerdictOnly, fmt, shapeTable, summaryTable, UNSCORED_NOTE, verdictBlock, verdictOnly } from './lib/report.mjs';
import { MODES, REPO, assertPlainManifest, layout, loadQrels, loadQueries, readSetJson, runFile, setFile, setKey } from './lib/sets.mjs';
import { rng } from './lib/stats.mjs';

const OPTIONS = /** @type {const} */ ({
  variant: { type: 'string' },
  ref: { type: 'string' },
  set: { type: 'string', default: 'dev' },
  holdout: { type: 'boolean', default: false },
  'set-dir': { type: 'string' },
  baseline: { type: 'string' },
  run: { type: 'string' },
  runs: { type: 'string' },
  'change-kind': { type: 'string', default: 'general' },
  'target-shapes': { type: 'string' },
  exempt: { type: 'string' },
  unfiltered: { type: 'boolean', default: false },
  strip: { type: 'string' },
  mode: { type: 'string', default: 'hybrid' },
  embedding: { type: 'string' },
  'store-only': { type: 'boolean', default: false },
  reason: { type: 'string' },
  'embed-missing': { type: 'boolean', default: false },
  out: { type: 'string' },
  qrels: { type: 'string' },
  json: { type: 'string' },
  unjudged: { type: 'boolean', default: false },
  custodian: { type: 'boolean', default: false },
  seed: { type: 'string', default: '20261104' },
  help: { type: 'boolean', default: false },
});

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`eval: ${msg}`);
  process.exit(1);
}

/**
 * @typedef {ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values']} Args
 */

/** @param {Args} a */
function setOf(a) {
  return layout(a.holdout ? 'holdout' : /** @type {string} */ (a.set), a['set-dir'] ? resolve(a['set-dir']) : undefined);
}

/**
 * @param {Args} a
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @returns {import('./lib/gate.mjs').Change}
 */
function changeOf(a, set) {
  const kind = /** @type {string} */ (a['change-kind']);
  if (!CHANGE_KINDS.includes(kind)) fail(`--change-kind must be one of ${CHANGE_KINDS.join(', ')}, got ${kind}`);
  const targetShapes = a['target-shapes'] ? a['target-shapes'].split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (kind !== 'general' && targetShapes.length) fail(`--change-kind ${kind} takes no --target-shapes: ${kind === 'cutoff' ? 'the cutoff rule replaces the Δ rules and has no targets' : 'its one check is over the primary set'}`);
  if (a.exempt !== undefined) {
    if (set.encrypted) fail(`--exempt is dev only: the ${set.name} set never leaves a query out of its verdict`);
    if (kind !== 'no-loss') fail('--exempt is for --change-kind no-loss only');
  }
  if (set.encrypted && DEV_ONLY_KINDS.includes(kind)) fail(`--change-kind ${kind} is a dev screen only: no ${set.name} verdict takes it`);
  if (set.gate === 'test' && (kind !== 'general' || targetShapes.length)) fail('the test set has one rule; --change-kind and --target-shapes do not apply to it');
  return { kind: /** @type {import('./lib/gate.mjs').Change['kind']} */ (kind), targetShapes };
}

/**
 * @param {string} path
 * @param {import('./lib/metrics.mjs').EvalQuery[]} queries
 * @param {string} setName
 * @returns {Promise<string[]>}
 */
async function readExempt(path, queries, setName) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    fail(`--exempt ${path}: ${/** @type {Error} */ (err).message}`);
  }
  const ids = Array.isArray(raw) ? raw : /** @type {any} */ (raw)?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) fail(`--exempt ${path} must hold a JSON array of query ids, or { "ids": [...] }`);
  const known = new Set(queries.map((q) => q.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) fail(`--exempt ${path} names ${unknown.length} id${unknown.length === 1 ? '' : 's'} the ${setName} set does not have: ${unknown.join(', ')}`);
  return [...new Set(ids)];
}

const custodyGate = (/** @type {import('./lib/sets.mjs').SetLayout} */ set) => set.gate === 'holdout' || set.gate === 'test';

/** @param {import('./lib/metrics.mjs').RunFile} run */
const rankerCell = (run) => String(/** @type {any} */ (run.ranker)?.sha ?? 'unknown').slice(0, 7);

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} v
 */
const runPath = (set, v) => (v.includes('/') || v.endsWith('.json') || v.endsWith('.enc') ? resolve(v) : runFile(set, v));

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} path
 * @param {import('./lib/sets.mjs').ReadOptions} [options]
 * @returns {Promise<import('./lib/metrics.mjs').RunFile>}
 */
async function readRun(set, path, options = {}) {
  if (!existsSync(path)) throw new RunFileError(`no run file at ${path}`);
  return readSetJson(set, path, options);
}

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} variant
 */
async function assertRunSlotFree(set, variant) {
  const path = runFile(set, variant);
  const name = relative(set.dir, path);
  if (!(name in ((await manifestFiles(set.dir)) ?? {}))) return;
  const dirArg = set.dir === layout(set.name).dir ? '' : ` --set-dir ${relative(process.cwd(), set.dir) || '.'}`;
  fail(`${name} is already in ${join(set.dir, MANIFEST)}; a stored run is never overwritten. To replace it, retire it first (logged in ${set.retiredLog}):\n  node eval/cli.mjs retire-run --set ${set.name}${dirArg} --variant ${variant} --reason "<why>"`);
}

/** @param {import('./lib/metrics.mjs').RunFile[]} runs */
function assertComparable(runs) {
  const key = (/** @type {import('./lib/metrics.mjs').RunFile} */ r) => JSON.stringify([r.set, /** @type {any} */ (r.queries)?.sha256, /** @type {any} */ (r.corpus)?.moduleInfoSha256]);
  const first = key(runs[0]);
  for (const r of runs.slice(1)) {
    if (key(r) !== first) throw new RunFileError(`runs ${runs[0].variant} and ${r.variant} differ in set, query-set sha256 or corpus; they cannot be compared`);
  }
  const restrictions = new Set(runs.map((r) => /** @type {any} */ (r.corpus)?.ngRestrictionsSha256).filter((v) => v !== undefined));
  if (restrictions.size > 1) throw new RunFileError(`the runs were normalised with different NG restrictions (${[...restrictions].map((v) => String(v).slice(0, 12)).join(', ')}); they cannot be compared`);
}

/** @param {import('./lib/metrics.mjs').RunFile[]} runs */
function assertGateable(runs) {
  for (const r of runs) {
    const mode = /** @type {any} */ (r.config)?.mode ?? 'hybrid';
    if (mode !== 'hybrid') throw new RunFileError(`run ${r.variant} used --mode ${mode}, a pool variant; gates compare hybrid runs only`);
  }
}

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} candPath
 * @param {string | undefined} basePath
 * @param {Args} a
 * @param {import('./lib/gate.mjs').Change} change
 */
async function fullReport(set, candPath, basePath, a, change) {
  const querySet = await loadQueries(set);
  const qrelsPath = a.qrels ? resolve(a.qrels) : setFile(set, 'qrels.json');
  if (!existsSync(qrelsPath)) {
    console.log(`no qrels at ${qrelsPath} yet; run files are written but cannot be scored`);
    return;
  }
  if (!a.qrels) await assertPlainManifest(set, qrelsPath);
  /** @type {import('./lib/metrics.mjs').Qrels} */
  const qrels = JSON.parse(await readFile(qrelsPath, 'utf8'));
  const cand = await readRun(set, candPath);
  const base = basePath ? await readRun(set, basePath) : null;
  assertComparable(base ? [base, cand] : [cand]);
  if (base && change.kind === 'cutoff') assertTruncation(base, cand);
  assertSameCorpus(qrels, base ? [base, cand] : [cand]);
  const groups = await loadGroups();
  const scored = withCorpusGroups(qrels, groups);
  const currentSha = /** @type {any} */ (cand.queries)?.sha256;
  const { createHash } = await import('node:crypto');
  const nowSha = createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex');
  if (currentSha !== nowSha) console.warn(`warning: ${cand.variant} was run on a different version of the ${set.name} queries; re-run it`);

  if (change.kind === 'compliance') {
    if (!base) fail('--change-kind compliance compares a candidate with --baseline <variant>');
    assertGateable([base, cand]);
    const sources = await loadRuleSources(set, cand);
    try {
      const r = devComplianceReport({ set, queries: querySet.queries, qrels: scored, qrelsVersion: qrels.version, base, cand, sources, change });
      console.log(r.text);
      if (a.json) {
        await mkdir(dirname(resolve(a.json)), { recursive: true });
        await writeFile(resolve(a.json), `${JSON.stringify(r.json, null, 1)}\n`);
      }
    } finally {
      await sources.close();
    }
    return;
  }

  const exempt = a.exempt ? await readExempt(resolve(a.exempt), querySet.queries, set.name) : [];
  const candScores = scoreRun(cand, querySet.queries, scored);
  const baseScores = base ? scoreRun(base, querySet.queries, scored) : null;
  console.log(`\nset ${set.name} · queries ${querySet.version} (${querySet.queries.length}) · qrels ${qrels.version} · duplicate groups ${groups.version} · metrics on top ${K}`);
  console.log(summaryTable([...(base && baseScores ? [{ name: base.variant, summary: summarise(baseScores) }] : []), { name: cand.variant, summary: summarise(candScores) }]));
  const unscored = unscoredIds(candScores);
  console.log(`\nunscored (${UNSCORED_NOTE}): ${unscored.length}${unscored.length ? `: ${unscored.join(', ')}` : ''}`);

  /** @type {Record<string, unknown>} */
  const json = { set: set.name, queries: querySet.version, qrels: qrels.version, candidate: cand.variant, summary: summarise(candScores), unscored, shapes: byShape(candScores) };
  let cmp = null;
  if (base && baseScores) {
    assertGateable([base, cand]);
    cmp = compare(baseScores, candScores);
    console.log(`\n${comparisonTable(cmp, base.variant, cand.variant, qrels.version)}`);
    if (/** @type {any} */ (querySet).diagnostic === true) {
      console.log('\ndiagnostic set: reported, never gated (no verdict)');
      Object.assign(json, { baseline: base.variant, baseSummary: summarise(baseScores), comparison: { ...cmp, shapes: undefined }, diagnostic: true });
      console.log(`\nper shape (${set.name} only)`);
      console.log(shapeTable(byShape(baseScores), byShape(candScores), cmp));
      if (a.json) {
        await mkdir(dirname(resolve(a.json)), { recursive: true });
        await writeFile(resolve(a.json), `${JSON.stringify(json, null, 1)}\n`);
      }
      return;
    }
    const kept = (/** @type {import('./lib/metrics.mjs').QueryScore} */ s) => !exempt.includes(s.id);
    const noLoss = exempt.length ? compare(baseScores.filter(kept), candScores.filter(kept)) : undefined;
    const v = gateFor(set.gate, cmp, exempt.length ? { ...change, exempt } : change, { noLoss });
    console.log(`\n${verdictBlock(v)}`);
    if (exempt.length) {
      const byId = new Map(candScores.map((c, i) => [c.id, { b: baseScores[i], c }]));
      console.log(`\nexempt from no-loss (dev only): ${exempt.length}`);
      for (const id of exempt) {
        const { b, c } = /** @type {{ b: import('./lib/metrics.mjs').QueryScore, c: import('./lib/metrics.mjs').QueryScore }} */ (byId.get(id));
        const primary = b.answerable && !b.featureGap;
        const d = c.ndcg - b.ndcg;
        console.log(`  ${id}  ΔnDCG@10 ${primary ? `${d >= 0 ? '+' : ''}${fmt(d)}` : '— (not primary answerable)'}`);
      }
    }
    Object.assign(json, { baseline: base.variant, baseSummary: summarise(baseScores), comparison: { ...cmp, shapes: undefined }, verdict: v, ...(exempt.length ? { exempt } : {}) });
  }
  console.log(`\nper shape (${set.name} only)`);
  console.log(shapeTable(baseScores ? byShape(baseScores) : {}, byShape(candScores), cmp));
  if (a.json) {
    await mkdir(dirname(resolve(a.json)), { recursive: true });
    await writeFile(resolve(a.json), `${JSON.stringify(json, null, 1)}\n`);
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} candPath
 * @param {string} basePath
 * @param {Args} a
 * @param {import('./lib/gate.mjs').Change} change
 * @param {string | null} [reserved]
 */
async function verdictReport(set, candPath, basePath, a, change, reserved = null) {
  const ledger = /** @type {string} */ (set.ledger);
  /** @param {import('./lib/ledger.mjs').LockHandle} [lock] */
  const body = async (lock) => {
    if (!reserved) await assertLookAllowed(ledger, set.name, set.maxLooks);
    const verify = { verify: true };
    const querySet = await loadQueries(set, verify);
    const qrels = await loadQrels(set, verify);
    const cand = await readRun(set, candPath, verify);
    const base = await readRun(set, basePath, verify);
    assertComparable([base, cand]);
    assertGateable([base, cand]);
    if (custodyGate(set)) await assertBaselineAt(base, baselinePinFor(set.gate));
    if (change.kind === 'cutoff') assertTruncation(base, cand);
    assertSameCorpus(qrels, [base, cand]);
    const scored = withCorpusGroups(qrels, await loadGroups());
    /** @type {import('./lib/compliance.mjs').ComplianceResult | null} */
    let rule = null;
    if (change.kind === 'compliance') {
      const sources = await loadRuleSources(set, cand);
      try {
        rule = applyComplianceRule({ queries: querySet.queries, qrels: scored, base, cand, sources });
      } finally {
        await sources.close();
      }
    }
    const cmp = rule ? rule.cmp : compare(scoreRun(base, querySet.queries, scored), scoreRun(cand, querySet.queries, scored));
    const ranker = /** @type {any} */ (cand.ranker) ?? {};
    const row = {
      date: today(),
      set: set.name,
      commit: `${String(ranker.sha ?? 'unknown').slice(0, 7)}${ranker.dirty ? '+dirty' : ''}`,
      variant: cand.variant,
      baseline: base.variant,
      rule: ruleOf(set.gate, change),
      baselineRanker: rankerCell(base),
    };
    if (cmp.judged.base < 1 || cmp.judged.cand < 1) {
      if (reserved) await finaliseLook(ledger, reserved, { ...row, verdict: 'unjudged', ndcg: '—', p5: '—' });
      console.log(`${set.name}: not fully judged (judged@10 must be 100%); judge the pool first. ${reserved ? 'The look reserved for this run stays counted.' : 'No look recorded.'}`);
      process.exitCode = 2;
      return;
    }
    const v = gateFor(set.gate, cmp, change, rule ? {
      compliance: { raw: rule.raw, block: rule.block, compliance: { queries: rule.compliance.queries, violations: rule.compliance.violations.length }, identity: { queries: rule.identity.queries, differing: rule.identity.differing.length }, newErrors: rule.newErrors.length },
    } : {});
    const label = custodyGate(set) ? pinLabel(baselinePinFor(set.gate)) : `${String(/** @type {any} */ (base.ranker)?.ref ?? 'unknown')} ${rankerCell(base)}`;
    const out = rule ? complianceVerdictOnly(v, cmp, rule, qrels.version, label) : verdictOnly(v, cmp, qrels.version, label);
    const final = { ...row, rule: v.rule ?? row.rule, verdict: v.verdict, ndcg: out.ndcg, p5: out.p5 };
    if (reserved) {
      await finaliseLook(ledger, reserved, final);
    } else {
      lock?.assertHeld();
      await appendLook(ledger, final);
    }
    console.log(out.text);
  };
  return reserved ? body() : withLedgerLock(ledger, body);
}

/** @param {Args} a */
async function cmdRun(a) {
  if (!a.variant) fail('--variant <name> is required');
  const set = setOf(a);
  if (a['embed-missing'] && process.env.CI) fail('--embed-missing calls Workers AI and never runs in CI');
  if (!MODES.includes(/** @type {string} */ (a.mode))) fail(`--mode must be one of ${MODES.join(', ')}, got ${a.mode}`);
  if (a.mode !== 'hybrid' && (a.baseline || (setOf(a).encrypted && !a['store-only']))) fail('--mode lexical|vector makes a pool variant; it takes no --baseline and no verdict (use --store-only on an encrypted set)');
  const change = changeOf(a, set);
  /** @type {string | null} */
  let reserved = null;
  /** @type {import('./lib/ledger.mjs').LedgerRow | null} */
  let look = null;
  if (set.encrypted) {
    if (a.out) fail('--out is not allowed for encrypted sets');
    if (!a['store-only'] && !a.baseline) fail(`the ${set.name} set needs --baseline <variant> (or --store-only to store a run without a verdict)`);
    if (!a['store-only'] && change.kind === 'compliance') {
      fail(`a compliance verdict on the ${set.name} set is taken on stored runs, so a parse mismatch stops it before any look is counted: store the candidate with --store-only, then npm run eval:report -- --set ${set.name}${a['set-dir'] ? ` --set-dir ${a['set-dir']}` : ''} --run ${a.variant} --baseline ${a.baseline} --change-kind compliance`);
    }
    if (!a['store-only'] && change.kind === 'cutoff') {
      fail(`a cutoff verdict on the ${set.name} set is taken on a stored run, so the truncation check comes before a look is counted: store the candidate with --store-only, then npm run eval:report -- --set ${set.name}${a['set-dir'] ? ` --set-dir ${a['set-dir']}` : ''} --run ${a.variant} --baseline ${a.baseline} --change-kind cutoff`);
    }
    await setKey();
    await assertRunSlotFree(set, /** @type {string} */ (a.variant));
    if (!a['store-only']) {
      const baseRun = await precheckCorpus(set, a);
      look = {
        date: today(), set: set.name, commit: 'pending', variant: /** @type {string} */ (a.variant), baseline: /** @type {string} */ (a.baseline),
        verdict: 'aborted', ndcg: '—', p5: '—', rule: ruleOf(set.gate, change), baselineRanker: baseRun ? rankerCell(baseRun) : 'unknown',
      };
      reserved = await reserveLook(/** @type {string} */ (set.ledger), set.maxLooks, look);
    }
  }
  if (!set.encrypted && a.baseline) await precheckCorpus(set, a);
  try {
    await runAndReport(a, set, change, reserved && look ? { line: reserved, row: look } : null);
  } catch (err) {
    if (reserved && look) await abortLook(set, reserved, look);
    throw err;
  }
}

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {Args} a
 * @returns {Promise<import('./lib/metrics.mjs').RunFile | null>}
 */
async function precheckCorpus(set, a) {
  const verify = { verify: set.encrypted };
  const baseRun = await readRun(set, runPath(set, /** @type {string} */ (a.baseline)), verify);
  assertGateable([baseRun]);
  /** @type {import('./lib/metrics.mjs').Qrels} */
  let qrels;
  if (set.encrypted) {
    qrels = await loadQrels(set, verify);
    await loadQueries(set, verify);
    const cache = setFile(set, 'embeddings.json');
    if (existsSync(cache)) await assertInManifest(set.dir, cache);
    if (custodyGate(set)) await assertBaselineAt(baseRun, baselinePinFor(set.gate));
  } else {
    const qrelsPath = a.qrels ? resolve(a.qrels) : setFile(set, 'qrels.json');
    if (!existsSync(qrelsPath)) return null;
    qrels = JSON.parse(await readFile(qrelsPath, 'utf8'));
  }
  assertSameCorpus(qrels, [baseRun]);
  withCorpusGroups(qrels, await loadGroups());
  return baseRun;
}

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} reserved
 * @param {import('./lib/ledger.mjs').LedgerRow} row
 */
function abortLook(set, reserved, row) {
  return finaliseLook(/** @type {string} */ (set.ledger), reserved, { ...row, commit: 'unknown', verdict: 'aborted', ndcg: '—', p5: '—' });
}

/**
 * @param {Args} a
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {import('./lib/gate.mjs').Change} change
 * @param {{ line: string, row: import('./lib/ledger.mjs').LedgerRow } | null} reserved
 */
async function runAndReport(a, set, change, reserved) {
  const { runVariant } = await import('./runner/run.mjs');
  const embedMissing = a['embed-missing'];
  const embed = () => {
    const args = [join(REPO, 'scripts/embed.mjs'), '--set', set.name, ...(a['set-dir'] ? ['--set-dir', a['set-dir']] : [])];
    const r = spawnSync(process.execPath, args, { cwd: REPO, stdio: set.encrypted ? 'ignore' : 'inherit' });
    if (r.status === 0) return;
    if (set.encrypted) throw new EmbeddingError(`scripts/embed.mjs exited ${r.status ?? r.signal}`);
    fail('embedding the missing texts failed');
  };
  if (embedMissing) embed();
  const run = () => runVariant({
    set,
    variant: /** @type {string} */ (a.variant),
    ref: a.ref,
    embedding: a.embedding,
    unfiltered: a.unfiltered,
    strip: a.strip ? a.strip.split(',').map((s) => s.trim()).filter(Boolean) : [],
    mode: a.mode,
    output: a.out ? resolve(a.out) : undefined,
  });
  let res = await run();
  if (!res.ok && embedMissing && res.problems.some((p) => p.includes('without a precomputed embedding'))) {
    embed();
    res = await run();
  }
  if (!res.ok) {
    if (set.encrypted) throw new RunFailedError(res.problems.join('; '));
    if (reserved) await abortLook(set, reserved.line, reserved.row);
    console.error(`eval: run ${a.variant} failed:\n  ${res.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`wrote ${res.output}`);
  if (!set.encrypted) {
    /** @type {import('./lib/metrics.mjs').RunFile} */
    const written = JSON.parse(await readFile(res.output, 'utf8'));
    const all = Object.values(written.results);
    console.log(`errors: ${all.filter((r) => r.status !== 200).length} of ${all.length} queries returned a non-200 response`);
  }
  if (set.encrypted) await recordInManifest(set.dir, [res.output]);
  if (a['store-only']) return;
  if (set.encrypted) return verdictReport(set, res.output, runPath(set, /** @type {string} */ (a.baseline)), a, change, reserved?.line ?? null);
  return fullReport(set, res.output, a.baseline ? runPath(set, a.baseline) : undefined, a, change);
}

/** @param {Args} a */
async function cmdReport(a) {
  if (!a.run) fail('--run <variant or path> is required');
  const set = setOf(a);
  const cand = runPath(set, /** @type {string} */ (a.run));
  const change = changeOf(a, set);
  if (set.encrypted) {
    if (!a.baseline) fail(`the ${set.name} set reports only a verdict against --baseline <variant>`);
    if (a.qrels || a.json) fail('--qrels and --json are not allowed for encrypted sets');
    return verdictReport(set, cand, runPath(set, a.baseline), a, change);
  }
  return fullReport(set, cand, a.baseline ? runPath(set, a.baseline) : undefined, a, change);
}

/** @param {Args} a */
async function cmdRetireRun(a) {
  if (!a.variant) fail('--variant <name> is required');
  const set = setOf(a);
  if (!set.encrypted || !set.retiredLog) fail(`retire-run is for encrypted sets; the ${set.name} set's run files are plain and are simply overwritten`);
  const reason = a.reason?.trim();
  if (!reason) fail('--reason "<why>" is required: every retired run is logged');
  const path = runFile(set, /** @type {string} */ (a.variant));
  const name = relative(set.dir, path);
  const listed = (await manifestFiles(set.dir)) ?? {};
  if (!(name in listed)) fail(`${name} is not in ${join(set.dir, MANIFEST)}; there is nothing to retire (--store-only can write it)`);
  const sha = existsSync(path) ? sha256(await readFile(path)) : `missing (manifest ${listed[name]})`;
  const log = set.retiredLog;
  if (!existsSync(log)) {
    await mkdir(dirname(log), { recursive: true });
    await writeFile(log, `# Retired runs\n\nAppend-only. One row per stored encrypted run retired with \`node eval/cli.mjs retire-run\` so that\n\`--store-only\` may write its replacement. Retiring is not a look.\n\n| date | set | file | sha256 | reason |\n|---|---|---|---|---|\n`);
  }
  const clean = (/** @type {string} */ s) => s.replace(/[|\n]/g, ' ');
  await appendFile(log, `| ${[today(), set.name, name, sha, reason].map(clean).join(' | ')} |\n`);
  await rm(path, { force: true });
  await removeFromManifest(set.dir, path);
  console.log(`retired ${name} (sha256 ${sha.slice(0, 12)}…), logged in ${log}; --store-only can now write ${set.name}/${a.variant}`);
}

/** @param {Args} a */
async function cmdPool(a) {
  if (!a.runs) fail('--runs <a,b,...> is required');
  const set = setOf(a);
  if (set.encrypted && !a.custodian) fail(`refusing to pool the ${set.name} set without --custodian (only the custodian dispatches holdout judging)`);
  const querySet = await loadQueries(set);
  const runs = await Promise.all(a.runs.split(',').map((v) => readRun(set, runPath(set, v.trim()))));
  assertComparable(runs);
  if (a.qrels && !a.unjudged) fail('--qrels for eval:pool only says which judgments --unjudged leaves out');
  const qrelsPath = a.qrels ? resolve(a.qrels) : setFile(set, 'qrels.json');
  if (a.qrels && !existsSync(qrelsPath)) fail(`no qrels at ${qrelsPath}`);
  const qrels = a.unjudged && existsSync(qrelsPath) ? await readSetJson(set, qrelsPath) : { queries: {} };
  const corpusFile = join(set.dir, 'corpus.json');
  const corpus = existsSync(corpusFile) ? await loadCorpusFile(corpusFile) : await loadPinnedWith(REPO);
  const byCode = new Map(corpus.modules.map((m) => [m.code, m]));

  const rand = rng(Number(a.seed));
  /** @template T @param {T[]} xs */
  const shuffle = (xs) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  let docs = 0;
  const queries = shuffle(querySet.queries).map((q) => {
    const judged = new Set(Object.keys(qrels.queries?.[q.id]?.judgments ?? {}));
    const codes = [...new Set(runs.flatMap((r) => r.results[q.id]?.codes.slice(0, K) ?? []))].filter((c) => !judged.has(c)).sort();
    docs += codes.length;
    return {
      id: q.id,
      text: q.text,
      narrative: q.narrative ?? null,
      filters: q.filters ?? {},
      constraints: q.constraints ?? q.filters ?? {},
      candidates: shuffle(codes).map((code) => {
        const m = byCode.get(code);
        if (!m) throw new Error(`pooled code ${code} is not in the corpus`);
        return poolCandidate(m);
      }),
    };
  });
  const corpusIds = /** @type {any} */ (runs[0].corpus) ?? {};
  const pool = {
    schema: 'vnm-eval-pool/1', set: set.name, queriesVersion: querySet.version, createdAt: new Date().toISOString(), seed: Number(a.seed),
    sourceRuns: runs.length, depth: K,
    corpus: { moduleInfoSha256: corpusIds.moduleInfoSha256 ?? null, ngSha256: corpusIds.ngSha256 ?? null },
    embedding: /** @type {any} */ (runs[0].embedding)?.corpus ?? null,
    queries,
  };
  const out = resolve(a.out ?? join(REPO, '.eval-work', `pool-${set.name}.json${set.encrypted ? '.enc' : ''}`));
  await mkdir(dirname(out), { recursive: true });
  if (set.encrypted) {
    if (!out.endsWith('.enc')) fail('an encrypted set pool must be written to a .enc path');
    await writeEncryptedJson(out, pool, await setKey(), set.name);
  } else {
    await writeFile(out, `${JSON.stringify(pool, null, 1)}\n`);
  }
  console.log(`pooled ${docs} ${a.unjudged ? 'unjudged ' : ''}documents over ${queries.length} queries from ${runs.length} runs -> ${out}`);
}

const { positionals, values } = parseArgs({ options: OPTIONS, allowPositionals: true });
const command = positionals[0] ?? 'run';
if (values.help) {
  console.log(spawnSync('sed', ['-n', '3,12p', new URL(import.meta.url).pathname]).stdout.toString());
  process.exit(0);
}
const commands = { run: cmdRun, report: cmdReport, pool: cmdPool, 'retire-run': cmdRetireRun };
const fn = /** @type {Record<string, (a: Args) => Promise<void>>} */ (commands)[command];
if (!fn) fail(`unknown command "${command}"; expected run, report, pool or retire-run`);
/** @returns {string | null} */
function encryptedSetName() {
  try {
    const set = setOf(values);
    return set.encrypted ? set.name : null;
  } catch {
    return null;
  }
}

try {
  await fn(values);
} catch (err) {
  const hidden = encryptedSetName();
  if (hidden) {
    console.error(`eval: ${hidden} run failed (${errorClass(err)}); details withheld`);
    process.exit(1);
  }
  fail(/** @type {Error} */ (err).message);
}
