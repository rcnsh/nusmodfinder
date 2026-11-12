// @ts-check
// Guards for calls to bindings: per-call timeouts and the dense-retrieval
// circuit breaker.

// Budgets per upstream. Workers AI and Vectorize answer in tens of
// milliseconds when healthy; 1.5 s each keeps a hybrid search that falls back
// to keyword-only under ~1.6 s from the user's side. D1 gets longer because
// it is the source of truth: there is nothing to fall back to.
export const AI_TIMEOUT_MS = 1500;
export const VECTORIZE_TIMEOUT_MS = 1500;
export const D1_TIMEOUT_MS = 3000;

export class TimeoutError extends Error {
  /** @param {string} what @param {number} ms */
  constructor(what, ms) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Runs `start(signal)` and rejects with a TimeoutError if it has not settled
 * within `ms`. The signal is aborted on timeout, so bindings that accept one
 * (Workers AI) stop the request; for those that don't (D1, Vectorize) the
 * call is abandoned and its eventual result ignored.
 * @template T
 * @param {string} what Names the upstream in the error message.
 * @param {number} ms
 * @param {(signal: AbortSignal) => Promise<T>} start
 * @returns {Promise<T>}
 */
export function withTimeout(what, ms, start) {
  const controller = new AbortController();
  /** @type {any} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeoutError(what, ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  const call = Promise.resolve().then(() => start(controller.signal));
  return /** @type {Promise<T>} */ (Promise.race([call, timeout])).finally(() => clearTimeout(timer));
}

/**
 * Per-isolate circuit breaker for the dense half (Workers AI + Vectorize).
 * After `threshold` consecutive failures, `open()` is true for `coolMs`; the
 * first request after that tries again, and one more failure re-opens it.
 * State is per isolate, so it only shields the isolate that saw the failures;
 * that is enough to stop a dead upstream adding its timeout to every search.
 */
export class Circuit {
  /** @param {{ threshold?: number, coolMs?: number, now?: () => number }} [options] */
  constructor({ threshold = 3, coolMs = 30_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.coolMs = coolMs;
    this.now = now;
    this.failures = 0;
    this.openUntil = 0;
    /** @type {string | null} the upstream that failed last */
    this.lastSource = null;
  }

  reset() {
    this.failures = 0;
    this.openUntil = 0;
    this.lastSource = null;
  }

  open() {
    return this.now() < this.openUntil;
  }

  success() {
    this.failures = 0;
    this.openUntil = 0;
  }

  /** @param {string} source */
  failure(source) {
    this.failures += 1;
    this.lastSource = source;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.coolMs;
  }
}

/** The breaker /search consults. Exported so tests can reset or inspect it. */
export const denseCircuit = new Circuit();
