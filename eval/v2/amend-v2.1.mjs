// Amendment v2 -> v2.1 of the eval query sets (PR #10 review; ADR 0003 "v2.1").
// Run once by the holdout custodian. Deterministic for dev; the holdout's code
// queries are redrawn from a secret seed held only in custody.
//
//   node eval/v2/amend-v2.1.mjs --dev eval/dev/queries.json \
//     --holdout <custody>/queries.holdout.v2.json --out-holdout <custody>/queries.holdout.v2.1.json \
//     --seed-file <custody>/code-seed.v2.1 --module-info <repo>/.data/2026-2027-moduleInfo.json
//
// 1. Code queries get a form shape (code-exact, code-space, code-partial,
//    code-nonexistent), so eval/lib/metrics.mjs EXACT_CODE_SHAPES applies.
// 2. Non-existent-code queries get noAnswerByRule: true.
// 3. A "typo" query whose text equals its source's (no word of 4+ letters to
//    edit) is dropped: it duplicated its source.
// 4. Holdout only: every code query is redrawn, same form, from the same pools
//    as eval/v2/build-queries.mjs but with the secret seed. The v2 picks came
//    from the committed seed and committed/released data, so anyone could
//    rebuild them. Excluded from the draw: anything overlapping (as a prefix,
//    either way) a v2 code pick (dev and holdout), a code example shown to
//    persona writers (eval/v2/PERSONAS.md), or an earlier draw. Partial
//    queries are redrawn as code families, never GE pillars (too few to hide).
// Prints counts only; never the holdout's text.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: {
  dev: { type: 'string' }, holdout: { type: 'string' }, 'out-holdout': { type: 'string' },
  'seed-file': { type: 'string' }, 'module-info': { type: 'string' }, ng: { type: 'string', default: 'data/ng-courses-2026-2027.json' },
} });
for (const k of ['dev', 'holdout', 'out-holdout', 'seed-file', 'module-info']) if (!a[k]) throw new Error(`--${k} is required`);

/** Code examples persona writers saw (PERSONAS.md); never drawn. */
const WRITER_EXAMPLES = ['CS3244', 'CS32', 'GEA'];

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const dev = read(a.dev);
const hold = read(a.holdout);
if (dev.version !== 'v2' || hold.version !== 'v2') throw new Error('expected two v2 sets');

// Secret seed: created once, kept in custody, never printed or committed.
if (!existsSync(a['seed-file'])) writeFileSync(a['seed-file'], `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
const SEED = readFileSync(a['seed-file'], 'utf8').trim();
let ctr = 0;
const rnd = () => createHash('sha256').update(`${SEED}:${ctr++}`).digest().readUInt32BE(0) / 2 ** 32;
const shuffle = (xs) => { xs = xs.slice(); for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };

const ng = read(a.ng);
const info = read(a['module-info']);
const offered = new Set(info.filter((r) => (r.semesterData ?? []).length).map((r) => r.moduleCode));
const ngSem = new Map();
for (const [s, codes] of Object.entries(ng.semesters)) for (const c of codes) { if (!ngSem.has(c)) ngSem.set(c, []); ngSem.get(c).push(Number(s)); }
const level = (c) => Number(c.match(/\d/)[0]);

const v2Targets = [...new Set([...dev.queries, ...hold.queries].filter((q) => q.origin === 'code').map((q) => q.target))];
// Two targets overlap when one is a prefix of the other (a code and its
// letter-suffixed variant, a family prefix and the codes under it). A drawn
// target may not overlap any v2 pick, writer example or earlier draw.
const overlaps = (x, y) => x.startsWith(y) || y.startsWith(x);
const banned = (t) => [...v2Targets, ...WRITER_EXAMPLES].some((e) => overlaps(t, e));
const pool = shuffle([...ngSem.keys()].filter((c) => offered.has(c) && level(c) <= 4 && /^[A-Z]{2,4}\d{4}[A-Z]?$/.test(c) && !banned(c)));
const used = new Set();
const clashes = (t) => banned(t) || [...used].some((u) => overlaps(t, u));
const take = (ok) => { const c = pool.find((x) => !clashes(x) && ok(x)); if (!c) throw new Error('code pool exhausted'); used.add(c); return c; };

/** Same record shape as build-queries.mjs, for a newly drawn target. */
function codeRecord(old, form, target, text) {
  const sems = form === 'exact' || form === 'space' ? ngSem.get(target) : null;
  const filters = { ng: true, ...(sems?.length === 1 ? { sem: sems[0] } : {}) };
  const narrative = form === 'nonexistent'
    ? { relevant: `Nothing: ${target} is not an NUS course this year; the tool should say so rather than show unrelated courses.`, partial: 'none', notRelevant: 'any course' }
    : form === 'partial'
      ? { relevant: `Courses whose code starts with ${target}, open to exchange students.`, partial: 'Courses with a similar code family or subject.', notRelevant: 'Courses unrelated to that code prefix.' }
      : { relevant: `The course ${target} itself.`, partial: `Variants or cross-listings of ${target} (same base code with a letter suffix).`, notRelevant: 'Any other course.' };
  const shapes = form === 'nonexistent' ? ['code', 'noanswer'] : (form === 'partial' && target.startsWith('GE') ? ['code', 'ge'] : ['code']);
  return { ...old, shapes, text, filters, narrative, target };
}

function redraw(q) {
  const form = q.codeForm;
  if (form === 'exact') { const c = take(() => true); return codeRecord(q, form, c, c); }
  if (form === 'space') { const c = take(() => true); const m = c.match(/^([A-Z]+)(\d.*)$/); return codeRecord(q, form, c, `${m[1].toLowerCase()} ${m[2].toLowerCase()}`); }
  if (form === 'partial') {
    // Always a code family: a GE pillar has six possible values, three of
    // them public (dev, writer example, the rebuildable v2 pick), so it could
    // be guessed (PR #10 review round 2).
    const famOf = (/** @type {string} */ c) => c.match(/^[A-Z]+\d\d/)[0];
    const fam = famOf(take((c) => !clashes(famOf(c))));
    used.add(fam);
    return codeRecord(q, form, fam, fam);
  }
  if (form === 'nonexistent') {
    const lower = q.text === q.text.toLowerCase();
    for (;;) {
      const c = `${shuffle(['CS', 'MA', 'EC', 'BT', 'LSM', 'PH'])[0]}${1000 + Math.floor(rnd() * 3999)}`;
      if (offered.has(c) || info.some((r) => r.moduleCode === c) || banned(c) || used.has(c)) continue;
      used.add(c);
      return codeRecord(q, form, c, lower ? c.toLowerCase() : c);
    }
  }
  throw new Error(`unknown code form ${form}`);
}

/** Steps 1-3 (and 4 when `redrawCodes`). Returns the new set and counts. */
function amend(set, redrawCodes) {
  const byId = new Map(set.queries.map((q) => [q.id, q]));
  const dropped = set.queries.filter((q) => q.origin === 'typo' && byId.get(q.source)?.text === q.text).map((q) => q.id);
  let redrawn = 0;
  const queries = set.queries.filter((q) => !dropped.includes(q.id)).map((q) => {
    if (q.origin !== 'code') return q;
    const base = redrawCodes ? (redrawn++, redraw(q)) : q;
    return {
      ...base,
      shapes: [...base.shapes.filter((s) => !s.startsWith('code-')), `code-${q.codeForm}`],
      ...(q.codeForm === 'nonexistent' ? { noAnswerByRule: true } : {}),
    };
  });
  const amendment = 'v2.1: code-<form> shapes; noAnswerByRule on non-existent codes; typo copies of their source dropped'
    + (redrawCodes ? '; code queries redrawn from a custody-held seed' : '');
  const out = { ...set, version: 'v2.1', amendment, queries };
  const shapes = {};
  queries.forEach((q) => q.shapes.forEach((s) => (shapes[s] = (shapes[s] ?? 0) + 1)));
  return { out, counts: { queries: queries.length, dropped: dropped.length, redrawn, noAnswerByRule: queries.filter((q) => q.noAnswerByRule).length, shapes } };
}

const d = amend(dev, false);
const h = amend(hold, true);
// Redrawn holdout targets must not collide with dev's.
const devTargets = new Set(d.out.queries.filter((q) => q.origin === 'code').map((q) => q.target));
const clash = h.out.queries.filter((q) => q.origin === 'code' && devTargets.has(q.target)).length;
if (clash) throw new Error(`${clash} redrawn holdout code targets collide with dev`);
const minShape = (c) => Math.min(...Object.values(c.shapes));

writeFileSync(a.dev, `${JSON.stringify(d.out, null, 1)}`);
writeFileSync(a['out-holdout'], JSON.stringify(h.out, null, 1), { mode: 0o600 });
console.log(JSON.stringify({ dev: d.counts, holdout: { ...h.counts, shapes: undefined, minShapeCount: minShape(h.counts) } }, null, 1));
