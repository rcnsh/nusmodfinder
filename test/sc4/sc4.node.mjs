// @ts-check
// Shared by the P-6 tests (test/sc4/*.node.test.js, test/full/sc4-prereg.node.test.js):
// the suite and gibberish files, §4's row counts, the `interpreted` schema,
// and the near-duplicate check against dev.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../../eval/lib/sets.mjs';

export const SUITE_PATH = join(REPO, 'test/sc4/queries.json');
export const DOC_PATH = join(REPO, 'docs/plans/phase3-prereg.md');
export const GIBBERISH_PATH = join(REPO, 'eval/dev/gibberish.json');
export const NEEDS_EMBEDDING_PATH = join(REPO, 'test/sc4/needs-embedding.txt');
/** Where the suite's and gibberish set's query embeddings go once embedded (eval cache format). */
export const SC4_EMBEDDINGS_PATH = join(REPO, 'test/sc4/embeddings.json');

/** @returns {any} */
export const readJson = (/** @type {string} */ path) => JSON.parse(readFileSync(path, 'utf8'));

/** §4's item table: row key → n. */
export const ROW_COUNTS = Object.freeze({
  'space-code': 5,
  'code-vs-level': 3,
  'code-join': 2,
  'partial-code': 6,
  'code-in-longer': 2,
  'unrouted-code-in-longer': 2,
  'ge-in-longer': 2,
  typo: 5,
  'level-beginner': 4,
  'level-graduate': 2,
  'level-n': 3,
  'level-year': 3,
  'no-exam': 3,
  su: 3,
  workload: 3,
  'no-prereq': 3,
  gibberish: 5,
  'nonexistent-code': 3,
  'not-offered-code': 2,
  guard: 29,
});

/** The `interpreted` schema (docs/plans/phase3-prereg.md, "The `interpreted` schema"). */
export const INTERPRETED_KEYS = Object.freeze(['pin', 'prefix', 'ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);

/** The only dev texts §4 lets into the suite, and the row each belongs to. */
export const ALLOWED_DEV = Object.freeze({ 'd-024': 'no-exam', 'd-079': 'ge-in-longer', 'd-022': 'ge-in-longer', 'd-016': 'unrouted-code-in-longer' });

/** Lower-case, every non-alphanumeric run to one space. @param {string} s */
export const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** @param {string} s */
const tokenSet = (s) => new Set(normalise(s).split(' ').filter(Boolean));

/** Token Jaccard. @param {string} a @param {string} b */
export function jaccard(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Near-duplicate: equal after normalising (with or without spaces), or a token
 * Jaccard of at least 0.5.
 * @param {string} a @param {string} b
 */
export const nearDuplicate = (a, b) => normalise(a) === normalise(b)
  || normalise(a).replace(/ /g, '') === normalise(b).replace(/ /g, '')
  || jaccard(a, b) >= 0.5;

/**
 * Every text the suite carries: item texts, typo clean forms, constraint references.
 * @param {any[]} items
 */
export function suiteTexts(items) {
  /** @type {{ id: string, text: string, field: string }[]} */
  const out = [];
  for (const it of items) {
    out.push({ id: it.id, text: it.text, field: 'text' });
    if (it.params?.clean) out.push({ id: it.id, text: it.params.clean, field: 'params.clean' });
    if (it.params?.reference) out.push({ id: it.id, text: it.params.reference, field: 'params.reference' });
  }
  return out;
}

/** The dev query set (open; read for the near-duplicate check only). @returns {{ id: string, text: string }[]} */
export const devQueries = () => readJson(join(REPO, 'eval/dev/queries.json')).queries;
