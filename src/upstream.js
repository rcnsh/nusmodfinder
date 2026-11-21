// @ts-check

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
 * @template T
 * @param {string} what
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

export class Circuit {
  /** @param {{ threshold?: number, coolMs?: number, now?: () => number }} [options] */
  constructor({ threshold = 3, coolMs = 30_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.coolMs = coolMs;
    this.now = now;
    this.failures = 0;
    this.openUntil = 0;
    /** @type {string | null} */
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

export const denseCircuit = new Circuit();
