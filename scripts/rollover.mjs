#!/usr/bin/env node
// @ts-check
// The year-switch rehearsal (Phase 7 7E, CI job `rollover`; docs/plans/phase7.md 7E "Rehearsal in
// CI"). In a temp copy of the repo, with no PDF and no archive, it relabels the pinned corpus as
// next year's and runs the switch the runbook describes, locally:
//
//   1. setup: copies the tree; sets DEFAULT_ACAD_YEAR, public/year.js and the header to next
//      year; copies this year's NG files, source manifest, overlay module, register and oracle,
//      each marked as next year; makes the pinned corpus next year's `current`;
//   2. `year next`, which must keep every copy (it never overwrites) and change nothing;
//   3. the builders other than the restrictions builder: the reason texts, then the production
//      bundle (with the data version, vocabulary, groups, NG-unscheduled and 3B files), then
//      `corpus check`;
//   4. `year check` (CI mode), which must pass;
//   5. a local Worker (scripts/ui-server.mjs: wrangler dev --local, FakeAI, a temp D1) holding
//      this year's corpus, then `ingest --d1-only --write-budget 80000`, refused without
//      --allow-year-change and done in one run with it, then `verify --pre-deploy`;
//   6. what each copy must fail on: a stale public/year.js (year check) and a stub NG file
//      (year check and ingest);
//   7. the SC1 tests (sc1 and sc1-node) over the relabelled corpus against the oracle the
//      selector picks for next year, every test passing and none skipped (all but B12, whose
//      premise, codes production gained since the pin, is false when the pin is production);
//   8. the variant with Sem 2 unpublished (G2): the manifest marks it so and the NG list loses
//      its Sem 2; year check passes, the state is exercised (courses on last year's Sem 2 list
//      are "to confirm"), and sc1-node agrees with the oracle.
//
// It proves the code has no year built in. It cannot show what a new PDF layout or new rules will
// break: the wrong-year heading and the missing role are unit tests, and a real year still needs
// the source gate and a person's rulings.
//
//   node scripts/rollover.mjs [--keep] [--skip-sc1]
//
// Needs the pinned corpus (.data/<year>-moduleInfo.json, sha-checked) and the eval's corpus
// embeddings (downloaded by the bundle build with gh when absent). Never contacts Cloudflare or
// NUSMods; ports 8787 and 8799 are never used.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from './lib.mjs';
import {
  manifestRel, ngCoursesRel, ngRestrictionsRel, nextYear, oracleRel, overlayRel, readManifest, registerRel, yearLabel,
} from './ng-sources.mjs';
import { MODULE_INFO_PATH, PINNED_ACAD_YEAR } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECTION = '='.repeat(8);

/** @param {string} m */
const say = (m) => console.log(`rollover: ${m}`);
/** @param {string} m */
const fail = (m) => { throw new Error(m); };

/**
 * Runs a command in the copy; resolves with its exit code and output (also streamed).
 * @param {string} cwd @param {string} cmd @param {string[]} args @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, out: string }>}
 */
function run(cwd, cmd, args, env = {}) {
  say(`$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { out += d; process.stdout.write(d); });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

/** @param {string} cwd @param {string} cmd @param {string[]} args @param {Record<string, string>} [env] */
async function must(cwd, cmd, args, env) {
  const r = await run(cwd, cmd, args, env);
  if (r.code !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.code}`);
  return r;
}

/** The tree's files: tracked ones and untracked ones git doesn't ignore, as they are on disk. */
async function treeFiles() {
  const r = await run(ROOT, 'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (r.code !== 0) fail('git ls-files failed');
  return [...new Set(r.out.split('\0').filter(Boolean))].filter((f) => existsSync(join(ROOT, f)) && !lstatSync(join(ROOT, f)).isDirectory());
}

/** @param {string} path */
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** @param {string} path @returns {any} */
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
/** @param {string} path @param {unknown} data @param {number} indent */
const writeJson = (path, data, indent) => writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);
/** @param {string} path @param {string} from @param {string} to */
const replaceIn = (path, from, to) => {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) fail(`${path} does not hold "${from}"`);
  writeFileSync(path, text.replaceAll(from, to));
};

/**
 * Step 1: the copy, relabelled.
 * @param {string} copy @param {string} y0 @param {string} y1
 */
async function setup(copy, y0, y1) {
  const files = await treeFiles();
  for (const f of files) {
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    cpSync(join(ROOT, f), join(copy, f));
  }
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'));
  mkdirSync(join(ROOT, '.data/emb'), { recursive: true });
  mkdirSync(join(copy, '.data'), { recursive: true });
  symlinkSync(join(ROOT, '.data/emb'), join(copy, '.data/emb'));
  say(`copied ${files.length} files into ${copy}`);

  // The one year source and the two places that must equal it.
  replaceIn(join(copy, 'scripts/lib.mjs'), `export const DEFAULT_ACAD_YEAR = '${y0}';`, `export const DEFAULT_ACAD_YEAR = '${y1}';`);
  replaceIn(join(copy, 'public/year.js'), `export const DEFAULT_ACAD_YEAR = '${y0}';`, `export const DEFAULT_ACAD_YEAR = '${y1}';`);
  replaceIn(join(copy, 'public/index.html'), `Academic year ${yearLabel(y0)}<`, `Academic year ${yearLabel(y1)}<`);

  // The year's files, as next year's.
  const courses = readJson(join(ROOT, ngCoursesRel(y0)));
  writeJson(join(copy, ngCoursesRel(y1)), { ...courses, acadYear: y1 }, 2);
  const restrictions = readJson(join(ROOT, ngRestrictionsRel(y0)));
  writeJson(join(copy, ngRestrictionsRel(y1)), { ...restrictions, acadYear: y1, register: registerRel(y1) }, 1);
  const manifest = readManifest(y0, { root: ROOT }) ?? fail(`no ${manifestRel(y0)}`);
  cpSync(join(ROOT, manifest.overlay), join(copy, overlayRel(y1)));
  cpSync(join(ROOT, manifest.oracle), join(copy, oracleRel(y1)));
  mkdirSync(dirname(join(copy, registerRel(y1))), { recursive: true });
  cpSync(join(ROOT, manifest.register), join(copy, registerRel(y1)));
  writeJson(join(copy, manifestRel(y1)), { ...manifest, acadYear: y1, overlay: overlayRel(y1), oracle: oracleRel(y1), register: registerRel(y1) }, 1);

  // The pinned corpus as next year's `current`.
  if (!existsSync(MODULE_INFO_PATH)) fail(`no pinned corpus at ${MODULE_INFO_PATH} (CI downloads it from its release)`);
  const raw = readFileSync(MODULE_INFO_PATH);
  const digest = createHash('sha256').update(raw).digest('hex');
  mkdirSync(join(copy, '.data/prod'), { recursive: true });
  writeFileSync(join(copy, '.data/prod', `${digest}.json`), raw);
  const corpus = readJson(join(copy, 'data/corpus.json'));
  const release = `prod-${y1}-rehearsal`;
  corpus.corpora[release] = { year: y1, release, asset: `${y1}-moduleInfo.json.gz`, sha256: digest, bytes: raw.length, fetchedAt: new Date().toISOString() };
  corpus.current = release;
  writeJson(join(copy, 'data/corpus.json'), corpus, 2);

  // A repo of its own (scripts record HEAD; nothing is pushed: it has no remote).
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'rollover@localhost'], ['config', 'user.name', 'rollover'],
    ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-q', '-m', `rehearsal: ${y0} -> ${y1}`]]) await must(copy, 'git', args);
  return { records: JSON.parse(raw.toString('utf8')) };
}

/**
 * The GitHub repo the releases are read from (the corpus and embeddings): CI's, else the checkout's
 * origin. The copy has no remote, so gh is told (GH_REPO).
 */
async function githubRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const r = await run(ROOT, 'git', ['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+\/[^/.\s]+?)(?:\.git)?\s*$/.exec(r.out);
  return m ? m[1] : fail('cannot tell the GitHub repo: set GITHUB_REPOSITORY');
}

/** Every file's sha256 in the copy, for "year next changed nothing". @param {string} copy @param {string[]} rels */
const hashes = (copy, rels) => Object.fromEntries(rels.filter((r) => existsSync(join(copy, r))).map((r) => [r, sha(join(copy, r))]));

async function main() {
  const { values } = parseArgs({ options: { keep: { type: 'boolean' }, 'skip-sc1': { type: 'boolean' } }, strict: true });
  const y0 = DEFAULT_ACAD_YEAR;
  const y1 = nextYear(y0);
  const copy = mkdtempSync(join(tmpdir(), 'vnm-rollover-'));
  const runs = join(copy, '.runs');
  const env = { VNM_RUNS_DIR: runs, WRANGLER_SEND_METRICS: 'false', GH_REPO: await githubRepo() };
  /** @type {{ url: string, secret: string, stop: () => Promise<void> } | null} */
  let worker = null;
  try {
    say(`${SECTION} 1. setup: ${y0} -> ${y1}, the pinned corpus (${PINNED_ACAD_YEAR}) relabelled`);
    const { records } = await setup(copy, y0, y1);

    say(`${SECTION} 2. year next ${y1} keeps every copy`);
    const scaffold = [manifestRel(y1), ngCoursesRel(y1), ngRestrictionsRel(y1), overlayRel(y1), oracleRel(y1), registerRel(y1)];
    const before = hashes(copy, (await treeFiles()).concat(scaffold));
    const next = await must(copy, process.execPath, ['scripts/year.mjs', 'next', y1], env);
    for (const rel of scaffold) if (!next.out.includes(`kept  ${rel}`)) fail(`year next did not keep ${rel}`);
    if (/^wrote /m.test(next.out)) fail('year next wrote a file over the copies');
    const after = hashes(copy, Object.keys(before));
    const changed = Object.keys(before).filter((r) => before[r] !== after[r]);
    if (changed.length) fail(`year next changed ${changed.join(', ')}`);

    say(`${SECTION} 3. the builders (not the restrictions builder)`);
    await must(copy, process.execPath, ['scripts/build-ng-reasons.mjs'], env);
    const lib = await import(pathToFileURL(join(copy, 'scripts/lib.mjs')).href);
    const rows = lib.offeredModules(records, y1, await lib.loadNgCourses(y1)).modules.length;
    await must(copy, process.execPath, ['scripts/vectors.mjs', 'build', '--corpus', 'production', '--expect-count', String(rows)], env);
    await must(copy, process.execPath, ['scripts/corpus.mjs', 'check'], env);
    const reasons = readJson(join(copy, 'data/ng-reasons.json'));
    if (reasons.acadYear !== y1) fail(`data/ng-reasons.json is for ${reasons.acadYear}`);

    say(`${SECTION} 4. year check (CI mode)`);
    await must(copy, process.execPath, ['scripts/year.mjs', 'check'], env);

    say(`${SECTION} 5. a local D1 holding ${y0}, then the switch: ingest --d1-only, verify --pre-deploy`);
    const { startUiServer } = await import(pathToFileURL(join(copy, 'scripts/ui-server.mjs')).href);
    worker = /** @type {{ url: string, secret: string, stop: () => Promise<void> }} */ (await startUiServer({}));
    const w = /** @type {{ url: string, secret: string }} */ (worker);
    // This year's corpus, as production holds it before the switch (rows written by this checkout's ingest code).
    const thisYear = offeredModules(records, y0, await loadNgCourses(y0)).modules;
    for (let i = 0; i < thisYear.length; i += 100) {
      const res = await fetch(`${w.url}/admin/ingest?d1Only=1`, {
        method: 'POST', body: JSON.stringify({ modules: thisYear.slice(i, i + 100) }),
        headers: { authorization: `Bearer ${w.secret}`, 'content-type': 'application/json' },
      });
      if (res.status !== 200) fail(`seeding ${y0}: /admin/ingest answered ${res.status}`);
    }
    // And its catalogue-only rows as this year's: their row hash includes the year, so the switch
    // rewrites them too (about 28.7k rows charged, docs/plans/phase7.md 7E), which the 80,000-row
    // budget must cover in one run.
    const catalogue = readJson(join(copy, 'data/catalogue-only.json'));
    for (let i = 0; i < catalogue.rows.length; i += 100) {
      const upsert = catalogue.rows.slice(i, i + 100).map((/** @type {[string, string, string]} */ [code, title, description]) => ({ code, title, description, acadYear: y0 }));
      const res = await fetch(`${w.url}/admin/catalogue`, {
        method: 'POST', body: JSON.stringify({ upsert }), headers: { authorization: `Bearer ${w.secret}`, 'content-type': 'application/json' },
      });
      if (res.status !== 200) fail(`seeding ${y0}'s catalogue: /admin/catalogue answered ${res.status}`);
    }
    say(`seeded ${thisYear.length} ${y0} rows and ${catalogue.rows.length} ${y0} catalogue-only rows`);
    const ingestEnv = { ...env, INGEST_SECRET: w.secret };
    const refused = await run(copy, process.execPath, ['scripts/ingest.mjs', '--d1-only', '--url', w.url, '--write-budget', '80000'], ingestEnv);
    if (refused.code === 0 || !/allow-year-change/.test(refused.out)) fail('ingest switched the year without --allow-year-change');
    const ingest = await run(copy, process.execPath, ['scripts/ingest.mjs', '--d1-only', '--allow-year-change', '--url', w.url, '--write-budget', '80000'], ingestEnv);
    if (ingest.code === 2) fail('the year switch stopped at the 80,000-row write budget the runbook passes');
    if (ingest.code !== 0) fail(`ingest --d1-only --allow-year-change exited ${ingest.code}`);
    if (!new RegExp(`catalogue_only +${catalogue.rows.length} written`).test(ingest.out)) fail(`the switch did not rewrite every catalogue-only row (${catalogue.rows.length})`);
    await must(copy, process.execPath, ['scripts/verify.mjs', '--pre-deploy', '--url', w.url], ingestEnv);

    say(`${SECTION} 6. what each copy must fail on`);
    const yearJs = join(copy, 'public/year.js');
    const yearJsText = readFileSync(yearJs, 'utf8');
    writeFileSync(yearJs, yearJsText.replace(`'${y1}'`, `'${y0}'`));
    const stale = await run(copy, process.execPath, ['scripts/year.mjs', 'check'], env);
    if (stale.code === 0 || !/public\/year\.js says/.test(stale.out)) fail('year check passed a stale public/year.js');
    writeFileSync(yearJs, yearJsText);
    const coursesPath = join(copy, ngCoursesRel(y1));
    const coursesText = readFileSync(coursesPath, 'utf8');
    writeJson(coursesPath, { stub: true, acadYear: y1, semesters: {} }, 1);
    const stubCheck = await run(copy, process.execPath, ['scripts/year.mjs', 'check'], env);
    if (stubCheck.code === 0 || !/is a stub/.test(stubCheck.out)) fail('year check passed a stub NG file');
    const stubIngest = await run(copy, process.execPath, ['scripts/ingest.mjs', '--d1-only', '--allow-year-change', '--url', w.url, '--write-budget', '80000'], ingestEnv);
    if (stubIngest.code === 0 || !/stub/.test(stubIngest.out)) fail('ingest accepted a stub NG file');
    writeFileSync(coursesPath, coursesText);
    await worker.stop();
    worker = null;

    if (!values['skip-sc1']) {
      say(`${SECTION} 7. SC1 over ${y1}, against the oracle the selector picks`);
      const report = join(copy, '.sc1.json');
      // B12 (test/sc1/catalogue.test.js) checks the codes production gained since the pin; here
      // production is the pinned corpus relabelled, so it has none by construction.
      await run(copy, 'npx', ['vitest', 'run', '--project', 'sc1', '--project', 'sc1-node', '--exclude', 'test/sc1/catalogue.test.js',
        '--reporter=default', '--reporter=json', `--outputFile=${report}`], { ...env, PRODUCTION_CORPUS: '1' });
      const r = readJson(report);
      if (r.numPassedTests === 0 || r.numPassedTests !== r.numTotalTests) fail(`SC1: passed ${r.numPassedTests} of ${r.numTotalTests}`);
    }

    say(`${SECTION} 8. the variant: Sem 2 unpublished (G2)`);
    const manifestPath = join(copy, manifestRel(y1));
    const m = readJson(manifestPath);
    m.published.ngList['2'] = false;
    writeJson(manifestPath, m, 1);
    const sem1 = readJson(coursesPath);
    delete sem1.semesters['2'];
    sem1.allCodes = [...sem1.semesters['1']].sort();
    writeJson(coursesPath, sem1, 2);
    // The rules' answers change, so the data version does: the bundle build rewrites it with
    // data/ng-unscheduled.json and the other per-corpus files, as a real revision's would.
    await must(copy, process.execPath, ['scripts/vectors.mjs', 'build', '--corpus', 'production', '--expect-count', String(rows)], env);
    const check = await must(copy, process.execPath, ['scripts/year.mjs', 'check'], env);
    if (!/Sem 2 unpublished/.test(check.out)) fail('year check did not note the unpublished Sem 2');
    const libV = await import(`${pathToFileURL(join(copy, 'scripts/lib.mjs')).href}?variant`);
    const elig = await import(pathToFileURL(join(copy, 'src/eligibility.js')).href);
    const ng = await libV.loadNgCourses(y1);
    const modules = libV.offeredModules(records, y1, ng).modules;
    const carried = modules.filter((/** @type {any} */ x) => x.ngSemesters.includes(2));
    const asked = carried.filter((/** @type {any} */ x) => elig.eligibility(x, { sem: 2, study: 'ug2' }, ng.rules).reasons.includes(elig.UNPUBLISHED_SEM));
    const opened = carried.filter((/** @type {any} */ x) => elig.eligibility(x, { sem: 2, study: 'ug2' }, ng.rules).status === 'open');
    say(`Sem 2: ${carried.length} courses on ${y0}'s list, ${asked.length} of them "to confirm" for a 2nd-year, ${opened.length} open`);
    if (!asked.length || opened.length) fail('the unpublished Sem 2 state is not exercised, or a course on last year\'s list shows open');
    if (!values['skip-sc1']) {
      const report = join(copy, '.sc1-variant.json');
      await run(copy, 'npx', ['vitest', 'run', '--project', 'sc1-node', '--reporter=default', '--reporter=json', `--outputFile=${report}`], { ...env, PRODUCTION_CORPUS: '1' });
      const r = readJson(report);
      if (r.numPassedTests === 0 || r.numPassedTests !== r.numTotalTests) fail(`SC1 (Sem 2 unpublished): passed ${r.numPassedTests} of ${r.numTotalTests}`);
    }
    say(`${SECTION} the rehearsal passed: ${y0} -> ${y1}, Sem 2 unpublished included`);
    return 0;
  } catch (err) {
    console.error(`rollover: FAILED: ${/** @type {Error} */ (err).message}`);
    return 1;
  } finally {
    if (worker) await worker.stop();
    if (values.keep) say(`kept ${copy}`);
    else rmSync(copy, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
