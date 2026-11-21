// @ts-check

const MAX_TOKEN = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const A = 97, E = 101, I = 105, L = 108, O = 111, S = 115, T = 116, U = 117, W = 119, X = 120, Y = 121, Z = 122;

/** @param {number} c @param {boolean} yIsVowel */
const isVowel = (c, yIsVowel) => c === A || c === E || c === I || c === O || c === U || (yIsVowel && c === Y);

/**
 * @param {Uint8Array} b
 * @param {number} start
 * @param {number} end
 * @param {boolean} prevCons
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

/**
 * @param {Uint8Array} b
 * @param {number} n
 */
const mGt0 = (b, n) => gobbleVC(b, 0, n, false) !== 0;
/**
 * @param {Uint8Array} b
 * @param {number} n
 */
const mGt1 = (b, n) => {
  const k = gobbleVC(b, 0, n, false);
  return k !== 0 && gobbleVC(b, k, n, true) !== 0;
};
/**
 * @param {Uint8Array} b
 * @param {number} n
 */
const mEq1 = (b, n) => {
  const k = gobbleVC(b, 0, n, false);
  return k !== 0 && gobbleVC(b, k, n, true) === 0;
};
/**
 * @param {Uint8Array} b
 * @param {number} n
 */
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
/**
 * @param {Uint8Array} b
 * @param {number} n
 */
const mGt1ST = (b, n) => (b[n - 1] === S || b[n - 1] === T) && mGt1(b, n);
/**
 * @param {Uint8Array} b
 * @param {number} n
 */
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
 * @param {Record<string, Rule[]>} table
 * @param {Uint8Array} b
 * @param {number} n
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

/**
 * @param {Uint8Array} b
 * @param {number} n
 */
function step1a(b, n) {
  if (b[n - 1] !== S) return n;
  if (b[n - 2] === E) {
    if ((n > 4 && b[n - 4] === S && b[n - 3] === S) || (n > 3 && b[n - 3] === I)) return n - 2;
    return n - 1;
  }
  return b[n - 2] !== S ? n - 1 : n;
}

/** @param {string} token */
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

/** @param {string} token */
export const foldDiacritics = (token) => token.normalize('NFD').replace(/\p{M}+/gu, '');

/** @param {string} token */
export const ftsTerm = (token) => porterStem(foldDiacritics(token));
