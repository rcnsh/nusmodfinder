// @ts-check
// The department and faculty check the oracle-node project runs over
// the production corpus (test/oracle/oracle.node.test.js). The rules and the
// oracle match on NUSMods' strings, so a renamed department must fail it.
import { describe, expect, it } from 'vitest';
import { unknownRuleNames } from '../scripts/ng-rule-names.mjs';

const rules = {
  rules: [
    { id: 'C-law', match: { faculties: ['Law'] } },
    { id: 'C-cs-dept', match: { departments: ['Computer Science'] } },
    { id: 'C-codes', match: { codes: ['CS1010'] } },
  ],
};

describe('unknownRuleNames', () => {
  it('passes a corpus holding every named department and faculty', () => {
    expect(unknownRuleNames(rules, { departments: ['Computer Science', 'Mathematics'], faculties: ['Law', 'Computing'] })).toEqual([]);
  });

  it('fails on a renamed department, naming the rule and the old name', () => {
    expect(unknownRuleNames(rules, { departments: ['School of Computing (Computer Science)'], faculties: ['Law'] }))
      .toEqual(['C-cs-dept: department Computer Science']);
  });

  it('fails on a renamed faculty', () => {
    expect(unknownRuleNames(rules, { departments: ['Computer Science'], faculties: ['Faculty of Law'] })).toEqual(['C-law: faculty Law']);
  });
});
