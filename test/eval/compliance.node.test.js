// @ts-check
// Phase 5 5F's compliance rule (`--change-kind compliance`), on a synthetic
// set built here (test/eval/compliance-set.node.mjs): pure checks of the
// rule, then the CLI end to end, on the encrypted `selftest` set with a
// throwaway key (the holdout's verdict path: verdict, Δ lines and counts
// only; a parse mismatch, a reference parsing nothing, missing constraint
// fields or a missing parse record spend no look) and on an open set (the
// dev path, with per-query detail). The real reference parse (tag 3h) runs
// over the synthetic corpus's vocabulary.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADR_0003, applyComplianceRule, assertReferenceTag, assertRuleAdopted, candidateParse, DRAFT_MARKER, failedConstraint, queryConstraints, REFERENCE_PARSE, sameParse } from '../../eval/lib/compliance.mjs';
import { generateKey, readKey, updateManifest, writeEncryptedJson } from '../../eval/lib/crypto.mjs';
import { ParseMismatchError, ReferenceParseError } from '../../eval/lib/errors.mjs';
import { GateRuleError } from '../../eval/lib/errors.mjs';
import { CHANGE_KINDS, gateFor, ruleOf } from '../../eval/lib/gate.mjs';
import { ledgerRows } from '../../eval/lib/ledger.mjs';
import { loadStudyMap, REPO } from '../../eval/lib/sets.mjs';
import { CSCU, codeOf, mod, PARSED, syntheticSet } from './compliance-set.node.mjs';
import { archiveTree, labelRe, rankerAt, SHIPPED_PIN } from './pins.node.mjs';

const CLI = join(REPO, 'eval', 'cli.mjs');
const PHRASES = join(REPO, 'eval', 'phrases.mjs');

/** @type {string} */
let tmp;
/** @type {string} */
let keyFile;
/** @type {Buffer} */
let key;
/** @type {string} */
let pinTree;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vnm-compliance-'));
  keyFile = await generateKey(join(tmp, 'throwaway.key'));
  key = await readKey(keyFile);
  pinTree = await archiveTree(SHIPPED_PIN.sha);
});
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const candRanker = () => ({ ref: 'WORKTREE', sha: 'c'.repeat(40), dirty: false, treeHash: 'd'.repeat(64), runner: { sha: 'c'.repeat(40), dirty: false } });
/** @param {string} set */
const fresh = (set) => syntheticSet(set, { ranker: { base: rankerAt(SHIPPED_PIN, pinTree), cand: candRanker() } });
/** @typedef {ReturnType<typeof fresh>} Synthetic */

/**
 * Writes the synthetic set to a directory: encrypted (bound to `selftest`,
 * manifested) or plain (an open `fixture`-layout set). corpus.json is plain
 * either way, as a set's corpus is public.
 * @param {string} name
 * @param {{ encrypted: boolean, tweak?: (s: Synthetic) => void }} o
 */
async function makeSet(name, o) {
  const dir = join(tmp, name);
  const s = fresh(o.encrypted ? 'selftest' : 'fixture');
  o.tweak?.(s);
  if (o.encrypted) {
    await writeEncryptedJson(join(dir, 'queries.json.enc'), s.querySet, key, 'selftest');
    await writeEncryptedJson(join(dir, 'qrels.json.enc'), s.qrels, key, 'selftest');
    await writeEncryptedJson(join(dir, 'runs', 'run-base.json.enc'), s.base, key, 'selftest');
    await writeEncryptedJson(join(dir, 'runs', 'run-cand.json.enc'), s.cand, key, 'selftest');
    await updateManifest(dir);
  } else {
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(join(dir, 'queries.json'), JSON.stringify(s.querySet));
    await writeFile(join(dir, 'qrels.json'), JSON.stringify(s.qrels));
    await writeFile(join(dir, 'runs', 'base.json'), JSON.stringify(s.base));
    await writeFile(join(dir, 'runs', 'cand.json'), JSON.stringify(s.cand));
  }
  await writeFile(join(dir, 'corpus.json'), JSON.stringify(s.corpus));
  return { dir, s };
}

/** @param {string} script @param {string[]} args */
function node(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, VNM_HOLDOUT_KEY_FILE: keyFile, FORCE_COLOR: '0' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}
/** @param {string} dir @param {string[]} [extra] */
const report = (dir, extra = ['--change-kind', 'compliance']) => node(CLI, ['report', '--set', 'selftest', '--set-dir', dir, '--run', 'cand', '--baseline', 'base', ...extra]);
/** @param {string} dir */
const ledgerOf = async (dir) => (existsSync(join(dir, 'ledger.md')) ? ledgerRows(await readFile(join(dir, 'ledger.md'), 'utf8')) : []);
/** @param {string} cls */
const withheld = (cls) => `eval: selftest run failed (${cls}); details withheld\n`;
/** No query id, query text or code of the set in `out`. @param {string} out @param {Synthetic} s */
const assertNoLeak = (out, s) => { for (const x of s.secrets) expect(out.includes(x), `output names ${x}`).toBe(false); };

describe('the rule, pure', () => {
  it('applies each constraint as /search does', () => {
    const o = { prereq: 'ii', suGrading: (/** @type {string | null} */ b) => b === CSCU };
    expect(failedConstraint(mod('A', { examSemesters: [1] }), { exam: 0 }, o)).toBe('exam');
    expect(failedConstraint(mod('A', { examSemesters: [1] }), { exam: 0 }, { ...o, sem: 2 })).toBeNull();
    expect(failedConstraint(mod('A', { workloadHours: 10 }), { hoursBelow: 10 }, o)).toBe('hoursBelow');
    expect(failedConstraint(mod('A', { prereqNone: false, prereqCohortOnly: true }), { prereq: 'none' }, o)).toBeNull();
    expect(failedConstraint(mod('A', { prereqNone: false, prereqCohortOnly: true }), { prereq: 'none' }, { ...o, prereq: 'i' })).toBe('prereq');
  });

  it('reads the candidate\'s parse from its interpreted echo, and any difference is a mismatch', () => {
    const ref = { constraints: { prereq: 'none' }, semantics: 'ii' };
    expect(sameParse(candidateParse({ exam: null, su: null, hoursBelow: null, prereq: { value: 'none', semantics: 'ii' } }), ref)).toBe(true);
    expect(sameParse(candidateParse({ exam: null, su: null, hoursBelow: null, prereq: { value: 'none', semantics: 'i' } }), ref)).toBe(false);
    expect(sameParse(candidateParse({ exam: 0, su: null, hoursBelow: null, prereq: { value: 'none', semantics: 'ii' } }), ref)).toBe(false);
    expect(sameParse(candidateParse(null), { constraints: {}, semantics: null })).toBe(true);
    expect(sameParse(candidateParse({ exam: 1 }), { constraints: { exam: 0 }, semantics: null })).toBe(false);
    expect(candidateParse({ su: { value: 1, basis: [] }, hoursBelow: 12 })).toEqual({ constraints: { su: 1, hoursBelow: 12 }, semantics: null });
  });

  it('an exchange-mode query is constrained by its semester and study level\'s allow bit', async () => {
    const { ngBit } = await import('../../src/ng-bit.js');
    const none = { constraints: {}, semantics: null };
    const c = queryConstraints({ id: 'x', text: 't', filters: { ng: true, sem: 2 }, persona: 'P1' }, none, loadStudyMap(), ngBit);
    expect(c.exchange).toEqual({ sem: 2, bit: ngBit({ ng: true, sem: 2, study: 'ug3' }) });
    expect(queryConstraints({ id: 'x', text: 't', filters: { sem: 2 } }, none, loadStudyMap(), ngBit).exchange).toBeNull();
    expect(queryConstraints({ id: 'x', text: 't', filters: { ng: true, sem: 3 } }, none, loadStudyMap(), ngBit).exchange?.bit).toBe(0);
  });

  it('filters the qrels in DCG and IDCG alike, unscores a query left with none, and scores both runs on the same filtered qrels', async () => {
    const { ngBit } = await import('../../src/ng-bit.js');
    const s = fresh('fixture');
    const byCode = new Map(s.corpus.modules.map((m) => [m.code, /** @type {any} */ (m)]));
    const parses = new Map(PARSED.map((p) => [p.text, candidateParse(p.parse)]));
    const sources = {
      reference: (/** @type {string} */ t) => ({ ...(parses.get(t) ?? { constraints: {}, semantics: null }), corrected: null }),
      fieldsOf: (/** @type {string} */ c) => byCode.get(c),
      suGrading: (/** @type {string | null} */ b) => b === CSCU,
      ngBit,
      source: { reference: 'test', vocabularySha256: 'x', fields: 'test', lib: 'test', runTextSha256: /** @type {any} */ (s.cand.corpus).textSha256, fieldsSha256: /** @type {any} */ (s.cand.corpus).constraintFieldsSha256 },
    };
    const r = applyComplianceRule({ queries: s.querySet.queries, qrels: s.qrels, base: s.base, cand: s.cand, sources });
    // syn-p1: the two relevant documents with a real prerequisite count for nothing, so the
    // compliant list is ideal (nDCG 1) and the baseline's (which ranks them first) is not.
    const i = s.querySet.queries.findIndex((q) => q.id === 'syn-p1');
    expect(r.scores.cand[i].ndcg).toBeCloseTo(1, 12);
    expect(r.scores.base[i].ndcg).toBeLessThan(1);
    expect(Object.keys(r.detail.removed['syn-p1'].removed).sort()).toEqual([codeOf('syn-p1', 0), codeOf('syn-p1', 3)]);
    // syn-p2 (exchange, sem 1): the sem-1 exam and the closed course are removed; a sem-2 exam is fine.
    expect(r.detail.removed['syn-p2'].removed).toEqual({ [codeOf('syn-p2', 0)]: 'exam', [codeOf('syn-p2', 2)]: 'exchange' });
    expect(r.cmp.overall.ndcg.delta).toBeGreaterThan(0);
    expect(r.raw.overall.ndcg.delta).toBeLessThan(0);
    expect(r.counts).toEqual({ parsed: 4, primary: 15, block: 1, unscored: 0 });
    expect(r.compliance.violations).toEqual([]);
    expect(r.identity).toEqual({ queries: 12, differing: [] });
    expect(r.newErrors).toEqual([]);

    // A query whose every relevant document fails its constraint is unscored, not a zero.
    const q2 = structuredClone(s.qrels);
    q2.queries['syn-p1'].judgments[codeOf('syn-p1', 1)] = 0;
    q2.queries['syn-p1'].judgments[codeOf('syn-p1', 2)] = 0;
    const r2 = applyComplianceRule({ queries: s.querySet.queries, qrels: q2, base: s.base, cand: s.cand, sources });
    expect(r2.detail.emptied).toEqual(['syn-p1']);
    expect(r2.counts).toEqual({ parsed: 4, primary: 14, block: 1, unscored: 1 });
  });

  it('the gate takes compliance on dev and the holdout, never the test set, and needs the rule\'s checks', () => {
    expect(CHANGE_KINDS).toContain('compliance');
    expect(ruleOf('holdout', { kind: 'compliance' })).toBe('compliance');
    const cmp = /** @type {any} */ ({ n: 10, overall: { ndcg: { delta: 0 }, p5: { delta: 0 } }, judged: { base: 1, cand: 1 }, errors: { base: 0, cand: 0 }, exactCodeRegressions: [] });
    expect(() => gateFor('test', cmp, { kind: 'compliance' })).toThrow(GateRuleError);
    expect(() => gateFor('holdout', cmp, { kind: 'compliance' })).toThrow(GateRuleError);
    const checks = { raw: cmp, block: { n: 0, delta: NaN }, compliance: { queries: 1, violations: 0 }, identity: { queries: 9, differing: 0 }, newErrors: 0 };
    const v = gateFor('holdout', cmp, { kind: 'compliance' }, { compliance: checks });
    expect(v.verdict).toBe('pass');
    expect(v.rule).toBe('compliance (constraint block vacuous)');
    expect(v.checks.find((c) => c.name.startsWith('constraint block'))?.detail).toMatch(/vacuous pass/);
    expect(gateFor('holdout', cmp, { kind: 'compliance' }, { compliance: { ...checks, block: { n: 2, delta: -0.01 } } }).verdict).toBe('fail');
    expect(gateFor('holdout', cmp, { kind: 'compliance' }, { compliance: { ...checks, compliance: { queries: 1, violations: 1 } } }).verdict).toBe('fail');
    expect(gateFor('holdout', cmp, { kind: 'compliance' }, { compliance: { ...checks, identity: { queries: 9, differing: 1 } } }).verdict).toBe('fail');
    expect(gateFor('holdout', cmp, { kind: 'compliance' }, { compliance: { ...checks, raw: { ...cmp, exactCodeRegressions: ['x'] } } }).verdict).toBe('fail');
    expect(gateFor('holdout', cmp, { kind: 'compliance' }, { compliance: { ...checks, newErrors: 1 } }).verdict).toBe('fail');
  });

  it('a draft amendment refuses the rule on the holdout and test sets (not the throwaway selftest set); the adopted ADR allows it', async () => {
    const adopted = await readFile(ADR_0003, 'utf8');
    // The lead adopted the amendment on 2026-11-11: the draft line is gone.
    expect(adopted).not.toContain(DRAFT_MARKER);
    expect(adopted).toContain('Adopted by the lead, 2026-11-11');
    expect(() => assertRuleAdopted({ name: 'holdout', encrypted: true }, adopted)).not.toThrow();
    const draft = `${adopted}\n${DRAFT_MARKER}\n`;
    expect(() => assertRuleAdopted({ name: 'holdout', encrypted: true }, draft)).toThrow(GateRuleError);
    expect(() => assertRuleAdopted({ name: 'test', encrypted: true }, draft)).toThrow(GateRuleError);
    expect(() => assertRuleAdopted({ name: 'selftest', encrypted: true }, draft)).not.toThrow();
    expect(() => assertRuleAdopted({ name: 'dev', encrypted: false }, draft)).not.toThrow();
  });

  it('the reference is frozen at tag 3h = 2476012, and a moved tag is refused', async () => {
    expect(REFERENCE_PARSE).toEqual({ tag: '3h', sha: '24760122a489dac6e4c604c1bacb8cd002624391' });
    expect(() => assertReferenceTag()).not.toThrow();
    const clone = join(tmp, 'moved-tag');
    expect(spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', REPO, clone]).status).toBe(0);
    expect(spawnSync('git', ['update-ref', 'refs/tags/3h', '7ac984174ded88cb2b6497d9835b456981acdd99'], { cwd: clone }).status).toBe(0);
    expect(() => assertReferenceTag(clone)).toThrow(ReferenceParseError);
  });
});

describe('the holdout verdict path, on the encrypted selftest set', () => {
  it('prints only the verdict, the Δ lines and the counts, and records one look with the rule', async () => {
    const { dir, s } = await makeSet('pass', { encrypted: true });
    const r = report(dir);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    assertNoLeak(r.out, s);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(new RegExp(`^holdout verdict: PASS · rule compliance · baseline ${labelRe(SHIPPED_PIN)} · qrels qrels-synthetic-5f-v1$`));
    expect(lines[1]).toMatch(/^ΔnDCG@10 \+\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\] \(BCa 95%, constraint-filtered qrels\)$/);
    expect(lines[2]).toMatch(/^ΔP@5 +[+-]\d\.\d{3} \[-?\d\.\d{3}, -?\d\.\d{3}\] \(BCa 95%, constraint-filtered qrels\)$/);
    expect(lines[3]).toMatch(/^constraint block ΔnDCG@10 \+\d\.\d{3} \(n 1\)$/);
    expect(lines[4]).toBe('scored queries: 15 primary, 1 constraint block · unscored queries: 0 · parsed queries: 4');
    const rows = await ledgerOf(dir);
    expect(rows.map((c) => [c[3], c[5], c[8]])).toEqual([['cand', 'pass', 'compliance']]);
    // The same runs fail the general rule, which scores removed ineligible documents as loss (3H's L7).
    const general = report(dir, ['--change-kind', 'general']);
    expect(general.stdout).toMatch(/^holdout verdict: FAIL · rule general/m);
  });

  it('a parse mismatch on one query throws before the ledger row: no look is spent, nothing is named', async () => {
    const { dir, s } = await makeSet('mismatch', { encrypted: true, tweak: (x) => { /** @type {any} */ (x.cand.intents)['syn-p3'].hoursBelow = 12; } });
    const r = report(dir);
    expect(r.code).toBe(1);
    expect(r.out).toBe(withheld('ParseMismatchError'));
    assertNoLeak(r.out, s);
    expect(existsSync(join(dir, 'ledger.md'))).toBe(false);
    // A candidate that parses an unparsed query is a mismatch too.
    const { dir: d2 } = await makeSet('mismatch-extra', { encrypted: true, tweak: (x) => { /** @type {any} */ (x.cand.intents)['syn-u01'].exam = 0; } });
    expect(report(d2).out).toBe(withheld('ParseMismatchError'));
    expect(existsSync(join(d2, 'ledger.md'))).toBe(false);
  });

  it('a mismatch after earlier looks leaves the ledger byte-identical', async () => {
    const { dir } = await makeSet('mismatch-after-look', { encrypted: true });
    expect(report(dir).code).toBe(0);
    const before = await readFile(join(dir, 'ledger.md'), 'utf8');
    const s = fresh('selftest');
    /** @type {any} */ (s.cand.intents)['syn-p1'].prereq = { value: 'none', semantics: 'i' };
    await writeEncryptedJson(join(dir, 'runs', 'run-cand2.json.enc'), { ...s.cand, variant: 'cand2' }, key, 'selftest');
    await updateManifest(dir);
    const r = node(CLI, ['report', '--set', 'selftest', '--set-dir', dir, '--run', 'cand2', '--baseline', 'base', '--change-kind', 'compliance']);
    expect(r.out).toBe(withheld('ParseMismatchError'));
    expect(await readFile(join(dir, 'ledger.md'), 'utf8')).toBe(before);
  });

  it('refuses, with no look, a set the reference parses nothing in, missing constraint fields, and a run with no parse record', async () => {
    const none = await makeSet('no-parse', {
      encrypted: true,
      tweak: (x) => {
        for (const q of x.querySet.queries) if (q.id.startsWith('syn-p')) q.text = `plain topical query ${q.id.slice(-1)}`;
        for (const id of Object.keys(/** @type {any} */ (x.cand.intents))) /** @type {any} */ (x.cand.intents)[id] = null;
      },
    });
    const r1 = report(none.dir);
    expect(r1.out).toBe(withheld('ReferenceParseError'));
    assertNoLeak(r1.out, none.s);
    expect(existsSync(join(none.dir, 'ledger.md'))).toBe(false);

    // Both runs return a code the corpus does not have.
    const fields = await makeSet('no-fields', { encrypted: true, tweak: (x) => { x.base.results['syn-u03'].codes.push('ZZ99X9'); x.cand.results['syn-u03'].codes.push('ZZ99X9'); } });
    expect(report(fields.dir).out).toBe(withheld('ConstraintFieldsError'));
    expect(existsSync(join(fields.dir, 'ledger.md'))).toBe(false);

    const unrecorded = await makeSet('no-intents', { encrypted: true, tweak: (x) => { delete x.cand.intents; } });
    expect(report(unrecorded.dir).out).toBe(withheld('RunFileError'));
    expect(existsSync(join(unrecorded.dir, 'ledger.md'))).toBe(false);

    const noDigest = await makeSet('no-digest', { encrypted: true, tweak: (x) => { delete /** @type {any} */ (x.cand.corpus).constraintFieldsSha256; } });
    expect(report(noDigest.dir).out).toBe(withheld('RunFileError'));
    expect(existsSync(join(noDigest.dir, 'ledger.md'))).toBe(false);
  });

  it('reads only the corpus the candidate was seeded with: an edited corpus.json is refused, with no look (review finding 1)', async () => {
    const { dir } = await makeSet('tampered', { encrypted: true, tweak: (x) => { x.cand.results['syn-p2'].codes.unshift(codeOf('syn-p2', 0)); } });
    expect(report(dir).stdout).toMatch(/^holdout verdict: FAIL · rule compliance/m);
    const corpus = JSON.parse(await readFile(join(dir, 'corpus.json'), 'utf8'));
    for (const m of corpus.modules) m.examSemesters = [];
    await writeFile(join(dir, 'corpus.json'), JSON.stringify(corpus));
    const before = await readFile(join(dir, 'ledger.md'), 'utf8');
    expect(report(dir).out).toBe(withheld('CorpusMismatchError'));
    // A changed title (the reference's vocabulary) is refused too.
    corpus.modules[0].text = 'something else';
    await writeFile(join(dir, 'corpus.json'), JSON.stringify(corpus));
    expect(report(dir).out).toBe(withheld('CorpusMismatchError'));
    expect(await readFile(join(dir, 'ledger.md'), 'utf8')).toBe(before);
  });

  it('a candidate error on a query the baseline answered fails, even when the error totals match (review finding 2)', async () => {
    const { dir, s } = await makeSet('error-swap', {
      encrypted: true,
      tweak: (x) => {
        x.base.results['syn-p1'] = { status: 500, codes: [] };
        x.cand.results['syn-p3'] = { status: 500, codes: [] };
        /** @type {any} */ (x.cand.intents)['syn-p3'] = { exam: 0, su: null, hoursBelow: 99, prereq: null };
      },
    });
    const r = report(dir);
    expect(r.stdout).toMatch(/^holdout verdict: FAIL · rule compliance/m);
    assertNoLeak(r.out, s);
  });

  it('fails on a compliance breach, a changed unparsed top 10, or an exact-code loss on the raw qrels; still prints nothing set-specific', async () => {
    const breach = await makeSet('breach', { encrypted: true, tweak: (x) => { x.cand.results['syn-p2'].codes.unshift(codeOf('syn-p2', 0)); } });
    const b = report(breach.dir);
    expect(b.stdout).toMatch(/^holdout verdict: FAIL · rule compliance/m);
    assertNoLeak(b.out, breach.s);

    const moved = await makeSet('identity', { encrypted: true, tweak: (x) => { x.cand.results['syn-u05'].codes.reverse(); } });
    const m = report(moved.dir);
    expect(m.stdout).toMatch(/^holdout verdict: FAIL · rule compliance/m);
    assertNoLeak(m.out, moved.s);

    // syn-p2 as an exact-code query whose second relevant document is graded 1: the baseline's
    // rank 1 (grade 2 on the raw qrels) has a sem-1 exam, so the compliant candidate drops it
    // and its rank 1 is graded 1. No loss on the filtered qrels; a regression on the raw ones.
    const exactTweak = (/** @type {Synthetic} */ x) => {
      /** @type {any} */ (x.querySet.queries.find((q) => q.id === 'syn-p2')).shapes = ['code-exact'];
      x.qrels.queries['syn-p2'].judgments[codeOf('syn-p2', 1)] = 1;
    };
    const exact = await makeSet('exact-code', { encrypted: true, tweak: exactTweak });
    const e = report(exact.dir);
    expect(e.stdout).toMatch(/^holdout verdict: FAIL · rule compliance/m);
    assertNoLeak(e.out, exact.s);
    expect(await ledgerOf(exact.dir)).toHaveLength(1);
    // The open path shows it is the raw-qrels exact-code check, and only it, that fails.
    const open = await makeSet('exact-code-open', { encrypted: false, tweak: exactTweak });
    const o = node(CLI, ['report', '--set', 'fixture', '--set-dir', open.dir, '--run', 'cand', '--baseline', 'base', '--change-kind', 'compliance']);
    expect(o.stdout.split('\n').filter((l) => l.startsWith('  [FAIL]'))).toEqual(['  [FAIL] no exact-code regression (raw qrels) — 1 exact-code queries lost their rank-1 hit']);
  });

  it('an empty constraint block is a recorded vacuous pass', async () => {
    const { dir, s } = await makeSet('vacuous', { encrypted: true, tweak: (x) => { /** @type {any} */ (x.querySet.queries.find((q) => q.id === 'syn-p4')).shapes = ['topical']; } });
    const r = report(dir);
    expect(r.stdout).toMatch(/^holdout verdict: PASS · rule compliance \(constraint block vacuous\)/m);
    expect(r.stdout).toMatch(/^constraint block ΔnDCG@10 — \(vacuous pass: no scored query\)$/m);
    expect(r.stdout).toMatch(/^scored queries: 16 primary, 0 constraint block/m);
    assertNoLeak(r.out, s);
    expect((await ledgerOf(dir)).map((c) => c[8])).toEqual(['compliance (constraint block vacuous)']);
  });

  it('`npm run eval` refuses the compliance kind on an encrypted set before reserving a look', async () => {
    const { dir } = await makeSet('run-refused', { encrypted: true });
    const r = node(CLI, ['run', '--set', 'selftest', '--set-dir', dir, '--variant', 'cand3', '--baseline', 'base', '--change-kind', 'compliance']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/taken on stored runs/);
    expect(existsSync(join(dir, 'ledger.md'))).toBe(false);
    expect(existsSync(join(dir, 'runs', 'run-cand3.json.enc'))).toBe(false);
  });

  it('eval:phrases refuses an encrypted set', async () => {
    const { dir } = await makeSet('phrases-refused', { encrypted: true });
    const r = node(PHRASES, ['list', '--set', 'selftest', '--set-dir', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/encrypted/);
  });
});

describe('the open-set path (dev and the fixture)', () => {
  it('prints the same verdict with per-query detail', async () => {
    const { dir } = await makeSet('open', { encrypted: false });
    const r = node(CLI, ['report', '--set', 'fixture', '--set-dir', dir, '--run', 'cand', '--baseline', 'base', '--change-kind', 'compliance', '--json', join(dir, 'out.json')]);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^gate \(dev\): PASS · rule compliance$/m);
    expect(r.stdout).toMatch(/^parsed by the reference \(4\):$/m);
    expect(r.stdout).toMatch(/^ {2}syn-p1 {2}"intro programming no prerequisites" {2}\{"prereq":"none"\} \(prereq ii\) {2}ΔnDCG@10 \+\d\.\d{3} {2}compliance ok$/m);
    expect(r.stdout).toMatch(new RegExp(`^ {2}syn-p2: ${codeOf('syn-p2', 0)} \\(exam\\), ${codeOf('syn-p2', 2)} \\(exchange\\)$`, 'm'));
    expect(r.stdout).toMatch(/^unparsed queries whose top 10 differ from the baseline \(0 of 12\): none$/m);
    expect(r.stdout).toMatch(/candidate run recorded none \(DIFFERENT\)/);
    const json = JSON.parse(await readFile(join(dir, 'out.json'), 'utf8'));
    expect(json.counts).toEqual({ parsed: 4, primary: 15, block: 1, unscored: 0 });
    expect(json.verdict.verdict).toBe('pass');
  });

  it('names the queries a mismatch is on, and the reference-parse listing names every parsed query', async () => {
    const { dir } = await makeSet('open-mismatch', { encrypted: false, tweak: (x) => { /** @type {any} */ (x.cand.intents)['syn-p2'].exam = null; } });
    const r = node(CLI, ['report', '--set', 'fixture', '--set-dir', dir, '--run', 'cand', '--baseline', 'base', '--change-kind', 'compliance']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/differs from the reference parse \(3h\) on 1 of 16 queries/);
    const list = node(PHRASES, ['list', '--set', 'fixture', '--set-dir', dir]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/^4 of 16 queries parsed/m);
    for (const p of PARSED) expect(list.stdout).toContain(`${p.id}  ${JSON.stringify(p.text)}`);
    expect(list.stdout).toMatch(/^syn-p2 {2}"project course with no final exam" {2}-> {2}exam=0 {2}filters \{"ng":true,"sem":1\}$/m);
  });

  it('the screen reuses existing runs and reports the gate and the B2-4 diagnostic', async () => {
    const { dir, s } = await makeSet('screen', { encrypted: false });
    // The screen's run names; the diagnostic's baseline carries the explicit params.
    await writeFile(join(dir, 'runs', 't-cand.json'), JSON.stringify({ ...s.cand, variant: 't-cand', config: { ...s.cand.config, vocabulary: { sha256: 'none' } } }));
    await writeFile(join(dir, 'runs', 't-pin.json'), JSON.stringify({ ...s.base, variant: 't-pin' }));
    await writeFile(join(dir, 'runs', 't-pin-explicit.json'), JSON.stringify({ ...s.cand, intents: undefined, variant: 't-pin-explicit', config: { ...s.base.config, explicit: 'reference-3h' } }));
    const r = node(PHRASES, ['screen', '--set', 'fixture', '--set-dir', dir, '--prefix', 't', '--reuse', '--json-dir', join(dir, 'json')]);
    expect(r.stdout).toMatch(/^reference parse 3h: 4 of 16 fixture queries parsed$/m);
    expect(r.stdout).toMatch(/^gate \(dev\): PASS · rule compliance$/m);
    expect(r.stdout).toMatch(/^diagnostic \(B2-4\)/m);
    expect(r.stdout).toMatch(/^diagnostic: reported, no gate$/m);
    // The rule passes but the candidate run's vocabulary is not the reference's (A3-1): the screen fails.
    expect(r.stdout).toMatch(/^dev screen \(fixture\): FAIL · compliance rule pass · vocabulary DIFFERENT/m);
    expect(r.code).toBe(1);
    const diag = JSON.parse(await readFile(join(dir, 'json', 't-diagnostic.json'), 'utf8'));
    expect(diag.rule).toBe('diagnostic');
    expect(diag.comparison.overall.ndcg.delta).toBe(0);
  });

  it('a gate refuses a run with explicit params; only the diagnostic takes one as its baseline', async () => {
    const { dir } = await makeSet('explicit-base', { encrypted: false, tweak: (x) => { /** @type {any} */ (x.base.config).explicit = 'reference-3h'; } });
    const r = node(CLI, ['report', '--set', 'fixture', '--set-dir', dir, '--run', 'cand', '--baseline', 'base', '--change-kind', 'compliance']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/explicit 3H params/);
  });
});

it('ParseMismatchError and ReferenceParseError say no look is spent without naming a query', () => {
  expect(new ParseMismatchError('x').name).toBe('ParseMismatchError');
  expect(new ReferenceParseError('x').name).toBe('ReferenceParseError');
});
