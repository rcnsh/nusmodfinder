#!/usr/bin/env node
// @ts-check
// Splits the gibberish set (eval/dev/gibberish.json) into a derivation half,
// on which the no-signal threshold τ is derived, and a gate half, on which it
// is checked. The split is a seeded Fisher–Yates shuffle of the ids in file order
// (eval/lib/stats.mjs `rng`, the eval's seeded generator); the first
// floor(n/2) shuffled ids are the derivation half, the rest the gate half.
// Each half is listed in file order.
//
//   node eval/gibberish-split.mjs           # print the split
//   node eval/gibberish-split.mjs --check   # exit 1 unless the file's split is the seed's
//   node eval/gibberish-split.mjs --write   # write the split into the file
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './lib/sets.mjs';
import { rng } from './lib/stats.mjs';

export const GIBBERISH_PATH = join(REPO, 'eval/dev/gibberish.json');

/**
 * @param {string[]} ids in file order
 * @param {number} seed
 * @returns {{ derivation: string[], gate: string[] }}
 */
export function splitGibberish(ids, seed) {
  const order = [...ids];
  const next = rng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const half = new Set(order.slice(0, Math.floor(order.length / 2)));
  return { derivation: ids.filter((id) => half.has(id)), gate: ids.filter((id) => !half.has(id)) };
}

/** @param {any} file */
export const splitOf = (file) => splitGibberish(file.strings.map((/** @type {any} */ s) => s.id), file.split.seed);

function main() {
  const file = JSON.parse(readFileSync(GIBBERISH_PATH, 'utf8'));
  const split = splitOf(file);
  const mode = process.argv[2];
  if (mode === '--write') {
    file.split = { seed: file.split.seed, method: file.split.method, ...split };
    writeFileSync(GIBBERISH_PATH, `${JSON.stringify(file, null, 1)}\n`);
    console.log(`wrote the split (seed ${file.split.seed}): ${split.derivation.length} derivation, ${split.gate.length} gate`);
  } else if (mode === '--check') {
    const same = JSON.stringify(file.split.derivation) === JSON.stringify(split.derivation) && JSON.stringify(file.split.gate) === JSON.stringify(split.gate);
    console.log(same ? 'gibberish split matches its seed' : 'gibberish split differs from its seed');
    if (!same) process.exitCode = 1;
  } else {
    console.log(JSON.stringify(split, null, 1));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
