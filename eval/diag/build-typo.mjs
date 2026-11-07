#!/usr/bin/env node
// @ts-check
// The 3C typo diagnostic (docs/plans/phase3.md 3C "Measured", A-N8): one
// noise-model variant of each clean, answerable dev query, in its own set
// directory with its own qrels, so the locked dev files never change.
// Reported, never gated. See eval/diag/typo/README.md.
//
//   node eval/diag/build-typo.mjs           write eval/diag/typo/{queries,qrels,MANIFEST}.json
//   node eval/diag/build-typo.mjs --check   rebuild in memory; exit 1 if a committed file differs
//
// Sources: dev queries (eval/dev/queries.json) of a topical, abbreviation,
// level, language, SEA or mapping shape, at most 60 characters, not typo,
// code, no-answer or constraint queries, with at least one grade-≥1 judgment
// in qrels-dev and a letter-only word of 4+ letters.
//
// Noise model: Phase 2b's (eval/v2/build-queries.mjs, which made the dev typo
// queries), seeded here with SEED. Per source, 1 or 2 words (even odds) of the
// letter-only words of 4+ letters, each edited once at an interior position
// (never the first or last letter) by one of, with equal odds: a substitution
// by a keyboard neighbour (QWERTY, same row or the row above or below), a
// transposition with the next letter, a deletion, or a doubling. A variant
// equal to its source is drawn again.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO } from '../lib/sets.mjs';

export const SEED = 'vnm-3c-diag-typo-2026-11-07';
export const DIAG_DIR = 'eval/diag/typo';
const SOURCE_SHAPES = ['topical', 'abbreviation', 'level', 'language', 'sea', 'mapping'];
const EXCLUDED_SHAPES = ['typo', 'code', 'code-exact', 'code-space', 'code-partial', 'noanswer', 'constraint'];
const MAX_CHARS = 60;
const WORD = /^[a-z]{4,}$/i;

/**
 * Whether a dev query is a source: a clean, short, answerable query of a
 * shape a student might mistype.
 * @param {{ id: string, text: string, shapes: string[] }} q
 * @param {{ queries: Record<string, { judgments: Record<string, { grade: number } | number> }> }} qrels
 */
export function isSource(q, qrels) {
  const judged = Object.values(qrels.queries[q.id]?.judgments ?? {});
  return q.text.length <= MAX_CHARS
    && q.shapes.some((s) => SOURCE_SHAPES.includes(s))
    && !q.shapes.some((s) => EXCLUDED_SHAPES.includes(s))
    && judged.some((j) => (typeof j === 'number' ? j : j.grade) >= 1)
    && q.text.split(' ').some((w) => WORD.test(w));
}

/** The seeded stream, as Phase 2b's: sha256(SEED:n) as a fraction. */
function stream() {
  let n = 0;
  return () => createHash('sha256').update(`${SEED}:${n++}`).digest().readUInt32BE(0) / 2 ** 32;
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * The noise model on a query's words (space-split): 1–2 edited words.
 * @param {string[]} words
 * @param {() => number} rnd
 */
export function noisy(words, rnd) {
  const near = (/** @type {string} */ ch) => {
    const lower = ch.toLowerCase();
    for (let r = 0; r < ROWS.length; r++) {
      const i = ROWS[r].indexOf(lower);
      if (i < 0) continue;
      const opts = [ROWS[r][i - 1], ROWS[r][i + 1], ROWS[r - 1]?.[i], ROWS[r + 1]?.[i]].filter(Boolean);
      const pick = opts[Math.floor(rnd() * opts.length)];
      return ch === lower ? pick : pick.toUpperCase();
    }
    return ch;
  };
  const edit = (/** @type {string} */ w) => {
    const k = Math.floor(rnd() * 4);
    const i = 1 + Math.floor(rnd() * (w.length - 2));
    if (k === 0) return w.slice(0, i) + near(w[i]) + w.slice(i + 1);
    if (k === 1) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    if (k === 2) return w.slice(0, i) + w.slice(i + 1);
    return w.slice(0, i) + w[i] + w.slice(i);
  };
  const out = [...words];
  const cands = out.map((w, j) => ({ w, j })).filter(({ w }) => WORD.test(w));
  const nEdits = Math.min(cands.length, rnd() < 0.5 ? 1 : 2);
  // Fisher–Yates on the candidates, then the first nEdits are edited.
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  for (const { j } of cands.slice(0, nEdits)) out[j] = edit(out[j]);
  return out;
}

/** @param {unknown} v */
const json = (v) => `${JSON.stringify(v, null, 1)}\n`;

/** Every output file, as the bytes it should hold. */
export async function build() {
  const dev = JSON.parse(await readFile(join(REPO, 'eval/dev/queries.json'), 'utf8'));
  const qrels = JSON.parse(await readFile(join(REPO, 'eval/dev/qrels.json'), 'utf8'));
  const devTexts = new Set(dev.queries.map((/** @type {{ text: string }} */ q) => q.text));
  const rnd = stream();
  const sources = dev.queries.filter((/** @type {any} */ q) => isSource(q, qrels));
  const queries = sources.map((/** @type {any} */ src, /** @type {number} */ n) => {
    let text = src.text;
    // A variant equal to its source, or to any dev text, is drawn again.
    while (devTexts.has(text)) text = noisy(src.text.split(' '), rnd).join(' ');
    return {
      id: `dt-${String(n + 1).padStart(3, '0')}`, shapes: ['typo'], text,
      ...(src.filters ? { filters: src.filters } : {}), origin: 'typo-diag', source: src.id,
    };
  });
  const queriesFile = {
    schema: 'vnm-eval-queries/1', set: 'dev', version: 'diag-typo-v1', diagnostic: true, seed: SEED,
    derivedFrom: { queries: dev.version, qrels: qrels.version },
    noiseModel: 'eval/diag/build-typo.mjs (Phase 2b\'s, eval/v2/build-queries.mjs): 1–2 letter-only words of 4+ letters, '
      + 'each one interior keyboard-neighbour substitution, transposition, deletion or doubling',
    queries,
  };
  const qrelsFile = {
    schema: qrels.schema, set: 'dev', version: 'qrels-diag-typo-v1', derivedFrom: qrels.version,
    rule: 'each variant has its source dev query\'s judgments, verbatim',
    corpus: qrels.corpus, embedding: qrels.embedding, groups: qrels.groups,
    queries: Object.fromEntries(queries.map((/** @type {any} */ q) => [q.id, qrels.queries[q.source]])),
  };
  const queriesBytes = json(queriesFile);
  const qrelsBytes = json(qrelsFile);
  const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
  const manifest = `${JSON.stringify({ schema: 'vnm-holdout-manifest/1', files: { 'qrels.json': sha(qrelsBytes), 'queries.json': sha(queriesBytes) } }, null, 2)}\n`;
  return { queries: queriesBytes, qrels: qrelsBytes, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
  const out = await build();
  const files = { queries: 'queries.json', qrels: 'qrels.json', manifest: 'MANIFEST.json' };
  const stale = [];
  for (const [k, name] of Object.entries(files)) {
    const path = join(REPO, DIAG_DIR, name);
    const want = out[/** @type {keyof typeof out} */ (k)];
    if (values.check) {
      if ((await readFile(path, 'utf8').catch(() => null)) !== want) stale.push(name);
    } else {
      await writeFile(path, want);
      console.log(`wrote ${DIAG_DIR}/${name}`);
    }
  }
  if (values.check) {
    if (stale.length) { console.error(`out of date: ${stale.join(', ')} (node eval/diag/build-typo.mjs)`); process.exitCode = 1; }
    else console.log(`${DIAG_DIR} up to date`);
  }
}
