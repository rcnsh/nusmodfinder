#!/usr/bin/env node
// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeEntities } from './ng-sources.mjs';

/** @param {string} html */
export function ystText(html) {
  const nodes = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .split(/<[^>]*>/)
    .map((t) => decodeEntities(t).replace(/[ \t\n\r\f\v]+/g, ' ').trim())
    .filter(Boolean);
  return nodes.join('\n');
}

/** @param {string[]} argv @param {{ log?: (m: string) => void, out?: (s: string) => void }} [o] */
export function main(argv, { log = console.error, out = (s) => process.stdout.write(s) } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { out: { type: 'string' }, expect: { type: 'string' } } });
  } catch (err) {
    log(`${/** @type {Error} */ (err).message}`);
    return 2;
  }
  const [input] = parsed.positionals;
  if (!input) { log('usage: node scripts/yst-text.mjs <page.html> [--out <page.txt>] [--expect <sha256>]'); return 2; }
  const text = ystText(readFileSync(input, 'utf8'));
  const sha = createHash('sha256').update(text).digest('hex');
  if (parsed.values.expect && parsed.values.expect !== sha) {
    log(`yst-text: the text of ${input} has sha256 ${sha}, not ${parsed.values.expect}`);
    return 1;
  }
  if (parsed.values.out) {
    writeFileSync(parsed.values.out, text);
    log(`yst-text: wrote ${text ? text.split('\n').length : 0} lines to ${parsed.values.out} (sha256 ${sha})`);
  } else out(text);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
