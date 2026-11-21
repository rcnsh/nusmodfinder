import { DEFAULT_ACAD_YEAR } from '../../public/year.js';

const RANK = { open: 0, note: 1, closed: 2 };
const UNPUBLISHED_NOTE = "unpublished semester: on last year's NG list for this semester; NUS hasn't published this year's yet";

/** @param {any} m @param {number} sem */
const carried = (m, sem) => (m.ngUnpublished || []).includes(sem) && (m.ngSemesters || []).includes(sem);

/** @param {any} o */
function withUnpublished(o) {
  const pending = (m) => Array.isArray(m.ngUnpublished) && m.ngUnpublished.length > 0;
  /** @param {(m: any, ctx: any) => any} base */
  const wrap = (base) => {
    const one = (m, ctx) => {
      const e = base(m, ctx);
      if (e.result === 'closed' || !carried(m, ctx.sem)) return e;
      return { result: 'note', closed: [], notes: [...e.notes, UNPUBLISHED_NOTE] };
    };
    return (m, ctx) => {
      if (!pending(m)) return base(m, ctx);
      if (ctx.sem !== 'any') return one(m, ctx);
      let best = null;
      for (const s of [...new Set((m.ngSemesters || []).filter((x) => x === 1 || x === 2))]) {
        const r = one(m, { ...ctx, sem: s });
        if (!best || RANK[r.result] < RANK[best.result] || (r.result === best.result && r.notes.length < best.notes.length)) best = r;
      }
      return best || base(m, ctx);
    };
  };
  const explain = wrap(o.explain);
  const explainShown = wrap(o.explainShown);
  return {
    year: o.year,
    explain,
    explainShown,
    oracle: (m, ctx) => explain(m, ctx).result,
    oracleShown: (m, ctx) => explainShown(m, ctx).result,
    prereqYears: o.prereqYears,
    yearNoteOf: o.yearNoteOf,
    levelNoteOf: o.levelNoteOf,
  };
}

/** @param {string} year */
export async function oracleFor(year) {
  if (!/^\d{4}-\d{4}$/.test(String(year))) throw new Error(`oracleFor: ${year} is not an acad year (YYYY-YYYY)`);
  let mod;
  try {
    mod = await import(`./oracle-${year}.node.mjs`);
  } catch (err) {
    throw new Error(`no oracle for ${year}: test/oracle/oracle-${year}.node.mjs is missing (npm run year -- next ${year} scaffolds it; docs/year-refresh/brief-oracle.md)`, { cause: err });
  }
  if (mod.stub) throw new Error(`test/oracle/oracle-${year}.node.mjs is a stub: its author hasn't written ${year}'s oracle yet (docs/year-refresh/brief-oracle.md)`);
  return withUnpublished({ ...mod, year });
}

const live = await oracleFor(DEFAULT_ACAD_YEAR);
export const oracleYear = DEFAULT_ACAD_YEAR;
export const { oracle, explain, explainShown, oracleShown, prereqYears, yearNoteOf, levelNoteOf } = live;
