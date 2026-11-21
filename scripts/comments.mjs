// @ts-check
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'acorn';
import { allowed, isJsdoc, jsdocSkeleton, removeComments } from './comment-core.mjs';

/** @typedef {import('./comment-core.mjs').Comment} Comment */

const VERDICTS = new Set(['tautology', 'stale', 'excuse', 'decision', 'keep']);
const USAGE = `usage:
  node scripts/comments.mjs list [paths...]     one JSON line per banned comment, with its id and context
  node scripts/comments.mjs apply <ledger.json>  delete every comment the ledger classifies, except "keep"
  node scripts/comments.mjs count [paths...]     banned comments and the lines deleting them all would shed`;

/** @param {string[]} paths */
function jsFiles(paths) {
  const out = execFileSync('git', ['ls-files', '--', ...(paths.length ? paths : ['.'])], { encoding: 'utf8' });
  return out.split('\n').filter((f) => /\.(m?js|cjs)$/.test(f) && !f.endsWith('.d.ts'));
}

/**
 * @param {string} src
 * @returns {Comment[]}
 */
export function commentsOf(src) {
  /** @type {Comment[]} */
  const found = [];
  parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, onComment: (block, value, start, end) => found.push({ block, value, start, end }) });
  return src.startsWith('#!') ? found.filter((c) => c.start !== 0) : found;
}

/** @param {string} src */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (/** @type {number} */ pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - starts[lo] + 1 };
  };
}

/**
 * @param {string} file
 * @param {string} src
 */
function banned(file, src) {
  const at = lineIndex(src);
  const lines = src.split('\n');
  /** @type {{ id: string, comments: Comment[], line: number, endLine: number }[]} */
  const out = [];
  for (const c of commentsOf(src).filter((x) => !allowed(x))) {
    const { line, col } = at(c.start);
    const endLine = at(c.end).line;
    const alone = !c.block && lines[line - 1].trimStart().startsWith('//');
    const prev = out.at(-1);
    const prevC = prev?.comments.at(-1);
    if (alone && prev && prevC && !prevC.block && prev.endLine === line - 1 && lines[prev.endLine - 1].trimStart().startsWith('//')) {
      prev.comments.push(c);
      prev.endLine = endLine;
      continue;
    }
    out.push({ id: `${file}:${line}:${col}`, comments: [c], line, endLine });
  }
  return out.map((b) => ({ ...b, text: b.comments.length > 1 ? lines.slice(b.line - 1, b.endLine).map((l) => l.trim()).join('\n') : b.comments[0].block ? `/*${b.comments[0].value}*/` : `//${b.comments[0].value}` }));
}

/** @param {string[]} paths */
function list(paths) {
  for (const file of jsFiles(paths)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (const { id, comments, endLine, text } of banned(file, src)) {
      const c = comments[0];
      const kind = isJsdoc(c) ? 'jsdoc' : c.block ? 'block' : 'line';
      const keeps = kind === 'jsdoc' ? jsdocSkeleton(c.value).kept : [];
      const code = lines.slice(endLine - (c.block || comments.length > 1 ? 0 : 1), endLine + 4).join('\n');
      process.stdout.write(`${JSON.stringify({ id, kind, text, ...(keeps.length ? { typesKept: keeps } : {}), code })}\n`);
    }
  }
}

/**
 * @param {string} src
 * @returns {{ comments: number, lines: number }}
 */
export function shed(src) {
  const all = commentsOf(src);
  const gone = all.filter((c) => !allowed(c));
  const after = removeComments(src, gone);
  return { comments: gone.length, lines: src.split('\n').length - after.split('\n').length };
}

/** @param {string[]} paths */
function count(paths) {
  /** @type {Record<string, { files: number, comments: number, lines: number, total: number }>} */
  const by = {};
  for (const file of jsFiles(paths)) {
    const src = readFileSync(file, 'utf8');
    const s = shed(src);
    const parts = file.split('/');
    const dir = parts.length > 1 ? parts[0] : '(root)';
    by[dir] ??= { files: 0, comments: 0, lines: 0, total: 0 };
    by[dir].files++;
    by[dir].comments += s.comments;
    by[dir].lines += s.lines;
    by[dir].total += src.split('\n').length;
  }
  const sum = Object.values(by).reduce((a, v) => ({ files: a.files + v.files, comments: a.comments + v.comments, lines: a.lines + v.lines, total: a.total + v.total }), { files: 0, comments: 0, lines: 0, total: 0 });
  console.table({ ...by, total: sum });
}

/** @param {string} src */
const shape = (src) => JSON.stringify(parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true }),
  (k, v) => (k === 'start' || k === 'end' || k === 'raw' ? undefined : v));

/** @param {string} ledgerPath */
function apply(ledgerPath) {
  /** @type {{ id: string, verdict: string, text?: string }[]} */
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  /** @type {Map<string, Map<string, string | undefined>>} */
  const byFile = new Map();
  for (const { id, verdict, text } of ledger) {
    if (!VERDICTS.has(verdict)) throw new Error(`${id}: unknown verdict ${verdict}`);
    if (verdict === 'keep') continue;
    if (typeof text !== 'string') throw new Error(`${id}: the entry needs the comment's \`text\` from \`list\``);
    const file = id.replace(/:\d+:\d+$/, '');
    if (!byFile.has(file)) byFile.set(file, new Map());
    byFile.get(file)?.set(id, text);
  }
  /** @type {[string, string][]} */
  const writes = [];
  /** @type {string[]} */
  const problems = [];
  let removed = 0;
  for (const [file, ids] of byFile) {
    const src = readFileSync(file, 'utf8');
    const found = banned(file, src).filter((b) => ids.has(b.id));
    for (const [id, text] of ids) {
      const b = found.find((x) => x.id === id);
      if (!b) problems.push(`${id}: no banned comment here`);
      else if (b.text !== text) problems.push(`${id}: the comment here is not the one the ledger names`);
    }
    if (problems.length) continue;
    const next = removeComments(src, found.flatMap((b) => b.comments));
    if (shape(next) !== shape(src)) { problems.push(`${file}: removing these comments changes the program`); continue; }
    writes.push([file, next]);
    removed += found.length;
  }
  if (problems.length) throw new Error(`nothing written; list the files again:\n${problems.join('\n')}`);
  for (const [file, next] of writes) writeFileSync(file, next);
  console.log(`removed ${removed} comments from ${writes.length} files`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') list(args);
else if (cmd === 'count') count(args);
else if (cmd === 'apply' && args.length === 1) apply(args[0]);
else {
  console.error(USAGE);
  process.exit(2);
}
