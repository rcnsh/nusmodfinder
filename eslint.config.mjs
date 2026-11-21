// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import local from './scripts/eslint-no-comments.mjs';

const HTML_SINK = 'Build DOM nodes and set textContent (public/dom.js); HTML strings are banned in the page.';

export default [
  {
    ignores: ['node_modules/', '.claude/', '**/.wrangler/', '.data/', '.eval-work/', '.venv/', 'docs/', 'worker-configuration.d.ts'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    plugins: { local },
    rules: {
      'local/no-comments': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eval/runner/**/*.js'],
    ignores: ['test/ui/**/*.spec.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker } },
  },
  {
    files: ['scripts/**/*.mjs', 'workers/**/*.mjs', 'eval/**/*.mjs', '*.mjs', 'test/**/*.node.test.js', 'test/**/*.node.mjs', 'test/ui/**/*.spec.js', 'test/ui/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['test/ui/**/*.spec.js', 'test/ui/**/*.mjs', 'scripts/live-check.mjs', 'scripts/live-shortlist.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['workers/**/*.mjs'],
    languageOptions: { ecmaVersion: 2025 },
  },
  {
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
