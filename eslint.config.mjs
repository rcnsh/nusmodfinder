// @ts-check
import js from '@eslint/js';
import globals from 'globals';

const HTML_SINK = 'Build DOM nodes and set textContent (public/dom.js); HTML strings are banned in the page (F8).';

export default [
  {
    ignores: ['node_modules/', '.claude/', '**/.wrangler/', '.data/', '.eval-work/', '.venv/', 'docs/', 'eval/v1/', 'worker-configuration.d.ts'],
  },
  js.configs.recommended,
  {
    // Worker code and the tests that run inside workerd.
    files: ['src/**/*.js', 'test/**/*.js', 'eval/runner/**/*.js'],
    ignores: ['test/ui/**/*.spec.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker } },
  },
  {
    // Node-side scripts, tool configs, and the tests that run in Node, the
    // Playwright specs included (they drive the browser from Node).
    files: ['scripts/**/*.mjs', 'eval/**/*.mjs', '*.mjs', 'test/**/*.node.test.js', 'test/**/*.node.mjs', 'test/ui/**/*.spec.js', 'test/ui/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // The callbacks the specs and their helpers pass to page.evaluate run in the
    // page (5D, 5E); so do the live checks' (5G).
    files: ['test/ui/**/*.spec.js', 'test/ui/**/*.mjs', 'scripts/p5-live.mjs', 'scripts/p6-live.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // The page (Phase 5 5B): browser ES modules that render DOM nodes only.
    // Every HTML sink is banned (F8), by property and by name, so neither
    // `el.innerHTML = …` nor `el['innerHTML']` nor `{ innerHTML: … }` lints.
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      'no-restricted-properties': ['error',
        ...['innerHTML', 'outerHTML', 'insertAdjacentHTML'].map((property) => ({ property, message: HTML_SINK })),
        { object: 'document', property: 'write', message: HTML_SINK },
        { object: 'document', property: 'writeln', message: HTML_SINK }],
      'no-restricted-syntax': ['error',
        { selector: 'Identifier[name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]', message: HTML_SINK },
        { selector: 'Literal[value=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]', message: HTML_SINK }],
    },
  },
];
