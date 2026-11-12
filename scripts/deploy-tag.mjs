// @ts-check
// The deploy trace in git: an annotated tag on the deployed commit for every
// deploy and rollback,
//
//   deploy/<UTC yyyymmddThhmmssZ>-<version id, first 8>     on HEAD, by `npm run deploy`
//   rollback/<UTC yyyymmddThhmmssZ>-<version id, first 8>   on the target's commit, by `npm run rollback`
//
// whose annotation is a title paragraph and one `key: value` paragraph per field (versionId,
// previousVersionId, commit, dataVersion, startupMs, and every guard check's `field`, the
// catalogueKey among them). Rollback reads a target's commit and data from its tag. The two
// oldest deploy tags were made by hand after the fact and carry `backfilled: true` and `source`.

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 * @typedef {'deploy' | 'rollback'} TagKind
 * @typedef {Record<string, string | number | boolean | null | undefined>} TagFields
 */

/** `20261112T101530Z`. @param {Date} d */
export const tagStamp = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');

/** @param {TagKind} kind @param {Date} date @param {string} versionId */
export const tagName = (kind, date, versionId) => `${kind}/${tagStamp(date)}-${versionId.slice(0, 8)}`;

/** A tag name's time, for ordering (`null` if it isn't one of ours). @param {string} name */
export const tagTime = (name) => /^(?:deploy|rollback)\/(\d{8}T\d{6}Z)-[0-9a-f]{8}$/.exec(name)?.[1] ?? null;

/** The fields that have a value, as `key: value` lines. @param {TagFields} fields */
const fieldLines = (fields) => Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`);

/**
 * `git tag -a` arguments: one `-m` paragraph for the title and one for each field.
 * @param {string} name @param {string} commit @param {string} title @param {TagFields} fields
 */
export const tagArgs = (name, commit, title, fields) => ['tag', '-a', name, commit, '-m', title, ...fieldLines(fields).flatMap((l) => ['-m', l])];

/** The `key: value` lines of an annotation. @param {string} text @returns {Record<string, string>} */
export function parseTagFields(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z][\w-]*): (.+)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** The command that pushes a tag (also printed for a retry). @param {string} name */
export const pushCommand = (name) => `git push origin refs/tags/${name}`;

/**
 * Creates the annotated tag and pushes it. Neither failure throws: the caller reports it.
 * @param {{ exec: Exec, name: string, commit: string, title: string, fields: TagFields }} o
 * @returns {Promise<{ created: boolean, pushed: boolean }>}
 */
export async function createAndPushTag({ exec, name, commit, title, fields }) {
  const made = await exec('git', tagArgs(name, commit, title, fields));
  if (made.code !== 0) return { created: false, pushed: false };
  const pushed = await exec('git', ['push', 'origin', `refs/tags/${name}`]);
  return { created: true, pushed: pushed.code === 0 };
}

/** Fetches every deploy and rollback tag from origin (force: a moved tag follows origin). @param {Exec} exec */
export async function fetchTraceTags(exec) {
  const r = await exec('git', ['fetch', '--quiet', '--force', 'origin', '+refs/tags/deploy/*:refs/tags/deploy/*', '+refs/tags/rollback/*:refs/tags/rollback/*']);
  return r.code === 0;
}

/**
 * Every local deploy and rollback tag with the commit it points at.
 * @param {Exec} exec
 * @returns {Promise<{ name: string, commit: string }[]>}
 */
export async function listTraceTags(exec) {
  const r = await exec('git', ['for-each-ref', '--format=%(refname:short)%09%(*objectname)', 'refs/tags/deploy', 'refs/tags/rollback']);
  if (r.code !== 0) throw new Error(`git for-each-ref failed (exit ${r.code})`);
  return r.stdout.split('\n').filter(Boolean).map((l) => { const [name, commit] = l.split('\t'); return { name, commit }; })
    .filter((t) => tagTime(t.name) !== null && /^[0-9a-f]+$/.test(t.commit ?? ''));
}

/**
 * The newest trace tag by its time (what is live, as far as git knows).
 * @param {{ name: string, commit: string }[]} tags
 */
export const newestTag = (tags) => [...tags].sort((a, b) => String(tagTime(b.name)).localeCompare(String(tagTime(a.name))))[0] ?? null;

/**
 * The tag naming a version (by its first 8), deploy/ before rollback/, newest first; with its
 * commit and fields. Fetches the tags first; works from local tags when that fails.
 * @param {{ exec: Exec, versionId: string, fetch?: boolean }} o
 * @returns {Promise<{ name: string, commit: string, fields: Record<string, string> } | null>}
 */
export async function findVersionTag({ exec, versionId, fetch = true }) {
  if (fetch) await fetchTraceTags(exec);
  const id8 = versionId.slice(0, 8);
  const hits = (await listTraceTags(exec)).filter((t) => t.name.endsWith(`-${id8}`))
    .sort((a, b) => (a.name.startsWith('deploy/') === b.name.startsWith('deploy/') ? String(tagTime(b.name)).localeCompare(String(tagTime(a.name))) : a.name.startsWith('deploy/') ? -1 : 1));
  const hit = hits[0];
  if (!hit) return null;
  const r = await exec('git', ['for-each-ref', '--format=%(contents)', `refs/tags/${hit.name}`]);
  if (r.code !== 0) throw new Error(`could not read tag ${hit.name}`);
  return { name: hit.name, commit: hit.commit, fields: parseTagFields(r.stdout) };
}
