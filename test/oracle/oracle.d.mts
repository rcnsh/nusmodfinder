// Types for the oracle selector (test/oracle/oracle.mjs) and the year's oracle it picks
// (test/oracle/oracle-<year>.node.mjs, written from the sources and the register only),
// so tsc checks the callers without type-checking the
// oracles themselves, which stay as their authors wrote them.
type Ctx = { sem: 1 | 2 | 'any', study: 'ug1' | 'ug2' | 'ug3' | 'ug4' | 'grad' };
type OracleModule = {
  code: string, title: string, department: string | null, faculty: string | null, level: number | null,
  semesters: number[], ng: boolean, ngSemesters: number[], prerequisite?: string | null,
  // The semesters NUS hasn't published this year's list for (scripts/lib.mjs).
  ngUnpublished?: number[],
};
type Explained = { result: 'open' | 'note' | 'closed', closed: string[], notes: string[] };
export type Oracle = {
  year: string,
  oracle(m: OracleModule, ctx: Ctx): 'open' | 'note' | 'closed',
  explain(m: OracleModule, ctx: Ctx): Explained,
  explainShown(m: OracleModule, ctx: Ctx): Explained,
  oracleShown(m: OracleModule, ctx: Ctx): 'open' | 'note' | 'closed',
  // The year-of-study note (ADR 0007), read from the prerequisite on the oracle's own.
  prereqYears(prerequisite: string | null | undefined): number[] | null,
  yearNoteOf(m: OracleModule, study: Ctx['study']): string | null,
  // GRO's level 4000 note (ADR 0007), read from the code and faculty on the oracle's own.
  levelNoteOf(m: OracleModule, study: Ctx['study']): string | null,
};
/** The oracle for an acad year; refuses a missing or stub one. */
export function oracleFor(year: string): Promise<Oracle>;
/** The live year (public/year.js), whose oracle the exports below are. */
export const oracleYear: string;
export const oracle: Oracle['oracle'];
export const explain: Oracle['explain'];
export const explainShown: Oracle['explainShown'];
export const oracleShown: Oracle['oracleShown'];
export const prereqYears: Oracle['prereqYears'];
export const yearNoteOf: Oracle['yearNoteOf'];
export const levelNoteOf: Oracle['levelNoteOf'];
