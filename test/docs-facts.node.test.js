// @ts-check
// Phase 8 8A, SC10 (docs/plans/phase8.md §2 8A, ADR 0012): README.md, EVAL.md and
// docs/REFERENCE.md describe the system as it is.
//
// - Facts that change only by a deliberate act are checked against their source: holdout and
//   test-set looks (eval/holdout-ledger.md), SC5's Δ and CI (docs/evidence/phase3/sc5.md), the
//   dev qrels label and size (eval/dev/qrels.json), the year in sentences marked
//   `<!-- year:live -->` (DEFAULT_ACAD_YEAR) or `<!-- year:pinned -->` (PINNED_ACAD_YEAR), and
//   the NG list's counts in those sentences (data/ or eval/pinned/).
// - Volatile values (corpus counts and sizes, the ng-unscheduled count, the shipped pin's sha)
//   are written as pointers to their files: a `<!-- pointer -->` sentence holds no number.
// - Retired claims appear nowhere outside a section headed "History".
// - The commands the docs give exist and run as written.
//
// Text is compared after collapsing whitespace and stripping quote markers, so a phrase split
// across lines still matches. Markers go at the start of the sentence they mark; the sentence runs
// to its full stop, the end of its paragraph, list item or table cell, or the next marker.
//
// This file is year-scanned (it reads year-named NG files): it derives every year and spells none.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHIPPED_BASELINE } from '../eval/lib/baseline.mjs';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';
import { PINNED_ACAD_YEAR } from '../scripts/pinned-corpus.mjs';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** The three SC10 docs. */
const DOCS = /** @type {const} */ (['README.md', 'EVAL.md', 'docs/REFERENCE.md']);

const collapse = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();

/**
 * @typedef {{ text: string, history: boolean, fence: boolean }} Block
 * A paragraph, list item, table row, heading or (one per line) fenced code line, its whitespace
 * collapsed; `history` when it sits under a heading containing "History".
 */

/**
 * @param {string} md
 * @returns {Block[]}
 */
export function blocks(md) {
  /** @type {Block[]} */
  const out = [];
  /** @type {{ level: number, history: boolean }[]} */
  const headings = [];
  const inHistory = () => headings.some((h) => h.history);
  /** @type {string[]} */
  let cur = [];
  let fence = false;
  const flush = () => {
    if (cur.length) out.push({ text: collapse(cur.join(' ')), history: inHistory(), fence: false });
    cur = [];
  };
  for (const raw of md.split('\n')) {
    if (/^\s*```/.test(raw)) { flush(); fence = !fence; continue; }
    if (fence) { out.push({ text: raw, history: inHistory(), fence: true }); continue; }
    const line = raw.replace(/^(?:\s*>\s?)+/, '');
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      while (headings.length && /** @type {{ level: number }} */ (headings.at(-1)).level >= level) headings.pop();
      headings.push({ level, history: /\bhistory\b/i.test(h[2]) });
      out.push({ text: collapse(h[2]), history: inHistory(), fence: false });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line) || /^\s*\|/.test(line)) flush();
    cur.push(line);
    if (/^\s*\|/.test(line)) flush();
  }
  flush();
  return out;
}

/** The text of a doc outside "History" sections, whitespace collapsed. */
const current = (/** @type {string} */ md) => blocks(md).filter((b) => !b.history).map((b) => collapse(b.text)).join(' \n ');

const MARKER = /<!--\s*(year:live|year:pinned|pointer)\s*-->/g;

/**
 * The sentences each marker starts, with the marker's kind.
 * @param {string} md
 * @returns {{ kind: string, text: string }[]}
 */
export function marked(md) {
  const out = [];
  for (const b of blocks(md)) {
    if (b.fence) continue;
    for (const m of b.text.matchAll(MARKER)) {
      const rest = b.text.slice(/** @type {number} */ (m.index) + m[0].length);
      const next = rest.search(/<!--|\s\|/);
      const span = next === -1 ? rest : rest.slice(0, next);
      const end = /[.!?](?=\s+[A-Z(*`"_[]|\s*$)/.exec(span);
      out.push({ kind: m[1], text: (end ? span.slice(0, end.index + 1) : span).trim() });
    }
  }
  return out;
}

/** Prose only: code spans and link targets removed. */
const prose = (/** @type {string} */ s) => s.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');

/**
 * Every year in a marked sentence must be `year` (an acad year `yyyy-yyyy`): a span such as
 * yyyy/yy, yyyy/yyyy or AYyyyy/yyyy must be the whole year, a lone year one of its two.
 * Identifiers in code spans are not read.
 * @param {{ kind: string, text: string }[]} sentences
 * @param {string} year
 * @returns {string[]}
 */
export function yearProblems(sentences, year) {
  const [from, to] = year.split('-');
  const problems = [];
  for (const s of sentences) {
    const text = prose(s.text);
    const found = [...text.matchAll(/(?<!\d)(\d{4})(?:\s*[/–-]\s*(\d{4}|\d{2})(?!\d))?(?!\d)/g)].filter((m) => m[1].startsWith('2'));
    if (found.length === 0) problems.push(`${s.kind}: no year in "${s.text}"`);
    for (const m of found) {
      const ok = m[2] === undefined
        ? m[1] === from || m[1] === to
        : m[1] === from && (m[2].length === 2 ? `${m[1].slice(0, 2)}${m[2]}` : m[2]) === to;
      if (!ok) problems.push(`${s.kind}: "${m[0]}" is not ${year} in "${s.text}"`);
    }
  }
  return problems;
}

const num = (/** @type {string} */ s) => Number(s.replace(/,/g, ''));

/**
 * The NG list's counts a marked sentence states, against the list: "N codes for Sem S" and
 * "N codes in all" (or "N course codes in the PDF").
 * @param {{ kind: string, text: string }[]} sentences
 * @param {{ semesters: Record<string, string[]>, allCodes: string[] }} list
 * @returns {{ checked: number, problems: string[] }}
 */
export function ngProblems(sentences, list) {
  const problems = [];
  let checked = 0;
  for (const s of sentences) {
    const text = prose(s.text);
    for (const m of text.matchAll(/(\d[\d,]*) (?:(?:course )?codes? )?for Sem ([12])\b/g)) {
      checked++;
      const want = list.semesters[m[2]]?.length;
      if (num(m[1]) !== want) problems.push(`"${m[0]}": the list has ${want} for Sem ${m[2]}, in "${s.text}"`);
    }
    for (const m of text.matchAll(/(\d[\d,]*) (?:course )?codes (?:in all|in the PDF)/g)) {
      checked++;
      if (num(m[1]) !== list.allCodes.length) problems.push(`"${m[0]}": the list has ${list.allCodes.length} codes, in "${s.text}"`);
    }
  }
  return { checked, problems };
}

/** The next acad year after `year`, for the stubbed-year checks. */
const nextYear = (/** @type {string} */ year) => year.split('-').map((y) => String(Number(y) + 1)).join('-');

const docs = Object.fromEntries(DOCS.map((d) => [d, read(d)]));
const sentencesOf = (/** @type {string} */ doc, /** @type {string} */ kind) => marked(docs[doc]).filter((s) => s.kind === kind);
const allMarked = (/** @type {string} */ kind) => DOCS.flatMap((d) => sentencesOf(d, kind));

describe('the parsing this file relies on', () => {
  it('collapses whitespace and quote markers, so a phrase split across lines matches', () => {
    expect(current('> the vector half does not\n> currently earn its keep')).toContain('does not currently earn its keep');
  });
  it('drops sections headed History, down to the next heading of the same level', () => {
    const md = '# A\nkept one\n## History: v1\ndropped\n### deeper\ndropped too\n## B\nkept two';
    expect(current(md)).toContain('kept one');
    expect(current(md)).toContain('kept two');
    expect(current(md)).not.toContain('dropped');
  });
  it('takes a marked sentence to its full stop, the next marker or the table cell', () => {
    const ay = `AY${DEFAULT_ACAD_YEAR.slice(0, 4)}/${DEFAULT_ACAD_YEAR.slice(7)}`;
    const md = `Before. <!-- year:live --> It serves ${ay}, e.g. now. After ${nextYear(nextYear(DEFAULT_ACAD_YEAR))}.\n\n| a | <!-- pointer --> see \`x\` | 9 |`;
    expect(marked(md)).toEqual([{ kind: 'year:live', text: `It serves ${ay}, e.g. now.` }, { kind: 'pointer', text: 'see `x`' }]);
    expect(yearProblems(marked(md).slice(0, 1), DEFAULT_ACAD_YEAR)).toEqual([]);
  });
});

describe('deliberate facts against their sources', () => {
  const ledger = read('eval/holdout-ledger.md');
  const limits = /`holdout` max (\d+), `test` max (\d+)/.exec(ledger);
  const rows = ledger.split('\n').filter((l) => /^\|\s*\d{4}-\d\d-\d\d\s*\|/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
  const looks = (/** @type {string} */ set) => rows.filter((r) => r[2] === set).length;

  it('EVAL.md states the holdout and test-set looks the ledger records, against their limits', () => {
    expect(limits).not.toBeNull();
    const [, holdoutMax, testMax] = /** @type {RegExpExecArray} */ (limits);
    const text = current(docs['EVAL.md']);
    expect(text).toContain(`${looks('holdout')} of ${holdoutMax} holdout looks`);
    expect(text).toContain(`${looks('test')} of ${testMax} test-set look`);
    for (const doc of DOCS) {
      for (const m of current(docs[doc]).matchAll(/(\d+) of (\d+) (holdout|test-set) looks?/g)) {
        expect(`${doc}: ${m[0]}`).toBe(`${doc}: ${m[3] === 'holdout' ? `${looks('holdout')} of ${holdoutMax}` : `${looks('test')} of ${testMax}`} ${m[3]} look${m[0].endsWith('looks') ? 's' : ''}`);
      }
    }
  });

  it('README and EVAL.md state SC5\'s Δ and CI as the evidence and the ledger\'s test row do', () => {
    const sc5 = /\*\*filtered \(the SC5 set\)\*\* \| (\d+) \| \*\*([+-][\d.]+) \[([\d.]+), ([\d.]+)\]\*\* \| \*\*([+-][\d.]+) \[([\d.]+), ([\d.]+)\]\*\*/.exec(read('docs/evidence/phase3/sc5.md'));
    expect(sc5).not.toBeNull();
    const [, n, nd, nlo, nhi, pd, plo, phi] = /** @type {RegExpExecArray} */ (sc5);
    const testRow = rows.find((r) => r[2] === 'test');
    expect(testRow?.[7]).toBe(`${nd} [${nlo}, ${nhi}]`);
    expect(testRow?.[8]).toBe(`${pd} [${plo}, ${phi}]`);
    const evalText = current(docs['EVAL.md']);
    expect(evalText).toContain(`${nd} [${nlo}, ${nhi}]`);
    expect(evalText).toContain(`${pd} [${plo}, ${phi}]`);
    expect(evalText).toContain(`n = ${n}`);
    const readme = current(docs['README.md']);
    expect(readme).toContain(`**${nd}** (95% CI ${nlo} to ${nhi})`);
    expect(readme).toContain(`${n} queries`);
  });

  it('EVAL.md names the dev qrels eval/dev/qrels.json holds, and their size, outside its History', () => {
    const qrels = JSON.parse(read('eval/dev/qrels.json'));
    const pairs = Object.values(/** @type {Record<string, { judgments: object }>} */ (qrels.queries))
      .reduce((n, q) => n + Object.keys(q.judgments).length, 0);
    const text = current(docs['EVAL.md']);
    const labels = [...text.matchAll(/qrels-dev-v\d+/g)].map((m) => m[0]);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels)).toEqual(new Set([qrels.version]));
    const sizes = [...text.matchAll(/qrels-dev-v\d+`?,? ([\d,]+) pairs/g)].map((m) => num(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBe(pairs);
  });

  it('every <!-- year:live --> sentence states DEFAULT_ACAD_YEAR; README and REFERENCE.md have one', () => {
    expect(sentencesOf('README.md', 'year:live').length).toBeGreaterThan(0);
    expect(sentencesOf('docs/REFERENCE.md', 'year:live').length).toBeGreaterThan(0);
    expect(yearProblems(allMarked('year:live'), DEFAULT_ACAD_YEAR)).toEqual([]);
  });

  it('every <!-- year:pinned --> sentence states PINNED_ACAD_YEAR; EVAL.md and REFERENCE.md have one', () => {
    expect(sentencesOf('EVAL.md', 'year:pinned').length).toBeGreaterThan(0);
    expect(sentencesOf('docs/REFERENCE.md', 'year:pinned').length).toBeGreaterThan(0);
    expect(yearProblems(allMarked('year:pinned'), PINNED_ACAD_YEAR)).toEqual([]);
  });

  it('the year checks fail with the year stubbed to the next one', () => {
    expect(yearProblems(allMarked('year:live'), nextYear(DEFAULT_ACAD_YEAR)).length).toBeGreaterThan(0);
    expect(yearProblems(allMarked('year:pinned'), nextYear(PINNED_ACAD_YEAR)).length).toBeGreaterThan(0);
    expect(yearProblems([{ kind: 'year:live', text: 'No year here.' }], DEFAULT_ACAD_YEAR)).toHaveLength(1);
  });

  it('EVAL.md calls the live and pinned NG lists identical only while they are byte for byte', () => {
    const live = read(`data/ng-courses-${DEFAULT_ACAD_YEAR}.json`);
    const pinned = read(`eval/pinned/ng-courses-${PINNED_ACAD_YEAR}.json`);
    expect(current(docs['EVAL.md']).includes('identical today')).toBe(live === pinned);
  });

  it('the NG list\'s counts in marked sentences are the list\'s: data/ for live, eval/pinned/ for pinned', () => {
    const live = ngProblems(allMarked('year:live'), JSON.parse(read(`data/ng-courses-${DEFAULT_ACAD_YEAR}.json`)));
    const pinned = ngProblems(allMarked('year:pinned'), JSON.parse(read(`eval/pinned/ng-courses-${PINNED_ACAD_YEAR}.json`)));
    expect(live.problems).toEqual([]);
    expect(pinned.problems).toEqual([]);
    expect(live.checked).toBeGreaterThan(0);
    expect(pinned.checked).toBeGreaterThan(0);
    // And the check can fail.
    expect(ngProblems([{ kind: 'year:live', text: '1 code for Sem 1.' }], { semesters: { 1: ['A', 'B'] }, allCodes: [] }).problems).toHaveLength(1);
  });
});

describe('volatile values are pointers, never stated', () => {
  it('a <!-- pointer --> sentence holds no number outside code spans and link targets', () => {
    const bad = DOCS.flatMap((d) => sentencesOf(d, 'pointer').filter((s) => /\d/.test(prose(s.text))).map((s) => `${d}: ${s.text}`));
    expect(bad).toEqual([]);
  });

  it('the bundle, the ng-unscheduled count, the standby and the shipped pin each have a pointer', () => {
    const names = (/** @type {string} */ doc) => sentencesOf(doc, 'pointer').map((s) => s.text).join(' ');
    expect(names('README.md')).toContain('data/vectors.json');
    expect(names('EVAL.md')).toContain('eval/lib/baseline.mjs');
    for (const file of ['data/vectors.json', 'data/ng-unscheduled.json', 'eval/lib/baseline.mjs']) {
      expect(names('docs/REFERENCE.md')).toContain(file);
    }
  });

  it('the README gives no bundle size and README and EVAL.md never spell the shipped pin', () => {
    expect(current(docs['README.md'])).not.toMatch(/\d(?:\.\d+)?\s*MB\b/);
    const pin = SHIPPED_BASELINE.sha.slice(0, 7);
    expect(docs['README.md']).not.toContain(pin);
    expect(docs['EVAL.md']).not.toContain(pin);
  });
});

describe('retired claims', () => {
  const RETIRED = [
    'Exchange Course Finder',
    'vector half is unproven',
    'does not currently earn its keep',
    'not pulling its weight',
    'until midnight UTC',
    'No look has been taken',
    'Vectorize search is approximate',
    'year of study at home',
    'Headers and IPs are never logged',
  ];
  for (const doc of DOCS) {
    it(`${doc} makes none of them outside a History section`, () => {
      const text = current(docs[doc]).toLowerCase();
      expect(RETIRED.filter((c) => text.includes(c.toLowerCase()))).toEqual([]);
    });
  }
});

describe('commands run as written', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  it('every `npm run <x>` in the README is a package.json script', () => {
    const named = [...docs['README.md'].matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !Object.hasOwn(scripts, n))).toEqual([]);
  });

  it('the README installs Playwright\'s browsers before `npm run test:ui`', () => {
    const install = docs['README.md'].indexOf('npx playwright install');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(docs['README.md'].indexOf('npm run test:ui'));
  });

  it('every eval command with `--ref eval-v0` also passes eval-v0\'s own corpus embedding', () => {
    const manifest = JSON.parse(read('eval/embeddings.json'));
    const v0 = Object.entries(/** @type {Record<string, { textRef: string }>} */ (manifest.versions)).filter(([, v]) => v.textRef === 'eval-v0').map(([k]) => k);
    expect(v0).toHaveLength(1);
    // The runner refuses a v0 ranker on the default (later) embedding.
    expect(manifest.default).not.toBe(v0[0]);
    const bad = [];
    let seen = 0;
    for (const doc of [...DOCS, 'eval/README.md']) {
      for (const line of read(doc).split('\n')) {
        if (!/--ref eval-v0\b/.test(line) || !/npm run eval\b|eval\/cli\.mjs/.test(line)) continue;
        seen++;
        if (!line.includes(`--embedding ${v0[0]}`)) bad.push(`${doc}: ${line.trim()}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
