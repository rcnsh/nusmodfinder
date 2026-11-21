// @ts-check

/**
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
