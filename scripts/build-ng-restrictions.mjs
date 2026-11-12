#!/usr/bin/env node
// @ts-check
// Builds data/ng-restrictions-<year>.json, the rules src/eligibility.js reads
// (docs/plans/phase4.md 4B; Phase 7 7E: per year, from the year's source manifest). Inputs, all
// named by data/ng-sources-<year>.json:
//   - `transcription`: the restrictions PDF as transcribed (two transcriptions, diffed;
//     docs/year-refresh/brief-transcription.md); every code, title and quote below comes from it;
//   - `overlay`: the year's module (scripts/ng-overlay/<year>.mjs): how each transcribed rule
//     matches NUSMods fields, per the year's interpretations register, with the roles
//     `self-funded-list` and `off-list-rule`;
//   - the newest revision's documents: every `builder` document is read through its sha256 (a
//     mismatch, or one never read, fails the build); the self-funded course list and the YST
//     elective lists are extracted here.
//
//   node scripts/build-ng-restrictions.mjs --sources <dir> [--check] [--revision <date>]
//
// <dir> holds the revision's documents: `npm run sources -- restore` unpacks them into a temp
// dir (docs/year-refresh/README.md). There is no default. --check compares the build with the
// committed file byte for byte instead of writing it (`year check --full` runs it).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULT_ACAD_YEAR } from './lib.mjs';
import { ROLES, builderHashes, documentOf, ngRestrictionsRel, readManifest, revisionOf } from './ng-sources.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const GENERATOR = 'scripts/build-ng-restrictions.mjs';

/** @typedef {import('../src/eligibility.js').RuleMatch} RuleMatch */
/** @typedef {import('./ng-sources.mjs').SourceManifest} SourceManifest */
/** @typedef {import('./ng-sources.mjs').Revision} Revision */
/**
 * @typedef {{ suffix?: string, role?: string, effect: 'closed' | 'note' | 'open', note?: string,
 *   studies?: import('../src/eligibility.js').Study[], codes?: boolean, match?: RuleMatch, reason: string }} Part
 * @typedef {{ departments?: string[], faculties?: string[], levels?: number[] }} OffListScope
 * @typedef {Record<string, Part[] | { info: string, offList?: OffListScope, role?: string }>} Overlay
 * @typedef {{ OVERLAY: Overlay, TWINS: Record<string, string>,
 *   DECIDED: { id: string, effect: 'open', match: RuleMatch, reason: string, cite: string }[] }} OverlayModule
 * @typedef {{ read: (file: string) => Buffer }} SourceReader
 */

/**
 * Where each role sits in the overlay: the rule id (and, for a rule with parts, the part).
 * Fails if a role is missing, appears twice, or is not one the builder knows.
 * @param {Overlay} overlay
 * @returns {Record<typeof ROLES[number], string>}
 */
export function rolesOf(overlay) {
  /** @type {Record<string, string[]>} */
  const found = {};
  for (const [id, o] of Object.entries(overlay)) {
    const roles = Array.isArray(o) ? o.map((p) => (p.role ? { role: p.role, at: p.suffix ? `${id}:${p.suffix}` : id } : null)) : [o.role ? { role: o.role, at: id } : null];
    for (const r of roles) if (r) (found[r.role] ??= []).push(r.at);
  }
  const problems = [];
  for (const role of Object.keys(found)) if (!(/** @type {readonly string[]} */ (ROLES)).includes(role)) problems.push(`unknown role ${role} (${found[role].join(', ')})`);
  for (const role of ROLES) {
    if (!found[role]) problems.push(`role ${role} is missing`);
    else if (found[role].length > 1) problems.push(`role ${role} appears ${found[role].length} times (${found[role].join(', ')})`);
  }
  if (problems.length) throw new Error(`overlay roles: ${problems.join('; ')}`);
  return /** @type {Record<typeof ROLES[number], string>} */ (Object.fromEntries(ROLES.map((r) => [r, found[r][0]])));
}

const CODE_RE = /\b[A-Z]{2,4}\d{4}[A-Z]{0,3}\b/g;
// A YST page offers the courses its headings name, and the pages mark
// headings two ways, neither complete: the heading line carries "(N Units"
// (its codes start that line, or the nearest line above it within three, as
// titles wrap), and the heading's code is in an orange (#ff5200) span. The
// union of the two is the list. Codes in Pre-requisite, Co-requisite and
// Preclusion lines are in neither (audit 4B).
const LEAD = /^\*?([A-Z]{2,4}\d{4}[A-Z]?(?:\/[A-Z]{2,4}\d{4}[A-Z]?)*)\b/;

/**
 * The rules file for a year, as the text written to disk.
 * @param {{ manifest: SourceManifest, revision: Revision, transcription: { rules: any[] }, overlay: OverlayModule, sources: SourceReader }} input
 * @returns {{ out: any, text: string, summary: string }}
 */
export function buildRestrictions({ manifest, revision, transcription, overlay, sources }) {
  const { OVERLAY, TWINS, DECIDED } = overlay;
  const roles = rolesOf(OVERLAY);
  const expected = builderHashes(revision);
  /** @type {Record<string, string>} */
  const computed = {};
  /** Every document the builder reads goes through here. @param {string} id */
  const source = (id) => {
    const d = documentOf(revision, id);
    if (!d?.file || !d.builder) throw new Error(`the ${revision.date} revision has no builder document ${id}`);
    const bytes = sources.read(d.file);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== expected[d.file]) throw new Error(`${d.file}: sha256 ${got} does not match the source manifest (${expected[d.file] ?? 'missing'})`);
    computed[d.file] = got;
    return bytes.toString('utf8');
  };

  // The .txt files are pdftotext's output of the PDFs (and the HTML pages' text, scripts/yst-text.mjs);
  // each is hashed in the manifest like its original, so a changed extraction fails.
  source('self-funded');
  const selfFunded = [...new Set(source('self-funded-text').match(CODE_RE) ?? [])].sort();
  /** @param {1 | 2} sem */
  const ystCodes = (sem) => {
    const codes = new Set();
    /** @param {string} text */
    const add = (text) => { const head = LEAD.exec(text.trim()); if (head) for (const c of head[1].split('/')) if (!/^AY\d/.test(c)) codes.add(c); return !!head; };
    const lines = source(`yst-sem${sem}-text`).split('\n').map((l) => l.trim());
    lines.forEach((line, i) => {
      if (!/\(\d+ units?\b/i.test(line)) return;
      for (let j = i; j >= Math.max(0, i - 3); j--) if (add(lines[j])) return;
      throw new Error(`yst-sem${sem}: no course code above line ${i + 1}: ${line}`);
    });
    const html = source(`yst-sem${sem}`);
    for (const m of html.matchAll(/<span[^>]*color:\s*#ff5200[^>]*>([\s\S]*?)<\/span>/gi)) add(m[1].replace(/<[^>]+>/g, ''));
    return [...codes].sort();
  };
  source('restrictions'); source('law-compulsory'); source('ng-list');

  const missing = transcription.rules.map((r) => r.id).filter((id) => !(id in OVERLAY));
  const extra = Object.keys(OVERLAY).filter((id) => !transcription.rules.some((r) => r.id === id));
  if (missing.length || extra.length) throw new Error(`overlay out of step with the transcription: missing ${missing.join(', ')}; extra ${extra.join(', ')}`);

  /** @type {any[]} */
  const rules = [];
  /** @type {{ id: string, why: string, text?: string, scope?: OffListScope }[]} */
  const info = [];
  for (const r of transcription.rules) {
    const o = OVERLAY[r.id];
    const cite = `restrictions PDF §${r.section}${r.department ? ` (${r.department})` : ''}, p${r.page}`;
    if (!Array.isArray(o)) { info.push({ id: r.id, why: o.info, ...(o.offList ? { text: r.quote, scope: o.offList } : {}) }); continue; }
    for (const part of o) {
      /** @type {RuleMatch} */
      const match = { ...(part.match ?? {}) };
      /** @type {{ code: string, title: string }[] | undefined} */
      let titled;
      if (part.codes) {
        const codes = new Set((r.scope?.codes ?? []).map((/** @type {{ code: string }} */ c) => c.code));
        for (const c of [...codes]) if (TWINS[c]) codes.add(TWINS[c]);
        match.codes = [...codes].sort();
        titled = (r.scope?.codes ?? []).map((/** @type {{ code: string, title: string }} */ c) => ({ code: c.code, title: c.title }));
      }
      rules.push({
        id: part.suffix ? `${r.id}:${part.suffix}` : r.id,
        effect: part.effect,
        ...(part.note ? { note: part.note } : {}),
        ...(part.studies ? { studies: part.studies } : {}),
        match,
        reason: part.reason,
        cite,
        quote: r.quote,
        ...(titled ? { titles: titled } : {}),
      });
    }
  }
  for (const d of DECIDED) rules.push({ ...d });

  const ystElectives = { 1: ystCodes(1), 2: ystCodes(2) };
  const out = {
    acadYear: manifest.acadYear,
    generator: GENERATOR,
    sourceSha256: /** @type {Record<string, string>} */ ({}),
    register: manifest.register,
    rules,
    lists: {
      ystElectives,
    },
    info,
  };
  const selfFundedRule = rules.find((r) => r.id === roles['self-funded-list']);
  if (!selfFundedRule) throw new Error(`role self-funded-list names ${roles['self-funded-list']}, which builds no rule`);
  selfFundedRule.match = { codes: selfFunded };
  if (!info.some((i) => i.id === roles['off-list-rule'] && i.text !== undefined)) throw new Error(`role off-list-rule names ${roles['off-list-rule']}, which is not an off-list info rule`);
  const unread = Object.keys(expected).filter((name) => !(name in computed));
  if (unread.length) throw new Error(`the source manifest lists builder documents the builder never read: ${unread.join(', ')}`);
  out.sourceSha256 = Object.fromEntries(Object.entries(computed).sort());
  return {
    out,
    text: `${JSON.stringify(out, null, 1)}\n`,
    summary: `${rules.length} rules (${info.length} info-only); self-funded ${selfFunded.length} codes; YST electives S1 ${ystElectives[1].length}, S2 ${ystElectives[2].length}`,
  };
}

/**
 * The year's inputs from the repo (or a root), read through its manifest.
 * @param {{ year?: string, root?: string, revision?: string }} [o]
 */
export async function loadInputs({ year = DEFAULT_ACAD_YEAR, root = ROOT, revision } = {}) {
  const manifest = readManifest(year, { root });
  if (!manifest) throw new Error(`no source manifest data/ng-sources-${year}.json`);
  if (manifest.stub) throw new Error(`data/ng-sources-${year}.json is a stub (year next); fill it in first`);
  const rev = revisionOf(manifest, revision);
  if (!rev) throw new Error(`data/ng-sources-${year}.json has no revision ${revision}`);
  const transcription = JSON.parse(readFileSync(join(root, manifest.transcription), 'utf8'));
  /** @type {OverlayModule} */
  const overlay = await import(pathToFileURL(join(root, manifest.overlay)).href);
  if (/** @type {any} */ (overlay).stub) throw new Error(`${manifest.overlay} is a stub (year next); write the year's overlay first`);
  return { manifest, revision: rev, transcription, overlay };
}

/** Reads documents from a directory. @param {string} dir @returns {SourceReader} */
export const dirReader = (dir) => ({
  read: (file) => {
    const path = join(dir, file);
    if (!existsSync(path)) throw new Error(`${file} is not in ${dir}`);
    return readFileSync(path);
  },
});

/**
 * @param {string[]} argv
 * @param {{ log?: (m: string) => void, root?: string, year?: string }} [o]
 * @returns {Promise<number>}
 */
export async function main(argv, { log = console.log, root = ROOT, year = DEFAULT_ACAD_YEAR } = {}) {
  const { values } = parseArgs({ args: argv, strict: true, options: { sources: { type: 'string' }, check: { type: 'boolean' }, revision: { type: 'string' } } });
  if (!values.sources) {
    log('usage: node scripts/build-ng-restrictions.mjs --sources <dir> [--check] [--revision <date>]\n'
      + '<dir> holds the revision\'s documents (npm run sources -- restore unpacks them); there is no default.');
    return 2;
  }
  try {
    const inputs = await loadInputs({ year, root, ...(values.revision ? { revision: values.revision } : {}) });
    const built = buildRestrictions({ ...inputs, sources: dirReader(values.sources) });
    const rel = ngRestrictionsRel(year);
    const path = join(root, rel);
    if (values.check) {
      const committed = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (committed !== built.text) { log(`FAIL ${rel} is not what the builder writes from the ${inputs.revision.date} documents (${built.summary})`); return 1; }
      log(`ok ${rel} rebuilds byte for byte from the ${inputs.revision.date} documents (${built.summary})`);
      return 0;
    }
    writeFileSync(path, built.text);
    log(`wrote ${built.summary} to ${rel}`);
    return 0;
  } catch (err) {
    log(`build-ng-restrictions: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
