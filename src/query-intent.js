// @ts-check
// The query parse (docs/plans/phase3.md 3B, docs/plans/phase3-prereg.md §3 and
// §4 "The `interpreted` schema"): one order for every query, from the
// canonical text to the routes /search takes and the `interpreted` echo. Pure:
// the corpus data and the offered-code lookup come in through an
// IntentContext (src/intent-data.js builds the Worker's), so Node tests run
// it as it is.
//
// The parse order (prereg §3):
//   1. canonical q                                         canonicalQuery
//   2. 3G's vocabulary test on the pre-correction tokens    seam: `tokens` exposed
//   3. 3C's correction of df-0 letter-only tokens           src/typo.js correctQuery
//   4. intent pass A: the 3H phrases, stripped before joins seam: no phrases
//   5. code joins                                           joinCodes
//   6. code resolution                                      resolve
//   7. intent pass B: the GE phrases and the 3D level phrases  passB
//
// 3B sets `pin`, `prefix`, `ge`, and `level` through an `XX N000` code token;
// 3D sets `level` from its phrases. The other keys stay null until 3H fills
// them. Steps 4–7 read the corrected text; 3C's corrections are not echoed in
// `interpreted`.
import { queryTokens } from './fts-query.js';
import { correctQuery } from './typo.js';

/** The `interpreted` keys, in order (prereg §4). */
export const INTERPRETED_KEYS = Object.freeze(['pin', 'prefix', 'ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);
/** The intents `ignore=` can undo (plan §2 "Response cache key"; 3B, 3D, 3H). */
export const IGNORABLE_INTENTS = Object.freeze(['ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);
/** Resolution step 1 pins at most this many offered codes, in query order. */
export const MAX_PINS = 3;

/**
 * @typedef {[string, string]} CodeRange A primary-key range [lo, hi) over codes.
 * @typedef {{ min: number, max: number | null }} LevelWindow
 * @typedef {{
 *   pin: string[] | null, prefix: string | null, ge: string[] | null,
 *   level: { min: number, max: number | null, source: string[] } | null,
 *   exam: number | null, su: { value: number, basis: string[] } | null, hoursBelow: number | null,
 *   prereq: { value: string, semantics: string } | null,
 * }} Interpreted
 * @typedef {{ reason: 'not-offered' | 'unknown-code', code: string }} NoMatch
 * @typedef {{
 *   q: string, lexical: string, dense: string, interpreted: Interpreted,
 *   kind: 'search' | 'mask' | 'no-match',
 *   pins: string[], ranges: CodeRange[] | null, codeList: CodeRange[] | null,
 *   level: LevelWindow | null, beginner: boolean, noMatch: NoMatch | null,
 *   tokens: string[], corrected: string | null, fts: import('./fts-query.js').FtsTerms,
 * }} ParsedQuery
 *   - `kind` 'mask': a whole-query partial code, bare prefix, `XX N000` or GE
 *     phrase. The results are the members of `ranges` (∩ `level`, ∩ the
 *     filters), ordered by exact dense score, or by code without the dense half.
 *   - `kind` 'search': the fused retrieval. `ranges`, when set, is the GE
 *     pre-retrieval mask on both halves; `codeList` the third RRF list's
 *     members; `level` a filter on everything.
 *   - `beginner`: a beginner phrase is among the level windows, so 3D's α
 *     prior applies (src/level-prior.js).
 *   - `kind` 'no-match': `count: 0` with `noMatch`.
 *   - `lexical`: the text the FTS half searches (corrected, GE and level
 *     phrases stripped), with `fts` its 3C prefix terms and corrections; `dense` the
 *     text the dense half embeds (the canonical q, raw); `corrected` the
 *     canonical q with 3C's corrections (null when there are none), which
 *     3C-2 also embeds.
 *   - `tokens`: the pre-correction tokens, for 3G's vocabulary test.
 * @typedef {{ prefixes: string[], genericPhrases: string[], pillars: { name: string, prefixes: string[] }[] }} GeTable
 * @typedef {{
 *   prefixes: Set<string>, catalogue: Set<string>, collision: Set<string>, stopwords: Set<string>,
 *   ge: GeTable, gePhrases: { re: RegExp, prefixes: string[] }[], isOffered: (code: string) => boolean,
 *   vocabulary: import('./vocabulary.js').Vocabulary | null,
 *   levelPhrases: LevelPhrase[] | null, negators: Set<string>, negationWindow: number,
 * }} IntentContext Upper-case prefixes, codes and collision entries; lower-case stopwords;
 *   the corpus vocabulary 3C corrects against (null: no correction); 3D's level
 *   phrases (null: the rules are off and no phrase is read).
 * @typedef {{ re: RegExp, window: (n: number) => { min: number, max: number | null, source: string } }} LevelPhrase
 * @typedef {{
 *   negators: string[], negationWindow: number,
 *   level: Record<string, { phrases: string[], window: { min: number | 'N', max: number | 'N' | null }, N?: Record<string, number> } | string>,
 * }} LevelTable data/level-phrases.json, from eval/prereg/intent-phrases.json
 */

/**
 * Step 1, the canonical q every later stage sees and the cache key holds:
 * trimmed by the caller, runs of whitespace collapsed to one space, ASCII
 * letters lower-cased. Only ASCII: full Unicode lower-casing maps the Kelvin
 * sign (U+212A) to `k`, which would make a code match that the raw query
 * never matched. Neither retriever can tell the difference: the FTS tokeniser
 * lower-cases and splits on non-word characters, and bge-small-en-v1.5 is an
 * uncased model.
 * @param {string} trimmed
 */
export const canonicalQuery = (trimmed) => trimmed.replace(/\s+/g, ' ').replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * The primary-key range of a partial code P (C3-4): from P (P + '0' when P is
 * letters only) up to, not including, P + ':', ':' being the character after
 * '9'. Every code has digits after its letters, so a bare prefix never takes
 * in a longer one: `CS` excludes CSA6101, `GES` excludes GESS1000.
 * @param {string} p upper-case
 * @returns {CodeRange}
 */
export const codeRange = (p) => [/\d$/.test(p) ? p : `${p}0`, `${p}:`];

/**
 * `ignore=` as a sorted, de-duplicated list of intent names, or an error
 * naming the unknown ones.
 * @param {string | null | undefined} raw
 * @returns {{ ignore: string[], error?: undefined } | { error: string, ignore?: undefined }}
 */
export function parseIgnore(raw) {
  const names = [...new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))].sort();
  const unknown = names.filter((n) => !IGNORABLE_INTENTS.includes(n));
  if (unknown.length) return { error: `Unknown ignore intent${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}; expected any of ${IGNORABLE_INTENTS.join(', ')}.` };
  return { ignore: names };
}

/**
 * A phrase as a regex (prereg §5 "Matching"): bounded by no [a-z0-9] on either
 * side, a space matching a run of whitespace or '-', every other character
 * literal. With `n`, the placeholder `N` captures one digit 1–9 (a level).
 * @param {string} phrase
 * @param {boolean} [n]
 */
const phraseRegex = (phrase, n = false) => new RegExp(`(?<![a-z0-9])${phrase.split(n ? /(N)/ : /(?!)/)
  .map((p) => (n && p === 'N' ? '([1-9])' : p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '[\\s-]+')))
  .join('')}(?![a-z0-9])`, 'g');

/**
 * 3D's level phrases as regexes with the window each sets (prereg §5): a
 * beginner, graduate or year phrase its fixed window (year N from its table),
 * a level-N phrase N..N.
 * @param {LevelTable} table
 * @returns {LevelPhrase[]}
 */
function compileLevel(table) {
  /** @type {LevelPhrase[]} */
  const out = [];
  const source = /** @type {Record<string, string>} */ ({ beginner: 'beginner', graduate: 'graduate', levelN: 'level', year: 'year' });
  for (const [kind, l] of Object.entries(table.level)) {
    // `union` and `interpreted` are prose entries, not phrase lists.
    if (!l || typeof l !== 'object' || !Array.isArray(l.phrases)) continue;
    if (!(kind in source)) throw new Error(`unknown level kind ${kind}`);
    for (const phrase of l.phrases) {
      const fixed = l.N?.[phrase];
      /** @param {number | 'N' | null} v @param {number} n */
      const at = (v, n) => (v === 'N' ? fixed ?? n : v);
      out.push({
        re: phraseRegex(phrase, kind === 'levelN'),
        window: (n) => ({ min: /** @type {number} */ (at(l.window.min, n)), max: at(l.window.max, n), source: source[kind] }),
      });
    }
  }
  return out;
}

/**
 * @param {{
 *   prefixes: Iterable<string>, catalogueCodes: Iterable<string>, collision: Iterable<string>,
 *   ge: GeTable, stopwords: Iterable<string>, isOffered: (code: string) => boolean,
 *   vocabulary?: import('./vocabulary.js').Vocabulary | null, level?: LevelTable | null,
 * }} data
 * @returns {IntentContext}
 */
export function buildIntentContext({ prefixes, catalogueCodes, collision, ge, stopwords, isOffered, vocabulary = null, level = null }) {
  return {
    prefixes: new Set(prefixes),
    catalogue: new Set(catalogueCodes),
    collision: new Set(collision),
    stopwords: new Set(stopwords),
    ge,
    gePhrases: [
      ...ge.genericPhrases.map((p) => ({ re: phraseRegex(p), prefixes: ge.prefixes })),
      ...ge.pillars.map((p) => ({ re: phraseRegex(p.name), prefixes: p.prefixes })),
    ],
    isOffered,
    vocabulary,
    levelPhrases: level ? compileLevel(level) : null,
    negators: new Set(level?.negators ?? []),
    negationWindow: level?.negationWindow ?? 0,
  };
}

const FULL_CODE = /^([a-z]{1,4})(\d{4})([a-z0-9]{0,5})$/;
const PARTIAL_CODE = /^([a-z]{2,4})(\d{1,3})$/;
const LETTERS = /^[a-z]{1,4}$/;
const N000 = /^[A-Z]+([1-9])000$/;
/** A word without the punctuation around it (`cs32?` → `cs32`); internal characters stay (`s/u`). */
const core = (/** @type {string} */ w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
/**
 * A suffix word's letters (1–2), or null. Trailing punctuation is allowed
 * (`s?`, `s.`); `/` or `-` right after the letters is not (`s/u`, `s-u`).
 * @param {string} w the word as typed
 */
const suffixOf = (w) => /^([a-z]{1,2})(?:[^a-z0-9/-][^/-]*)?$/.exec(w)?.[1] ?? null;

/**
 * @typedef {{ text: string, from: number, to: number, joined: boolean }} Token
 *   One word, or several joined (`cs 1010s`), over words [from, to].
 */

/**
 * Step 5, the code joins (prereg §3 "Code joins"), on the words of what pass A
 * left. A join is made only when its result is usable:
 * - letters on the collision list or the stopword list in force join with
 *   digits only when letters + digits (+ a suffix word) are the whole query
 *   and the joined code is offered or catalogue-only (`ee 2211`, `me 3000`);
 * - other known prefixes join with 4 digits (and a suffix: `cs 1010s`) or 1–3
 *   digits (`cs 32`), anywhere;
 * - a code joins a following 1–2-letter word only into an offered or
 *   catalogue-only code, never across `/` or `-` (`cs1231 s/u` keeps CS1231).
 * @param {string[]} words
 * @param {IntentContext} ctx
 * @returns {Token[]}
 */
function joinCodes(words, ctx) {
  const known = (/** @type {string} */ c) => ctx.isOffered(c.toUpperCase()) || ctx.catalogue.has(c.toUpperCase());
  const n = words.length;
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  while (i < n) {
    const w = core(words[i]);
    /** @type {Token} */
    let tok = { text: w, from: i, to: i, joined: false };
    if (LETTERS.test(w) && ctx.prefixes.has(w.toUpperCase()) && i + 1 < n) {
      const d = core(words[i + 1]);
      if (ctx.collision.has(w.toUpperCase()) || ctx.stopwords.has(w)) {
        const s = n === 3 ? suffixOf(words[2]) : null;
        if (n === 2 && /^\d{4}[a-z0-9]{0,5}$/.test(d) && known(w + d)) tok = { text: w + d, from: 0, to: 1, joined: true };
        else if (s !== null && /^\d{4}$/.test(d) && known(w + d + s)) tok = { text: w + d + s, from: 0, to: 2, joined: true };
      } else if (/^(\d{1,3}|\d{4}[a-z0-9]{0,5})$/.test(d)) {
        tok = { text: w + d, from: i, to: i + 1, joined: true };
      }
    }
    // Suffix join: the next word as typed, so `s/u` and `s-u` never join.
    const next = tok.to + 1 < n ? suffixOf(words[tok.to + 1]) : null;
    if (next !== null && FULL_CODE.test(tok.text) && known(tok.text + next)) {
      tok = { text: tok.text + next, from: tok.from, to: tok.to + 1, joined: true };
    }
    out.push(tok);
    i = tok.to + 1;
  }
  return out;
}

/**
 * Step 4, intent pass A: the 3H phrases (no exam, S/U, workload,
 * prerequisite), matched and stripped from the lexical query before any join.
 * A seam until 3H: it strips nothing and sets nothing.
 * @param {string} q
 * @returns {{ text: string }}
 */
const intentPassA = (q) => ({ text: q });

/**
 * Step 7, intent pass B (prereg §3 step 7, §5 "Matching"): the GE phrases and
 * 3D's level phrases on the text the joins left, leftmost-longest and
 * non-overlapping across both lists. A joined token's words are masked, so
 * `ge 2101` is Geography's code, never the GE intent. Lead decision (PR #44):
 * `ge` directly followed by a token that starts with a digit is not a GE
 * phrase either, joined or not (`ge 2101 workload`): it stays text, as a
 * collision-list code inside a longer query does (plan 3B). A level phrase
 * with a negator among the two tokens before it sets nothing and stays in the
 * text (C17); the tokens are counted on the unmasked text, as queryTokens
 * splits it. An ignored intent's phrases are not read at all.
 * @param {string} masked the text with each resolved joined code masked
 * @param {string} plain the same text unmasked (the same offsets)
 * @param {IntentContext} ctx
 * @param {Set<string>} ignored
 * @returns {{ pillars: Set<string>, windows: { min: number, max: number | null, source: string }[], strip: [number, number][] }}
 */
function passB(masked, plain, ctx, ignored) {
  /** @type {{ start: number, end: number, prefixes?: string[], window?: { min: number, max: number | null, source: string } }[]} */
  const all = [];
  if (!ignored.has('ge')) {
    for (const { re, prefixes } of ctx.gePhrases) {
      for (const m of masked.matchAll(re)) {
        const start = /** @type {number} */ (m.index);
        if (m[0] === 'ge' && /^[^a-z0-9]+\d/.test(masked.slice(start + 2))) continue;
        all.push({ start, end: start + m[0].length, prefixes });
      }
    }
  }
  if (ctx.levelPhrases && !ignored.has('level')) {
    for (const { re, window } of ctx.levelPhrases) {
      for (const m of masked.matchAll(re)) {
        const start = /** @type {number} */ (m.index);
        all.push({ start, end: start + m[0].length, window: window(Number(m[1])) });
      }
    }
  }
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  /** @type {Set<string>} */
  const pillars = new Set();
  /** @type {{ min: number, max: number | null, source: string }[]} */
  const windows = [];
  /** @type {[number, number][]} */
  const strip = [];
  let at = 0;
  for (const m of all) {
    if (m.start < at) continue;
    at = m.end;
    if (m.window) {
      const before = queryTokens(plain.slice(0, m.start)).slice(-ctx.negationWindow);
      if (before.some((t) => ctx.negators.has(t))) continue;
      windows.push(m.window);
    } else {
      for (const p of /** @type {string[]} */ (m.prefixes)) pillars.add(p);
    }
    strip.push([m.start, m.end]);
  }
  return { pillars, windows, strip };
}

/** @returns {Interpreted} */
const emptyInterpreted = () => ({ pin: null, prefix: null, ge: null, level: null, exam: null, su: null, hoursBelow: null, prereq: null });

/**
 * The parse of a canonical query (steps 2–7).
 * @param {string} q the canonical q (canonicalQuery)
 * @param {IntentContext} ctx
 * @param {readonly string[]} [ignore] intents to undo (parseIgnore)
 * @returns {ParsedQuery}
 */
export function parseQuery(q, ctx, ignore = []) {
  const ignored = new Set(ignore);
  const interpreted = emptyInterpreted();
  /** @type {ParsedQuery} */
  const parsed = {
    q, lexical: q, dense: q, interpreted, kind: 'search', pins: [], ranges: null, codeList: null, level: null, beginner: false, noMatch: null,
    tokens: [], corrected: null, fts: { prefixes: [], corrections: [] },
  };

  // Step 2: 3G's vocabulary test (a seam) reads the pre-correction tokens.
  // Step 3: 3C's correction; every later step reads the corrected text.
  const c = ctx.vocabulary ? correctQuery(q, ctx.vocabulary) : { tokens: queryTokens(q), text: q, prefixes: [], corrections: [] };
  parsed.tokens = c.tokens;
  parsed.corrected = c.text === q ? null : c.text;
  parsed.fts = { prefixes: c.prefixes, corrections: c.corrections };
  parsed.lexical = c.text;
  // Step 4: a seam (3H).
  const rest = intentPassA(c.text).text;
  // A word that is only punctuation (`?`, `&`) is no token: it neither makes a
  // query "longer" nor counts toward the collision guard's whole query.
  const words = rest.split(' ').filter((w) => core(w) !== '');

  // Step 5.
  const tokens = joinCodes(words, ctx);
  const whole = tokens.length === 1;

  // Step 6: resolution, first match wins, per code-shaped token.
  /** @type {{ prefix: string, level: number | null } | null} */
  let route = null;
  /** Code tokens that route nothing (catalogue-only or unknown inside a longer query): they stay text. @type {Set<Token>} */
  const inert = new Set();
  for (const tok of tokens) {
    const full = FULL_CODE.exec(tok.text);
    if (full && ctx.prefixes.has(full[1].toUpperCase())) {
      const code = tok.text.toUpperCase();
      const letters = full[1];
      const n000 = N000.exec(code);
      if (ctx.isOffered(code)) {
        if (parsed.pins.length < MAX_PINS && !parsed.pins.includes(code)) parsed.pins.push(code);
      } else if (ctx.catalogue.has(code)) {
        if (whole) parsed.noMatch = { reason: 'not-offered', code };
        else inert.add(tok);
      } else if (n000 && !ctx.collision.has(letters.toUpperCase()) && !ctx.stopwords.has(letters)) {
        route ??= { prefix: letters.toUpperCase(), level: Number(n000[1]) };
      } else if (whole) {
        parsed.noMatch = { reason: 'unknown-code', code };
      } else {
        inert.add(tok);
      }
      continue;
    }
    const partial = PARTIAL_CODE.exec(tok.text);
    if (partial && ctx.prefixes.has(partial[1].toUpperCase())) {
      route ??= { prefix: tok.text.toUpperCase(), level: null };
      continue;
    }
    // A letter-only token routes only as the whole query, off the collision list.
    if (whole && LETTERS.test(tok.text) && ctx.prefixes.has(tok.text.toUpperCase()) && !ctx.collision.has(tok.text.toUpperCase())) {
      route = { prefix: tok.text.toUpperCase(), level: null };
    }
  }

  if (parsed.noMatch) {
    parsed.kind = 'no-match';
    return parsed;
  }
  if (parsed.pins.length) interpreted.pin = [...parsed.pins];

  // Step 7: pass B on what the joins left (passB). A joined code that routes
  // nothing stays text (prereg §3 "Code resolution"), so it is not masked.
  let masked = '';
  let plain = '';
  for (const tok of tokens) {
    const raw = words.slice(tok.from, tok.to + 1).join(' ');
    masked += `${masked ? ' ' : ''}${tok.joined && !inert.has(tok) ? '#'.repeat(raw.length) : raw}`;
    plain += `${plain ? ' ' : ''}${raw}`;
  }
  const { pillars, windows: levelWindows, strip } = passB(masked, plain, ctx, ignored);
  // Strip the matched phrases from the lexical text, right to left so the
  // offsets hold (the matches do not overlap). Lead decision (3D review): when
  // only level phrases were matched and stripping them would leave no word,
  // they stay, so the keyword half still searches (`graduate` within level 5+)
  // in mode=lexical and the keyword-only fallback.
  let lexical = plain;
  if (strip.length) {
    for (const [s, e] of [...strip].reverse()) lexical = lexical.slice(0, s) + lexical.slice(e);
    lexical = lexical.replace(/\s+/g, ' ').trim();
    if (!/[a-z0-9]/.test(lexical) && !pillars.size) lexical = plain;
  }
  parsed.lexical = lexical;

  if (pillars.size) {
    interpreted.ge = [...pillars].sort();
    parsed.ranges = interpreted.ge.map(codeRange);
    // The whole query was GE phrases: the pillar mask.
    if (!/[a-z0-9]/.test(lexical) && !route && !parsed.pins.length) parsed.kind = 'mask';
  }

  if (route) {
    interpreted.prefix = route.prefix;
    const range = [codeRange(route.prefix)];
    if (whole) {
      parsed.kind = 'mask';
      parsed.ranges = range;
    } else {
      parsed.codeList = range;
    }
    if (route.level !== null) levelWindows.push({ min: route.level, max: route.level, source: 'level' });
  }

  if (levelWindows.length && !ignored.has('level')) {
    const min = Math.min(...levelWindows.map((w) => w.min));
    const max = levelWindows.some((w) => w.max === null) ? null : Math.max(...levelWindows.map((w) => /** @type {number} */ (w.max)));
    interpreted.level = { min, max, source: [...new Set(levelWindows.map((w) => w.source))].sort() };
    parsed.level = { min, max };
    parsed.beginner = interpreted.level.source.includes('beginner');
  }
  return parsed;
}
