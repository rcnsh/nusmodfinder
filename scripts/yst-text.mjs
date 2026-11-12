#!/usr/bin/env node
// @ts-check
// YST's "Courses for NUS Non-Music Majors" page as text (Phase 7 7E): the step that was done by
// hand (docs/evidence/phase4/sources.md: "tags stripped, one text node per line"). The restrictions
// builder reads the text's line format: a heading line carries "(N Units" and its codes start
// that line or one of the three above it (scripts/build-ng-restrictions.mjs).
//
//   node scripts/yst-text.mjs <page.html> [--out <page.txt>] [--expect <sha256>]
//
// Without --out it prints the text. --expect fails unless the text's sha256 is the one given: the
// manifest's for the committed extraction (the lead's check on the Mac, against the saved page).
//
// One text node per line: <script>, <style> and comments dropped; every tag ends a node; entities
// decoded; each node's ASCII white space collapsed to single spaces (a no-break space inside a node
// stays, as the hand extraction kept it), then trimmed of every space, no-break ones included;
// empty nodes dropped; lines joined by newlines, with none after the last. The two committed
// extractions reproduce byte for byte from the saved pages (checked on the Mac against the archive).
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
