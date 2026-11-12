#!/usr/bin/env node
// @ts-check
// Two transcriptions of the restrictions PDF, compared (docs/year-refresh/brief-transcription.md).
//
//   node scripts/transcription-diff.mjs <a.json> <b.json>
//       the facts each holds that the other doesn't: (code, pattern or school) × kind × students
//       × levels, and title differences on the same code
//   node scripts/transcription-diff.mjs <new.json> --map-to <last-year.json>
//       proposes last year's rule id for each new rule whose normalised quote matches one of last
//       year's (within the same section and department when the quote alone is ambiguous), and
//       lists the renamed, new and dropped rules for review. Ids then stay stable across years,
//       so the overlay and the register carry over.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * @typedef {{ id: string, section: string, department: string | null, page?: number, kind?: string, students?: string,
 *   quote?: string, scope?: { codes?: { code: string, title?: string }[], patterns?: string[], levels?: number[] | null, school?: string | null } }} TRule
 */

/** @param {TRule} r */
const lv = (r) => (r.scope?.levels ?? []).join('/') || '-';

/** (code | pattern | school, kind, students, levels) → the rules that state it. @param {TRule[]} rs */
export function facts(rs) {
  /** @type {Map<string, string[]>} */
  const m = new Map();
  for (const r of rs) {
    const items = [
      ...(r.scope?.codes ?? []).map((c) => `code:${c.code}`),
      ...(r.scope?.patterns ?? []).map((p) => `pat:${p.toLowerCase().replace(/\s+/g, ' ')}`),
      ...(r.scope?.school ? [`school:${r.scope.school}`] : []),
    ];
    if (!items.length) items.push(`dept:${r.department ?? r.section}`);
    for (const it of items) {
      const k = `${it} | ${r.kind} | ${r.students} | L${lv(r)}`;
      m.set(k, [...(m.get(k) ?? []), `${r.id}@p${r.page}`]);
    }
  }
  return m;
}

/** @param {TRule[]} A @param {TRule[]} B */
export function diffTranscriptions(A, B) {
  const fa = facts(A);
  const fb = facts(B);
  const onlyA = [...fa.keys()].filter((k) => !fb.has(k));
  const onlyB = [...fb.keys()].filter((k) => !fa.has(k));
  /** @param {TRule[]} rs */
  const titles = (rs) => { /** @type {Map<string, string[]>} */ const m = new Map(); for (const r of rs) for (const c of r.scope?.codes ?? []) m.set(c.code, [...(m.get(c.code) ?? []), c.title ?? '']); return m; };
  const ta = titles(A);
  const tb = titles(B);
  const norm = (/** @type {string} */ t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const titleDiffs = [];
  for (const [c, t] of ta) {
    const u = tb.get(c);
    if (u && norm([...new Set(t)].sort().join('|')) !== norm([...new Set(u)].sort().join('|'))) titleDiffs.push({ code: c, a: t, b: u });
  }
  return { shared: [...fa.keys()].filter((k) => fb.has(k)).length, sizeA: fa.size, sizeB: fb.size, onlyA: onlyA.map((k) => ({ fact: k, rules: fa.get(k) })), onlyB: onlyB.map((k) => ({ fact: k, rules: fb.get(k) })), titleDiffs };
}

/** A quote reduced to its words, for matching across transcribers and years. @param {string | undefined} q */
export const normaliseRuleQuote = (q) => (q ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Last year's id for each new rule, by quote.
 * @param {TRule[]} last last year's transcription's rules
 * @param {TRule[]} next the new transcription's rules
 */
export function mapIds(last, next) {
  const where = (/** @type {TRule} */ r) => `${r.section}|${r.department ?? ''}`;
  /** @type {Map<string, TRule[]>} */
  const byQuote = new Map();
  for (const r of last) {
    const q = normaliseRuleQuote(r.quote);
    byQuote.set(q, [...(byQuote.get(q) ?? []), r]);
  }
  const used = new Set();
  /** @type {{ id: string, lastId: string }[]} */
  const kept = [];
  /** @type {{ from: string, to: string }[]} */
  const renamed = [];
  /** @type {{ id: string, candidates: string[] }[]} */
  const ambiguous = [];
  /** @type {string[]} */
  const added = [];
  for (const r of next) {
    let hits = byQuote.get(normaliseRuleQuote(r.quote)) ?? [];
    if (hits.length > 1) hits = hits.filter((h) => where(h) === where(r));
    hits = hits.filter((h) => !used.has(h.id));
    if (hits.length === 1) {
      used.add(hits[0].id);
      if (hits[0].id === r.id) kept.push({ id: r.id, lastId: hits[0].id });
      else renamed.push({ from: r.id, to: hits[0].id });
    } else if (hits.length > 1) ambiguous.push({ id: r.id, candidates: hits.map((h) => h.id) });
    else added.push(r.id);
  }
  const ambiguousIds = new Set(ambiguous.flatMap((a) => a.candidates));
  const dropped = last.filter((r) => !used.has(r.id) && !ambiguousIds.has(r.id)).map((r) => r.id);
  return { kept, renamed, ambiguous, added, dropped };
}

/** @param {string} path @returns {TRule[]} */
const rulesOf = (path) => JSON.parse(readFileSync(path, 'utf8')).rules;

/** @param {string[]} argv @param {{ log?: (m: string) => void }} [o] */
export function main(argv, { log = console.log } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { 'map-to': { type: 'string' }, json: { type: 'boolean' } } });
  if (values['map-to'] && positionals.length === 1) {
    const r = mapIds(rulesOf(values['map-to']), rulesOf(positionals[0]));
    if (values.json) { log(JSON.stringify(r, null, 1)); return 0; }
    log(`kept ${r.kept.length}, renamed ${r.renamed.length}, ambiguous ${r.ambiguous.length}, new ${r.added.length}, dropped ${r.dropped.length}`);
    log(`\n== rename to last year's id (${r.renamed.length})`); for (const x of r.renamed) log(`${x.from} -> ${x.to}`);
    log(`\n== ambiguous: pick by hand (${r.ambiguous.length})`); for (const x of r.ambiguous) log(`${x.id}: ${x.candidates.join(' | ')}`);
    log(`\n== new: no matching quote last year (${r.added.length})`); for (const x of r.added) log(x);
    log(`\n== dropped: last year's, with no match now (${r.dropped.length})`); for (const x of r.dropped) log(x);
    return 0;
  }
  if (positionals.length !== 2) { log('usage: node scripts/transcription-diff.mjs <a.json> <b.json> | <new.json> --map-to <last-year.json> [--json]'); return 2; }
  const d = diffTranscriptions(rulesOf(positionals[0]), rulesOf(positionals[1]));
  if (values.json) { log(JSON.stringify(d, null, 1)); return 0; }
  log(`facts A ${d.sizeA}, B ${d.sizeB}, shared ${d.shared}`);
  log(`\n== only A (${d.onlyA.length})`); for (const k of d.onlyA) log(`${k.fact} ${k.rules?.join(',')}`);
  log(`\n== only B (${d.onlyB.length})`); for (const k of d.onlyB) log(`${k.fact} ${k.rules?.join(',')}`);
  log('\n== title differences'); for (const t of d.titleDiffs) log(`${t.code} ${JSON.stringify(t.a)} vs ${JSON.stringify(t.b)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
