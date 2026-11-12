#!/usr/bin/env node
// @ts-check
// `npm run eval:representatives`: the representative-only group-identity
// check on an open set (dev, the fixture), from two stored run files:
//
//   npm run eval:representatives -- --set dev --run <cand> --baseline <pin>
//   npm run eval:representatives -- --set fixture --set-dir <dir> --run <cand> --baseline <pin>
//   … --route representative-only
//       on a pass, also appends a row to the count log (eval/count-log.md; with --set-dir, the
//       set directory's count-log.md) naming the ADR 0003 no-look route,
//       which a ranking-lock change can cite (eval:lock -- --evidence no-look <row>). A failing
//       check writes nothing.
//
// It prints the lists compared, how many lists and codes changed, and every
// problem (eval/lib/representatives.mjs), and exits 1 on any. Groups are
// groups-v1 over the runs' corpus: the pinned corpus for dev (its groups are
// eval/groups.json), the set's own corpus.json for the fixture. Encrypted sets
// are refused: the holdout's counterpart is the custodian's
// `eval:count --holdout --lists-differing --by-group`, which prints one integer.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpusFile, loadPinnedWith } from './lib/corpus.mjs';
import { appendCountRow, assertRoute } from './lib/count-log.mjs';
import { buildGroups, groupIndex } from './lib/groups.mjs';
import { compareRepresentatives } from './lib/representatives.mjs';
import { COUNT_LOG, REPO, layout, loadQueries, readSetJson, runFile } from './lib/sets.mjs';

const { values: a } = parseArgs({
  options: { set: { type: 'string', default: 'dev' }, 'set-dir': { type: 'string' }, run: { type: 'string' }, baseline: { type: 'string' }, route: { type: 'string' } },
  allowPositionals: false,
  strict: true,
});
const set = layout(/** @type {string} */ (a.set), a['set-dir'] ? resolve(a['set-dir']) : undefined);
if (set.encrypted) {
  console.error(`eval:representatives: the ${set.name} set is encrypted; the custodian counts it with eval:count --lists-differing --by-group`);
  process.exit(1);
}
try {
  assertRoute(a.route);
} catch (err) {
  console.error(`eval:representatives: ${/** @type {Error} */ (err).message}`);
  process.exit(1);
}
if (!a.run || !a.baseline) {
  console.error('eval:representatives: needs --run <variant> and --baseline <variant>');
  process.exit(1);
}

const { queries } = await loadQueries(set);
const run = await readSetJson(set, runFile(set, a.run));
const baseline = await readSetJson(set, runFile(set, a.baseline));
const own = join(set.dir, 'corpus.json');
const corpus = existsSync(own) ? await loadCorpusFile(own) : await loadPinnedWith(REPO);
// The semester each request named comes from these queries, so both runs must have been made on them.
const sha = createHash('sha256').update(JSON.stringify(queries)).digest('hex');
for (const [name, r] of [[a.run, run], [a.baseline, baseline]]) {
  if (r.queries?.sha256 !== sha) {
    console.error(`eval:representatives: run ${name} was not made on the ${set.name} set's current queries`);
    process.exit(1);
  }
}
if (run.corpus?.moduleInfoSha256 !== corpus.info.moduleInfoSha256) {
  console.error(`eval:representatives: run ${a.run} was made on corpus ${run.corpus?.moduleInfoSha256}, not ${corpus.info.moduleInfoSha256} (${corpus.info.source})`);
  process.exit(1);
}
const report = compareRepresentatives({
  queries, run, baseline,
  groupOf: groupIndex(buildGroups(corpus.modules).groups),
  semestersOf: new Map(corpus.modules.map((m) => [m.code, m.semesters])),
});
console.log(`${set.name}: ${a.run} vs ${a.baseline} (${JSON.stringify(run.config?.strip ?? [])} stripped, filters ${run.config?.filters})`);
console.log(`lists ${report.lists}, lists with a changed representative ${report.changedLists}, codes changed ${report.changedCodes}, problems ${report.problems.length}`);
for (const p of report.problems) console.log(`  ${p}`);
if (!report.problems.length && a.route) {
  const log = a['set-dir'] ? join(resolve(a['set-dir']), 'count-log.md') : join(REPO, COUNT_LOG);
  await appendCountRow(log, { set: set.name, kind: 'representatives', run: `${a.run} vs ${a.baseline}`, count: String(report.changedLists), route: a.route });
  console.log(`logged in ${log} with route ${a.route}`);
}
process.exit(report.problems.length ? 1 : 0);
