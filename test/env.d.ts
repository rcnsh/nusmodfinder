// Test-only additions to the Worker environment and vitest's provide/inject.
// A module (note the export) so `declare module 'vitest'` augments rather
// than replaces vitest's types.
export {};

declare global {
  namespace Cloudflare {
    interface Env {
      /** Migrations read on the Node side by readD1Migrations('./migrations'). */
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

declare module 'vitest' {
  interface ProvidedContext {
    /** The project's full corpus, normalised (pinned for test/full, `current` for sc1 and sc1-node); null when absent. */
    corpus: FullCorpus | null;
    /** Which bundle the `vectors-bundle` alias resolves to in the project (vitest.config.mjs). */
    vectorsBundle: 'pinned' | 'production' | 'fixture';
    /** test/full's lexical brute-force grid: every case, or a fixed 1-in-10 sample (LEXICAL_GRID, vitest.config.mjs). */
    lexicalGrid: 'full' | 'sample';
  }
}
