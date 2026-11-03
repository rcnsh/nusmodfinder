// @ts-check
// Per-request instrumentation: Server-Timing spans and D1 cost counters.
//
// workerd freezes the clock during synchronous CPU work and advances it only
// across I/O, so a span measures time spent waiting on a binding (D1, Workers
// AI, Vectorize, the cache), not CPU. That is the quantity SC7 is about.

const now = () => performance.now();

/** @param {number} ms */
const fmt = (ms) => (Math.round(ms * 10) / 10).toString();

export class Trace {
  /** @param {number} [start] `performance.now()` at fetch entry. */
  constructor(start = now()) {
    this.start = start;
    /** @type {Map<string, { dur?: number, desc?: string }>} */
    this.spans = new Map();
    this.d1 = {
      queries: 0,
      rowsRead: 0,
      /** @type {string[]} distinct `meta.served_by_region` values */
      servedByRegion: [],
      /** @type {boolean | null} true iff every query that reported it was served by the primary */
      servedByPrimary: /** @type {boolean | null} */ (null),
    };
  }

  /**
   * Awaits `fn()` and adds its wall time to span `name`. Errors pass through
   * unchanged; the time is recorded either way.
   * @template T
   * @param {string} name
   * @param {() => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async time(name, fn) {
    const t0 = now();
    try {
      return await fn();
    } finally {
      this.add(name, now() - t0);
    }
  }

  /**
   * Adds `ms` to span `name` (spans that run more than once accumulate).
   * @param {string} name
   * @param {number} ms
   * @param {string} [desc]
   */
  add(name, ms, desc) {
    const span = this.spans.get(name) ?? {};
    span.dur = (span.dur ?? 0) + ms;
    if (desc !== undefined) span.desc = desc;
    this.spans.set(name, span);
  }

  /**
   * Sets a span's description, e.g. `cache;desc=hit`.
   * @param {string} name
   * @param {string} desc
   */
  describe(name, desc) {
    this.spans.set(name, { ...this.spans.get(name), desc });
  }

  /**
   * Records the cost of one D1 result (`.all()`, `.run()` or a batch entry).
   * @param {{ meta?: Partial<D1Meta> } | null | undefined} result
   */
  d1Result(result) {
    const meta = result?.meta;
    this.d1.queries += 1;
    if (!meta) return;
    if (typeof meta.rows_read === 'number') this.d1.rowsRead += meta.rows_read;
    if (meta.served_by_region && !this.d1.servedByRegion.includes(meta.served_by_region)) {
      this.d1.servedByRegion.push(meta.served_by_region);
    }
    if (typeof meta.served_by_primary === 'boolean') {
      this.d1.servedByPrimary = (this.d1.servedByPrimary ?? true) && meta.served_by_primary;
    }
  }

  /** Milliseconds since fetch entry. */
  total() {
    return now() - this.start;
  }

  /**
   * Every span's duration, plus `total`, rounded to 0.1 ms.
   * @param {number} [total]
   */
  durations(total = this.total()) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [name, { dur }] of this.spans) if (dur !== undefined) out[name] = Number(fmt(dur));
    out.total = Number(fmt(total));
    return out;
  }

  /**
   * The Server-Timing header value: spans in the order they were first
   * recorded, then `total`. Stages that did not run are absent.
   * @param {number} [total] Pass the value already logged so header and log agree.
   */
  header(total = this.total()) {
    const parts = [];
    for (const [name, { dur, desc }] of this.spans) {
      let part = name;
      if (desc !== undefined) part += `;desc=${desc}`;
      if (dur !== undefined) part += `;dur=${fmt(dur)}`;
      parts.push(part);
    }
    parts.push(`total;dur=${fmt(total)}`);
    return parts.join(', ');
  }
}
