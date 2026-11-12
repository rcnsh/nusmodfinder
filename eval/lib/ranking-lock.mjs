// @ts-check
// The ranking lock: CI's eval gate.
//
// eval/ranking-lock.json holds, for every open-set query the eval runner answers, the sha256 of
// its HTTP status and ordered result codes, in two seeds: the dev set on the pinned corpus,
// filtered, `--strip ng` and `--unfiltered`, and the fixture set on its own corpus, in the same
// three modes. It also records `inputsHash` (the git objects of LOCK_INPUTS), the embedding
// version, the corpus release, and the evidence for its lists.
//
// The gate (`checkGate`, run by `npm run eval:lock -- --check` in the eval-gate job):
// 1. Fast path: HEAD's lock equals the base's, and HEAD's inputsHash equals the lock's or the
//    base's (a commit whose eval-gate passed: the PR base, or main's last green). No runner.
//    A lock edit of any kind never takes it.
// 2. Recompute: the runner's lists at HEAD must equal HEAD's lock. When the lock's lists
//    differ from the base's, its evidence must also pass (`checkEvidence`). A neutral change
//    leaves the lock as it is, so PRs never conflict on it.
// 3. Otherwise it fails, naming each changed query with its statuses.
//
// Evidence for a ranking change, checked against the base commit's lock:
// - `holdout-pass <n>`: ledger row n, appended after the base lock's commit, verdict `pass`,
//   against the base commit's shipped-ranker pin;
// - `no-look <n>`: count-log row n, appended after the base lock's commit, whose route column
//   names one of ADR 0003's no-look routes;
// - `revert <commit>`: the lists equal those of an earlier lock, at that commit;
// - `bootstrap <ref>`: only when the base has no lock.
// A row is cited once. An unchanged evidence, and an ADR pin line, are refused. This guards
// against accidents, not against a maintainer who writes false evidence.
//
// This module needs only Node and git (no npm package), so the fast path runs before `npm ci`.
// The runner side is eval/lib/lock-runner.mjs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { NO_LOOK_ROUTES, countLogRows } from './count-log.mjs';
import { ledgerRows } from './ledger.mjs';
import { COUNT_LOG, LEDGER, REPO } from './sets.mjs';
import { HASHED } from './workspace.mjs';

export { NO_LOOK_ROUTES };

export const LOCK_PATH = 'eval/ranking-lock.json';
export const LOCK_SCHEMA = 'vnm-ranking-lock/1';

/** The runner's filter modes, as the lock names them. */
export const MODES = Object.freeze({
  filtered: Object.freeze({ unfiltered: false, strip: /** @type {string[]} */ ([]) }),
  'strip-ng': Object.freeze({ unfiltered: false, strip: ['ng'] }),
  unfiltered: Object.freeze({ unfiltered: true, strip: /** @type {string[]} */ ([]) }),
});

/** The two seeds: the judged dev set on the pinned corpus, and the fixture on its own. */
export const SEEDS = Object.freeze({
  dev: Object.freeze({ dir: 'eval/dev', corpus: 'the pinned corpus' }),
  fixture: Object.freeze({ dir: 'eval/fixtures', corpus: 'eval/fixtures/corpus.json' }),
});

/** Where the static import closure starts: the lock's CLI and runner, and the eval runner. */
export const ENTRIES = Object.freeze([
  'eval/lock.mjs',
  'eval/lib/lock-runner.mjs',
  'eval/runner/run.mjs',
  // Forked by run.mjs by path, not imported.
  'eval/runner/vitest-child.mjs',
  // Loaded by vitest.eval.config.mjs in the workspace.
  'eval/runner/retrieval.eval.js',
  'vitest.eval.config.mjs',
]);

/**
 * Non-literal dynamic imports, by file, and the listed paths each loads (in the workspace, the
 * ranker's own copy of the same paths). The completeness test fails on any other.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DYNAMIC_IMPORTS = Object.freeze({
  'eval/runner/run.mjs': ['src/vector-bundle.js'],
  'eval/lib/corpus.mjs': ['scripts/lib.mjs'],
  'eval/lib/corrected.mjs': ['src/vocabulary.js', 'src/typo.js', 'src/query-intent.js', 'src/query-intent.js', 'src/intents.js', 'src/fts-query.js', 'src/groups.js'],
  'eval/lib/compliance.mjs': ['src/vocabulary.js', 'src/query-intent.js', 'src/intents.js', 'src/vector-bundle.js', 'src/ng-bit.js'],
});

/** Bare names vitest.eval.config.mjs aliases to files each run writes into its workspace. */
export const ALIASES = Object.freeze(['vectors-bundle', 'vocabulary-data', 'groups-data', 'ng-unscheduled-data', 'catalogue-codes-data', 'prefixes-data']);

/**
 * Everything the lock's lists depend on. `inputsHash` hashes these paths' git objects.
 * test/eval/ranking-lock.node.test.js recomputes the closure and fails on any file outside it.
 */
export const LOCK_INPUTS = Object.freeze([
  // The ranker and its test Worker config (workspace.mjs HASHED).
  ...HASHED,
  // The static import closure of ENTRIES, outside HASHED.
  'eval/lock.mjs',
  'eval/lib/baseline.mjs',
  'eval/lib/compliance.mjs',
  'eval/lib/corpus.mjs',
  'eval/lib/corrected.mjs',
  'eval/lib/count-log.mjs',
  'eval/lib/crypto.mjs',
  'eval/lib/embeddings.mjs',
  'eval/lib/errors.mjs',
  'eval/lib/ledger.mjs',
  'eval/lib/lock-runner.mjs',
  'eval/lib/metrics.mjs',
  'eval/lib/query-forms.mjs',
  'eval/lib/ranking-lock.mjs',
  'eval/lib/sets.mjs',
  'eval/lib/stats.mjs',
  'eval/lib/workspace.mjs',
  'eval/runner/harness.js',
  'eval/runner/lookup-ai.js',
  'eval/runner/reporter.mjs',
  'eval/runner/retrieval.eval.js',
  'eval/runner/run.mjs',
  'eval/runner/vitest-child.mjs',
  'scripts/pinned-corpus.mjs',
  // The fakes the runner binds, and its Vitest config.
  'test/fakes.js',
  'vitest.eval.config.mjs',
  // The sets, the study map and the corpus embeddings manifest.
  'eval/study-map.json',
  'eval/dev',
  'eval/fixtures',
  'eval/embeddings.json',
  // The pinned corpus's NG list and restrictions (eval/lib/corpus.mjs).
  'eval/pinned',
  // workerd and its SQLite, Vitest and the plugin.
  'package-lock.json',
]);

/**
 * @typedef {Record<string, Record<string, Record<string, string>>>} Lists set -> mode -> query id -> "<status> <sha256>"
 * @typedef {{ kind: string, ref: string }} Evidence
 * @typedef {{
 *   schema: string, inputsHash: string, embedding: string,
 *   corpus: { release: string | null, moduleInfoSha256: string },
 *   evidence: Evidence, lists: Lists,
 * }} RankingLock
 * @typedef {{ embedding: string, corpus: RankingLock['corpus'], lists: Lists }} Computed
 * @typedef {{ ok: boolean, path: 'none' | 'fast' | 'recompute', problems: string[], notes: string[] }} GateResult
 */

/**
 * One query's entry: its status, then the sha256 of the status and the ordered codes, so a 500
 * never hashes like an empty 200 and a status shows in a diff.
 * @param {number} status
 * @param {string[]} codes
 */
export const queryHash = (status, codes) => `${status} ${createHash('sha256').update(JSON.stringify([status, codes])).digest('hex')}`;

/** @param {string} entry */
const statusOf = (entry) => entry.split(' ')[0];

/**
 * @param {string} repo
 * @param {string[]} args
 */
function git(repo, args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** @param {string} repo @param {string} rev */
export function commitOf(repo, rev) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** @param {string} repo @param {string} rev @param {string} path @returns {string | null} */
function showAt(repo, rev, path) {
  const r = git(repo, ['show', `${rev}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

/**
 * sha256 over the sorted `git ls-tree` lines (mode, type, object id, path) of `inputs` at
 * `rev`: the committed content only, so ignored and untracked files never count.
 * @param {string} repo
 * @param {string} rev
 * @param {readonly string[]} [inputs]
 */
export function inputsHash(repo, rev, inputs = LOCK_INPUTS) {
  const r = git(repo, ['ls-tree', '-r', '--full-tree', rev, '--', ...inputs]);
  if (r.status !== 0) throw new Error(`git ls-tree ${rev} failed: ${r.stderr.trim()}`);
  const lines = r.stdout.split('\n').filter(Boolean).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Uncommitted changes to LOCK_INPUTS, which the runner would read but inputsHash would not.
 * @param {string} [repo]
 */
export function dirtyInputs(repo = REPO) {
  return git(repo, ['status', '--porcelain', '--', ...LOCK_INPUTS]).stdout.split('\n').filter(Boolean);
}

/**
 * The lock committed at `rev`, or null when there is none.
 * @param {string} repo
 * @param {string} rev
 * @returns {RankingLock | null}
 */
export function readLockAt(repo, rev) {
  const text = showAt(repo, rev, LOCK_PATH);
  if (text === null) return null;
  return JSON.parse(text);
}

/** Canonical JSON (sorted keys at every level). @param {unknown} v @returns {string} */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(/** @type {any} */ (v)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Every query whose entry differs between two lists, as "<set> <mode> <id>: status A -> B".
 * @param {Lists} locked
 * @param {Lists} now
 */
export function diffLists(locked, now) {
  /** @type {string[]} */
  const out = [];
  const sets = [...new Set([...Object.keys(locked ?? {}), ...Object.keys(now ?? {})])].sort();
  for (const set of sets) {
    const modes = [...new Set([...Object.keys(locked?.[set] ?? {}), ...Object.keys(now?.[set] ?? {})])].sort();
    for (const mode of modes) {
      const a = locked?.[set]?.[mode] ?? {};
      const b = now?.[set]?.[mode] ?? {};
      for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (a[id] === b[id]) continue;
        const from = a[id] === undefined ? 'absent' : `status ${statusOf(a[id])}`;
        const to = b[id] === undefined ? 'absent' : statusOf(b[id]);
        out.push(`${set} ${mode} ${id}: ${from} -> ${to}${a[id] && b[id] && statusOf(a[id]) === statusOf(b[id]) ? ' (codes or their order changed)' : ''}`);
      }
    }
  }
  return out;
}

/** @param {Evidence | undefined} a @param {Evidence | undefined} b */
const sameEvidence = (a, b) => !!a && !!b && a.kind === b.kind && a.ref === b.ref;

/**
 * Every lock committed in the history of `rev`, newest first.
 * @param {string} repo
 * @param {string} rev
 * @returns {{ sha: string, lock: RankingLock }[]}
 */
function lockHistory(repo, rev) {
  const r = git(repo, ['log', '--format=%H', rev, '--', LOCK_PATH]);
  if (r.status !== 0) return [];
  /** @type {{ sha: string, lock: RankingLock }[]} */
  const out = [];
  for (const sha of r.stdout.split('\n').filter(Boolean)) {
    try {
      const lock = readLockAt(repo, sha);
      if (lock) out.push({ sha, lock });
    } catch { /* a version that does not parse cites nothing */ }
  }
  return out;
}

/**
 * The shipped-ranker pin (eval/lib/baseline.mjs SHIPPED_BASELINE) as committed at `rev`.
 * @param {string} repo
 * @param {string} rev
 */
export function pinAt(repo, rev) {
  const text = showAt(repo, rev, 'eval/lib/baseline.mjs') ?? '';
  return text.match(/SHIPPED_BASELINE = Object\.freeze\(\{ ref: '[^']*', sha: '([0-9a-f]{40})' \}\)/)?.[1] ?? null;
}

/** @param {string} ref */
const rowNumber = (ref) => (/^[1-9]\d*$/.test(ref) ? Number(ref) : null);

/**
 * The problems with HEAD's evidence for lists that differ from the base lock's (none when it
 * holds). `baseLock` null means the base commit has no lock.
 * @param {{ repo: string, head: string, base: string, headLock: RankingLock, baseLock: RankingLock | null }} o
 * @returns {string[]}
 */
export function checkEvidence({ repo, head, base, headLock, baseLock }) {
  const ev = headLock.evidence;
  if (!ev || typeof ev.kind !== 'string' || typeof ev.ref !== 'string' || !ev.ref) {
    return ['the lock changes the lists but records no evidence ({ kind, ref }): npm run eval:lock -- --evidence <kind> <ref>'];
  }
  if (!baseLock) {
    return ev.kind === 'bootstrap' ? [] : [`the base commit has no lock, so the first lock's evidence must be bootstrap, not ${ev.kind}`];
  }
  if (sameEvidence(ev, baseLock.evidence)) {
    return [`the evidence is unchanged from the base lock's (${ev.kind} ${ev.ref}); a change to the lists needs evidence written after the base lock`];
  }
  if (ev.kind === 'bootstrap') return ['bootstrap evidence is allowed only when the base commit has no lock, and this base has one'];
  if (ev.kind === 'pin' || ev.kind === 'adr-pin') return ['an ADR 0003 pin line is not evidence: pin lines are written after the merge'];

  const history = lockHistory(repo, base);
  if (ev.kind !== 'revert') {
    const cited = history.find((h) => sameEvidence(h.lock.evidence, ev));
    if (cited) return [`${ev.kind} ${ev.ref} is already cited by the lock at ${cited.sha.slice(0, 7)}; a row can be cited once`];
  }
  const baseLockCommit = git(repo, ['log', '-1', '--format=%H', base, '--', LOCK_PATH]).stdout.trim();

  if (ev.kind === 'holdout-pass') {
    const n = rowNumber(ev.ref);
    if (n === null) return [`holdout-pass takes a ledger row number (1-based), not ${JSON.stringify(ev.ref)}`];
    const rows = ledgerRows(showAt(repo, head, LEDGER) ?? '');
    const before = ledgerRows(showAt(repo, baseLockCommit, LEDGER) ?? '').length;
    if (n > rows.length) return [`ledger row ${n} does not exist at HEAD (${rows.length} rows); commit the row first`];
    if (n <= before) return [`ledger row ${n} was not appended after the base lock (${baseLockCommit.slice(0, 7)} had ${before} rows)`];
    const cells = rows[n - 1];
    const [set, verdict, ranker] = [cells[1] ?? '', cells[5] ?? '', cells[9] ?? ''];
    /** @type {string[]} */
    const problems = [];
    if (set !== 'holdout') problems.push(`ledger row ${n} is a ${set || 'blank'} row, not a holdout look`);
    if (verdict !== 'pass') problems.push(`ledger row ${n} has verdict ${verdict || 'blank'}, not pass`);
    const pin = pinAt(repo, base);
    if (!pin) problems.push(`the base commit ${base.slice(0, 7)} records no shipped-ranker pin`);
    else if (ranker !== pin.slice(0, 7)) problems.push(`ledger row ${n} has baseline ranker ${ranker || 'blank'}, not the base commit's pin ${pin.slice(0, 7)}`);
    return problems;
  }

  if (ev.kind === 'no-look') {
    const n = rowNumber(ev.ref);
    if (n === null) return [`no-look takes a count-log row number (1-based), not ${JSON.stringify(ev.ref)}`];
    const rows = countLogRows(showAt(repo, head, COUNT_LOG) ?? '');
    const before = countLogRows(showAt(repo, baseLockCommit, COUNT_LOG) ?? '').length;
    if (n > rows.length) return [`count-log row ${n} does not exist at HEAD (${rows.length} rows); commit the row first`];
    if (n <= before) return [`count-log row ${n} was not appended after the base lock (${baseLockCommit.slice(0, 7)} had ${before} rows)`];
    const { route } = rows[n - 1];
    if (!NO_LOOK_ROUTES.includes(route)) {
      return [`count-log row ${n} names no no-look route (route: ${route || 'none'}); ADR 0003's are ${NO_LOOK_ROUTES.join(', ')}`];
    }
    return [];
  }

  if (ev.kind === 'revert') {
    const target = commitOf(repo, ev.ref);
    const earlier = target ? history.find((h) => h.sha === target) : undefined;
    if (!earlier) return [`revert ${ev.ref}: no earlier lock in the base's history was written at that commit`];
    if (canonical(earlier.lock.lists) !== canonical(headLock.lists)) return [`revert ${ev.ref}: the lists differ from that lock's`];
    return [];
  }

  return [`unknown evidence kind ${JSON.stringify(ev.kind)}; expected holdout-pass, no-look, revert or bootstrap`];
}

/**
 * The fast path alone: HEAD's lock equals the base's, and HEAD's inputs equal the lock's or the
 * base's. `reason` says why it holds or not.
 * @param {{ repo?: string, base?: string | null, head?: string }} o
 * @returns {{ fast: boolean, reason: string }}
 */
export function fastPath({ repo = REPO, base, head = 'HEAD' }) {
  const headLock = readLockAt(repo, head);
  if (!headLock) return { fast: false, reason: `HEAD has no ${LOCK_PATH}` };
  const baseSha = base ? commitOf(repo, base) : null;
  if (!baseSha) return { fast: false, reason: base ? `the base ${base} is not in this clone` : 'no base to compare with' };
  const baseLock = readLockAt(repo, baseSha);
  if (!baseLock) return { fast: false, reason: `the base ${baseSha.slice(0, 7)} has no lock` };
  if (canonical(headLock) !== canonical(baseLock)) return { fast: false, reason: `the lock differs from the base's (${baseSha.slice(0, 7)})` };
  const now = inputsHash(repo, head);
  if (now === headLock.inputsHash) return { fast: true, reason: 'the inputs are unchanged since the lock was written' };
  if (now === inputsHash(repo, baseSha)) return { fast: true, reason: `the inputs equal the base's (${baseSha.slice(0, 7)}), whose eval-gate passed` };
  return { fast: false, reason: 'the inputs differ from the lock\'s and the base\'s' };
}

/**
 * The eval gate. `recompute` gives the runner's lists at HEAD (eval/lib/lock-runner.mjs
 * computeLists); it runs only off the fast path. Without a reachable base the lists are still
 * recomputed and compared, but there is no base lock to check evidence against (noted).
 * @param {{ repo?: string, base?: string | null, head?: string, recompute: () => Promise<Computed> }} o
 * @returns {Promise<GateResult>}
 */
export async function checkGate({ repo = REPO, base, head = 'HEAD', recompute }) {
  /** @type {string[]} */
  const notes = [];
  /** @type {RankingLock | null} */
  let headLock;
  try {
    headLock = readLockAt(repo, head);
  } catch (err) {
    return { ok: false, path: 'none', problems: [`${LOCK_PATH} at HEAD does not parse: ${/** @type {Error} */ (err).message}`], notes };
  }
  if (!headLock) {
    return { ok: false, path: 'none', problems: [`HEAD has no ${LOCK_PATH}; write it with npm run eval:lock -- --evidence bootstrap <ref>`], notes };
  }
  const shape = lockShapeProblems(headLock);
  if (shape.length) return { ok: false, path: 'none', problems: shape, notes };

  const fast = fastPath({ repo, base, head });
  if (fast.fast) return { ok: true, path: 'fast', problems: [], notes: [fast.reason] };
  notes.push(`no fast path: ${fast.reason}`);

  const computed = await recompute();
  /** @type {string[]} */
  const problems = [];
  if (computed.embedding !== headLock.embedding) {
    problems.push(`the lock records embedding ${headLock.embedding}, but HEAD's lists were computed with ${computed.embedding}; rewrite the lock with npm run eval:lock`);
  }
  if (canonical(computed.corpus) !== canonical(headLock.corpus)) {
    problems.push(`the lock records corpus ${canonical(headLock.corpus)}, but HEAD's lists were computed on ${canonical(computed.corpus)}`);
  }
  problems.push(...diffLists(headLock.lists, computed.lists));
  if (problems.length) return { ok: false, path: 'recompute', problems, notes };

  const baseSha = base ? commitOf(repo, base) : null;
  if (!baseSha) {
    notes.push('no reachable base, so the evidence was not checked');
    return { ok: true, path: 'recompute', problems, notes };
  }
  const baseLock = readLockAt(repo, baseSha);
  if (!baseLock || canonical(baseLock.lists) !== canonical(headLock.lists)) {
    problems.push(...checkEvidence({ repo, head, base: baseSha, headLock, baseLock }));
    if (!problems.length) notes.push(`the lists changed, with evidence ${headLock.evidence.kind} ${headLock.evidence.ref}`);
  } else {
    notes.push('HEAD\'s lists equal the base lock\'s (ranking-neutral)');
  }
  return { ok: problems.length === 0, path: 'recompute', problems, notes };
}

/** @param {any} lock */
export function lockShapeProblems(lock) {
  /** @type {string[]} */
  const p = [];
  if (lock?.schema !== LOCK_SCHEMA) p.push(`${LOCK_PATH}: schema must be ${LOCK_SCHEMA}`);
  if (typeof lock?.inputsHash !== 'string') p.push(`${LOCK_PATH}: no inputsHash`);
  if (!lock?.lists || typeof lock.lists !== 'object') p.push(`${LOCK_PATH}: no lists`);
  return p;
}

// ---------------------------------------------------------------------------
// LOCK_INPUTS completeness: the static import closure of ENTRIES, read with acorn.

/** @param {string} path a repo-relative posix path */
const covered = (path) => LOCK_INPUTS.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Problems with LOCK_INPUTS against the closure under `root`: a file outside it, an import that
 * resolves to nothing, a bare name that is neither a built-in, a locked package nor an eval
 * alias, and a non-literal dynamic import not declared in DYNAMIC_IMPORTS.
 * @param {{ root?: string }} [o]
 * @returns {Promise<string[]>}
 */
export async function lockInputsProblems({ root = REPO } = {}) {
  const { parse } = await import('acorn');
  const lockfile = existsSync(join(root, 'package-lock.json')) ? join(root, 'package-lock.json') : join(REPO, 'package-lock.json');
  const packages = new Set(Object.keys(JSON.parse(readFileSync(lockfile, 'utf8')).packages ?? {})
    .filter((k) => k.startsWith('node_modules/')).map((k) => k.slice('node_modules/'.length)));
  const builtins = new Set(builtinModules);
  /** @type {string[]} */
  const problems = [];
  if (!LOCK_INPUTS.includes('package-lock.json')) problems.push('package-lock.json (workerd and its SQLite) is outside LOCK_INPUTS');
  /** @type {Set<string>} */
  const seen = new Set();
  const queue = [...ENTRIES];
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    if (!covered(file)) problems.push(`${file} is in the eval runner's import closure but outside LOCK_INPUTS`);
    if (!/\.m?js$/.test(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) {
      problems.push(`${file} is imported but does not exist`);
      continue;
    }
    const ast = parse(readFileSync(abs, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    let dynamic = 0;
    /** @param {string} spec */
    const follow = (spec) => {
      if (spec.startsWith('.')) {
        const target = resolveRelative(root, file, spec);
        if (target) queue.push(target);
        else problems.push(`${file} imports ${spec}, which resolves to no file`);
        return;
      }
      if (spec.startsWith('node:') || spec.startsWith('cloudflare:') || builtins.has(spec)) return;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (packages.has(name) || ALIASES.includes(spec)) return;
      problems.push(`${file} imports ${spec}, which is neither a built-in, a locked package nor an eval alias`);
    };
    /** @param {any} node */
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
        follow(String(node.source.value));
      } else if (node.type === 'ImportExpression') {
        const s = node.source;
        if (s.type === 'Literal' && typeof s.value === 'string') follow(s.value);
        else if (s.type === 'TemplateLiteral' && s.expressions.length === 0) follow(s.quasis[0].value.cooked);
        else dynamic++;
      }
      for (const v of Object.values(node)) {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object' && v !== node.loc) visit(v);
      }
    };
    visit(ast);
    const declared = DYNAMIC_IMPORTS[file] ?? [];
    if (dynamic !== declared.length) {
      problems.push(`${file} has ${dynamic} dynamic import(s) of a computed path, but DYNAMIC_IMPORTS declares ${declared.length}: a dynamic import must resolve to a listed path`);
    }
    for (const target of declared) {
      if (!covered(target)) problems.push(`${file} dynamically imports ${target}, which is outside LOCK_INPUTS`);
    }
  }
  return problems;
}

/**
 * @param {string} root
 * @param {string} from repo-relative file
 * @param {string} spec relative specifier
 * @returns {string | null} the repo-relative target
 */
function resolveRelative(root, from, spec) {
  const base = normalize(join(dirname(from), spec)).split('\\').join('/');
  if (base.startsWith('..')) return null;
  // A data file (JSON, a bundle) is a dependency to cover, not code to read.
  if (!/\.m?js$/.test(base) && /\.[a-z0-9]+$/i.test(base)) return base;
  for (const c of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) if (existsSync(join(root, c))) return c;
  return null;
}
