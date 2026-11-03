// @ts-check
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', '.wrangler/', '.data/', '.eval-work/', 'docs/', 'eval/v1/', 'worker-configuration.d.ts'],
  },
  js.configs.recommended,
  {
    // Worker code and the tests that run inside workerd.
    files: ['src/**/*.js', 'test/**/*.js', 'eval/runner/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.serviceworker } },
  },
  {
    // Node-side scripts, tool configs, and the tests that run in Node.
    files: ['scripts/**/*.mjs', 'eval/**/*.mjs', '*.mjs', 'test/**/*.node.test.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
];
