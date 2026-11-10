// Types for oracle.node.mjs (written from the sources and the register only,
// docs/evidence/phase4/rules-check.md), so tsc checks its callers without
// type-checking the oracle itself, which stays as its author wrote it.
type Ctx = { sem: 1 | 2 | 'any', study: 'ug1' | 'ug2' | 'ug3' | 'ug4' | 'grad' };
type OracleModule = {
  code: string, title: string, department: string | null, faculty: string | null, level: number | null,
  semesters: number[], ng: boolean, ngSemesters: number[],
};
export function oracle(m: OracleModule, ctx: Ctx): 'open' | 'note' | 'closed';
export function explain(m: OracleModule, ctx: Ctx): { result: 'open' | 'note' | 'closed', closed: string[], notes: string[] };
