// @ts-check
// Fails unless docs/FINDINGS.md triages every finding ID in docs/CRITERIA.md.
//
//   npm run check:findings
//
// Rules:
// - CRITERIA.md's <!-- ids:start -->…<!-- ids:end --> block holds exactly 35
//   unique IDs.
// - FINDINGS.md has exactly one `### <ID> …` section per ID, and no others.
// - Each section has `**Status:** <s>` with s from the closed set below.
// - Every `reproduced`, `partially-reproduced` or `fixed` section names at least
//   one piece of evidence in its `**Evidence:**` block, and every piece named
//   there must exist: a backticked repo path must be a file on disk, and a
//   backticked test name (starting with `[`) must appear in a file under test/.
// - The summary table, if present, agrees with the sections.
// No dependencies, so CI can run it with plain node.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXPECTED_ID_COUNT = 35;
export const STATUSES = ['reproduced', 'partially-reproduced', 'rejected', 'fixed'];
const NEEDS_EVIDENCE = new Set(STATUSES); // rejected rows need evidence for the rejection too
const ID = /^[A-Z]\d+$/;
// Anything shaped like a repo path is checked: a path with a directory part whose
// last segment has an extension (`docs/evidence/x.gz`, `scripts/missing.py`), or a bare
// file name with a common file extension (`README.md`, `wrangler.jsonc`). Prose spans
// such as `res.json()`, `text/plain`, `m.title` or `index.js:38` are not paths.
const EXT = 'm?[jt]sx?|cjs|jsonc?|md|ya?ml|toml|sql|html?|css|body|headers|timing|tsv|csv|txt|log|png|jpe?g|svg|gz|zip|py|sh|pdf|age';
const PATH = new RegExp(`^(?:(?:\\.?[\\w@-][\\w.@-]*/)+[\\w@-][\\w@-]*(?:\\.[\\w-]+)*\\.[A-Za-z][\\w]*|\\.?[\\w@-][\\w.@-]*\\.(?:${EXT}))$`);
/** Matches the title of every it()/test()/it.each()() call. */
const TEST_TITLE = /\b(?:it|test)(?:\.(?:each|skip|only|skipIf|runIf)\([^)]*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** @param {string} source @returns {Set<string>} exact test titles declared in `source` */
export function testTitles(source) {
  return new Set([...source.matchAll(TEST_TITLE)].map((m) => m[2].replace(/\\(.)/g, '$1')));
}

/**
 * @param {string} criteria CRITERIA.md text
 * @returns {{ ids: string[], errors: string[] }}
 */
export function parseIds(criteria) {
  const block = criteria.match(/<!-- ids:start -->([\s\S]*?)<!-- ids:end -->/);
  if (!block) return { ids: [], errors: ['CRITERIA.md: no <!-- ids:start --> … <!-- ids:end --> block'] };
  const ids = block[1].split(/\s+/).filter(Boolean);
  const errors = [];
  for (const id of ids) if (!ID.test(id)) errors.push(`CRITERIA.md: "${id}" is not a finding ID`);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) errors.push(`CRITERIA.md: duplicate IDs ${[...new Set(dupes)].join(', ')}`);
  if (ids.length !== EXPECTED_ID_COUNT) errors.push(`CRITERIA.md: expected ${EXPECTED_ID_COUNT} IDs, found ${ids.length}`);
  return { ids, errors };
}

/**
 * @typedef {{ id: string, status: string | null, evidence: string, line: number }} Section
 * @param {string} findings FINDINGS.md text
 * @returns {{ sections: Section[], table: { id: string, status: string, line: number }[] }}
 */
export function parseFindings(findings) {
  const lines = findings.split('\n');
  /** @type {Section[]} */
  const sections = [];
  /** @type {{ id: string, status: string, line: number }[]} */
  const table = [];
  /** @type {{ id: string, line: number, body: string[] } | null} */
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join('\n');
    const status = body.match(/^\*\*Status:\*\*\s*`?([^`\s]+)`?\s*$/m)?.[1] ?? null;
    const evidence = body.match(/^\*\*Evidence:\*\*([\s\S]*?)(?=^\*\*[A-Z][a-z]+:\*\*|$(?![\s\S]))/m)?.[1] ?? '';
    sections.push({ id: current.id, status, evidence, line: current.line });
  };
  lines.forEach((text, i) => {
    const heading = text.match(/^### ([A-Z]\d+)\b/);
    if (heading) { flush(); current = { id: heading[1], line: i + 1, body: [] }; return; }
    if (/^#{1,3} /.test(text)) { flush(); current = null; return; }
    if (current) { current.body.push(text); return; }
    const row = text.match(/^\|\s*([A-Z]\d+)\s*\|\s*`?([a-z-]+)`?\s*\|/);
    if (row) table.push({ id: row[1], status: row[2], line: i + 1 });
  });
  flush();
  return { sections, table };
}

/**
 * The evidence a section names: backticked repo paths and backticked test names.
 * @param {string} evidence
 */
export function evidenceRefs(evidence) {
  const spans = [...evidence.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  return {
    tests: spans.filter((s) => s.startsWith('[')),
    // A repo path: no spaces, ending in a file extension this repo uses, e.g.
    // `docs/evidence/phase0/raw/B1_sem3.body` or `tsconfig.json`. Other code
    // spans (`res.json()`, `0.030`) are prose.
    paths: spans.filter((s) => !s.startsWith('[') && PATH.test(s)),
  };
}

/**
 * @param {{
 *   criteria: string,
 *   findings: string,
 *   fileExists: (repoPath: string) => boolean,
 *   testSource: string,
 * }} input `testSource` is every test file under test/ (excluding check-findings' own tests), concatenated.
 * @returns {string[]} errors; empty means the check passed
 */
export function checkFindings({ criteria, findings, fileExists, testSource }) {
  const { ids, errors } = parseIds(criteria);
  const { sections, table } = parseFindings(findings);
  const titles = testTitles(testSource);
  const known = new Set(ids);
  /** @type {Map<string, Section>} */
  const byId = new Map();

  for (const s of sections) {
    const where = `FINDINGS.md:${s.line} ${s.id}`;
    if (!known.has(s.id)) errors.push(`${where}: not an ID in CRITERIA.md`);
    if (byId.has(s.id)) { errors.push(`${where}: duplicate section (first at line ${byId.get(s.id)?.line})`); continue; }
    byId.set(s.id, s);
    if (s.status === null) { errors.push(`${where}: no **Status:** line`); continue; }
    if (!STATUSES.includes(s.status)) {
      errors.push(`${where}: status "${s.status}" is not one of ${STATUSES.join(' | ')}`);
      continue;
    }
    const { tests, paths } = evidenceRefs(s.evidence);
    const missingPaths = paths.filter((p) => !fileExists(p));
    const missingTests = tests.filter((t) => !titles.has(t));
    for (const p of missingPaths) errors.push(`${where}: evidence file ${p} does not exist`);
    for (const t of missingTests) errors.push(`${where}: test ${t} not found under test/`);
    const found = paths.length - missingPaths.length + tests.length - missingTests.length;
    if (NEEDS_EVIDENCE.has(s.status) && found === 0) {
      errors.push(`${where}: status "${s.status}" needs at least one existing evidence file or test in **Evidence:**`);
    }
  }
  for (const id of ids) if (!byId.has(id)) errors.push(`FINDINGS.md: no section for ${id}`);

  for (const row of table) {
    const s = byId.get(row.id);
    if (s && s.status !== row.status) {
      errors.push(`FINDINGS.md:${row.line} summary table says ${row.id} is "${row.status}", its section says "${s.status}"`);
    }
  }
  return errors;
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name))
      : /\.test\.m?js$/.test(e.name) && e.name !== 'check-findings.node.test.js' ? [join(dir, e.name)] : []);
}

/**
 * Runs the check against a checkout.
 * @param {string} root repository root
 */
export function checkRepo(root) {
  const read = (/** @type {string} */ p) => readFileSync(join(root, p), 'utf8');
  for (const p of ['docs/CRITERIA.md', 'docs/FINDINGS.md']) {
    if (!existsSync(join(root, p))) return { errors: [`${p} does not exist`], counts: {} };
  }
  const findings = read('docs/FINDINGS.md');
  const testSource = walk(join(root, 'test')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const errors = checkFindings({
    criteria: read('docs/CRITERIA.md'),
    findings,
    fileExists: (p) => !p.includes('..') && existsSync(join(root, p)),
    testSource,
  });
  /** @type {Record<string, number>} */
  const counts = {};
  for (const s of parseFindings(findings).sections) counts[String(s.status)] = (counts[String(s.status)] ?? 0) + 1;
  return { errors, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { errors, counts } = checkRepo(root);
  if (errors.length) {
    console.error(`check-findings: ${errors.length} problem(s) in ${relative(process.cwd(), join(root, 'docs')) || 'docs'}/:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`check-findings: OK, ${EXPECTED_ID_COUNT} IDs triaged (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`);
}
