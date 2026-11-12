// Test-only additions to the Worker environment and vitest's provide/inject.
// A module (note the export) so `declare module 'vitest'` augments rather
// than replaces vitest's types.
export {};

declare global {
  /** Vite's import.meta.glob, which Vitest transforms (test/helpers.js finds a year's NG list with it). */
  interface ImportMeta {
    glob(pattern: string, options?: { eager?: boolean }): Record<string, unknown>;
  }
  namespace Cloudflare {
    interface Env {
      /** Migrations read on the Node side by readD1Migrations('./migrations'). */
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}
