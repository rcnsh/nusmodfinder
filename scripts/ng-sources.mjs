// @ts-check
// The per-year source manifest (Phase 7 7E, docs/plans/phase7.md 7E), data/ng-sources-<year>.json:
// which NUS documents exchange mode's rules and quotes come from, revision by revision, with
// each document's name, URL, file, sha256 and "updated as at" date; which semesters NUS has
// published a list for; the year's transcription, overlay module, oracle and register; and the
// quote index, each NUS sentence the page copies by hand with the document it comes from.
//
// Pure helpers plus file reads under a root (the repo by default), so `year check`, the
// restrictions builder, `sources` and the rehearsal share one reading. docs/year-refresh/ is the
// procedure; docs/REFERENCE.md "A new academic year" the summary.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MANIFEST_SCHEMA = 'vnm-ng-sources/1';
/** The overlay roles the restrictions builder and the page read instead of literal rule ids. */
export const ROLES = /** @type {const} */ (['self-funded-list', 'off-list-rule']);

/**
 * @typedef {{
 *   id: string, name: string, url: string | null, file: string | null, sha256: string | null,
 *   updatedAsAt: string | null, builder?: boolean, derivedFrom?: string, text?: string, textSha256?: string, note?: string,
 *   confirm?: string[], unarchived?: string,
 * }} SourceDocument
 *   `confirm` lists the fields the lead has still to fill in from the saved document (a URL or
 *   date not in git); `unarchived` gives the reason a quoted source can't go in the archive.
 *   `text` is the document's text extraction (pdftotext), archived with it, and `textSha256` its
 *   sha256 (red team L-5): `sources publish` writes it, and restore, `year check --full` and the
 *   restrictions builder check it. `file` and `text` are plain base names (red team L-4).
 * @typedef {{ release: string, asset: string, sha256: string | null, pending?: string }} ArchiveRef
 * @typedef {{ date: string, archive: ArchiveRef, documents: SourceDocument[] }} Revision
 * @typedef {{ id: string, file: string, text: string, document: string }} Quote
 * @typedef {{
 *   schema: string, acadYear: string, stub?: boolean,
 *   transcription: string, overlay: string, oracle: string, register: string,
 *   published: { ngList: Record<'1' | '2', boolean>, yst: Record<'1' | '2', string> },
 *   revisions: Revision[], quotes: Quote[],
 * }} SourceManifest
 */

/** 'YYYY-YYYY' is an acad year. @param {string} year */
export const isAcadYear = (year) => {
  const m = /^(\d{4})-(\d{4})$/.exec(year);
  return !!m && Number(m[2]) === Number(m[1]) + 1;
};
/** @param {string} year @param {number} by */
const shift = (year, by) => {
  if (!isAcadYear(year)) throw new Error(`not an acad year: ${year} (YYYY-YYYY)`);
  const a = Number(year.slice(0, 4)) + by;
  return `${a}-${a + 1}`;
};
/** The acad year before. @param {string} year */
export const previousYear = (year) => shift(year, -1);
/** The acad year after. @param {string} year */
export const nextYear = (year) => shift(year, 1);
/** 'YYYY-ZZZZ' → 'YYYY/ZZ', as the page labels a year. @param {string} year */
export const yearLabel = (year) => `${year.slice(0, 4)}/${year.slice(7, 9)}`;

/** The manifest's path, repo-relative. @param {string} year */
export const manifestRel = (year) => `data/ng-sources-${year}.json`;
/** @param {string} year */
export const ngCoursesRel = (year) => `data/ng-courses-${year}.json`;
/** @param {string} year */
export const ngRestrictionsRel = (year) => `data/ng-restrictions-${year}.json`;
/** @param {string} year */
export const overlayRel = (year) => `scripts/ng-overlay/${year}.mjs`;
/** @param {string} year */
export const oracleRel = (year) => `test/sc1/oracle-${year}.node.mjs`;
/** A new year's register (the first year's stays at docs/evidence/phase4/interpretations.md, as its manifest says). @param {string} year */
export const registerRel = (year) => `docs/year-refresh/registers/${year}.md`;

/**
 * The manifest for a year, or null when the file is missing.
 * @param {string} year @param {{ root?: string }} [o]
 * @returns {SourceManifest | null}
 */
export function readManifest(year, { root = ROOT } = {}) {
  const path = join(root, manifestRel(year));
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The newest revision (revisions are kept oldest first). @param {SourceManifest} m */
export const latestRevision = (m) => m.revisions[m.revisions.length - 1] ?? null;

/** A revision by its date, or the newest. @param {SourceManifest} m @param {string} [date] */
export function revisionOf(m, date) {
  if (!date) return latestRevision(m);
  return m.revisions.find((r) => r.date === date) ?? null;
}

/**
 * The semesters NUS has published this year's NG list for, ascending.
 * @param {Pick<SourceManifest, 'published'>} m
 * @returns {number[]}
 */
export const publishedSemesters = (m) => /** @type {const} */ (['1', '2']).filter((s) => m.published?.ngList?.[s] === true).map(Number);

/**
 * The semesters NUS hasn't published yet (G2): Sem 2 between the July switch and NUS's Sem 2
 * list. Exchange mode shows last year's list for them, each course "to confirm".
 * @param {Pick<SourceManifest, 'published'>} m
 */
export const unpublishedSemesters = (m) => [1, 2].filter((s) => !publishedSemesters(m).includes(s));

/** A document of a revision by id. @param {Revision} rev @param {string} id */
export const documentOf = (rev, id) => rev.documents.find((d) => d.id === id) ?? null;

/**
 * The documents the restrictions builder reads (each sha-checked), by file name.
 * @param {Revision} rev
 * @returns {Record<string, string>} file → sha256
 */
export function builderHashes(rev) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const d of rev.documents) if (d.builder && d.file && d.sha256) out[d.file] = d.sha256;
  return out;
}

/**
 * Whether a manifest's file name is a plain base name, safe to join onto a directory (red team
 * L-4): not empty, not `.`, and no `/`, `\\`, `..`, drive or absolute path, or NUL.
 * @param {unknown} name
 */
export const isPlainName = (name) => typeof name === 'string' && name !== '' && name !== '.'
  && !/[/\\\0]/.test(name) && !name.includes('..') && !/^[A-Za-z]:/.test(name);

/** The refusal for a name that is not plain. @param {string} what @param {unknown} name */
export const notPlain = (what, name) => `${what} ${JSON.stringify(name)} is not a plain file name (no /, \\, .., absolute path or NUL)`;

/**
 * What the manifest's shape gets wrong, as sentences (an empty list is a sound manifest).
 * @param {SourceManifest} m @param {string} year
 * @returns {string[]}
 */
export function manifestProblems(m, year) {
  const out = [];
  if (m.schema !== MANIFEST_SCHEMA) out.push(`schema is ${m.schema}, not ${MANIFEST_SCHEMA}`);
  if (m.acadYear !== year) out.push(`acadYear is ${m.acadYear}, not ${year}`);
  for (const k of /** @type {const} */ (['transcription', 'overlay', 'oracle', 'register'])) if (typeof m[k] !== 'string' || !m[k]) out.push(`${k} path is missing`);
  for (const s of /** @type {const} */ (['1', '2'])) {
    if (typeof m.published?.ngList?.[s] !== 'boolean') out.push(`published.ngList.${s} is not true or false`);
    if (typeof m.published?.yst?.[s] !== 'string' || !isAcadYear(m.published.yst[s])) out.push(`published.yst.${s} names no acad year`);
  }
  if (!Array.isArray(m.revisions) || !m.revisions.length) out.push('no revision');
  for (const rev of m.revisions ?? []) {
    if (!/^\d{4}-\d\d-\d\d$/.test(rev.date ?? '')) out.push(`a revision's date is ${rev.date}, not YYYY-MM-DD`);
    const a = rev.archive;
    if (!a || typeof a.release !== 'string' || typeof a.asset !== 'string') out.push(`revision ${rev.date}: no archive release and asset`);
    else if (!(typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256)) && !(a.sha256 === null && typeof a.pending === 'string' && a.pending)) {
      out.push(`revision ${rev.date}: the archive has neither a sha256 nor a pending reason`);
    }
    const ids = new Set();
    for (const d of rev.documents ?? []) {
      if (!d.id || ids.has(d.id)) out.push(`revision ${rev.date}: document id ${d.id} is missing or repeated`);
      ids.add(d.id);
      if (!d.name) out.push(`revision ${rev.date}: ${d.id} has no name`);
      const confirm = new Set(d.confirm ?? []);
      for (const k of /** @type {const} */ (['url', 'file', 'sha256', 'updatedAsAt'])) {
        if (d[k] === undefined) out.push(`revision ${rev.date}: ${d.id} has no ${k} (null, with the reason in \`note\` or \`confirm\`, if it has none)`);
        else if (d[k] === null && !confirm.has(k) && !(k === 'updatedAsAt' && d.note) && !(k === 'url' && d.derivedFrom) && !d.unarchived) {
          out.push(`revision ${rev.date}: ${d.id}'s ${k} is null with no reason (\`confirm\`, \`note\` or \`unarchived\`)`);
        }
      }
      if (d.sha256 !== null && d.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(d.sha256)) out.push(`revision ${rev.date}: ${d.id}'s sha256 is not 64 hex`);
      if (typeof d.file === 'string' && !isPlainName(d.file)) out.push(`revision ${rev.date}: ${notPlain(`${d.id}'s file`, d.file)}`);
      if (d.text !== undefined) {
        if (!isPlainName(d.text)) out.push(`revision ${rev.date}: ${notPlain(`${d.id}'s text`, d.text)}`);
        if (d.textSha256 !== undefined && !(typeof d.textSha256 === 'string' && /^[0-9a-f]{64}$/.test(d.textSha256))) out.push(`revision ${rev.date}: ${d.id}'s textSha256 is not 64 hex`);
        // A published revision pins every file it archived; a pending one gets it from publish.
        if (d.textSha256 === undefined && a?.sha256 && !d.unarchived) out.push(`revision ${rev.date}: ${d.id}'s text ${d.text} has no textSha256 (npm run sources -- publish writes it)`);
      }
      if (d.builder && (!d.file || !d.sha256)) out.push(`revision ${rev.date}: ${d.id} is a builder input with no file or sha256`);
      if (d.derivedFrom && !(rev.documents ?? []).some((o) => o.id === d.derivedFrom)) out.push(`revision ${rev.date}: ${d.id} is derived from ${d.derivedFrom}, which the revision lacks`);
    }
  }
  const qids = new Set();
  const docs = new Set((latestRevision(m)?.documents ?? []).map((d) => d.id));
  for (const q of m.quotes ?? []) {
    if (!q.id || qids.has(q.id)) out.push(`quote id ${q.id} is missing or repeated`);
    qids.add(q.id);
    if (!q.file || !q.text) out.push(`quote ${q.id} has no file or text`);
    if (!docs.has(q.document)) out.push(`quote ${q.id} names document ${q.document}, which the newest revision lacks`);
  }
  return out;
}

/** The documents whose fields the lead must still confirm, as `id: fields`. @param {Revision} rev */
export const toConfirm = (rev) => rev.documents.filter((d) => d.confirm?.length).map((d) => `${d.id}: ${d.confirm?.join(', ')}`);

// ---------------------------------------------------------------- quotes

/**
 * A text normalised for the verbatim check: typographic quotes and apostrophes as plain ones
 * (the page writes NUS's ' as ’ in places, and ' and " alike as a quote mark), every run of
 * white space as one space (a PDF's text breaks lines where the page doesn't), case kept.
 * @param {string} text
 */
export const normaliseQuote = (text) => text
  .replace(/[‘’ʼ′]/g, "'")
  .replace(/[“”″]/g, '"')
  .replace(/"/g, "'")
  .replace(/[–—]/g, '-')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Whether a quote appears verbatim in a text: after normaliseQuote, and with an ellipsis (…)
 * in the quote standing for words left out, each part in order.
 * @param {string} haystack the document's text, or a code file's
 * @param {string} quote
 */
export function quoteIn(haystack, quote) {
  const hay = normaliseQuote(haystack);
  let at = 0;
  for (const part of quote.split(/\s*(?:…|\.\.\.)\s*/).map(normaliseQuote).filter(Boolean)) {
    const i = hay.indexOf(part, at);
    if (i < 0) return false;
    at = i + part.length;
  }
  return true;
}

/**
 * A JavaScript file's text with string escapes undone (\' \" \\), so a quote matches the
 * sentence it writes rather than its source spelling.
 * @param {string} source
 */
export const unescapeJs = (source) => source.replace(/\\(['"\\`])/g, '$1');

/** Text from HTML: tags dropped, the common entities decoded. @param {string} html */
export function htmlText(html) {
  return decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

/** @param {string} s */
export function decodeEntities(s) {
  /** @type {Record<string, string>} */
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return named[e.toLowerCase()] ?? m;
  });
}
