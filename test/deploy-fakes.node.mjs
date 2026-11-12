// @ts-check
// Fakes shared by the Phase 7 7B tests (deploy, preflight, rollback, d1:restore): a git, gh
// and wrangler exec answered from a table, GitHub's push runs, and production D1 behind the
// real D1 REST client (scripts/d1-rest.mjs) with a fake fetch. Nothing here reaches GitHub,
// Cloudflare or the repo's remote.
import { HASHES_SQL, REQUIRED_TRIGGERS } from '../src/admin-hashes.js';
import { dataVersion, ROW_COLUMNS } from '../src/rowhash.js';
import { rowsKey } from '../src/vector-bundle.js';
import { d1RestClient } from '../scripts/d1-rest.mjs';

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const SHORT = '0123456';
/** The commit the live version's tag names (the back-filled `b0834844`'s). */
export const LIVE_SHA = 'a23601de0b15934960bfef1d8b56ab3e80fa5587';
export const LIVE_TAG = 'deploy/20261111T235933Z-b0834844';
export const VERSION = '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';
export const PREVIOUS = 'b0834844-f6fd-4bb9-838d-a45927c195fb';
export const SHIM = '/repo/.data/vectors/vec-production-abc-emb.js';
export const NOW = new Date('2026-11-12T10:15:30Z');
export const TAG = 'deploy/20261112T101530Z-9b1c2d3e';
/** A token the tests look for in every output: it must never appear. */
export const TOKEN = 'cf-token-NEVER-PRINT-ME-0123456789';

/** D1 as runbook step 4 left it, and the production bundle built for it. */
export const D1_MODULES = /** @type {const} */ ([
  { code: 'CS1010S', title: 'Programming Methodology', description: 'd1', text_hash: 't1', row_hash: 'r1', acad_year: '2026-2027' },
  { code: 'CS2040', title: 'Data Structures and Algorithms', description: 'd2', text_hash: 't2', row_hash: 'r2', acad_year: '2026-2027' },
]);
export const DV = await dataVersion(D1_MODULES.map((m) => ({ code: m.code, rowHash: m.row_hash })));
export const KEY = await rowsKey(D1_MODULES.map((m) => ({ code: m.code, textHash: m.text_hash })));

/** @param {Partial<{ corpus: string, sha256: string, dataVersion: string, rowsKey: string }>} [o] */
export const bundleOf = (o = {}) => async () => {
  const corpus = o.corpus ?? 'production';
  return /** @type {import('../scripts/deploy.mjs').DeployBundle} */ (/** @type {unknown} */ ({
    entry: { corpus, count: 2, dataVersion: o.dataVersion ?? DV, rowsKey: o.rowsKey ?? KEY, sha256: o.sha256 ?? 'prod-sha' },
    header: { corpus, dataVersion: o.dataVersion ?? DV, rowsKey: o.rowsKey ?? KEY },
    sha256: o.sha256 ?? 'prod-sha', shim: SHIM, others: ['fixture-sha', 'pinned-sha'],
  }));
};

/**
 * One GitHub Actions run as `GET /repos/…/actions/runs` lists it.
 * @param {string} name @param {Partial<{ id: number, status: string, conclusion: string | null, head_sha: string, run_number: number }>} [o]
 */
export const ghRun = (name, o = {}) => ({
  id: o.id ?? (name === 'CI' ? 101 : 202), name, event: 'push', head_sha: o.head_sha ?? SHA, head_branch: 'main',
  status: o.status ?? 'completed', conclusion: o.conclusion === undefined ? 'success' : o.conclusion,
  run_number: o.run_number ?? 1, created_at: '2026-11-12T10:00:00Z', html_url: `https://github.com/o/r/actions/runs/${o.id ?? 0}`,
});
/** @param {object[]} runs */
export const runsBody = (runs) => JSON.stringify({ total_count: runs.length, workflow_runs: runs });
export const GREEN = runsBody([ghRun('CI'), ghRun('Findings')]);

export const RUNS_API = `gh api repos/{owner}/{repo}/actions/runs?head_sha=${SHA}&event=push&per_page=100`;
export const TAG_FETCH = 'git fetch --quiet --force origin +refs/tags/deploy/*:refs/tags/deploy/* +refs/tags/rollback/*:refs/tags/rollback/*';
export const TAG_LIST = 'git for-each-ref --format=%(refname:short)%09%(*objectname) refs/tags/deploy refs/tags/rollback';
export const STATUS_KEY = 'git status --porcelain --untracked-files=all --ignore-submodules=none';

/** `wrangler deployments status --json` with `id` at 100%. @param {string} id */
export const statusJson = (id) => JSON.stringify({ id: 'dep-1', created_on: '2026-11-11T23:59:33Z', versions: [{ version_id: id, percentage: 100 }] });

/**
 * A fake exec answering git, gh and wrangler from a table; records every call. `git tag` and
 * `git push` answer `over.tag` / `over.push` (ok by default); wrangler subcommands answer
 * `over.check`, `over.upload`, `over.status`, `over.promote`, `over.triggers`.
 * @param {Record<string, { code?: number, stdout?: string } | ((args: string[]) => { code?: number, stdout?: string })>} [over]
 */
export function fakeExec(over = {}) {
  /** @type {Record<string, any>} */
  const table = {
    [STATUS_KEY]: { stdout: '' },
    'git ls-files -v': { stdout: 'H src/index.js\nH package.json\n' },
    'git fetch --quiet origin main': {},
    'git rev-parse HEAD': { stdout: `${SHA}\n` },
    'git rev-parse refs/remotes/origin/main': { stdout: `${SHA}\n` },
    'git merge-base --is-ancestor HEAD refs/remotes/origin/main': {},
    'git rev-parse --short HEAD': { stdout: `${SHORT}\n` },
    'git log -1 --format=%s': { stdout: 'feat(search): add Server-Timing\n' },
    [RUNS_API]: { stdout: GREEN },
    [TAG_FETCH]: {},
    [TAG_LIST]: { stdout: `${LIVE_TAG}\t${LIVE_SHA}\n` },
    [`git diff --name-only --no-renames ${LIVE_SHA} HEAD`]: { stdout: 'src/search.js\n' },
    ...over,
  };
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    /** @param {any} v */
    const answer = (v) => { const r = typeof v === 'function' ? v(args) : v; return { code: r?.code ?? 0, stdout: r?.stdout ?? '' }; };
    if (cmd === 'npx' && args[0] === 'wrangler') {
      const sub = args.slice(1, 3).join(' ');
      const w = sub === 'check startup' ? over.check ?? { stdout: 'Bundle: 10500.00 KiB\nLocal startup profile:\n  Active: 4.2 ms\n' }
        : sub === 'versions upload' ? over.upload ?? { stdout: `Total Upload: 10500 KiB\nWorker Startup Time: 21 ms\nWorker Version ID: ${VERSION}\n` }
          : sub === 'deployments status' ? over.status ?? { stdout: statusJson(PREVIOUS) }
            : sub === 'versions deploy' ? over.promote ?? { stdout: 'Deployed\n' }
              : sub === 'triggers deploy' ? over.triggers ?? { stdout: 'Deployed triggers\n' }
                : over[`wrangler ${sub}`] ?? { code: 99, stdout: `unexpected wrangler ${args.join(' ')}` };
      return answer(w);
    }
    if (cmd === 'git' && args[0] === 'tag') return answer(over.tag ?? {});
    if (cmd === 'git' && args[0] === 'push') return answer(over.push ?? {});
    const hit = table[[cmd, ...args].join(' ')];
    if (!hit) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return answer(hit);
  };
  return { exec, calls };
}

/** What 0006+ looks like to schemaStatus (src/admin-hashes.js). */
export const HEALTHY_SCHEMA = {
  version: '10', fts: "CREATE VIRTUAL TABLE modules_fts USING fts5(code, title, description, content='modules', content_rowid='rowid')",
  trig: 'CREATE TRIGGER modules_fts_update AFTER UPDATE ON modules BEGIN INSERT INTO modules_fts(modules_fts, rowid) VALUES (\'delete\', old.rowid); END',
  triggers: JSON.stringify(REQUIRED_TRIGGERS), row_hash: 1, columns: JSON.stringify([...ROW_COLUMNS, 'row_hash']),
};

/**
 * Production D1 behind the real REST client: a fake fetch answers the schema query and the
 * hashes query from `modules`, and any SQL in `extra` (by exact text), with `rows_read` in meta.
 * @param {{ modules?: readonly Record<string, unknown>[], rowsRead?: number, extra?: Record<string, Record<string, unknown>[]>,
 *   status?: number, token?: string }} [o]
 */
export function fakeD1(o = {}) {
  const { modules = D1_MODULES, rowsRead = 6800, extra = {}, status = 200, token = TOKEN } = o;
  /** @type {{ url: string, sql: string, params: unknown[], auth: string | null }[]} */
  const sent = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(input), sql: body.sql, params: body.params ?? [], auth: new Headers(init?.headers).get('authorization') });
    if (status !== 200) return Response.json({ success: false, errors: [{ code: 7403, message: 'The given account is not valid or is not authorized to access this service' }], result: null }, { status });
    /** @type {Record<string, unknown>[]} */
    let results;
    let read = 1;
    if (/FROM meta WHERE key = 'schema'/.test(body.sql)) results = [HEALTHY_SCHEMA];
    else if (body.sql === HASHES_SQL) { results = [...modules]; read = rowsRead; }
    else if (body.sql in extra) { results = extra[body.sql]; read = results.length; }
    else return Response.json({ success: false, errors: [{ code: 7500, message: `no such query in the fake: ${body.sql}` }], result: null }, { status: 400 });
    return Response.json({ success: true, errors: [], messages: [], result: [{ results, success: true, meta: { rows_read: read, rows_written: 0 } }] });
  };
  const client = d1RestClient({ accountId: 'acct-id', databaseId: 'db-id', token: async () => token, fetchImpl });
  return { client, sent, fetchImpl };
}
