// @ts-check
// SQLite FTS5's porter stemmer (ext/fts5/fts5_tokenize.c, the `porter`
// tokenizer modules_fts uses over unicode61), ported rule for rule and run on
// the token's UTF-8 bytes as the C code is. 3C needs it because FTS5 stems a
// prefix query's token too: `"learnin"*` looks for index terms starting with
// porter("learnin") = "learnin", and "learning" is indexed as "learn", so it
// matches nothing. Deciding a prefix term's fate from the vocabulary (no D1
// query) is exact only with the same stemmer. test/porter.node.test.js and
// test/full/vocabulary.node.test.js check it against node:sqlite's FTS5.
//
// SQLite's version differs from Porter's 1980 paper in places, all kept:
// - `y` is a vowel when the previous letter is a consonant (in the m
//   measure), and anywhere but the first letter (in *v*);
// - step 2 has `bli` → `ble` and `logi` → `log`;
// - within a step, the first rule whose suffix matches decides, even when its
//   condition fails;
// - tokens shorter than 3 or longer than 64 bytes pass through unstemmed.

/** FTS5_PORTER_MAX_TOKEN. */
const MAX_TOKEN = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const A = 97, E = 101, I = 105, L = 108, O = 111, S = 115, T = 116, U = 117, W = 119, X = 120, Y = 121, Z = 122;

/** @param {number} c @param {boolean} yIsVowel */
const isVowel = (c, yIsVowel) => c === A || c === E || c === I || c === O || c === U || (yIsVowel && c === Y);

/**
 * fts5PorterGobbleVC over b[start, end): the length up to and including the
 * consonant that follows the first vowel, or 0.
 * @param {Uint8Array} b @param {number} start @param {number} end @param {boolean} prevCons
 */
function gobbleVC(b, start, end, prevCons) {
  let cons = prevCons;
  let i = start;
  for (; i < end; i++) {
    cons = !isVowel(b[i], cons);
    if (!cons) break;
  }
  for (i++; i < end; i++) {
    cons = !isVowel(b[i], cons);
    if (cons) return i + 1 - start;
  }
  return 0;
}

/** (m > 0) @param {Uint8Array} b @param {number} n */
const mGt0 = (b, n) => gobbleVC(b, 0, n, false) !== 0;
/** (m > 1) @param {Uint8Array} b @param {number} n */
const mGt1 = (b, n) => {
  const k = gobbleVC(b, 0, n, false);
  return k !== 0 && gobbleVC(b, k, n, true) !== 0;
};
/** (m = 1) @param {Uint8Array} b @param {number} n */
const mEq1 = (b, n) => {
  const k = gobbleVC(b, 0, n, false);
  return k !== 0 && gobbleVC(b, k, n, true) === 0;
};
/** (*o): ends consonant-vowel-consonant, the last not w, x or y. @param {Uint8Array} b @param {number} n */
function ostar(b, n) {
  const last = b[n - 1];
  if (last === W || last === X || last === Y) return false;
  let mask = 0;
  let cons = false;
  for (let i = 0; i < n; i++) {
    cons = !isVowel(b[i], cons);
    mask = (mask << 1) + (cons ? 1 : 0);
  }
  return (mask & 7) === 5;
}
/** (m > 1 and (*S or *T)) @param {Uint8Array} b @param {number} n */
const mGt1ST = (b, n) => (b[n - 1] === S || b[n - 1] === T) && mGt1(b, n);
/** (*v*) @param {Uint8Array} b @param {number} n */
function hasVowel(b, n) {
  for (let i = 0; i < n; i++) if (isVowel(b[i], i > 0)) return true;
  return false;
}

/** @param {Uint8Array} b @param {number} n @param {string} suffix */
function endsWith(b, n, suffix) {
  if (n <= suffix.length) return false;
  for (let k = 0; k < suffix.length; k++) if (b[n - suffix.length + k] !== suffix.charCodeAt(k)) return false;
  return true;
}

/**
 * @typedef {(b: Uint8Array, n: number) => boolean} Cond
 * @typedef {[suffix: string, replacement: string, cond: Cond | null]} Rule
 */

/**
 * One step: the rules of the case named by the second-to-last byte, tried in
 * order; the first whose suffix matches (with at least one byte before it)
 * decides. Returns the new length and whether a replacement was made.
 * @param {Record<string, Rule[]>} table @param {Uint8Array} b @param {number} n
 */
function step(table, b, n) {
  const rules = n >= 2 ? table[String.fromCharCode(b[n - 2])] : undefined;
  if (!rules) return { n, hit: false };
  for (const [suffix, repl, cond] of rules) {
    if (!endsWith(b, n, suffix)) continue;
    const stem = n - suffix.length;
    if (cond && !cond(b, stem)) return { n, hit: false };
    for (let k = 0; k < repl.length; k++) b[stem + k] = repl.charCodeAt(k);
    return { n: stem + repl.length, hit: true };
  }
  return { n, hit: false };
}

/** @type {Record<string, Rule[]>} */
const STEP1B = {
  e: [['eed', 'ee', mGt0], ['ed', '', hasVowel]],
  n: [['ing', '', hasVowel]],
};
/** @type {Record<string, Rule[]>} */
const STEP1B2 = {
  a: [['at', 'ate', null]],
  b: [['bl', 'ble', null]],
  i: [['iz', 'ize', null]],
};
/** @type {(rules: [string, string][]) => Rule[]} */
const when = (rules) => rules.map(([s, r]) => [s, r, mGt0]);
/** @type {Record<string, Rule[]>} */
const STEP2 = {
  a: when([['ational', 'ate'], ['tional', 'tion']]),
  c: when([['enci', 'ence'], ['anci', 'ance']]),
  e: when([['izer', 'ize']]),
  g: when([['logi', 'log']]),
  l: when([['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous']]),
  o: when([['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate']]),
  s: when([['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous']]),
  t: when([['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble']]),
};
/** @type {Record<string, Rule[]>} */
const STEP3 = {
  a: when([['ical', 'ic']]),
  s: when([['ness', '']]),
  t: when([['icate', 'ic'], ['iciti', 'ic']]),
  u: when([['ful', '']]),
  v: when([['ative', '']]),
  z: when([['alize', 'al']]),
};
/** @type {(suffixes: string[]) => Rule[]} */
const drop = (suffixes) => suffixes.map((s) => [s, '', mGt1]);
/** @type {Record<string, Rule[]>} */
const STEP4 = {
  a: drop(['al']),
  c: drop(['ance', 'ence']),
  e: drop(['er']),
  i: drop(['ic']),
  l: drop(['able', 'ible']),
  n: drop(['ant', 'ement', 'ment', 'ent']),
  o: [['ion', '', mGt1ST], ['ou', '', mGt1]],
  s: drop(['ism']),
  t: drop(['ate', 'iti']),
  u: drop(['ous']),
  v: drop(['ive']),
  z: drop(['ize']),
};

/** Step 1a. @param {Uint8Array} b @param {number} n */
function step1a(b, n) {
  if (b[n - 1] !== S) return n;
  if (b[n - 2] === E) {
    if ((n > 4 && b[n - 4] === S && b[n - 3] === S) || (n > 3 && b[n - 3] === I)) return n - 2;
    return n - 1;
  }
  return b[n - 2] !== S ? n - 1 : n;
}

/**
 * The porter stem of one token, as FTS5's porter tokenizer emits it.
 * @param {string} token lower-cased and diacritic-folded (what unicode61 hands porter)
 */
export function porterStem(token) {
  const bytes = encoder.encode(token);
  if (bytes.length > MAX_TOKEN || bytes.length < 3) return token;
  const b = new Uint8Array(bytes.length + 2);
  b.set(bytes);
  let n = step1a(b, bytes.length);
  const s1b = step(STEP1B, b, n);
  n = s1b.n;
  if (s1b.hit) {
    const s1b2 = step(STEP1B2, b, n);
    n = s1b2.n;
    if (!s1b2.hit) {
      const c = b[n - 1];
      if (!isVowel(c, false) && c !== L && c !== S && c !== Z && n >= 2 && c === b[n - 2]) n--;
      else if (mEq1(b, n) && ostar(b, n)) b[n++] = E;
    }
  }
  if (b[n - 1] === Y && hasVowel(b, n - 1)) b[n - 1] = I;
  n = step(STEP2, b, n).n;
  n = step(STEP3, b, n).n;
  n = step(STEP4, b, n).n;
  if (b[n - 1] === E && (mGt1(b, n - 1) || (mEq1(b, n - 1) && !ostar(b, n - 1)))) n--;
  if (n > 1 && b[n - 1] === L && b[n - 2] === L && mGt1(b, n - 1)) n--;
  return decoder.decode(b.subarray(0, n));
}

/**
 * Diacritics removed (canonical decomposition, combining marks dropped), as
 * unicode61's remove_diacritics folds a token before porter sees it.
 * @param {string} token
 */
export const foldDiacritics = (token) => token.normalize('NFD').replace(/\p{M}+/gu, '');

/**
 * The FTS5 index term a surface token (queryTokens) becomes: folded, then
 * stemmed.
 * @param {string} token
 */
export const ftsTerm = (token) => porterStem(foldDiacritics(token));
