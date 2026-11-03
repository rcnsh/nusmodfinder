// Types shared by the eval runner inside workerd and its Node-side driver.
// Vitest's provide/inject and task.meta augmentation is in vitest.d.ts
// (worker tsconfig only, so the Node-side vitest.config.mjs keeps its types).
export {};

declare global {
  /** One query as the runner sends it: opaque id + /search params. */
  interface EvalPayloadQuery {
    id: string;
    params: Record<string, string>;
  }

  interface EvalPayload {
    queries: EvalPayloadQuery[];
    corpus: NormalisedModule[];
    /** Every precomputed vector (corpus + queries), one base64 Float32 string. */
    lookup: { model: string; dims: number; keys: string[]; b64: string };
    seedTimeoutMs: number;
  }

  interface EvalDocMeta {
    level: number | null;
    semesters: number[];
    ng: boolean;
    ngSemesters: number[];
    credits: number | null;
    faculty: string | null;
  }

  interface EvalQueryResult {
    status: number;
    codes: string[];
    docs: Record<string, EvalDocMeta>;
    error?: string;
    /** Texts the fake AI had no vector for (holdout: written encrypted only). */
    missing: string[];
  }
}
