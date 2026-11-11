// @ts-check
// scripts/p5-live-plan.mjs (Phase 5 5G): the live check's arguments and its
// seeded draw, on the fixture (the production modules live in .data/, which
// CI doesn't have). The browser half, scripts/p5-live.mjs, is run by hand:
// against the local UI server before the PR, against production after the
// deploy (README, "Live checks after a page ship").
import { describe, expect, it } from 'vitest';
import { CLOSED_KINDS, GAP_MS, PRODUCTION_URL, STRATA, drawHidden, drawSc2, loadModules, parseArgs, rng } from '../scripts/p5-live-plan.mjs';
import { bitOf } from '../src/ng-bit.js';
import { oracle } from './sc1/oracle.node.mjs';

const modules = await loadModules('fixture');

describe('arguments', () => {
  it('defaults to production: its URL, the production modules, the commit from git, the committed log', () => {
    expect(parseArgs([])).toEqual({
      url: PRODUCTION_URL, log: 'docs/evidence/phase5/p5-live.jsonl', corpus: 'production', expectCommit: '', seed: 5, dryRun: false,
    });
  });

  it('a local server: the fixture modules and no version tag, unless told otherwise', () => {
    expect(parseArgs(['--url', 'http://127.0.0.1:8911'])).toMatchObject({ url: 'http://127.0.0.1:8911', corpus: 'fixture', expectCommit: 'none' });
    expect(parseArgs(['--url', 'http://localhost:9000', '--corpus', 'production', '--expect-commit', 'abc1234'])).toMatchObject({ corpus: 'production', expectCommit: 'abc1234' });
  });

  it('refuses a URL with a path, an unknown argument, a bad corpus or seed', () => {
    expect(() => parseArgs(['--url', 'http://127.0.0.1:8911/x'])).toThrow(/origin/);
    expect(() => parseArgs(['--gap-ms', '100'])).toThrow(/unknown/);
    expect(() => parseArgs(['--corpus', 'holdout'])).toThrow(/corpus/);
    expect(() => parseArgs(['--seed', 'x'])).toThrow(/seed/);
    expect(() => parseArgs(['--url'])).toThrow(/incomplete/);
  });

  it('requests start at least 4 s apart, and nothing lowers it', () => {
    expect(GAP_MS).toBe(4_000);
  });
});

describe('the SC2 draw', () => {
  const picks = drawSc2(modules, rng(5));

  it('20 distinct codes, 4 from each stratum and 4 plain, each fitting its stratum', () => {
    expect(picks).toHaveLength(20);
    expect(new Set(picks.map((p) => p.m.code)).size).toBe(20);
    for (const [name, fits] of STRATA) {
      const mine = picks.filter((p) => p.stratum === name);
      expect(mine, name).toHaveLength(4);
      for (const p of mine) expect(fits(p.m), `${p.m.code} fits ${name}`).toBe(true);
    }
    const plain = picks.filter((p) => p.stratum === 'plain');
    expect(plain).toHaveLength(4);
    for (const p of plain) expect(STRATA.some(([, fits]) => fits(p.m)), p.m.code).toBe(false);
  });

  it('the same seed draws the same codes, whatever the modules\' order; another seed differs', () => {
    expect(drawSc2([...modules].reverse(), rng(5)).map((p) => p.m.code)).toEqual(picks.map((p) => p.m.code));
    expect(drawSc2(modules, rng(6)).map((p) => p.m.code)).not.toEqual(picks.map((p) => p.m.code));
  });
});

describe('the hidden-code draw', () => {
  const r = rng(5);
  drawSc2(modules, r);
  const { closed, partial } = drawHidden(modules, r);

  it('one closed code of each kind, closed by the oracle and the stored bit', () => {
    expect(closed.map((c) => c.kind)).toEqual(CLOSED_KINDS.map(([kind]) => kind));
    for (const c of closed) {
      expect(oracle(c.m, { sem: c.sem, study: c.study }), c.m.code).toBe('closed');
      expect(Number(c.m.ngAllow) & bitOf(c.sem, c.study), c.m.code).toBe(0);
    }
  });

  it('a partial code every course under which is closed at its semester and year', () => {
    expect(partial).not.toBeNull();
    const p = /** @type {NonNullable<typeof partial>} */ (partial);
    const under = modules.filter((m) => m.code.startsWith(p.prefix));
    expect(under.length).toBeGreaterThan(0);
    for (const m of under) expect(oracle(m, { sem: p.sem, study: p.study }), m.code).toBe('closed');
    const other = p.sem === 1 ? 2 : 1;
    expect(p.otherHasResults).toBe(under.some((m) => oracle(m, { sem: other, study: p.study }) !== 'closed'));
  });
});
