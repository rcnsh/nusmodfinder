// @ts-check
// Read-only access to production D1 over Cloudflare's D1 REST query endpoint (Phase 7 7B, G1):
//
//   POST https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<id>/query
//   { "sql": "...", "params": [...] }
//
// The deploy guard, rollback's data check and d1:restore's re-read go through it, on the Mac
// and in GitHub Actions alike, instead of a `wrangler dev --remote` session (which would bind
// Vectorize and Workers AI too). Every statement is checked before it leaves: only SELECT and
// read-only PRAGMA statements are sent, one per request; anything else is refused in code,
// whatever the token would allow. The token is asked for once, lazily, and never appears in an
// error. `rowsRead` sums the responses' `meta.rows_read`, for run records.
//
// No Node APIs, so the Worker test harness can drive it (test/admin-hashes-rest.test.js); the
// token, account and database come from scripts/d1-read.mjs.

export const D1_API = 'https://api.cloudflare.com/client/v4';

/** PRAGMAs that only read the schema. Any other PRAGMA (and any `=` form) is refused. */
const READ_PRAGMAS = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);

/**
 * The statement with comments removed and string and identifier literals blanked, so a `;` or a
 * keyword inside one can't fool the checks below.
 * @param {string} sql
 */
function skeleton(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      out += ' ';
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j++; continue; } // a doubled quote is an escape
          break;
        }
      }
      out += `${c}x${close}`;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Throws unless `sql` is one SELECT, or one PRAGMA that only reads the schema.
 * @param {string} sql
 */
export function assertReadOnly(sql) {
  const shown = JSON.stringify(String(sql).slice(0, 80));
  const refuse = (/** @type {string} */ why) => {
    throw new Error(`D1 REST: refusing ${shown}: ${why}. Only read-only statements are sent (one SELECT, or a schema-reading PRAGMA).`);
  };
  if (typeof sql !== 'string') refuse('not a statement');
  const body = skeleton(sql).trim().replace(/;\s*$/, '').trim();
  if (!body) refuse('empty');
  if (body.includes(';')) refuse('more than one statement');
  const keyword = body.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (keyword === 'SELECT') return;
  if (keyword === 'PRAGMA') {
    const m = body.match(/^PRAGMA\s+(?:\w+\.)?(\w+)\s*(?:\(\s*[^()=]*\)\s*)?$/i);
    if (m && READ_PRAGMAS.has(m[1].toLowerCase())) return;
    refuse('a PRAGMA that may write, or one not on the read-only list');
  }
  refuse(`a ${keyword ?? 'non'}-SELECT statement`);
}

/**
 * @typedef {{ results: any[], meta: { rows_read?: number, rows_written?: number } & Record<string, unknown> }} D1Answer
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<D1Answer>, readonly rowsRead: number, readonly queries: number }} D1Client
 */

/**
 * @param {{ accountId: string, databaseId: string, token: string | (() => Promise<string>), fetchImpl?: typeof fetch }} o
 * @returns {D1Client}
 */
export function d1RestClient({ accountId, databaseId, token, fetchImpl = fetch }) {
  const url = `${D1_API}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  /** @type {Promise<string> | null} */
  let bearer = null;
  let rowsRead = 0;
  let queries = 0;
  /** @param {string} sql @param {unknown[]} [params] @returns {Promise<D1Answer>} */
  const query = async (sql, params = []) => {
    assertReadOnly(sql);
    bearer ??= Promise.resolve(typeof token === 'function' ? token() : token);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${await bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    queries++;
    /** @type {any} */
    let body = null;
    try { body = await res.json(); } catch { /* not JSON: reported below */ }
    if (!res.ok || body?.success !== true) {
      const errors = Array.isArray(body?.errors) ? body.errors.map((/** @type {any} */ e) => `${e?.code ?? '?'} ${String(e?.message ?? '').slice(0, 200)}`).join('; ') : '';
      throw new Error(`D1 REST query failed: HTTP ${res.status}${errors ? ` (${errors})` : ''}`);
    }
    const first = Array.isArray(body.result) ? body.result[0] : null;
    if (!first || !Array.isArray(first.results)) throw new Error('D1 REST query answered with no results array');
    rowsRead += Number(first.meta?.rows_read ?? 0);
    return { results: first.results, meta: first.meta ?? {} };
  };
  return {
    query,
    get rowsRead() { return rowsRead; },
    get queries() { return queries; },
  };
}
