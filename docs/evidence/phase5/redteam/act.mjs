#!/usr/bin/env node
// Red team: your one way to use the course finder.
//   node <K>/act.mjs <command> [arguments…]
// Each command acts in your browser and prints what changed. Your brief lists
// the commands you can use. Commands run one at a time; a page may take a
// while to answer, so just wait. Never run two at once or in the background.
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const K = dirname(fileURLToPath(import.meta.url));
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: act.mjs <command> [arguments…]'); process.exit(2); }
const port = readFileSync(`${K}/.port`, 'utf8').trim();
const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ cmd, args }), signal: AbortSignal.timeout(600_000) });
console.log(await res.text());
