// @ts-check
// 3D's ranking (docs/plans/phase3.md 3D "Ranking", docs/plans/phase3-prereg.md
// §5 "Ranking grids", eval/prereg/grids.json `3D`), applied to the fused list
// before hydration:
// - α, the beginner prior: when a beginner phrase was read, score × (1 − α·p),
//   p 0 for levels 1–2, 0.5 for 3 and 1 for 4 (the window already excludes 5+);
// - β, the default graduate penalty: when no level intent was parsed, a level
//   5+ score × (1 − β). Lead reading (prereg §5 names β "a default penalty on
//   level ≥ 5" without its form): the same multiplicative form as α with
//   p = 1. `ignore=level` leaves no level intent, so β applies there too.
// The level comes from the code (its first digit), as ingest computes the
// level column, so candidates are re-ranked before any D1 read.
//
// Each grid point is a variant; the selected one is LEVEL_VARIANT. The rules
// switch turns 3D's phrases on (src/intent-data.js passes the phrase table only
// then): β is screened alone, with the rules off.

/** @typedef {{ rules: boolean, alpha: number, beta: number }} LevelConfig */

export const LEVEL_VARIANTS = Object.freeze({
  a0: Object.freeze({ rules: true, alpha: 0, beta: 0 }),
  a10: Object.freeze({ rules: true, alpha: 0.1, beta: 0 }),
  a20: Object.freeze({ rules: true, alpha: 0.2, beta: 0 }),
  a35: Object.freeze({ rules: true, alpha: 0.35, beta: 0 }),
  b10: Object.freeze({ rules: false, alpha: 0, beta: 0.1 }),
  b20: Object.freeze({ rules: false, alpha: 0, beta: 0.2 }),
  b35: Object.freeze({ rules: false, alpha: 0, beta: 0.35 }),
  // The bundle: the rules, α* and β*, selected from the first round (α* 0.35, the largest
  // level-target gain; β* 0.1, tied with 0.2 to 3 decimals, the smaller change). Its own
  // dev-only round (plan §3, A3-5).
  a35b10: Object.freeze({ rules: true, alpha: 0.35, beta: 0.1 }),
});
/** @typedef {keyof typeof LEVEL_VARIANTS} LevelVariant */

/** The fallback (the rules with α = 0 and no β) until the dev screen selects. @type {LevelVariant} */
export const LEVEL_VARIANT = 'a0';

/** @type {LevelConfig} */
export const LEVEL = LEVEL_VARIANTS[LEVEL_VARIANT];

/** α's p by level. */
const ALPHA_P = /** @type {Record<number, number>} */ ({ 1: 0, 2: 0, 3: 0.5, 4: 1 });

/** A code's level, its first digit (scripts/lib.mjs levelOf), or null. @param {string} code */
export const codeLevel = (code) => {
  const d = /\d/.exec(code);
  return d ? Number(d[0]) : null;
};

/**
 * The fused list re-scored by α and β and re-sorted. Equal scores keep the
 * fused order (and so fuse's tie-break); with nothing to apply, the list
 * itself is returned.
 * @template {{ code: string, score: number }} T
 * @param {T[]} fused
 * @param {{ beginner: boolean, levelIntent: boolean }} intent
 * @param {{ alpha: number, beta: number }} config
 * @returns {T[]}
 */
export function applyLevelPrior(fused, { beginner, levelIntent }, { alpha, beta }) {
  const a = beginner ? alpha : 0;
  const b = levelIntent ? 0 : beta;
  if (a === 0 && b === 0) return fused;
  return fused
    .map((f) => {
      const level = codeLevel(f.code);
      if (level === null) return f;
      const factor = level >= 5 ? 1 - b : 1 - a * (ALPHA_P[level] ?? 0);
      return factor === 1 ? f : { ...f, score: f.score * factor };
    })
    .sort((x, y) => y.score - x.score);
}
