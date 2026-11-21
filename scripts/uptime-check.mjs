// @ts-check

export const SCHEDULE = '*/15 * * * *';
export const PERIOD_MS = 15 * 60_000;
export const GAP_MS = 4000;
export const RETRY_MS = 90_000;
export const TRIES = 3;
export const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'nusmodfinder-uptime';
const SHOWN = '<HC_UPTIME_URL>';
export const CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

export const QUERIES = Object.freeze([
  'marine biology', 'urban planning', 'machine learning', 'public health policy', 'game design',
  'japanese language', 'climate change', 'financial accounting', 'human rights law', 'music composition',
  'data visualisation', 'ancient philosophy', 'renewable energy', 'consumer psychology', 'film studies',
  'cyber security', 'southeast asian history', 'food science', 'robotics and automation', 'social entrepreneurship',
  'architectural design', 'quantum physics', 'creative writing', 'supply chain management', 'how languages are learned',
  'environmental economics', 'digital marketing', 'medical ethics', 'korean culture', 'sports science',
  'operations research',
]);
const QUERY_STRIDE = 2 * TRIES;
const MISS_KINDS = Object.freeze(['unknown', 'catalogue-only', 'ng-listed']);

/** @param {number} period */
export const queryIndex = (period) => (((period % QUERIES.length) * QUERY_STRIDE) % QUERIES.length + QUERIES.length) % QUERIES.length;

/** @param {{ groups?: unknown }} file */
export function moduleCodes(file) {
  const all = Array.isArray(file.groups) ? file.groups.flat() : [];
  return [...new Set(all.filter((c) => typeof c === 'string' && CODE_RE.test(c)))].sort();
}

/** @param {unknown} err */
export function describeError(err) {
  const e = /** @type {{ name?: string, cause?: { code?: unknown } }} */ (err ?? {});
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `timed out after ${REQUEST_TIMEOUT_MS / 1000} s`;
  const code = typeof e.cause?.code === 'string' ? e.cause.code : e.name ?? 'error';
  return `network error (${String(code).replace(/[^\w-]/g, '').slice(0, 40)})`;
}

/** @param {unknown} v */
const word = (v) => String(v ?? '').replace(/[^\w-]/g, '').slice(0, 40) || 'unknown';

/** @param {number} ms */
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [o]
 * @returns {(url: string, body?: string) => Promise<{ ok: boolean, status: number }>}
 */
export function httpPinger({ fetchImpl = fetch, sleep = realSleep } = {}) {
  return async (url, body) => {
    let status = 0;
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await sleep(5000);
      try {
        const res = await fetchImpl(url, {
          method: 'POST', body: body ?? '', headers: { 'content-type': 'text/plain; charset=utf-8' },
          signal: AbortSignal.timeout(10_000),
        });
        await res.body?.cancel();
        if (res.ok) return { ok: true, status: res.status };
        status = res.status;
      } catch { status = 0; }
    }
    return { ok: false, status };
  };
}

/**
 * @typedef {{
 *   base: string, codes: string[], pingUrl?: string, dryRun?: boolean, fetchImpl?: typeof fetch,
 *   ping?: (url: string, body?: string) => Promise<{ ok: boolean, status: number }>,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (m: string) => void, error?: (m: string) => void,
 * }} CheckOptions
 */

/**
 * @param {CheckOptions} o
 * @returns {Promise<0 | 1 | 2>}
 */
export async function checkAndReport({
  base, codes, pingUrl: given, dryRun = false, fetchImpl = fetch, ping, sleep = realSleep, now = Date.now,
  log = console.log, error = console.error,
}) {
  const raw = String(given ?? '').trim();
  /** @type {URL | null} */
  let pingUrl = null;
  try { pingUrl = raw ? new URL(raw) : null; } catch { pingUrl = null; }
  /** @type {string[]} */
  const needles = [raw, raw.replace(/\/+$/, '')];
  if (pingUrl) needles.push(pingUrl.href, pingUrl.host, pingUrl.pathname.replace(/^\/+|\/+$/g, ''));
  const secrets = needles.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  /** @param {string} m */
  const redact = (m) => secrets.reduce((s, n) => s.split(n).join(SHOWN), m);
  /** @param {string} m */
  const say = (m) => log(redact(m));
  /** @param {string} m */
  const warn = (m) => error(redact(m));

  if (!dryRun && (!pingUrl || pingUrl.protocol !== 'https:')) {
    warn('uptime: HC_UPTIME_URL is not set or is not an https URL (its value is not shown).');
    return 2;
  }
  if (!codes.length) { warn('uptime: no course codes to ask /module for.'); return 2; }

  const period = Math.floor(now() / PERIOD_MS);
  const code = codes[period % codes.length];
  let cursor = queryIndex(period);
  /** @type {number | null} */
  let lastAnswered = null;
  /** @param {string} path */
  const send = async (path) => {
    if (lastAnswered !== null) {
      const wait = lastAnswered + GAP_MS - now();
      if (wait > 0) await sleep(wait);
    }
    try {
      const res = await fetchImpl(`${base}${path}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { res, text: await res.text() };
    } finally {
      lastAnswered = now();
    }
  };
  /** @param {string} text */
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

  const check = async () => {
    let route = '/health';
    try {
      const h = await send('/health');
      if (h.res.status !== 200) return `/health HTTP ${h.res.status}`;
      if (parse(h.text)?.ok !== true) return '/health answered without ok: true';
      say(`uptime: /health 200, tag ${word(parse(h.text)?.versionTag)}`);

      route = `/module/${code}`;
      const m = await send(`/module/${encodeURIComponent(code)}`);
      const mod = parse(m.text);
      if (m.res.status === 404 && mod?.error === 'not_found' && MISS_KINDS.includes(mod.kind)) {
        say(`uptime: ${route} 404 (${mod.kind}): not in the live corpus (groups file ahead of or behind the deploy?); D1 answered`);
      } else if (m.res.status !== 200) return `${route} HTTP ${m.res.status}`;
      else if (mod?.code !== code) return `${route} answered another course or no JSON`;
      else say(`uptime: ${route} 200`);

      route = '/search';
      for (let t = 0; t < TRIES; t += 1) {
        const q = QUERIES[cursor % QUERIES.length];
        cursor += 1;
        const s = await send(`/search?${new URLSearchParams({ q })}`);
        if (s.res.status !== 200) return `/search HTTP ${s.res.status}`;
        const body = parse(s.text);
        if (!body) return '/search answered no JSON';
        const timing = s.res.headers.get('server-timing') ?? '';
        if (/(^|,)\s*cache;desc=hit\b/.test(timing)) { say(`uptime: /search "${q}" was a cache hit; taking the next query`); continue; }
        if (!/(^|,)\s*cache;desc=miss\b/.test(timing)) return '/search has no cache;desc=miss in Server-Timing';
        if (body.degraded) return `/search degraded (${word(body.degraded.source)}-${word(body.degraded.reason)})`;
        if (!Array.isArray(body.results) || body.results.length === 0) return '/search answered no results';
        say(`uptime: /search "${q}" 200, a cache miss, not degraded, ${body.results.length} results`);
        return null;
      }
      return `/search ${TRIES} cache hits in a row, no miss`;
    } catch (err) {
      return `${route} ${describeError(err)}`;
    }
  };

  say(`uptime: ${base}${dryRun ? ' (dry run)' : ''}`);
  const first = await check();
  /** @type {string | null} */
  let second = null;
  if (first) {
    warn(`uptime: FAIL ${first}; checking again in ${RETRY_MS / 1000} s`);
    await sleep(RETRY_MS);
    second = await check();
    if (second) warn(`uptime: FAIL again ${second}`);
    else say('uptime: the second check passed');
  }
  const down = first !== null && second !== null;
  const reason = down ? `down twice, ${RETRY_MS / 1000} s apart: ${first}; then ${second}`.replace(/["\r\n]/g, ' ').slice(0, 300) : undefined;
  const shown = down ? `${SHOWN}/fail` : SHOWN;

  if (dryRun) {
    say(`uptime: --dry-run: would ping ${shown}${reason ? ` with "${reason}"` : ''}`);
    return 0;
  }
  const target = `${/** @type {URL} */ (pingUrl).href.replace(/\/+$/, '')}${down ? '/fail' : ''}`;
  try {
    const r = await (ping ?? httpPinger({ fetchImpl, sleep }))(target, reason);
    if (!r.ok) {
      warn(`uptime: the ping to ${shown} failed: ${r.status ? `healthchecks.io answered HTTP ${r.status}` : 'no answer in 3 tries'}`);
      return 1;
    }
  } catch (err) {
    warn(`uptime: the ping to ${shown} failed: ${describeError(err)}`);
    return 1;
  }
  say(`uptime: ${down ? `DOWN (${reason})` : 'up'}; pinged ${shown}`);
  return 0;
}
