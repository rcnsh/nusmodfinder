// provide/inject and task.meta types for the eval runner (worker tsconfig).
export {};

declare module 'vitest' {
  interface ProvidedContext {
    /** Set by eval/runner/run.mjs; absent under plain `vitest`. */
    evalPayload?: EvalPayload;
  }
  interface TaskMeta {
    vnmEval?: EvalQueryResult;
  }
}
