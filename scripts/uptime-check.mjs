// @ts-check
// The uptime check itself (ADR 0012, ADR 0019), shared by the Worker that runs it every 15 minutes
// (workers/uptime/index.mjs) and the CLI (scripts/uptime.mjs). It imports nothing and uses only
// fetch, AbortSignal and setTimeout, so the uptime Worker can bundle it. Three GETs to the live
// site, one at a time, each sent at least 4 s after the last answer (the site's limit is per
// address):
//
//   /health          200 with `ok: true` (no D1, no neurons)
//   /module/<code>   200 with that code (one D1 row; not edge-cached). The code is drawn by the
//                    period from data/groups.json, so no course name is written here. The deploy
//                    can be behind or ahead of that file (a corpus refresh is merged before D1 is
//                    re-ingested; a rollback; the uptime Worker bundles the file when it is
//                    deployed), so a 404 that names its kind of miss passes too: the Worker read D1
//                    to give it, and a D1 failure is a 502
//   /search?q=<q>    200, `cache;desc=miss`, not `degraded`, at least one result. The query
//                    rotates by the period through QUERIES; on a cache hit it takes the next one
//                    (TRIES at most), so the check always reaches Workers AI and catches the
//                    keyword-only fallback, which still answers 200
//
// A failure is checked again 90 s later, with queries not yet sent. Nothing is kept between runs.
// Then it reports to healthchecks.io: a pass pings HC_UPTIME_URL; two failures ping
// HC_UPTIME_URL/fail with a one-line reason (the route and the status, never a visitor's data);
// healthchecks.io's Pushover integration alerts Jacob. A run that never arrives alerts after the
// check's grace. The ping URL is a secret: it never appears in a log line or an error, only as
// `<HC_UPTIME_URL>`.

/** The uptime Worker's cron (workers/uptime/wrangler.jsonc; test/uptime.node.test.js checks they match). */
export const SCHEDULE = '*/15 * * * *';
/** One run per period: the module code and the first query are drawn by it. */
export const PERIOD_MS = 15 * 60_000;
/** The least time between one answer and the next request. */
export const GAP_MS = 4000;
/** How long after a failed check the second one starts. */
export const RETRY_MS = 90_000;
/** Searches one check may send while the answers are cache hits. */
export const TRIES = 3;
/** One request's limit. */
export const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'nusmodfinder-uptime';
const SHOWN = '<HC_UPTIME_URL>';
/** scripts/lib.mjs's MODULE_CODE_RE, copied so this file imports nothing (a test keeps them equal). */
export const CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

/**
 * Plain-English searches, one run's first in turn. Topics, not names: none is a course title or
 * code, a filter phrase or a year, so a refresh or a year switch never breaks one. 31 of them,
 * stepped QUERY_STRIDE at a time (coprime), so none comes back as a run's first query within 31
 * periods (7.75 h, past the search cache's TTL and the zone's 4 h Browser Cache TTL), and the
 * queries one run may send (two checks of TRIES) never include the next period's first.
 */
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
/** /module's 404 kinds (src/modules.js notFound): each is answered after D1's modules read succeeded. */
const MISS_KINDS = Object.freeze(['unknown', 'catalogue-only', 'ng-listed']);

/** The first query's index for a period since the epoch. @param {number} period */
export const queryIndex = (period) => (((period % QUERIES.length) * QUERY_STRIDE) % QUERIES.length + QUERIES.length) % QUERIES.length;

/**
 * Every code in a groups file (data/groups.json, `{ groups: string[][] }`), sorted, once each.
 * @param {{ groups?: unknown }} file
 */
export function moduleCodes(file) {
  const all = Array.isArray(file.groups) ? file.groups.flat() : [];
  return [...new Set(all.filter((c) => typeof c === 'string' && CODE_RE.test(c)))].sort();
}

/** What went wrong with a request, without its message (which may carry a URL). @param {unknown} err */
export function describeError(err) {
  const e = /** @type {{ name?: string, cause?: { code?: unknown } }} */ (err ?? {});
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return `timed out after ${REQUEST_TIMEOUT_MS / 1000} s`;
  const code = typeof e.cause?.code === 'string' ? e.cause.code : e.name ?? 'error';
  return `network error (${String(code).replace(/[^\w-]/g, '').slice(0, 40)})`;
}

/** A server-supplied word, made safe for a one-line report. @param {unknown} v */
const word = (v) => String(v ?? '').replace(/[^\w-]/g, '').slice(0, 40) || 'unknown';

/** @param {number} ms */
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * healthchecks.io's ping: a POST with the reason as its body, tried 3 times, 5 s apart.
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
 * One run: the check, a second one 90 s later if it failed, then the ping. `base` is the site's
 * origin with no trailing slash, already validated by the caller.
 * @param {CheckOptions} o
 * @returns {Promise<0 | 1 | 2>} 0 when the report reached healthchecks.io (or on a dry run), up or
 *   down; 1 when the ping itself failed; 2 on a configuration error, before any request
 */
export async function checkAndReport({
  base, codes, pingUrl: given, dryRun = false, fetchImpl = fetch, ping, sleep = realSleep, now = Date.now,
  log = console.log, error = console.error,
}) {
  // Every line goes through redact(), so no path can print the ping URL or its parts.
  const raw = String(given ?? '').trim();
  /** @type {URL | null} */
  let pingUrl = null;
  try { pingUrl = raw ? new URL(raw) : null; } catch { pingUrl = null; }
  // The URL as given and as parsed, its host and its path (the check's id), longest first.
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
  /** One GET, sent at least GAP_MS after the last answer. @param {string} path */
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

  /** One check: null when every route passes, else the first failure as `<route> <what>`. */
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
        // The Worker read D1's modules table to say this (a D1 failure is a 502), so D1 is up.
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
