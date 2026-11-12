// The SC1 oracle selector (Phase 7 7E): every caller imports this file, never a dated oracle
// (test/oracle-selector.node.test.js fails on a direct import). It picks the year's oracle,
// test/sc1/oracle-<year>.node.mjs, written from that year's PDFs and register only.
//
//   oracleFor(year)   the oracle for a corpus's year (tests over a corpus pass its acadYear);
//                     refuses a missing or stub oracle (`year next` scaffolds a stub)
//   oracle, explain, explainShown, oracleShown, prereqYears, yearNoteOf, levelNoteOf
//                     the live year's (public/year.js, which `year check` holds equal to
//                     DEFAULT_ACAD_YEAR), for callers over fixture data or the live corpus
//
// G2 (Jacob's answer, ADR 0011): a semester NUS hasn't published yet shows the courses on last
// year's list for it, each "to confirm" (a note), never open. The normalised module marks those
// semesters in `ngUnpublished` (scripts/lib.mjs, from the year's source manifest), and its
// `ngSemesters` hold an unpublished semester exactly when the course was on last year's list. The
// ruling is the same every year, so it is applied here, around the year's oracle:
//   - a semester in `ngUnpublished` that the course is listed in: the oracle's answer, but a
//     course it shows becomes a note;
//   - one it isn't listed in: the oracle's answer (closed: not on the list for that semester);
//   - either semester: D1, the least restrictive of the per-semester answers above.
// A module with no `ngUnpublished` gets the year's oracle untouched. This wrapper was written by
// the author of the state in src/eligibility.js, so docs/year-refresh/brief-oracle.md gives it to
// the next fresh oracle author to re-derive from the ruling.
import { DEFAULT_ACAD_YEAR } from '../../public/year.js';

const RANK = { open: 0, note: 1, closed: 2 };
const G2_NOTE = "G2: on last year's NG list for this semester; NUS hasn't published this year's yet";

/** @param {any} m @param {number} sem */
const carried = (m, sem) => (m.ngUnpublished || []).includes(sem) && (m.ngSemesters || []).includes(sem);

/** The year's oracle with G2 applied. @param {any} o the dated module */
function withUnpublished(o) {
  const pending = (m) => Array.isArray(m.ngUnpublished) && m.ngUnpublished.length > 0;
  /** @param {(m: any, ctx: any) => any} base */
  const wrap = (base) => {
    const one = (m, ctx) => {
      const e = base(m, ctx);
      if (e.result === 'closed' || !carried(m, ctx.sem)) return e;
      return { result: 'note', closed: [], notes: [...e.notes, G2_NOTE] };
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

/**
 * The oracle for an acad year.
 * @param {string} year 'YYYY-YYYY'
 */
export async function oracleFor(year) {
  if (!/^\d{4}-\d{4}$/.test(String(year))) throw new Error(`oracleFor: ${year} is not an acad year (YYYY-YYYY)`);
  let mod;
  try {
    mod = await import(`./oracle-${year}.node.mjs`);
  } catch (err) {
    throw new Error(`no SC1 oracle for ${year}: test/sc1/oracle-${year}.node.mjs is missing (npm run year -- next ${year} scaffolds it; docs/year-refresh/brief-oracle.md)`, { cause: err });
  }
  if (mod.stub) throw new Error(`test/sc1/oracle-${year}.node.mjs is a stub: its author hasn't written ${year}'s oracle yet (docs/year-refresh/brief-oracle.md)`);
  return withUnpublished({ ...mod, year });
}

const live = await oracleFor(DEFAULT_ACAD_YEAR);
export const oracleYear = DEFAULT_ACAD_YEAR;
export const { oracle, explain, explainShown, oracleShown, prereqYears, yearNoteOf, levelNoteOf } = live;
