// Types for oracle.node.mjs (written from the sources and the register only,
// docs/evidence/phase4/rules-check.md), so tsc checks its callers without
// type-checking the oracle itself, which stays as its author wrote it.
type Ctx = { sem: 1 | 2 | 'any', study: 'ug1' | 'ug2' | 'ug3' | 'ug4' | 'grad' };
type OracleModule = {
  code: string, title: string, department: string | null, faculty: string | null, level: number | null,
  semesters: number[], ng: boolean, ngSemesters: number[], prerequisite?: string | null,
};
export function oracle(m: OracleModule, ctx: Ctx): 'open' | 'note' | 'closed';
export function explain(m: OracleModule, ctx: Ctx): { result: 'open' | 'note' | 'closed', closed: string[], notes: string[] };
// R3: the year-of-study note, read from the prerequisite on the oracle's own.
export function prereqYears(prerequisite: string | null | undefined): number[] | null;
export function yearNoteOf(m: OracleModule, study: Ctx['study']): string | null;
// R6-2: GRO's level 4000 note, read from the code and faculty on the oracle's own.
export function levelNoteOf(m: OracleModule, study: Ctx['study']): string | null;
export function explainShown(m: OracleModule, ctx: Ctx): { result: 'open' | 'note' | 'closed', closed: string[], notes: string[] };
export function oracleShown(m: OracleModule, ctx: Ctx): 'open' | 'note' | 'closed';
