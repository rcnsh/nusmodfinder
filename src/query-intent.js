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
//   2. 3G's vocabulary test on the pre-correction tokens    seam: not built
//   3. 3C's correction of df-0 letter-only tokens           seam: identity
//   4. intent pass A: the 3H phrases, stripped before joins seam: no phrases
//   5. code joins                                           joinCodes
//   6. code resolution                                      resolve
//   7. intent pass B: the GE phrases (here) and the 3D level phrases (seam)
//
// 3B sets `pin`, `prefix`, `ge`, and `level` only through an `XX N000` code
// token; the other keys stay null until 3D and 3H fill them.

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
 *   level: LevelWindow | null, noMatch: NoMatch | null,
 * }} ParsedQuery
 *   - `kind` 'mask': a whole-query partial code, bare prefix, `XX N000` or GE
 *     phrase. The results are the members of `ranges` (∩ `level`, ∩ the
 *     filters), ordered by exact dense score, or by code without the dense half.
 *   - `kind` 'search': the fused retrieval. `ranges`, when set, is the GE
 *     pre-retrieval mask on both halves; `codeList` the third RRF list's
 *     members; `level` a filter on everything.
 *   - `kind` 'no-match': `count: 0` with `noMatch`.
 *   - `lexical`: the text the FTS half searches (GE phrases stripped); `dense`
 *     the text the dense half embeds (the canonical q, raw).
 * @typedef {{ prefixes: string[], genericPhrases: string[], pillars: { name: string, prefixes: string[] }[] }} GeTable
 * @typedef {{
 *   prefixes: Set<string>, catalogue: Set<string>, collision: Set<string>, stopwords: Set<string>,
 *   ge: GeTable, gePhrases: { re: RegExp, prefixes: string[] }[], isOffered: (code: string) => boolean,
 * }} IntentContext Upper-case prefixes, codes and collision entries; lower-case stopwords.
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
 * literal.
 * @param {string} phrase
 */
const phraseRegex = (phrase) => new RegExp(
  `(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '[\\s-]+')}(?![a-z0-9])`, 'g');

/**
 * @param {{
 *   prefixes: Iterable<string>, catalogueCodes: Iterable<string>, collision: Iterable<string>,
 *   ge: GeTable, stopwords: Iterable<string>, isOffered: (code: string) => boolean,
 * }} data
 * @returns {IntentContext}
 */
export function buildIntentContext({ prefixes, catalogueCodes, collision, ge, stopwords, isOffered }) {
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
  };
}

const FULL_CODE = /^([a-z]{1,4})(\d{4})([a-z0-9]{0,5})$/;
const PARTIAL_CODE = /^([a-z]{2,4})(\d{1,3})$/;
const LETTERS = /^[a-z]{1,4}$/;
const N000 = /^[A-Z]+([1-9])000$/;
/** A word without the punctuation around it (`cs32?` → `cs32`); internal characters stay (`s/u`). */
const core = (/** @type {string} */ w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

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
        const s = n === 3 ? words[2] : null;
        if (n === 2 && /^\d{4}[a-z0-9]{0,5}$/.test(d) && known(w + d)) tok = { text: w + d, from: 0, to: 1, joined: true };
        else if (s !== null && /^\d{4}$/.test(d) && /^[a-z]{1,2}$/.test(s) && known(w + d + s)) tok = { text: w + d + s, from: 0, to: 2, joined: true };
      } else if (/^(\d{1,3}|\d{4}[a-z0-9]{0,5})$/.test(d)) {
        tok = { text: w + d, from: i, to: i + 1, joined: true };
      }
    }
    // Suffix join: the next word as typed, so `s/u` and `s-u` never join.
    const next = tok.to + 1 < n ? words[tok.to + 1] : null;
    if (next !== null && FULL_CODE.test(tok.text) && /^[a-z]{1,2}$/.test(next) && known(tok.text + next)) {
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
 * Step 7's 3D half, the level phrases (beginner, graduate, level N, year N).
 * A seam until 3D: it matches nothing. Its windows would take the union with
 * the `XX N000` level.
 * @type {(text: string) => { min: number, max: number | null, source: string }[]}
 */
const levelPhrases = () => [];

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
    q, lexical: q, dense: q, interpreted, kind: 'search', pins: [], ranges: null, codeList: null, level: null, noMatch: null,
  };

  // Steps 2–4: seams (3G, 3C, 3H).
  const rest = intentPassA(q).text;
  const words = rest.split(' ').filter(Boolean);

  // Step 5.
  const tokens = joinCodes(words, ctx);
  const whole = tokens.length === 1;

  // Step 6: resolution, first match wins, per code-shaped token.
  /** @type {{ prefix: string, level: number | null } | null} */
  let route = null;
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
      } else if (n000 && !ctx.collision.has(letters.toUpperCase()) && !ctx.stopwords.has(letters)) {
        route ??= { prefix: letters.toUpperCase(), level: Number(n000[1]) };
      } else if (whole) {
        parsed.noMatch = { reason: 'unknown-code', code };
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

  // Step 7: pass B on what the joins left (a joined token's words are masked,
  // so `ge 2101` is Geography's code, never the GE intent).
  let masked = '';
  let lexical = '';
  for (const tok of tokens) {
    const raw = words.slice(tok.from, tok.to + 1).join(' ');
    masked += `${masked ? ' ' : ''}${tok.joined ? '#'.repeat(raw.length) : raw}`;
    lexical += `${lexical ? ' ' : ''}${raw}`;
  }
  /** @type {Set<string>} */
  const pillars = new Set();
  if (!ignored.has('ge')) {
    /** @type {[number, number][]} */
    const spans = [];
    for (const { re, prefixes } of ctx.gePhrases) {
      for (const m of masked.matchAll(re)) {
        const start = /** @type {number} */ (m.index);
        spans.push([start, start + m[0].length]);
        for (const p of prefixes) pillars.add(p);
      }
    }
    // Strip the matched phrases from the lexical text, right to left so the
    // offsets hold. Overlapping matches (none in the table) strip their union.
    spans.sort((a, b) => b[0] - a[0]);
    let cut = Infinity;
    for (const [s, e] of spans) {
      const end = Math.min(e, cut);
      if (end > s) lexical = lexical.slice(0, s) + lexical.slice(end);
      cut = Math.min(cut, s);
    }
    lexical = lexical.replace(/\s+/g, ' ').trim();
  }
  const levelWindows = levelPhrases(masked);
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
  }
  return parsed;
}
