// @ts-check
// public/history.js (Phase 6 6B): the one history writer. Every pushState and
// replaceState the page makes goes through it; it counts its writes over a
// sliding 10 s, coalesces past 80 into one write 300 ms after the last, wraps
// each in try, retries a refusal with backoff, and queues later writes behind
// a refused one so nothing is written out of order. WebKit refuses the 101st
// write within 10 s (docs/plans/phase6.md §1 "Browser limits").
import { describe, expect, it } from 'vitest';
import { BUDGET, COALESCE_MS, createWriter } from '../../public/history.js';

/**
 * A history and a clock: `log` records every write made, `refuse` makes the
 * next N writes throw as WebKit's SecurityError does.
 */
function fakes() {
  let t = 0;
  /** @type {{ at: number, fn: () => void, id: number }[]} */
  let timers = [];
  let nextId = 1;
  /** @type {{ op: string, url: string, data: any }[]} */
  const log = [];
  /** @type {{ url: string, data: any }[]} */
  const entries = [{ url: '/', data: null }];
  let index = 0;
  const box = { refuse: 0 };
  /** @param {string} op */
  const writeFn = (op) => (/** @type {any} */ data, /** @type {string} */ _unused, /** @type {string} */ url) => {
    if (box.refuse > 0) { box.refuse -= 1; throw new Error('SecurityError'); }
    log.push({ op, url, data });
    if (op === 'push') { entries.splice(index + 1); entries.push({ url, data }); index += 1; } else entries[index] = { url, data };
  };
  const history = {
    pushState: writeFn('push'),
    replaceState: writeFn('replace'),
    get state() { return entries[index].data; },
  };
  const clock = {
    now: () => t,
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (/** @type {any} */ id) => { timers = timers.filter((x) => x.id !== id); },
    /** Advances the clock by `ms`, running the timers that fall due, in order. @param {number} ms */
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
  return { history, clock, log, entries, box, url: () => entries[index].url };
}

/** @param {ReturnType<typeof fakes>} f @param {object} [over] */
const writer = (f, over = {}) => createWriter({ history: f.history, now: f.clock.now, setTimer: f.clock.setTimer, clearTimer: f.clock.clearTimer, ...over });

describe('the history writer (6B)', () => {
  it('writes at once while under budget; replace keeps the entry\'s state unless given one', () => {
    const f = fakes();
    const w = writer(f);
    w.push('/?q=a', { vnmDetail: true });
    w.replace('/?q=a&pick=CS2030.1');
    expect(f.log).toEqual([
      { op: 'push', url: '/?q=a', data: { vnmDetail: true } },
      { op: 'replace', url: '/?q=a&pick=CS2030.1', data: { vnmDetail: true } },
    ]);
    w.replace('/?q=b', null);
    expect(f.log.at(-1)).toEqual({ op: 'replace', url: '/?q=b', data: null });
    expect(w.pending()).toBe(false);
  });

  it(`past ${BUDGET} writes in 10 s it coalesces into one write ${COALESCE_MS} ms after the last, and never passes WebKit's 100`, () => {
    const f = fakes();
    const w = writer(f);
    for (let i = 0; i < 150; i += 1) { w.replace(`/?pick=A${1000 + i}`); f.clock.tick(5000 / 150); }
    expect(f.log.length).toBeLessThanOrEqual(BUDGET + 1);
    expect(w.pending()).toBe(true);
    f.clock.tick(COALESCE_MS);
    expect(w.pending()).toBe(false);
    expect(f.url()).toBe('/?pick=A1149');
    // Never more than 100 writes in any 10 s.
    expect(f.log.length).toBeLessThan(100);
    // Once the window has passed, writes go out at once again.
    f.clock.tick(10_000);
    const before = f.log.length;
    w.replace('/?pick=Z9999');
    expect(f.log.length).toBe(before + 1);
  });

  it('coalescing folds replaces into the write before them, never a push into a replace: the entry left keeps its edit', () => {
    const f = fakes();
    const w = writer(f, { forceCoalesce: true });
    w.replace('/?q=a&pick=X1001.1');
    w.replace('/?q=a&pick=X1001.1&pick=X1002.1');
    w.push('/?q=b&pick=X1001.1&pick=X1002.1', null);
    w.replace('/?q=b&pick=X1001.1&pick=X1002.1&pick=X1003.1');
    expect(f.log).toEqual([]);
    f.clock.tick(COALESCE_MS);
    expect(f.log).toEqual([
      { op: 'replace', url: '/?q=a&pick=X1001.1&pick=X1002.1', data: null },
      { op: 'push', url: '/?q=b&pick=X1001.1&pick=X1002.1&pick=X1003.1', data: null },
    ]);
  });

  it('replace then push (opening the view from a detail opened by link) stays two writes when coalesced (review finding 3)', () => {
    const f = fakes();
    const w = writer(f, { forceCoalesce: true });
    w.replace('/?q=a', null);
    w.push('/?q=a&view=shortlist', { vnmShortlist: true });
    f.clock.tick(COALESCE_MS);
    expect(f.log.map((x) => [x.op, x.url])).toEqual([['replace', '/?q=a'], ['push', '/?q=a&view=shortlist']]);
  });

  it('flush writes a pending write now (before act(), Copy link, an export, hidden, pagehide); cancel drops it (popstate)', () => {
    const f = fakes();
    const w = writer(f, { forceCoalesce: true });
    w.replace('/?pick=A1001.1');
    w.flush();
    expect(f.url()).toBe('/?pick=A1001.1');
    w.replace('/?pick=A1001.1&pick=B1002.1');
    w.cancel();
    f.clock.tick(1000);
    expect(f.url()).toBe('/?pick=A1001.1');
    expect(w.pending()).toBe(false);
  });

  it('a refused write is retried with backoff (1 s, 2 s, 4 s … up to 10 s), and an edit made meanwhile folds into it', () => {
    const f = fakes();
    const w = writer(f);
    f.box.refuse = 2;
    w.push('/?q=b', null);
    expect(f.log).toEqual([]);
    w.replace('/?q=b&pick=A1001.1');
    f.clock.tick(999);
    expect(f.log).toEqual([]);
    f.clock.tick(1);
    // Refused again at 1 s; the next try is 2 s later.
    expect(f.log).toEqual([]);
    f.clock.tick(2000);
    expect(f.log).toEqual([{ op: 'push', url: '/?q=b&pick=A1001.1', data: null }]);
    expect(f.entries).toHaveLength(2);
  });

  it('a push queued behind a refused push is written after it, in order: no submit is dropped', () => {
    const f = fakes();
    const w = writer(f);
    f.box.refuse = 1;
    w.push('/?q=b', null);
    w.push('/?q=c', null);
    w.replace('/?q=c&pick=A1001.1');
    f.clock.tick(1000);
    expect(f.entries.map((e) => e.url)).toEqual(['/', '/?q=b', '/?q=c&pick=A1001.1']);
  });

  it('backoff caps at 10 s', () => {
    const f = fakes();
    const w = writer(f);
    f.box.refuse = 6;
    w.replace('/?q=a');
    // 1 + 2 + 4 + 8 + 10 + 10 = 35 s of refusals; the 7th try, at 35 s, succeeds.
    f.clock.tick(34_999);
    expect(f.log).toEqual([]);
    f.clock.tick(1);
    expect(f.url()).toBe('/?q=a');
  });

  it('state() is the state of the entry the page will be on once pending writes land', () => {
    const f = fakes();
    const w = writer(f);
    f.box.refuse = 1;
    w.push('/?q=a&open=CS2030', { vnmDetail: true });
    expect(f.history.state).toBe(null);
    expect(w.state()).toEqual({ vnmDetail: true });
  });
});
