// @ts-check
// src/level-prior.js, 3D's ranking (docs/plans/phase3.md 3D "Ranking",
// docs/plans/phase3-prereg.md §5 "Ranking grids", eval/prereg/grids.json `3D`):
// the beginner prior α and the default graduate penalty β, applied to the
// fused list.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../eval/lib/sets.mjs';
import { levelOf } from '../scripts/lib.mjs';
import { LEVEL, LEVEL_VARIANT, LEVEL_VARIANTS, applyLevelPrior, codeLevel } from '../src/level-prior.js';

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const grids = readJson('eval/prereg/grids.json')['3D'];

describe('the variants', () => {
  it('are the pre-registered grid: rules with each α, and each β alone', () => {
    const v = Object.values(LEVEL_VARIANTS);
    expect(v.filter((x) => x.rules && x.beta === 0).map((x) => x.alpha)).toEqual(grids.alpha);
    expect(v.filter((x) => !x.rules).map((x) => x.beta)).toEqual(grids.beta);
    expect(v.filter((x) => x.rules && x.beta !== 0)).toHaveLength(1);
    for (const x of v.filter((y) => !y.rules)) expect(x.alpha).toBe(0);
  });

  it('the bundle takes its α from the α grid and its β from the β grid, with the rules on', () => {
    expect(LEVEL_VARIANTS.a35b10.rules).toBe(true);
    expect(grids.alpha).toContain(LEVEL_VARIANTS.a35b10.alpha);
    expect(grids.beta).toContain(LEVEL_VARIANTS.a35b10.beta);
  });

  it('the selected variant is one of them; the fallback is the rules with α = 0 and no β', () => {
    expect(LEVEL_VARIANTS[LEVEL_VARIANT]).toBe(LEVEL);
    expect(LEVEL_VARIANTS.a0).toEqual({ rules: true, alpha: 0, beta: grids.betaBaseline });
  });
});

describe('codeLevel', () => {
  it('is the first digit of the code, as ingest computes the level column', () => {
    const codes = readJson('test/fixtures/corpus.json').modules.map((/** @type {{ code: string }} */ m) => m.code);
    for (const c of [...codes, 'GESS1000', 'CS1010S', 'ACC1701XA']) expect(codeLevel(c), c).toBe(levelOf(c));
    expect(codeLevel('CS5242')).toBe(5);
  });
});

/** @param {[string, number][]} pairs */
const fused = (pairs) => pairs.map(([code, score]) => ({ code, score }));
/** @param {{ code: string }[]} list */
const order = (list) => list.map((f) => f.code);

describe('applyLevelPrior', () => {
  it('α scales a beginner query by 1 - α·p, p 0 for levels 1-2, 0.5 for 3, 1 for 4', () => {
    const list = fused([['AB4000', 0.032], ['AB3000', 0.031], ['AB1000', 0.03], ['AB2000', 0.029]]);
    const out = applyLevelPrior(list, { beginner: true, levelIntent: true }, { alpha: 0.2, beta: 0 });
    expect(order(out)).toEqual(['AB1000', 'AB2000', 'AB3000', 'AB4000']);
    const score = Object.fromEntries(out.map((f) => [f.code, f.score]));
    expect(score.AB4000).toBeCloseTo(0.032 * 0.8, 12);
    expect(score.AB3000).toBeCloseTo(0.031 * 0.9, 12);
    expect(score.AB1000).toBe(0.03);
  });

  it('α does nothing without the beginner intent', () => {
    const list = fused([['AB4000', 0.032], ['AB1000', 0.03]]);
    expect(applyLevelPrior(list, { beginner: false, levelIntent: true }, { alpha: 0.35, beta: 0 })).toEqual(list);
  });

  it('β scales level 5 and up by 1 - β when no level intent was parsed, and only then', () => {
    const list = fused([['AB5000', 0.032], ['AB6000', 0.0315], ['AB1000', 0.03]]);
    const out = applyLevelPrior(list, { beginner: false, levelIntent: false }, { alpha: 0, beta: 0.1 });
    expect(order(out)).toEqual(['AB1000', 'AB5000', 'AB6000']);
    expect(out[1].score).toBeCloseTo(0.032 * 0.9, 12);
    expect(applyLevelPrior(list, { beginner: false, levelIntent: true }, { alpha: 0, beta: 0.35 })).toEqual(list);
  });

  it('a code without a digit has no level and is never scaled', () => {
    const list = fused([['WEIRD', 0.02], ['AB5000', 0.03]]);
    const out = applyLevelPrior(list, { beginner: true, levelIntent: false }, { alpha: 0.35, beta: 0.35 });
    expect(out.find((f) => f.code === 'WEIRD')?.score).toBe(0.02);
  });

  it('α = β = 0 returns the list as it was; equal scores keep the fused order', () => {
    const list = fused([['AB4000', 0.03], ['AB1000', 0.03], ['AB5000', 0.03]]);
    expect(applyLevelPrior(list, { beginner: true, levelIntent: false }, { alpha: 0, beta: 0 })).toEqual(list);
    const tied = fused([['AB2000', 0.02], ['AB1000', 0.02], ['AB4000', 0.04]]);
    expect(order(applyLevelPrior(tied, { beginner: true, levelIntent: true }, { alpha: 0.35, beta: 0 })).slice(1)).toEqual(['AB2000', 'AB1000']);
  });
});
