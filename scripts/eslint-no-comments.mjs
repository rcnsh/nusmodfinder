// @ts-check
import { allowed } from './comment-core.mjs';

const MESSAGE = 'Comments are banned (ADR 0020). Name the code so it reads without one, move a decision into an ADR, or file an issue for a workaround; `/delete-comment` does all three.';

/** @type {import('eslint').Rule.RuleModule} */
const noComments = {
  meta: {
    type: 'suggestion',
    docs: { description: 'ban comments other than tool directives and type-only JSDoc' },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          if (String(c.type) === 'Shebang' || !c.range || !c.loc) continue;
          if (allowed({ block: c.type === 'Block', value: c.value, start: c.range[0], end: c.range[1] })) continue;
          context.report({ loc: c.loc, message: MESSAGE });
        }
      },
    };
  },
};

export default { rules: { 'no-comments': noComments } };
