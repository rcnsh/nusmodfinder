// @ts-check
// The one history writer. Every pushState and replaceState the
// page makes goes through it, for every caller (act(), checkFrom, settle,
// popstate, shortlist edits):
// - it counts its writes over a sliding 10 s and, past BUDGET of them,
//   holds the rest and writes them COALESCE_MS after the last: each replace
//   folds into the write before it (so a flood of edits is one write), and a
//   push stays a write of its own, after it, so the entry left keeps its last
//   replace (an edit, or the detail closed before the view opens). WebKit
//   refuses the 101st write in 10 s (pushState and replaceState together),
//   and real Chrome drops excess writes silently;
// - each write is wrapped in try; a refusal is retried with backoff (1 s, 2 s,
//   4 s … up to 10 s). While a write waits for its retry, later writes queue
//   behind it (a replace folds into the write before it), so no submit is
//   dropped and no entry is written out of order;
// - flush() writes a pending write now (before act(), Copy link, an export,
//   on visibilitychange to hidden and on pagehide); cancel() drops it
//   (popstate: the browser has already moved to another entry).
// No DOM: the history and the timers are passed in, so
// test/web/history.node.test.js runs it in Node.

/** The most writes made at once in any WINDOW_MS; past it, writes coalesce. */
export const BUDGET = 80;
export const WINDOW_MS = 10_000;
/** A coalesced write goes out this long after the last write asked for. */
export const COALESCE_MS = 300;
export const RETRY_FIRST_MS = 1000;
export const RETRY_MAX_MS = 10_000;

/** `replace` with no state given keeps the state of the entry it replaces. */
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
 * }} deps `forceCoalesce`: hold every write for COALESCE_MS (a test hook)
 * @returns {Writer}
 */
export function createWriter({
  history, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), forceCoalesce = false,
}) {
  /** When each write was tried, within the last WINDOW_MS. @type {number[]} */
  let times = [];
  /** Writes not yet made, in order. @type {Write[]} */
  let queue = [];
  /** @type {any} */
  let timer = null;
  /** The wait before the next retry; 0 when no write is refused. */
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
  /** The state of the entry the page is on once the queue is written. */
  const state = () => (queue.length ? queue[queue.length - 1].data : history.state);

  /** @param {Write} w @returns {boolean} whether the browser took it */
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

  /** Writes the queue in order, stopping at a refusal, which is retried later. */
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
      // Waiting for a retry: queue behind it. A replace changes the entry the
      // write before it makes; a push is a new entry, after it.
      if (op === 'replace' && last) Object.assign(last, { url, data: resolved });
      else queue.push({ op, url, data: resolved });
      return;
    }
    if (last || forceCoalesce || used() >= BUDGET) {
      // Over budget: held, and written COALESCE_MS after the last asked for. A
      // replace folds into the held write before it; a push is its own.
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
