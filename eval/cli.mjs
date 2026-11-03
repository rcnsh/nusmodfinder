#!/usr/bin/env node
// @ts-check
// Phase 2 eval CLI. See eval/README.md.
//
//   npm run eval -- --variant <name> [--ref <git ref>] [--set dev|holdout|test] [--baseline <variant>]
//   npm run eval -- --holdout --variant <name> --baseline <variant>      (custodian only)
//   npm run eval:report -- --run <variant> [--baseline <variant>] [--set dev]
//   npm run eval:pool -- --runs <a,b,...> [--set dev] [--unjudged]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpusFile, loadPinnedWith } from './lib/corpus.mjs';
import { writeEncryptedJson } from './lib/crypto.mjs';
import { gateFor } from './lib/gate.mjs';
import { appendLook, assertLookAllowed } from './lib/ledger.mjs';
import { byShape, compare, K, scoreRun, summarise } from './lib/metrics.mjs';
import { comparisonTable, shapeTable, summaryTable, verdictBlock, verdictOnly } from './lib/report.mjs';
import { REPO, layout, loadQrels, loadQueries, readSetJson, runFile, setFile, setKey } from './lib/sets.mjs';
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
  unfiltered: { type: 'boolean', default: false },
  embedding: { type: 'string' },
  'store-only': { type: 'boolean', default: false },
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

/** @param {Args} a @returns {import('./lib/gate.mjs').Change} */
function changeOf(a) {
  const kind = a['change-kind'];
  if (kind !== 'general' && kind !== 'cutoff') fail(`--change-kind must be general or cutoff, got ${kind}`);
  return {
    kind: /** @type {'general' | 'cutoff'} */ (kind),
    targetShapes: a['target-shapes'] ? a['target-shapes'].split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

/**
 * A variant name or a path to a run file.
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} v
 */
const runPath = (set, v) => (v.includes('/') || v.endsWith('.json') || v.endsWith('.enc') ? resolve(v) : runFile(set, v));

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} path
 * @returns {Promise<import('./lib/metrics.mjs').RunFile>}
 */
async function readRun(set, path) {
  if (!existsSync(path)) fail(`no run file at ${path}`);
  return readSetJson(set, path);
}

/** @param {import('./lib/metrics.mjs').RunFile[]} runs */
function assertComparable(runs) {
  const key = (/** @type {import('./lib/metrics.mjs').RunFile} */ r) => JSON.stringify([r.set, /** @type {any} */ (r.queries)?.sha256, /** @type {any} */ (r.corpus)?.moduleInfoSha256]);
  const first = key(runs[0]);
  for (const r of runs.slice(1)) {
    if (key(r) !== first) fail(`runs ${runs[0].variant} and ${r.variant} differ in set, query-set sha256 or corpus; they cannot be compared`);
  }
}

// ---------------------------------------------------------------------------
// dev / fixture: full report

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} candPath
 * @param {string | undefined} basePath
 * @param {Args} a
 */
async function fullReport(set, candPath, basePath, a) {
  const querySet = await loadQueries(set);
  const qrelsPath = a.qrels ? resolve(a.qrels) : setFile(set, 'qrels.json');
  if (!existsSync(qrelsPath)) {
    console.log(`no qrels at ${qrelsPath} yet; run files are written but cannot be scored`);
    return;
  }
  /** @type {import('./lib/metrics.mjs').Qrels} */
  const qrels = JSON.parse(await readFile(qrelsPath, 'utf8'));
  const cand = await readRun(set, candPath);
  const base = basePath ? await readRun(set, basePath) : null;
  assertComparable(base ? [base, cand] : [cand]);
  const currentSha = /** @type {any} */ (cand.queries)?.sha256;
  const { createHash } = await import('node:crypto');
  const nowSha = createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex');
  if (currentSha !== nowSha) console.warn(`warning: ${cand.variant} was run on a different version of the ${set.name} queries; re-run it`);

  const candScores = scoreRun(cand, querySet.queries, qrels);
  const baseScores = base ? scoreRun(base, querySet.queries, qrels) : null;
  console.log(`\nset ${set.name} · queries ${querySet.version} (${querySet.queries.length}) · qrels ${qrels.version} · metrics on top ${K}`);
  console.log(summaryTable([...(base && baseScores ? [{ name: base.variant, summary: summarise(baseScores) }] : []), { name: cand.variant, summary: summarise(candScores) }]));

  /** @type {Record<string, unknown>} */
  const json = { set: set.name, queries: querySet.version, qrels: qrels.version, candidate: cand.variant, summary: summarise(candScores), shapes: byShape(candScores) };
  let cmp = null;
  if (base && baseScores) {
    cmp = compare(baseScores, candScores);
    console.log(`\n${comparisonTable(cmp, base.variant, cand.variant)}`);
    const v = gateFor(set.name === 'fixture' ? 'dev' : set.name, cmp, changeOf(a));
    console.log(`\n${verdictBlock(v)}`);
    Object.assign(json, { baseline: base.variant, baseSummary: summarise(baseScores), comparison: { ...cmp, shapes: undefined }, verdict: v });
  }
  console.log(`\nper shape (${set.name} only)`);
  console.log(shapeTable(baseScores ? byShape(baseScores) : {}, byShape(candScores), cmp));
  if (a.json) {
    await mkdir(dirname(resolve(a.json)), { recursive: true });
    await writeFile(resolve(a.json), `${JSON.stringify(json, null, 1)}\n`);
  }
}

// ---------------------------------------------------------------------------
// holdout / test: verdict only, ledger-counted

/**
 * @param {import('./lib/sets.mjs').SetLayout} set
 * @param {string} candPath
 * @param {string} basePath
 * @param {Args} a
 */
async function verdictReport(set, candPath, basePath, a) {
  await assertLookAllowed(/** @type {string} */ (set.ledger), set.name, set.maxLooks);
  const querySet = await loadQueries(set);
  const qrels = await loadQrels(set);
  const cand = await readRun(set, candPath);
  const base = await readRun(set, basePath);
  assertComparable([base, cand]);
  const candScores = scoreRun(cand, querySet.queries, qrels);
  const baseScores = scoreRun(base, querySet.queries, qrels);
  const cmp = compare(baseScores, candScores);
  if (cmp.judged.base < 1 || cmp.judged.cand < 1) {
    console.log(`${set.name}: not fully judged (judged@10 must be 100%); judge the pool first. No look recorded.`);
    process.exitCode = 2;
    return;
  }
  const v = gateFor(set.name, cmp, changeOf(a));
  const out = verdictOnly(v, cmp);
  console.log(out.text);
  const ranker = /** @type {any} */ (cand.ranker) ?? {};
  await appendLook(/** @type {string} */ (set.ledger), {
    date: new Date().toISOString().slice(0, 10),
    set: set.name,
    commit: `${String(ranker.sha ?? 'unknown').slice(0, 7)}${ranker.dirty ? '+dirty' : ''}`,
    variant: cand.variant,
    baseline: base.variant,
    verdict: v.verdict,
    ndcg: out.ndcg,
    p5: out.p5,
  });
}

// ---------------------------------------------------------------------------
// commands

/** @param {Args} a */
async function cmdRun(a) {
  if (!a.variant) fail('--variant <name> is required');
  const set = setOf(a);
  if (set.encrypted) {
    if (a.out) fail('--out is not allowed for encrypted sets');
    if (!a['store-only'] && !a.baseline) fail(`the ${set.name} set needs --baseline <variant> (or --store-only to store a run without a verdict)`);
    if (!a['store-only']) await assertLookAllowed(/** @type {string} */ (set.ledger), set.name, set.maxLooks);
    await setKey(); // fail before any work if the key is not there
  }
  const { runVariant } = await import('./runner/run.mjs');
  const embedMissing = a['embed-missing'];
  if (embedMissing && process.env.CI) fail('--embed-missing calls Workers AI and never runs in CI');
  // Plan Final §1: locally, texts missing from the cache (new queries, or texts a
  // query-rewriting variant asked for) are embedded under the per-run cap, then
  // the run is repeated once. Off by default, so a run never calls Cloudflare unasked.
  const embed = () => {
    const args = [join(REPO, 'scripts/embed.mjs'), '--set', set.name, ...(a['set-dir'] ? ['--set-dir', a['set-dir']] : [])];
    const r = spawnSync(process.execPath, args, { cwd: REPO, stdio: 'inherit' });
    if (r.status !== 0) fail('embedding the missing texts failed');
  };
  if (embedMissing) embed();
  const run = () => runVariant({
    set,
    variant: /** @type {string} */ (a.variant),
    ref: a.ref,
    embedding: a.embedding,
    unfiltered: a.unfiltered,
    output: a.out ? resolve(a.out) : undefined,
  });
  let res = await run();
  if (!res.ok && embedMissing && res.problems.some((p) => p.includes('without a precomputed embedding'))) {
    embed();
    res = await run();
  }
  if (!res.ok) {
    console.error(`eval: run ${a.variant} failed:\n  ${res.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`wrote ${res.output}`);
  if (set.encrypted && !a['set-dir']) {
    const { updateManifest } = await import('./lib/crypto.mjs');
    await updateManifest(set.dir);
  }
  if (a['store-only']) return;
  if (set.encrypted) return verdictReport(set, res.output, runPath(set, /** @type {string} */ (a.baseline)), a);
  return fullReport(set, res.output, a.baseline ? runPath(set, a.baseline) : undefined, a);
}

/** @param {Args} a */
async function cmdReport(a) {
  if (!a.run) fail('--run <variant or path> is required');
  const set = setOf(a);
  const cand = runPath(set, /** @type {string} */ (a.run));
  if (set.encrypted) {
    if (!a.baseline) fail(`the ${set.name} set reports only a verdict against --baseline <variant>`);
    if (a.qrels || a.json) fail('--qrels and --json are not allowed for encrypted sets');
    return verdictReport(set, cand, runPath(set, a.baseline), a);
  }
  return fullReport(set, cand, a.baseline ? runPath(set, a.baseline) : undefined, a);
}

/** @param {Args} a */
async function cmdPool(a) {
  if (!a.runs) fail('--runs <a,b,...> is required');
  const set = setOf(a);
  if (set.encrypted && !a.custodian) fail(`refusing to pool the ${set.name} set without --custodian (only the custodian dispatches holdout judging)`);
  const querySet = await loadQueries(set);
  const runs = await Promise.all(a.runs.split(',').map((v) => readRun(set, runPath(set, v.trim()))));
  assertComparable(runs);
  const qrelsPath = setFile(set, 'qrels.json');
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
    // Sorted before the shuffle so the order carries no system or rank signal.
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
        return {
          code: m.code, title: m.title, level: m.level, semesters: m.semesters, ngSemesters: m.ngSemesters,
          units: m.credits, faculty: m.faculty, department: m.department, description: m.description, prerequisite: m.prerequisite,
        };
      }),
    };
  });
  const pool = { schema: 'vnm-eval-pool/1', set: set.name, queriesVersion: querySet.version, createdAt: new Date().toISOString(), seed: Number(a.seed), sourceRuns: runs.length, depth: K, queries };
  const out = resolve(a.out ?? join(REPO, '.eval-work', `pool-${set.name}.json${set.encrypted ? '.enc' : ''}`));
  await mkdir(dirname(out), { recursive: true });
  if (set.encrypted) {
    if (!out.endsWith('.enc')) fail('an encrypted set pool must be written to a .enc path');
    await writeEncryptedJson(out, pool, await setKey());
  } else {
    await writeFile(out, `${JSON.stringify(pool, null, 1)}\n`);
  }
  console.log(`pooled ${docs} ${a.unjudged ? 'unjudged ' : ''}documents over ${queries.length} queries from ${runs.length} runs -> ${out}`);
}

const { positionals, values } = parseArgs({ options: OPTIONS, allowPositionals: true });
const command = positionals[0] ?? 'run';
if (values.help) {
  console.log(spawnSync('sed', ['-n', '3,10p', new URL(import.meta.url).pathname]).stdout.toString());
  process.exit(0);
}
const commands = { run: cmdRun, report: cmdReport, pool: cmdPool };
const fn = /** @type {Record<string, (a: Args) => Promise<void>>} */ (commands)[command];
if (!fn) fail(`unknown command "${command}"; expected run, report or pool`);
try {
  await fn(values);
} catch (err) {
  fail(/** @type {Error} */ (err).message);
}
