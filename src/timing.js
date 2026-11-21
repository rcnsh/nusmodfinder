// @ts-check

const now = () => performance.now();

/** @param {number} ms */
const fmt = (ms) => (Math.round(ms * 10) / 10).toString();

export class Trace {
  /** @param {number} [start] */
  constructor(start = now()) {
    this.start = start;
    /** @type {Map<string, { dur?: number, desc?: string }>} */
    this.spans = new Map();
    this.d1 = {
      queries: 0,
      rowsRead: 0,
      /** @type {string[]} */
      servedByRegion: [],
      /** @type {boolean | null} */
      servedByPrimary: /** @type {boolean | null} */ (null),
    };
  }

  /**
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

  /** @param {string[]} names */
  reserve(...names) {
    for (const name of names) if (!this.spans.has(name)) this.spans.set(name, {});
  }

  /**
   * @param {string} name
   * @param {string} desc
   */
  describe(name, desc) {
    this.spans.set(name, { ...this.spans.get(name), desc });
  }

  /** @param {{ meta?: Partial<D1Meta> } | null | undefined} result */
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

  total() {
    return now() - this.start;
  }

  /** @param {number} [total] */
  durations(total = this.total()) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [name, { dur }] of this.spans) if (dur !== undefined) out[name] = Number(fmt(dur));
    out.total = Number(fmt(total));
    return out;
  }

  /** @param {number} [total] */
  header(total = this.total()) {
    const parts = [];
    for (const [name, { dur, desc }] of this.spans) {
      if (dur === undefined && desc === undefined) continue;
      let part = name;
      if (desc !== undefined) part += `;desc=${desc}`;
      if (dur !== undefined) part += `;dur=${fmt(dur)}`;
      parts.push(part);
    }
    parts.push(`total;dur=${fmt(total)}`);
    return parts.join(', ');
  }
}
