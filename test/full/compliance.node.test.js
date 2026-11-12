// @ts-check
// The dev screen's compliance rule against the pinned snapshot: the dev queries
// the frozen reference parse (tag parse-reference) reads, confirmed by hand
// before the dev screen; every judged dev code has its constraint fields; and
// the dev screen's runner end to end on the eval fixture (three real runs in
// workerd: the working-tree candidate, the shipped pin, and the pin with the
// reference's constraints as explicit params). The working tree has
// PARSE_PHRASES on, so its parse matches the reference and the
// screen stops at the fixture's corpus mismatch, before any verdict. Skipped when .data/ has no corpus; with FULL_CORPUS=1 a missing
// corpus fails instead.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { constraintFieldsSha256, isParsed, loadRuleSources } from '../../eval/lib/compliance.mjs';
import { loadPinnedWith } from '../../eval/lib/corpus.mjs';
import { qrelsFor } from '../../eval/lib/metrics.mjs';
import { layout, loadQrels, loadQueries, REPO } from '../../eval/lib/sets.mjs';
import { MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);
const worktree = /** @type {any} */ ({ variant: 'lib', ranker: { ref: 'WORKTREE' }, results: {}, docs: {} });

/** The reference parse of dev, as `npm run eval:phrases -- list` printed it for the hand-check. */
const DEV_PARSE = {
  'd-011': { prereq: 'none' },
  'd-023': { prereq: 'none' },
  'd-024': { exam: 0 },
  'd-037': { exam: 0 },
  'd-048': { prereq: 'none' },
  'd-049': { exam: 0 },
  'd-050': { exam: 0 },
  'd-080': { prereq: 'none' },
  'd-081': { exam: 0 },
  'd-099': { prereq: 'none' },
};

describe.skipIf(!available)('the compliance rule on the pinned snapshot', () => {
  it('the reference parses exactly the hand-checked dev queries, and every judged dev code has its constraint fields', async () => {
    const set = layout('dev');
    const [{ queries }, qrels] = await Promise.all([loadQueries(set), loadQrels(set)]);
    const sources = await loadRuleSources(set, worktree);
    try {
      const parsed = Object.fromEntries(queries.map((q) => [q.id, sources.reference(q.text)]).filter(([, p]) => isParsed(/** @type {any} */ (p))).map(([id, p]) => [id, /** @type {any} */ (p).constraints]));
      expect(parsed).toEqual(DEV_PARSE);
      for (const id of Object.keys(DEV_PARSE)) if (/** @type {any} */ (DEV_PARSE)[id].prereq) expect(sources.reference(/** @type {any} */ (queries.find((q) => q.id === id)).text).semantics).toBe('ii');
      const judged = new Set(queries.flatMap((q, i) => [...qrelsFor(qrels, q.id, i).grades.keys()]));
      expect(judged.size).toBeGreaterThan(800);
      expect([...judged].filter((c) => !sources.fieldsOf(c))).toEqual([]);
      expect(sources.source.fields).toMatch(/^the pinned snapshot/);
      // A dev run records the digest of the fields it seeds (eval/runner/run.mjs): the rule's source gives the same.
      const { modules, info } = await loadPinnedWith(REPO);
      const byCode = new Map(modules.map((m) => [m.code, /** @type {any} */ (m)]));
      expect(constraintFieldsSha256([...byCode.keys()], (c) => byCode.get(c))).toBe(sources.source.fieldsSha256);
      expect(info.textSha256).toBe(sources.source.runTextSha256);
    } finally {
      await sources.close();
    }
  }, 120_000);

  it('the screen runs the fixture end to end, passes the parse check, and stops on the fixture\'s corpus mismatch, before any verdict', async () => {
    const r = spawnSync(process.execPath, [join(REPO, 'eval/phrases.mjs'), 'screen', '--set', 'fixture', '--prefix', 'full-phrases'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, FORCE_COLOR: '0' } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^reference parse parse-reference: 1 of 11 fixture queries parsed$/m);
    expect(r.stderr).not.toMatch(/ParseMismatchError/);
    expect(r.stderr).toMatch(/CorpusMismatchError: the constraint fields in the pinned snapshot .* differ from those run full-phrases-cand was seeded with/);
    expect(r.stdout).not.toMatch(/^gate \(dev\)/m);
    const runs = layout('fixture').runsDir;
    const read = async (/** @type {string} */ v) => JSON.parse(await readFile(join(runs, `${v}.json`), 'utf8'));
    const [cand, pin, explicit] = await Promise.all([read('full-phrases-cand'), read('full-phrases-pin'), read('full-phrases-pin-explicit')]);
    // The runner records each query's parse outside `results`; with PARSE_PHRASES on, fx-08 parses as the reference does.
    expect(Object.keys(cand.intents).sort()).toEqual(Object.keys(cand.results).sort());
    expect(cand.intents['fx-08']).toEqual({ exam: 0, su: null, hoursBelow: null, prereq: null });
    expect(Object.keys(cand.intents).filter((id) => id !== 'fx-08' && cand.intents[id]).every((id) => Object.values(cand.intents[id]).every((v) => v === null))).toBe(true);
    expect(cand.intents['fx-10']).toBeNull(); // a 400 echoes no parse
    // The diagnostic's baseline sends fx-08's parsed exam=0 as an explicit param, and only fx-08's.
    expect(explicit.config.explicit).toEqual({ label: 'reference-parse-reference', params: { 'fx-08': { exam: '0' } } });
    expect(pin.config.explicit).toBeUndefined();
    const sources = await loadRuleSources(layout('fixture'), cand);
    try {
      // The vocabulary the run recorded is the one the reference parsed over.
      expect(cand.config.vocabulary.sha256).toBe(sources.source.vocabularySha256);
      expect(cand.corpus.textSha256).toBe(sources.source.runTextSha256);
      // The fixture's Worker was seeded without the constraint fields, so its recorded digest is not the
      // pinned snapshot's: past the parse check, the rule refuses the fixture (CorpusMismatchError, above).
      expect(cand.corpus.constraintFieldsSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cand.corpus.constraintFieldsSha256).not.toBe(sources.source.fieldsSha256);
      // The eval fixture's corpus.json has no constraint fields, so its Worker knows no exam and
      // exam=0 removes nothing there, while the pinned snapshot (the rule's source) knows them:
      // on the fixture the rule's compliance check would flag these. The rule is exercised on
      // synthetic sets (test/eval/compliance.node.test.js); the fixture shows the plumbing.
      expect(explicit.results['fx-08']).toEqual(pin.results['fx-08']);
      expect(pin.results['fx-08'].codes.some((/** @type {string} */ c) => (sources.fieldsOf(c)?.examSemesters ?? []).length > 0)).toBe(true);
    } finally {
      await sources.close();
    }
    for (const id of Object.keys(pin.results)) if (id !== 'fx-08') expect(explicit.results[id]).toEqual(pin.results[id]);
  }, 600_000);
});
