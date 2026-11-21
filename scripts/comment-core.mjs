// @ts-check

/** @typedef {{ block: boolean, value: string, start: number, end: number }} Comment */
/** @typedef {{ kept: string[], dropped: boolean }} Skeleton */

const DIRECTIVE = /^\s*(?:(?:eslint-disable(?:-next-line|-line)?|eslint-enable)(?:\s+[\w@/-]+(?:\s*,\s*[\w@/-]+)*)?(?:\s+--\s.*)?|@ts-(?:check|nocheck)|@ts-(?:expect-error|ignore)(?:\s.*)?|globals?\s+[\w$]+(?:\s*,\s*[\w$]+)*)\s*$/;
const REFERENCE = /^\/\s*<reference\s+[^>]*\/>\s*$/;
const JSDOC_DIRECTIVE = /^\*\s*@ts-(?:expect-error|ignore)\b[^\n]*$/;

const TYPE_ONLY = new Set(['type', 'returns', 'return', 'satisfies', 'enum', 'this', 'throws', 'extends', 'augments', 'implements']);
const NAMED = new Set(['param', 'arg', 'argument', 'property', 'prop', 'typedef', 'callback']);
const BARE = new Set(['overload', 'readonly', 'private', 'protected', 'public', 'override', 'abstract', 'deprecated']);

/**
 * @param {Comment} c
 * @returns {boolean}
 */
export function isDirective(c) {
  if (!c.block && REFERENCE.test(c.value)) return true;
  if (c.block && JSDOC_DIRECTIVE.test(c.value.trim())) return true;
  return !c.value.startsWith('*') && DIRECTIVE.test(c.value);
}

/** @param {Comment} c */
export const isJsdoc = (c) => c.block && c.value.startsWith('*') && !c.value.startsWith('**');

/**
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function closeBrace(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * @param {string} s
 * @param {number} i
 * @returns {number}
 */
function closeBracket(s, i) {
  let depth = 0;
  for (let j = i; j < s.length && s[j] !== '\n'; j++) {
    if (s[j] === '[') depth++;
    else if (s[j] === ']' && --depth === 0) return j + 1;
  }
  return -1;
}

/**
 * @param {string} value
 * @returns {Skeleton}
 */
export function jsdocSkeleton(value) {
  const text = value.slice(1).split('\n').map((l, i) => (i === 0 ? l : l.replace(/^\s*\*(?!\/)[ \t]?/, ''))).join('\n');
  /** @type {string[]} */
  const kept = [];
  let dropped = false;
  let i = 0;
  /** @param {number} to */
  const skipProse = (to) => {
    if (text.slice(i, to).trim() !== '') dropped = true;
    i = to;
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const m = /(^|\s)@(\w+)/.exec(rest);
    if (!m) { skipProse(text.length); break; }
    const at = i + m.index + m[1].length;
    skipProse(at);
    const tag = m[2];
    let j = at + 1 + tag.length;
    /** @param {RegExp} re */
    const take = (re) => {
      re.lastIndex = j;
      const r = re.exec(text);
      if (r && r.index === j) { j += r[0].length; return r[0]; }
      return null;
    };
    const ws = () => take(/[ \t]+/y);
    /** @param {RegExp} plain */
    const name = (plain) => {
      if (text[j] !== '[') return take(plain);
      const close = closeBracket(text, j);
      if (close < 0) return null;
      const n = text.slice(j, close);
      j = close;
      return n;
    };
    /** @returns {string | null} */
    const type = () => {
      const save = j;
      ws();
      if (text[j] !== '{') { j = save; return null; }
      const close = closeBrace(text, j);
      if (close < 0) { j = save; return null; }
      const t = text.slice(j, close);
      j = close;
      return t;
    };
    let out = null;
    if (tag === 'import') {
      const save = j;
      ws();
      const what = text[j] === '{' ? (() => { const c = closeBrace(text, j); if (c < 0) return null; const t = text.slice(j, c); j = c; return t; })() : take(/\*\s+as\s+[\w$]+|[\w$]+/y);
      ws();
      const from = what && take(/from\s*(['"])[^'"\n]*\1/y);
      if (what && from) out = `@import ${what} ${from}`;
      else j = save;
    } else if (tag === 'template') {
      const t = type();
      ws();
      const names = name(/[\w$]+(?:\s*,\s*[\w$]+)*/y);
      if (names) out = `@template ${t ? `${t} ` : ''}${names}`;
    } else if (NAMED.has(tag)) {
      const t = type();
      ws();
      const n = name(/[\w$][\w$.[\]]*/y);
      if (t || n) out = [`@${tag}`, t, n].filter(Boolean).join(' ');
    } else if (TYPE_ONLY.has(tag)) {
      const t = type();
      if (t) out = `@${tag} ${t}`;
    } else if (BARE.has(tag)) {
      out = `@${tag}`;
    }
    if (out === null) { dropped = true; i = at + 1 + tag.length; continue; }
    kept.push(out);
    i = j;
    const next = /(^|\s)@\w+/.exec(text.slice(i));
    skipProse(next ? i + next.index : text.length);
  }
  return { kept, dropped };
}

/** @param {Comment} c */
export function allowed(c) {
  if (isDirective(c)) return true;
  if (!isJsdoc(c)) return false;
  const s = jsdocSkeleton(c.value);
  return s.kept.length > 0 && !s.dropped;
}

/**
 * @param {string[]} kept
 * @param {string} indent
 * @param {boolean} ownLine
 */
export function renderJsdoc(kept, indent, ownLine) {
  if (kept.length === 1 && !kept[0].includes('\n')) return `/** ${kept[0]} */`;
  if (!ownLine) return `/** ${kept.join(' ').replace(/\s*\n\s*/g, ' ')} */`;
  const body = kept.flatMap((k) => k.split('\n')).map((l) => `${indent} *${l ? ` ${l}` : ''}`.replace(/\s+$/, ''));
  return ['/**', ...body, `${indent} */`].join('\n');
}

/**
 * @param {string} src
 * @param {Comment[]} comments
 * @returns {string}
 */
export function removeComments(src, comments) {
  let out = src;
  for (const c of [...comments].sort((a, b) => b.start - a.start)) {
    const lineStart = out.lastIndexOf('\n', c.start - 1) + 1;
    const nl = out.indexOf('\n', c.end);
    const lineEnd = nl < 0 ? out.length : nl;
    const before = out.slice(lineStart, c.start);
    const after = out.slice(c.end, lineEnd);
    const ownLine = before.trim() === '' && after.trim() === '';
    if (isJsdoc(c)) {
      const { kept } = jsdocSkeleton(c.value);
      if (kept.length > 0) {
        out = out.slice(0, c.start) + renderJsdoc(kept, before.match(/^[ \t]*/)?.[0] ?? '', ownLine) + out.slice(c.end);
        continue;
      }
    }
    if (!ownLine && c.block && c.value.includes('\n')) {
      out = out.slice(0, c.start).replace(/[ \t]+$/, '') + '\n' + out.slice(c.end);
    } else if (ownLine) {
      let from = lineStart;
      let to = nl < 0 ? out.length : nl + 1;
      const prevBlank = from === 0 || /\n[ \t]*\n$/.test(out.slice(0, from)) || /^\s*$/.test(out.slice(0, from)) || /^#![^\n]*\n$/.test(out.slice(0, from));
      const nextLineEnd = out.indexOf('\n', to);
      const nextLine = out.slice(to, nextLineEnd < 0 ? out.length : nextLineEnd);
      if (prevBlank && nextLine.trim() === '' && nextLineEnd >= 0) to = nextLineEnd + 1;
      out = out.slice(0, from) + out.slice(to);
    } else if (after.trim() === '') {
      const trimmed = before.replace(/[ \t]+$/, '');
      out = out.slice(0, lineStart + trimmed.length) + out.slice(c.end);
    } else {
      const tail = out.slice(c.end).match(/^[ \t]*/)?.[0] ?? '';
      const space = /\S$/.test(before) ? ' ' : '';
      out = out.slice(0, c.start) + space + out.slice(c.end + tail.length);
    }
  }
  return out;
}
