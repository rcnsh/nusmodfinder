// @ts-check

export const BUDGET = 80;
export const WINDOW_MS = 10_000;
export const COALESCE_MS = 300;
export const RETRY_FIRST_MS = 1000;
export const RETRY_MAX_MS = 10_000;

const KEEP = Symbol('keep');

/**
 * @typedef {{
 *   pushState(data: any, unused: string, url?: string | null): void,
 *   replaceState(data: any, unused: string, url?: string | null): void,
 *   readonly state: any,
 * }} HistoryLike
 * @typedef {{ op: 'push' | 'replace', url: string, data: any }} Write
 * @typedef {{
 *   push: (url: string, data: any) => void,
 *   replace: (url: string, data?: any) => void,
 *   flush: () => void,
 *   cancel: () => void,
 *   pending: () => boolean,
 *   state: () => any,
 * }} Writer
 */

/**
 * @param {{
 *   history: HistoryLike,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 *   forceCoalesce?: boolean,
 * }} deps
 * @returns {Writer}
 */
export function createWriter({
  history, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), forceCoalesce = false,
}) {
  /** @type {number[]} */
  let times = [];
  /** @type {Write[]} */
  let queue = [];
  /** @type {any} */
  let timer = null;
  let delay = 0;

  const used = () => {
    const t = now();
    times = times.filter((x) => t - x < WINDOW_MS);
    return times.length;
  };
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const state = () => (queue.length ? queue[queue.length - 1].data : history.state);

  /**
   * @param {Write} w
   * @returns {boolean}
   */
  function attempt(w) {
    times.push(now());
    try {
      if (w.op === 'push') history.pushState(w.data, '', w.url);
      else history.replaceState(w.data, '', w.url);
      return true;
    } catch {
      return false;
    }
  }

  function drain() {
    clear();
    while (queue.length) {
      if (!attempt(queue[0])) {
        delay = delay ? Math.min(delay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
        timer = setTimer(drain, delay);
        return;
      }
      queue.shift();
    }
    delay = 0;
  }

  /**
   * @param {'push' | 'replace'} op
   * @param {string} url
   * @param {any} data
   */
  function write(op, url, data) {
    const resolved = data === KEEP ? state() : data;
    const last = queue[queue.length - 1];
    if (delay) {
      if (op === 'replace' && last) Object.assign(last, { url, data: resolved });
      else queue.push({ op, url, data: resolved });
      return;
    }
    if (last || forceCoalesce || used() >= BUDGET) {
      if (op === 'replace' && last) Object.assign(last, { url, data: resolved });
      else queue.push({ op, url, data: resolved });
      clear();
      timer = setTimer(drain, COALESCE_MS);
      return;
    }
    queue.push({ op, url, data: resolved });
    drain();
  }

  return {
    push: (url, data) => write('push', url, data),
    replace: (url, data = KEEP) => write('replace', url, data),
    flush: () => { if (queue.length) drain(); },
    cancel: () => { clear(); queue = []; delay = 0; },
    pending: () => queue.length > 0,
    state,
  };
}
