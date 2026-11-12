// vitest's provide/inject for the corpus projects (vitest.config.mjs), shared by the workerd
// tests (tsconfig.json) and the Node ones (tsconfig.node.json: sc1-node injects the corpus too).
// A module (note the export) so `declare module 'vitest'` augments rather than replaces vitest's types.
export {};

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
