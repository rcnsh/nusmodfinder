#!/usr/bin/env node
// @ts-check
// Phase 5 5F's dev-side tooling (docs/plans/phase5.md §3 5F). Open sets only
// (dev, the fixture, or a plaintext --set-dir): it prints ids and texts, so
// it refuses every encrypted set.
//
//   npm run eval:phrases -- list [--set dev] [--set-dir <dir>] [--lib <ref>] [--json <file>]
//       every query the frozen reference parse (tag 3h) parses, with its
//       constraints, for the lead to confirm by hand before the dev screen
//   npm run eval:phrases -- screen --candidate <ref> [--pin <ref>] [--set dev] [--set-dir <dir>]
//       [--prefix 5f] [--reuse] [--json-dir <dir>]
//       the dev screen: runs the candidate, the pin, and the pin with the
//       reference's parsed constraints as explicit params; then the
//       compliance rule on the candidate vs the pin (the same rule as the
//       holdout's verdict path, with per-query detail) and the B2-4
//       diagnostic (the candidate vs the explicit-params pin, reported, no
//       gate). The screen passes iff the rule passes and the candidate run's
//       vocabulary is the one the reference parsed over (A3-1). SC4's 14
//       parsed-intent items run separately (test/full/sc4.test.js).
//
// `--candidate` omitted runs the working tree; `--pin` defaults to the
// shipped-ranker pin. `--reuse` keeps run files that already exist.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SHIPPED_BASELINE } from './lib/baseline.mjs';
import { explicitParams, isParsed, loadRuleSources, REFERENCE_PARSE } from './lib/compliance.mjs';
import { devComplianceReport } from './lib/compliance-report.mjs';
import { errorClass } from './lib/errors.mjs';
import { loadGroups, withCorpusGroups } from './lib/groups.mjs';
import { assertSameCorpus } from './lib/metrics.mjs';
import { layout, loadQrels, loadQueries, runFile } from './lib/sets.mjs';
import { git } from './lib/workspace.mjs';

const OPTIONS = /** @type {const} */ ({
  set: { type: 'string', default: 'dev' },
  'set-dir': { type: 'string' },
  lib: { type: 'string' },
  candidate: { type: 'string' },
  pin: { type: 'string' },
  prefix: { type: 'string', default: '5f' },
  reuse: { type: 'boolean', default: false },
  json: { type: 'string' },
  'json-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
});

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`eval:phrases: ${msg}`);
  process.exit(1);
}

/**
 * @param {Record<string, any>} a
 * @returns {import('./lib/sets.mjs').SetLayout}
 */
function openSet(a) {
  const set = layout(a.set, a['set-dir'] ? resolve(a['set-dir']) : undefined);
  if (set.encrypted) fail(`the ${set.name} set is encrypted; this tool prints ids and texts, so it runs on dev and the fixture only`);
  return set;
}

/**
 * A stand-in run whose ranker names the scripts/lib.mjs that normalises the
 * pinned snapshot (the working tree, or a ref's commit).
 * @param {string | undefined} ref
 * @returns {import('./lib/metrics.mjs').RunFile}
 */
function libRun(ref) {
  const ranker = ref ? { ref, sha: git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim() } : { ref: 'WORKTREE' };
  return /** @type {any} */ ({ variant: 'lib', ranker, results: {}, docs: {} });
}

/** @param {Record<string, unknown>} c @param {string | null} semantics */
const words = (c, semantics) => Object.entries(c).map(([k, v]) => (k === 'prereq' ? `prereq=${v} (${semantics})` : `${k}=${v}`)).join(', ');

/** @param {Record<string, any>} a */
async function cmdList(a) {
  const set = openSet(a);
  const { queries, version } = await loadQueries(set);
  const sources = await loadRuleSources(set, libRun(a.lib));
  try {
    const parsed = queries.map((q) => ({ q, p: sources.reference(q.text) })).filter(({ p }) => isParsed(p));
    console.log(`reference parse ${sources.source.reference} over the ${set.name} set's run corpus (vocabulary sha256 ${sources.source.vocabularySha256.slice(0, 12)}…, scripts/lib.mjs at ${sources.source.lib})`);
    console.log(`${parsed.length} of ${queries.length} queries parsed (queries ${version})\n`);
    for (const { q, p } of parsed) {
      const filters = Object.keys(q.filters ?? {}).length ? `  filters ${JSON.stringify(q.filters)}` : '';
      const corrected = p.corrected !== null ? `  (3C-corrected, phrases stripped: ${JSON.stringify(p.corrected)})` : '';
      console.log(`${q.id}  ${JSON.stringify(q.text)}  ->  ${words(p.constraints, p.semantics)}${filters}${corrected}`);
    }
    if (a.json) {
      await writeFile(resolve(a.json), `${JSON.stringify({
        schema: 'vnm-5f-reference-parse/1', set: set.name, queries: version, reference: sources.source,
        parsed: parsed.map(({ q, p }) => ({ id: q.id, text: q.text, filters: q.filters ?? {}, constraints: p.constraints, semantics: p.semantics, corrected: p.corrected })),
      }, null, 1)}\n`);
    }
  } finally {
    await sources.close();
  }
}

/** @param {Record<string, any>} a */
async function cmdScreen(a) {
  const set = openSet(a);
  const pin = a.pin ?? SHIPPED_BASELINE.ref;
  const prefix = String(a.prefix);
  const names = { cand: `${prefix}-cand`, pin: `${prefix}-pin`, explicit: `${prefix}-pin-explicit` };
  const querySet = await loadQueries(set);
  const qrels = await loadQrels(set);

  // The reference parse decides the explicit params of the diagnostic's baseline.
  const pre = await loadRuleSources(set, libRun(a.candidate));
  /** @type {Record<string, Record<string, string>>} */
  const explicit = {};
  try {
    for (const q of querySet.queries) {
      const p = pre.reference(q.text);
      if (isParsed(p)) explicit[q.id] = explicitParams(p.constraints);
    }
  } finally {
    await pre.close();
  }
  console.log(`reference parse ${REFERENCE_PARSE.tag}: ${Object.keys(explicit).length} of ${querySet.queries.length} ${set.name} queries parsed`);

  const { runVariant } = await import('./runner/run.mjs');
  /** @param {string} variant @param {string | undefined} ref @param {Parameters<typeof runVariant>[0]['explicit']} [ex] */
  const run = async (variant, ref, ex) => {
    const out = runFile(set, variant);
    if (a.reuse && existsSync(out)) {
      console.log(`reusing ${out}`);
      return out;
    }
    const res = await runVariant({ set, variant, ref, explicit: ex });
    if (!res.ok) fail(`run ${variant} failed:\n  ${res.problems.join('\n  ')}`);
    console.log(`wrote ${res.output}`);
    return res.output;
  };
  const candPath = await run(names.cand, a.candidate);
  const pinPath = await run(names.pin, pin);
  const explicitPath = await run(names.explicit, pin, { label: `reference-${REFERENCE_PARSE.tag}`, params: explicit });

  const read = async (/** @type {string} */ p) => /** @type {import('./lib/metrics.mjs').RunFile} */ (JSON.parse(await readFile(p, 'utf8')));
  const [cand, base, baseExplicit] = await Promise.all([read(candPath), read(pinPath), read(explicitPath)]);
  assertSameCorpus(qrels, [cand, base, baseExplicit]);
  const scored = withCorpusGroups(qrels, await loadGroups());
  const sources = await loadRuleSources(set, cand);
  /** @type {{ verdict: string, vocabMatch: boolean } | null} */
  let screen = null;
  try {
    const gate = devComplianceReport({ set, queries: querySet.queries, qrels: scored, qrelsVersion: qrels.version, base, cand, sources });
    console.log(gate.text);
    const diag = devComplianceReport({ set, queries: querySet.queries, qrels: scored, qrelsVersion: qrels.version, base: baseExplicit, cand, sources, gate: false });
    console.log(diag.text);
    screen = { verdict: /** @type {import('./lib/gate.mjs').Verdict} */ (gate.verdict).verdict, vocabMatch: gate.vocabMatch };
    if (a['json-dir']) {
      const dir = resolve(a['json-dir']);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${prefix}-screen.json`), `${JSON.stringify(gate.json, null, 1)}\n`);
      await writeFile(join(dir, `${prefix}-diagnostic.json`), `${JSON.stringify(diag.json, null, 1)}\n`);
    }
  } finally {
    await sources.close();
  }
  const pass = screen.verdict === 'pass' && screen.vocabMatch;
  console.log(`\ndev screen (${set.name}): ${pass ? 'PASS' : 'FAIL'} · compliance rule ${screen.verdict} · vocabulary ${screen.vocabMatch ? 'same as the reference\'s' : 'DIFFERENT from the reference\'s'}`);
  console.log('SC4\'s 14 parsed-intent items are part of the screen and run separately: npx vitest run test/full/sc4.test.js');
  if (!pass) process.exitCode = 1;
}

const { positionals, values } = parseArgs({ options: OPTIONS, allowPositionals: true });
if (values.help || positionals.length === 0) {
  console.log((await readFile(new URL(import.meta.url), 'utf8')).split('\n').slice(2, 23).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(values.help ? 0 : 1);
}
const commands = { list: cmdList, screen: cmdScreen };
const fn = /** @type {Record<string, (a: Record<string, any>) => Promise<void>>} */ (commands)[positionals[0]];
if (!fn) fail(`unknown command "${positionals[0]}"; expected list or screen`);
try {
  await fn(values);
} catch (err) {
  fail(`${errorClass(err)}: ${/** @type {Error} */ (err).message}`);
}
