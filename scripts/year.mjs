#!/usr/bin/env node
// @ts-check
// The year's source gate (Phase 7 7E, docs/plans/phase7.md 7E; the procedure is
// docs/year-refresh/README.md):
//
//   npm run year -- check [<year>]
//       CI mode, no key: every year source agrees; no stub remains; the source manifest's
//       documents and dates agree with the NG files and the reason texts; the per-corpus files
//       come from the year's corpus; each published semester's count moved at most 25% from last
//       year's (semesters published both years only); the year has an oracle; every indexed NUS
//       quote is still in its file. The archive may be pending (a note, not a failure). The
//       deploy preflight runs this mode (preflight() below).
//   npm run year -- check --full [<year>] [--key <path>]
//       on the Mac, with the sources key: CI mode, then restores the newest revision's archive
//       (sha-checked) into a temp dir, checks every indexed quote verbatim in its document's text,
//       and rebuilds data/ng-restrictions-<year>.json byte for byte. Refuses a pending archive and
//       uncommitted source-derived inputs. Writes a run record (script `year check`, details.mode
//       `full`, details.sourceInputsHash: scripts/preflight.mjs's hash of HEAD's source-derived
//       inputs). Commit the record: the preflight needs it whenever HEAD changes those inputs.
//   npm run year -- next <yyyy-yyyy>
//       scaffolds the year: its source manifest, NG files, overlay module, oracle and register,
//       as stubs (each marked so `year check` fails until it is filled in), never overwriting a
//       file, and prints the checklist.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildRestrictions, dirReader, loadInputs } from './build-ng-restrictions.mjs';
import {
  ROOT, builderHashes, documentOf, htmlText, latestRevision, manifestProblems, manifestRel, ngCoursesRel, ngRestrictionsRel,
  oracleRel, overlayRel, previousYear, publishedSemesters, quoteIn, readManifest, registerRel, toConfirm, unescapeJs,
  unpublishedSemesters, yearLabel,
} from './ng-sources.mjs';
import { sourceInputsHash } from './preflight.mjs';
import { startRun } from './run-record.mjs';
import { restore as restoreSources } from './sources.mjs';

/** How far a published semester's count may move from last year's before `year check` fails. */
export const COUNT_TOLERANCE = 0.25;
/** The marker a stub module or register carries until its author replaces it. */
const STUB_LINE = /^export const stub = true;?\s*$/m;
const STUB_MARK = '<!-- stub: year next -->';

/** @param {string} root @param {string} rel */
const readText = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
/** @param {string} root @param {string} rel @returns {any} */
const readJson = (root, rel) => {
  const t = readText(root, rel);
  if (t === null) return null;
  try { return JSON.parse(t); } catch { return { unreadable: true }; }
};

/**
 * Every place a year is written, as found in the tree (scripts/lib.mjs's DEFAULT_ACAD_YEAR is the
 * one source; test/year-scan.node.test.js keeps any other literal out).
 * @param {string} root
 * @returns {{ where: string, year: string | null }[]}
 */
export function yearSources(root) {
  const find = (/** @type {string} */ rel, /** @type {RegExp} */ re) => ({ where: rel, year: re.exec(readText(root, rel) ?? '')?.[1] ?? null });
  const header = /Academic year (\d{4})\/(\d{2})</.exec(readText(root, 'public/index.html') ?? '');
  const corpus = readJson(root, 'data/corpus.json');
  return [
    find('scripts/lib.mjs', /export const DEFAULT_ACAD_YEAR = '(\d{4}-\d{4})'/),
    find('public/year.js', /export const DEFAULT_ACAD_YEAR = '(\d{4}-\d{4})'/),
    { where: 'public/index.html (the header)', year: header ? `${header[1]}-${Number(header[1]) + 1}` : null },
    { where: 'data/corpus.json (current)', year: corpus?.corpora?.[corpus?.current]?.year ?? null },
    { where: 'data/ng-reasons.json', year: readJson(root, 'data/ng-reasons.json')?.acadYear ?? null },
    { where: 'data/ng-unscheduled.json', year: readJson(root, 'data/ng-unscheduled.json')?.acadYear ?? null },
  ];
}

/**
 * `year check`'s CI mode.
 * @param {{ root?: string, year?: string }} [o] the year defaults to the tree's DEFAULT_ACAD_YEAR
 * @returns {{ ok: boolean, year: string, problems: string[], notes: string[] }}
 */
export function yearCheck({ root = ROOT, year } = {}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  const sources = yearSources(root);
  const y = year ?? sources[0].year ?? '';
  if (!y) return { ok: false, year: y, problems: ['scripts/lib.mjs has no DEFAULT_ACAD_YEAR'], notes };

  // 1. Every year source agrees.
  for (const s of sources) if (s.year !== y) problems.push(`year sources disagree: ${s.where} says ${s.year ?? 'nothing'}, DEFAULT_ACAD_YEAR is ${y}`);

  // 2. The year's files exist, and none is a stub.
  const manifest = readManifest(y, { root });
  const courses = readJson(root, ngCoursesRel(y));
  const restrictions = readJson(root, ngRestrictionsRel(y));
  if (!manifest) problems.push(`no source manifest ${manifestRel(y)} (npm run year -- next ${y})`);
  if (!courses) problems.push(`no ${ngCoursesRel(y)}`);
  if (!restrictions) problems.push(`no ${ngRestrictionsRel(y)}`);
  for (const [rel, data] of /** @type {[string, any][]} */ ([[manifestRel(y), manifest], [ngCoursesRel(y), courses], [ngRestrictionsRel(y), restrictions]])) {
    if (data?.unreadable) problems.push(`${rel} is not JSON`);
    if (data?.stub === true) problems.push(`${rel} is a stub (year next); fill it in`);
  }
  if (!manifest || manifest.stub || !courses || courses.stub || !restrictions || restrictions.stub) return { ok: false, year: y, problems, notes };
  for (const p of manifestProblems(manifest, y)) problems.push(`${manifestRel(y)}: ${p}`);
  for (const k of /** @type {const} */ (['transcription', 'overlay', 'oracle', 'register'])) {
    const text = readText(root, manifest[k]);
    if (text === null) { problems.push(`${manifestRel(y)} names ${k} ${manifest[k]}, which doesn't exist`); continue; }
    if (STUB_LINE.test(text) || text.includes(STUB_MARK)) problems.push(`${manifest[k]} is a stub (year next); its author hasn't written it yet`);
  }
  // 6. An oracle exists for the year, where the selector looks.
  if (manifest.oracle !== oracleRel(y)) problems.push(`${manifestRel(y)} names oracle ${manifest.oracle}; the selector (test/sc1/oracle.mjs) reads ${oracleRel(y)}`);
  if (manifest.overlay !== overlayRel(y)) problems.push(`${manifestRel(y)} names overlay ${manifest.overlay}, not ${overlayRel(y)}`);

  // 3. The documents and dates.
  const rev = latestRevision(manifest);
  if (rev) {
    if (!rev.archive.sha256) notes.push(`archive: pending (${rev.archive.release}): ${rev.archive.pending}`);
    for (const c of toConfirm(rev)) notes.push(`to confirm (the lead): ${c}`);
    const list = documentOf(rev, 'ng-list');
    if (courses.acadYear !== y) problems.push(`${ngCoursesRel(y)} is for ${courses.acadYear}`);
    if (list && courses.updatedAsAt !== list.updatedAsAt) problems.push(`${ngCoursesRel(y)} says the NG list is updated as at ${courses.updatedAsAt}; the source manifest says ${list.updatedAsAt}`);
    if (restrictions.acadYear !== y) problems.push(`${ngRestrictionsRel(y)} is for ${restrictions.acadYear}`);
    if (restrictions.register !== manifest.register) problems.push(`${ngRestrictionsRel(y)} names register ${restrictions.register}; the source manifest names ${manifest.register}`);
    const want = builderHashes(rev);
    const got = restrictions.sourceSha256 ?? {};
    const files = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
    for (const f of files) if (want[f] !== got[f]) problems.push(`${ngRestrictionsRel(y)} was built from ${f} ${got[f] ?? '(absent)'}; the ${rev.date} revision lists ${want[f] ?? '(absent)'}`);
    const reasons = readJson(root, 'data/ng-reasons.json');
    for (const [name, id] of [['Courses offered to exchange (NG) students', 'ng-list'], ['Course restrictions for exchange (NG) students', 'restrictions']]) {
      const shown = reasons?.sources?.find((/** @type {any} */ s) => s.name === name)?.updatedAsAt;
      const d = documentOf(rev, id);
      if (d && shown !== d.updatedAsAt) problems.push(`data/ng-reasons.json shows "${name}" updated as at ${shown}; the source manifest says ${d.updatedAsAt} (node scripts/build-ng-reasons.mjs)`);
    }
  }

  // Published semesters: a published one has its section, an unpublished one none (G2).
  const published = publishedSemesters(manifest);
  for (const s of [1, 2]) {
    const has = Array.isArray(courses.semesters?.[String(s)]);
    if (published.includes(s) && !has) problems.push(`Sem ${s} is published (${manifestRel(y)}) but ${ngCoursesRel(y)} has no Sem ${s} list`);
    if (!published.includes(s) && has) problems.push(`${ngCoursesRel(y)} has a Sem ${s} list, but ${manifestRel(y)} marks Sem ${s} unpublished`);
  }
  const last = previousYear(y);
  const lastCourses = readJson(root, ngCoursesRel(last));
  for (const s of unpublishedSemesters(manifest)) {
    if (!lastCourses?.semesters?.[String(s)]) problems.push(`Sem ${s} is unpublished, so exchange mode shows ${last}'s Sem ${s} list, but ${ngCoursesRel(last)} has none`);
    else notes.push(`Sem ${s} unpublished: exchange mode shows ${yearLabel(last)}'s Sem ${s} list (${lastCourses.semesters[String(s)].length} courses), each to confirm`);
  }
  // YST's pages follow the same flag: a semester whose page YST hasn't published yet is read from an
  // earlier year's, and said so (a revision sets it to this year once the page is out).
  for (const s of [1, 2]) {
    const page = manifest.published?.yst?.[/** @type {'1' | '2'} */ (String(s))];
    if (typeof page === 'string' && page !== y) notes.push(`YST Sem ${s}: ${yearLabel(page)}'s page (YST hasn't published ${yearLabel(y)}'s)`);
  }

  // 4. The per-corpus files come from the year's corpus.
  const unscheduled = readJson(root, 'data/ng-unscheduled.json');
  if (unscheduled && unscheduled.corpus !== 'production') problems.push(`data/ng-unscheduled.json is built from the ${unscheduled.corpus} corpus, not production`);

  // 5. The counts, for semesters published in both years.
  if (lastCourses?.semesters) {
    const lastManifest = readManifest(last, { root });
    const lastPublished = lastManifest ? publishedSemesters(lastManifest) : Object.keys(lastCourses.semesters).map(Number);
    for (const s of published.filter((x) => lastPublished.includes(x))) {
      const now = courses.semesters?.[String(s)]?.length ?? 0;
      const before = lastCourses.semesters?.[String(s)]?.length ?? 0;
      if (!before) continue;
      const moved = Math.abs(now - before) / before;
      if (moved > COUNT_TOLERANCE) problems.push(`Sem ${s}: ${now} courses, ${Math.round(moved * 100)}% away from ${last}'s ${before} (more than ${COUNT_TOLERANCE * 100}%): check the extraction filed each section under its semester`);
    }
  } else notes.push(`counts: no ${ngCoursesRel(last)} to compare with`);

  // The quote index: each NUS sentence is still where it says.
  for (const q of manifest.quotes ?? []) {
    const text = readText(root, q.file);
    if (text === null) problems.push(`quote ${q.id}: ${q.file} doesn't exist`);
    else if (!quoteIn(unescapeJs(text), q.text)) problems.push(`quote ${q.id} is no longer in ${q.file}; if NUS's wording changed, update the quote index in ${manifestRel(y)} (a source-derived input: it needs a year check --full record)`);
  }
  return { ok: problems.length === 0, year: y, problems, notes };
}

/** @param {ReturnType<typeof yearCheck>} r @param {(m: string) => void} log */
function report(r, log) {
  for (const n of r.notes) log(`  note ${n}`);
  for (const p of r.problems) log(`  FAIL ${p}`);
}

/**
 * The deploy preflight's "year check" (scripts/preflight.mjs's optional-check contract).
 * @param {{ log?: (m: string) => void, root?: string }} [o]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function preflight({ root = ROOT } = {}) {
  const r = yearCheck({ root });
  if (!r.ok) return { ok: false, message: `${r.year}: ${r.problems.join('; ')}` };
  return { ok: true, message: `${r.year}: the year's sources agree${r.notes.length ? ` (${r.notes.length} note${r.notes.length === 1 ? '' : 's'}: ${r.notes[0]}${r.notes.length > 1 ? ' …' : ''})` : ''}` };
}

/**
 * git (or any command) in a directory, never throwing.
 * @param {string} cwd
 * @returns {import('./preflight.mjs').Exec}
 */
export const execIn = (cwd) => (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve({ code: err ? Number(/** @type {any} */ (err).code) || 1 : 0, stdout: String(stdout) }));
});

/**
 * The text a quote is checked against: the document's `text` extraction when it has one, else
 * the file itself (HTML with its tags dropped).
 * @param {import('./ng-sources.mjs').SourceDocument} d @param {string} dir
 */
function documentText(d, dir) {
  const name = d.text ?? d.file;
  if (!name) return null;
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return /\.html?$/i.test(name) ? htmlText(raw) : raw;
}

/**
 * A PDF's text in reading order (`pdftotext <file> -`, no `-layout`), or null when pdftotext is
 * missing or fails. `-layout` sets a page's columns side by side, so a sentence that wraps inside
 * one column comes out interleaved with its neighbour; reading order keeps it whole.
 * @param {string} path
 * @returns {Promise<string | null>}
 */
export const pdftotextReadingOrder = (path) => new Promise((resolve) => {
  execFile('pdftotext', [path, '-'], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

/**
 * `year check --full`.
 * @param {{ root?: string, year?: string, key?: string, download?: import('./sources.mjs').Download, runsDir?: string,
 *   log?: (m: string) => void, args?: string[], env?: NodeJS.ProcessEnv, pdfText?: (path: string) => Promise<string | null> }} [o]
 *   `pdfText`: a PDF's reading-order text, the second text a PDF quote is looked for in.
 * @returns {Promise<{ ok: boolean, problems: string[], notes: string[], record: string | null, sourceInputsHash: string | null }>}
 */
export async function yearCheckFull({ root = ROOT, year, key, download, runsDir, log = console.log, args = [], env = process.env, pdfText = pdftotextReadingOrder } = {}) {
  const ci = yearCheck({ root, ...(year ? { year } : {}) });
  const y = ci.year;
  const problems = [...ci.problems];
  const notes = [...ci.notes].filter((n) => !n.startsWith('archive: pending'));
  const manifest = readManifest(y, { root });
  const rev = manifest && !manifest.stub ? latestRevision(manifest) : null;
  if (!ci.ok) return { ok: false, problems: [`CI mode fails first:`, ...problems], notes, record: null, sourceInputsHash: null };
  if (!rev?.archive.sha256) return { ok: false, problems: [`the ${rev?.date} revision's archive is pending (${rev?.archive.pending}): npm run sources -- publish --from <dir> first`], notes, record: null, sourceInputsHash: null };

  const exec = execIn(root);
  const quoteFiles = [...new Set((manifest?.quotes ?? []).map((q) => q.file))];
  // Everything the rebuild reads from the tree, not only what the preflight hashes: a rules file
  // edited by hand must not pass against an uncommitted transcription or builder.
  const builderFiles = [manifest?.transcription, 'scripts/build-ng-restrictions.mjs', 'scripts/ng-sources.mjs'].filter((f) => typeof f === 'string');
  const dirty = await exec('git', ['status', '--porcelain', '--', 'data', 'scripts/ng-overlay', ...quoteFiles, ...builderFiles]);
  const dirt = dirty.stdout.split('\n').filter((l) => l && (/ data\/ng-/.test(l) || / scripts\/ng-overlay\//.test(l)
    || [...quoteFiles, ...builderFiles].some((f) => l.endsWith(` ${f}`))));
  if (dirty.code !== 0 || dirt.length) {
    return { ok: false, problems: [`commit the source-derived inputs (and the transcription and builder) first, so the record names their committed bytes:\n${dirt.join('\n')}`], notes, record: null, sourceInputsHash: null };
  }
  const hash = await sourceInputsHash(exec);
  const record = startRun('year check', { target: `sources archive ${rev.archive.release}`, args, cwd: root, ...(runsDir ? { dir: runsDir } : {}) });
  record.detail('mode', 'full');
  record.detail('year', y);
  record.detail('revision', rev.date);
  record.detail('sourceInputsHash', hash);
  record.detail('archiveSha256', rev.archive.sha256);
  /** @type {string | null} */
  let dir = null;
  try {
    record.request('gh release download');
    const restored = await restoreSources({ year: y, revision: rev.date, root, log, env, ...(key ? { key } : {}), ...(download ? { download } : {}) });
    dir = restored.dir;
    record.read('sources archive files', { actual: restored.files.length });

    // Every indexed quote, verbatim in its document.
    let checked = 0;
    const unarchived = [];
    for (const q of manifest?.quotes ?? []) {
      const d = documentOf(rev, q.document);
      if (!d) { problems.push(`quote ${q.id}: no document ${q.document} in the ${rev.date} revision`); continue; }
      if (d.unarchived) { unarchived.push(`${q.id} (${d.id}: ${d.unarchived})`); continue; }
      const text = documentText(d, dir);
      if (text === null) { problems.push(`quote ${q.id}: ${d.id} has no text in the archive (${d.text ?? d.file ?? 'no file'}); a PDF needs its \`text\` extraction`); continue; }
      // A PDF's quote is found in its archived `text` (pdftotext -layout) or, failing that, in the
      // PDF's own reading-order text: either way NUS's words, in order.
      const found = quoteIn(text, q.text)
        || (/\.pdf$/i.test(d.file ?? '') && quoteIn((await pdfText(join(dir, /** @type {string} */ (d.file)))) ?? '', q.text));
      if (!found) problems.push(`quote ${q.id} (${q.file}) is not in ${d.id} word for word: "${q.text}"`);
      else checked++;
    }
    for (const u of unarchived) notes.push(`unarchived, not checked: ${u}`);
    record.detail('quotes', { checked, unarchived: unarchived.length });

    // The builder reproduces the committed rules file byte for byte.
    const inputs = await loadInputs({ year: y, root, revision: rev.date });
    const built = buildRestrictions({ ...inputs, sources: dirReader(dir) });
    const committed = readText(root, ngRestrictionsRel(y));
    const same = committed === built.text;
    record.detail('rules', same ? 'byte-identical' : 'differs');
    if (!same) problems.push(`${ngRestrictionsRel(y)} is not what the builder writes from the ${rev.date} documents: a hand edit, or a source the rules weren't rebuilt from`);

    const ok = problems.length === 0;
    const path = record.finish(ok ? 'ok' : 'failed', { exitCode: ok ? 0 : 1, message: ok ? `${checked} quotes verbatim; ${ngRestrictionsRel(y)} byte-identical` : problems[0] });
    return { ok, problems, notes, record: path, sourceInputsHash: hash };
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    const path = record.finish('failed', { exitCode: 1, message });
    return { ok: false, problems: [...problems, message], notes, record: path, sourceInputsHash: hash };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Register rows that name a course code, flagged for re-verification (a new year's register
 * starts as last year's rulings).
 * @param {string} text
 */
export function flagCodeRows(text) {
  return text.split('\n').map((line) => (/^\|[^|]+\|/.test(line) && /\b[A-Z]{2,4}\d{4}[A-Z]{0,3}\b/.test(line) && !/re-verify/.test(line)
    ? line.replace(/^\|\s*([^|]*?)\s*\|/, '| $1 (re-verify) |') : line)).join('\n');
}

/**
 * `year next`: the year's files as stubs, never overwriting one.
 * @param {string} year
 * @param {{ root?: string }} [o]
 * @returns {{ written: string[], kept: string[] }}
 */
export function yearNext(year, { root = ROOT } = {}) {
  const last = previousYear(year);
  const lastManifest = readManifest(last, { root });
  if (!lastManifest) throw new Error(`no ${manifestRel(last)} to start ${year} from`);
  const lastOracle = readText(root, lastManifest.oracle);
  const lastRegister = readText(root, lastManifest.register);
  if (lastOracle === null || lastRegister === null) throw new Error(`${last}'s oracle or register is missing (${lastManifest.oracle}, ${lastManifest.register})`);
  const head = (/** @type {string} */ what) => `STUB (npm run year -- next ${year}): ${what} starts as ${last}'s; year check fails until it is written (docs/year-refresh/README.md).`;
  /** @type {[string, string][]} */
  const files = [
    [manifestRel(year), `${JSON.stringify({
      schema: lastManifest.schema, acadYear: year, stub: true,
      transcription: `docs/year-refresh/transcriptions/${year}-b.json`, overlay: overlayRel(year), oracle: oracleRel(year), register: registerRel(year),
      published: { ngList: { 1: false, 2: false }, yst: lastManifest.published.yst },
      revisions: [], quotes: lastManifest.quotes,
      todo: 'the revision(s) and their documents (name, url, file, sha256, updatedAsAt), the published semesters, the transcription; then delete `stub` and `todo`',
    }, null, 1)}\n`],
    [ngCoursesRel(year), `${JSON.stringify({ stub: true, acadYear: year, semesters: {} }, null, 1)}\n`],
    [ngRestrictionsRel(year), `${JSON.stringify({ stub: true, acadYear: year, rules: [] }, null, 1)}\n`],
    [overlayRel(year), `// @ts-check\n// ${head('the overlay')}\n// docs/year-refresh/overlay.md: new ids, roles, department renames.\nexport const stub = true;\nexport * from './${last}.mjs';\n`],
    [oracleRel(year), `// ${head('the oracle')}\n// docs/year-refresh/brief-oracle.md: a fresh author rewrites only the sections whose rules changed.\nexport const stub = true;\n${lastOracle}`],
    [registerRel(year), `${STUB_MARK}\n<!-- ${head('the register')} Rows that name a course code are flagged re-verify. -->\n\n${flagCodeRows(lastRegister)}`],
  ];
  const written = [];
  const kept = [];
  for (const [rel, text] of files) {
    const path = join(root, rel);
    if (existsSync(path)) { kept.push(rel); continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag: 'wx' });
    written.push(rel);
  }
  return { written, kept };
}

/** The year switch's checklist (docs/year-refresh/README.md has each step in full). @param {string} year */
export const CHECKLIST = (year) => [
  `Year switch to ${year} (docs/year-refresh/README.md):`,
  ' 1. When: NUSMods has the year and NUS has published its Sem 1 list (G2, July).',
  ` 2. Scaffold: npm run year -- next ${year} (done).`,
  ' 3. Sources: save the documents by hand into a new dir; npm run sources -- hash --from <dir>; fill in the revision; npm run sources -- publish --from <dir>.',
  ' 4. Transcription: two independent transcriptions (brief-transcription.md), node scripts/transcription-diff.mjs, then --map-to last year; the register with the maintainer\'s rulings (register.md).',
  ` 5. Corpus and rules: npm run corpus -- fetch ${year}; npm run corpus -- publish --new-data-version; the overlay (overlay.md); python3 scripts/extract-ng.py <pdf> --year ${year}; node scripts/build-ng-restrictions.mjs --sources <restored dir>; node scripts/build-ng-reasons.mjs; DEFAULT_ACAD_YEAR, public/year.js and the header.`,
  ' 6. Oracle: the changed sections by a fresh author (brief-oracle.md), then agreement (npm run test:sc1).',
  ' 7. Checks: npm run year -- check --full (commit its record); node scripts/vectors.mjs build --corpus production.',
  ' 8. PR: CI runs sc1 and rollover on the new year; merge only when complete.',
  ' 9. On merged main: npm run deploy -- --preflight; npm run d1:bookmark.',
  '10. npm run remote -- ingest --d1-only --allow-year-change --write-budget 80000; npm run remote -- verify --pre-deploy.',
  '11. npm run deploy; npm run smoke.',
  '12. npm run remote -- vectors standby; npm run remote -- verify.',
  '13. The live checks with the year\'s oracle.',
].join('\n');

const USAGE = 'usage: npm run year -- check [--full] [--key <path>] [<year>] | next <yyyy-yyyy>';

/**
 * @param {string[]} argv
 * @param {{ log?: (m: string) => void, root?: string, download?: import('./sources.mjs').Download, runsDir?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const root = deps.root ?? ROOT;
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { full: { type: 'boolean' }, key: { type: 'string' } } });
  } catch (err) {
    log(`${/** @type {Error} */ (err).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  try {
    if (command === 'check' && !values.full) {
      const r = yearCheck({ root, ...(positionals[0] ? { year: positionals[0] } : {}) });
      log(`year check ${r.year} (CI mode)`);
      report(r, log);
      log(r.ok ? '  OK' : `  ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`);
      return r.ok ? 0 : 1;
    }
    if (command === 'check') {
      const r = await yearCheckFull({
        root, log, args: argv, ...(positionals[0] ? { year: positionals[0] } : {}), ...(values.key ? { key: values.key } : {}),
        ...(deps.download ? { download: deps.download } : {}), ...(deps.runsDir ? { runsDir: deps.runsDir } : {}), ...(deps.env ? { env: deps.env } : {}),
      });
      log('year check --full');
      for (const n of r.notes) log(`  note ${n}`);
      for (const p of r.problems) log(`  FAIL ${p}`);
      if (r.record) log(`  record ${r.record}${r.ok ? ' (commit it: the preflight needs it)' : ''}`);
      log(r.ok ? `  OK: source-derived inputs ${r.sourceInputsHash?.slice(0, 12)}…` : '  FAILED');
      return r.ok ? 0 : 1;
    }
    if (command === 'next') {
      const year = positionals[0];
      if (!year) { log(USAGE); return 2; }
      const r = yearNext(year, { root });
      for (const f of r.written) log(`wrote ${f} (stub)`);
      for (const f of r.kept) log(`kept  ${f} (exists; year next never overwrites)`);
      log(`\n${CHECKLIST(year)}`);
      return 0;
    }
    log(USAGE);
    return 2;
  } catch (err) {
    log(`year ${command}: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
