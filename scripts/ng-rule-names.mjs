// @ts-check
// The NUSMods names the NG restrictions match on. A rule that closes a
// department or faculty names it as NUSMods spells it, and the exchange-mode
// oracle matches on the same strings, so a NUSMods rename would leave
// the rule matching nothing while CI stayed green and those courses showed as
// open. The oracle-node project runs this over the production corpus
// (test/oracle/oracle.node.test.js).

/**
 * Every department and faculty a rule names that the corpus does not have, as `<rule id>: department <name>`.
 * @param {{ rules: { id: string, match: { departments?: string[], faculties?: string[] } }[] }} rules
 * @param {{ departments: Iterable<string>, faculties: Iterable<string> }} corpus
 * @returns {string[]}
 */
export function unknownRuleNames(rules, corpus) {
  const departments = new Set(corpus.departments);
  const faculties = new Set(corpus.faculties);
  return rules.rules.flatMap((r) => [
    ...(r.match.departments ?? []).filter((d) => !departments.has(d)).map((d) => `${r.id}: department ${d}`),
    ...(r.match.faculties ?? []).filter((f) => !faculties.has(f)).map((f) => `${r.id}: faculty ${f}`),
  ]);
}
