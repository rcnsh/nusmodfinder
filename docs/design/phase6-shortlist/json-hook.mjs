// Lets Node import src/ng-reasons.js, whose `import file from '….json'` the
// Worker's bundler accepts without an import attribute (derive.mjs only).
import { registerHooks } from 'node:module';
registerHooks({
  load(url, context, next) {
    return url.endsWith('.json') ? next(url, { ...context, importAttributes: { type: 'json' } }) : next(url, context);
  },
});
