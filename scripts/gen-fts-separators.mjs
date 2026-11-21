// @ts-check
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../src/fts-separators.js', import.meta.url));
const SURROGATES = [0xd800, 0xdfff];

/** @returns {[number, number][]} */
export function probeSeparators() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'porter unicode61');
           CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
  const insert = db.prepare('INSERT INTO t(rowid, x) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= SURROGATES[0] && c <= SURROGATES[1]) continue;
    insert.run(c + 1, `x${String.fromCodePoint(c)}y`);
  }
  db.exec('COMMIT');
  const token = new Set(db.prepare('SELECT doc FROM v GROUP BY doc HAVING count(*) = 1').all()
    .map((r) => Number(r.doc) - 1));
  db.close();
  /** @type {[number, number][]} */
  const ranges = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    const separator = (c >= SURROGATES[0] && c <= SURROGATES[1]) || !token.has(c);
    if (!separator) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === c - 1) last[1] = c;
    else ranges.push([c, c]);
  }
  return ranges;
}

/** @param {[number, number][]} ranges */
export function render(ranges) {
  const hex = (/** @type {number} */ c) => c.toString(16);
  const list = ranges.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`));
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < list.length; i += 12) lines.push(`  '${list.slice(i, i + 12).join(',')}',`);
  return `// @ts-check
const RANGES = [
${lines.join('\n')}
].join(',');

const cls = RANGES.split(',').map((r) => r.split('-').map((h) => \`\\\\u{\${h}}\`).join('-')).join('');

export const FTS_SEPARATORS = new RegExp(\`[\${cls}]+\`, 'u');
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = render(probeSeparators());
  if (process.argv.includes('--check')) {
    const current = await readFile(OUT, 'utf8').catch(() => '');
    if (current !== text) {
      console.error('src/fts-separators.js is stale: run node scripts/gen-fts-separators.mjs');
      process.exit(1);
    }
    console.log('src/fts-separators.js is current');
  } else {
    await writeFile(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
