#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_ACAD_YEAR } from './lib.mjs';
import { ROOT, isPlainName, manifestRel, notPlain, readManifest, revisionOf } from './ng-sources.mjs';
import { startRun } from './run-record.mjs';

export const MAGIC = Buffer.from('VNMSRC1\n');
export const DEFAULT_KEY_PATH = join(homedir(), '.config/vnm/sources-archive.key');
export const HOLDOUT_KEY_NAME = 'holdout.key';

/** @param {Buffer | string} b */
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** @param {{ key?: string, env?: NodeJS.ProcessEnv }} [o] */
export function keyPath({ key, env = process.env } = {}) {
  const path = resolve(key ?? env.VNM_SOURCES_KEY_FILE ?? DEFAULT_KEY_PATH);
  const holdout = resolve(env.VNM_HOLDOUT_KEY_FILE ?? join(homedir(), '.config/vnm', HOLDOUT_KEY_NAME));
  if (isHoldoutName(path) || path.toLowerCase() === holdout.toLowerCase()) {
    throw new Error(`${path} is the holdout key's path; the sources archive has its own key (--key, VNM_SOURCES_KEY_FILE, default ${DEFAULT_KEY_PATH})`);
  }
  return path;
}

/** @param {string} path */
const isHoldoutName = (path) => basename(path).toLowerCase() === HOLDOUT_KEY_NAME;

/**
 * @param {string} path
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer}
 */
export function readKey(path, env = process.env) {
  if (!existsSync(path)) throw new Error(`no sources key at ${path} (npm run sources -- keygen --out <path>, or restore it from Bitwarden: nusmodfinder/sources-archive-key)`);
  const real = realpathSync(path);
  const refuse = () => new Error(`${path} is the holdout key (${real}); the sources archive has its own key`);
  if (isHoldoutName(real)) throw refuse();
  if (env.VNM_HOLDOUT_KEY_FILE && existsSync(env.VNM_HOLDOUT_KEY_FILE)) {
    const a = statSync(real);
    const b = statSync(env.VNM_HOLDOUT_KEY_FILE);
    if (a.dev === b.dev && a.ino === b.ino) throw refuse();
  }
  const text = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error(`${path} is not a sources key (64 hex characters)`);
  return Buffer.from(text, 'hex');
}

/** @param {string} out */
export function keygen(out) {
  const path = resolve(out);
  if (isHoldoutName(path)) throw new Error(`${path} is the holdout key's name; choose another`);
  if (existsSync(path)) throw new Error(`${path} exists; keygen never overwrites a key`);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** @param {string} year @param {string} revision */
const aad = (year, revision) => Buffer.from(`vnm-sources ${year} ${revision}`);

/**
 * @param {{ year: string, revision: string, files: { name: string, bytes: Buffer }[], key: Buffer }} o
 * @returns {Buffer}
 */
export function seal({ year, revision, files, key }) {
  const index = { year, revision, files: files.map((f) => ({ name: f.name, sha256: sha256(f.bytes), bytes: f.bytes.length })) };
  const head = Buffer.from(JSON.stringify(index));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  const plain = gzipSync(Buffer.concat([len, head, ...files.map((f) => f.bytes)]));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(year, revision));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

/**
 * @param {{ archive: Buffer, key: Buffer, year: string, revision: string }} o
 * @returns {{ name: string, bytes: Buffer, sha256: string }[]}
 */
export function open({ archive, key, year, revision }) {
  if (archive.length < MAGIC.length + 28 || !archive.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sources archive');
  const iv = archive.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = archive.subarray(archive.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(year, revision));
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = gunzipSync(Buffer.concat([decipher.update(archive.subarray(MAGIC.length + 12, archive.length - 16)), decipher.final()]));
  } catch {
    throw new Error(`the archive does not open with this key for ${year} revision ${revision} (a wrong key, or a damaged or swapped archive)`);
  }
  const n = plain.readUInt32BE(0);
  const index = JSON.parse(plain.subarray(4, 4 + n).toString('utf8'));
  if (index.year !== year || index.revision !== revision) throw new Error(`the archive is ${index.year} revision ${index.revision}, not ${year} ${revision}`);
  let at = 4 + n;
  return index.files.map((/** @type {{ name: string, sha256: string, bytes: number }} */ f) => {
    const bytes = plain.subarray(at, at + f.bytes);
    at += f.bytes;
    const got = sha256(bytes);
    if (got !== f.sha256) throw new Error(`${f.name} in the archive has sha256 ${got}, not its index's ${f.sha256}`);
    return { name: f.name, bytes, sha256: got };
  });
}

/** @param {string} year @param {string} date */
export const releaseName = (year, date) => `sources-${year}-${date.replaceAll('-', '')}`;

/**
 * @param {import('./ng-sources.mjs').Revision} rev
 * @returns {{ name: string, sha256: string | null, id: string }[]}
 */
export function archivedFiles(rev) {
  const out = [];
  for (const d of rev.documents) {
    if (d.unarchived) continue;
    if (d.file) out.push({ name: d.file, sha256: d.sha256, id: d.id });
    if (d.text) out.push({ name: d.text, sha256: d.textSha256 ?? null, id: `${d.id} (text)` });
  }
  return out;
}

/** @param {{ name: string, id?: string }[]} files */
const pathNames = (files) => files.filter((f) => !isPlainName(f.name)).map((f) => notPlain(f.id ? `${f.id}'s` : 'the archive entry', f.name));

/**
 * @typedef {(release: string, file: string, o: { title: string, notes: string }) => Promise<void>} Upload
 * @typedef {(release: string, asset: string, destDir: string) => Promise<void>} Download
 */

/** @type {Upload} */
async function ghUpload(release, file, { title, notes }) {
  const r = spawnSync('gh', ['release', 'create', release, file, '--title', title, '--notes', notes], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`gh release create ${release} failed (exit ${r.status})`);
}

/** @type {Download} */
async function ghDownload(release, asset, destDir) {
  const r = spawnSync('gh', ['release', 'download', release, '--pattern', asset, '--dir', destDir, '--clobber'], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`gh release download ${release} --pattern ${asset} failed (exit ${r.status})`);
}

/**
 * @param {{ from: string, year?: string, revision?: string, key?: string, root?: string, upload?: Upload,
 *   log?: (m: string) => void, runsDir?: string, args?: string[], env?: NodeJS.ProcessEnv }} o
 */
export async function publish({ from, year = DEFAULT_ACAD_YEAR, revision, key, root = ROOT, upload = ghUpload, log = console.log, runsDir, args = [], env = process.env }) {
  const rel = manifestRel(year);
  const manifest = readManifest(year, { root });
  if (!manifest) throw new Error(`no ${rel}`);
  const rev = revisionOf(manifest, revision);
  if (!rev) throw new Error(`${rel} has no revision ${revision ?? '(none)'}`);
  if (rev.archive.sha256) throw new Error(`${rel} revision ${rev.date} already has its archive (${rev.archive.release}); an archive is never replaced: add a new revision`);
  const named = pathNames(archivedFiles(rev));
  if (named.length) throw new Error(`refusing to publish ${rev.date}:\n  ${named.join('\n  ')}`);
  const files = [];
  const problems = [];
  for (const f of archivedFiles(rev)) {
    const path = join(from, f.name);
    if (!existsSync(path)) { problems.push(`${f.name} (${f.id}) is not in ${from}`); continue; }
    const bytes = readFileSync(path);
    if (f.sha256 && sha256(bytes) !== f.sha256) problems.push(`${f.name}: sha256 ${sha256(bytes)}, not the manifest's ${f.sha256}`);
    files.push({ name: f.name, bytes });
  }
  const pending = rev.documents.filter((d) => d.confirm?.some((k) => k === 'file' || k === 'sha256' || k === 'text'));
  for (const d of pending) problems.push(`${d.id}: its ${d.confirm?.join(', ')} still to confirm; fill them in (or mark it \`unarchived\` with the reason) first`);
  if (problems.length) throw new Error(`refusing to publish ${rev.date}:\n  ${problems.join('\n  ')}`);
  const k = readKey(keyPath({ ...(key ? { key } : {}), env }), env);
  const archive = seal({ year, revision: rev.date, files, key: k });
  const release = releaseName(year, rev.date);
  const asset = `${release}.vnmsrc`;
  const dir = mkdtempSync(join(tmpdir(), 'vnm-sources-'));
  const record = startRun('sources publish', { target: `GitHub release ${release}`, args, ...(runsDir ? { dir: runsDir } : {}) });
  try {
    const file = join(dir, asset);
    writeFileSync(file, archive);
    const digest = sha256(archive);
    record.request('gh release create');
    await upload(release, file, { title: asset, notes: `NUS source documents, ${year} revision ${rev.date}, AES-256-GCM (key: nusmodfinder/sources-archive-key). sha256 ${digest}` });
    record.wrote('GitHub release asset', { actual: 1 });
    record.version('release', release);
    record.detail('sha256', digest);
    record.detail('files', files.length);
    rev.archive = { release, asset, sha256: digest };
    for (const d of rev.documents) {
      const text = d.text && !d.unarchived ? files.find((f) => f.name === d.text) : undefined;
      if (text) d.textSha256 = sha256(text.bytes);
    }
    writeFileSync(join(root, rel), `${JSON.stringify(manifest, null, 1)}\n`);
    record.finish('ok', { exitCode: 0 });
    log(`sources: published ${release} (${files.length} files, sha256 ${digest.slice(0, 12)}); wrote it into ${rel}. Commit ${rel}.`);
    return { release, asset, sha256: digest };
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: /** @type {Error} */ (err).message });
    throw err;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {{ year?: string, revision?: string, key?: string, out?: string, root?: string, download?: Download,
 *   log?: (m: string) => void, env?: NodeJS.ProcessEnv }} [o]
 * @returns {Promise<{ dir: string, revision: string, files: string[] }>}
 */
export async function restore({ year = DEFAULT_ACAD_YEAR, revision, key, out, root = ROOT, download = ghDownload, log = console.log, env = process.env } = {}) {
  const rel = manifestRel(year);
  const manifest = readManifest(year, { root });
  if (!manifest) throw new Error(`no ${rel}`);
  const rev = revisionOf(manifest, revision);
  if (!rev) throw new Error(`${rel} has no revision ${revision ?? '(none)'}`);
  if (!rev.archive.sha256) throw new Error(`${rel} revision ${rev.date}'s archive is pending (${rev.archive.pending ?? 'not published'}): npm run sources -- publish --from <dir>`);
  const listed = archivedFiles(rev);
  const named = pathNames(listed);
  if (named.length) throw new Error(`${rel} revision ${rev.date}: ${named.join('; ')}; nothing restored`);
  const unpinned = listed.filter((f) => !f.sha256);
  if (unpinned.length) throw new Error(`${unpinned.map((f) => `${f.name} (${f.id})`).join(', ')} ha${unpinned.length === 1 ? 's' : 've'} no sha256 in the manifest's revision ${rev.date}, so it can't be checked; nothing restored`);
  const k = readKey(keyPath({ ...(key ? { key } : {}), env }), env);
  const dl = mkdtempSync(join(tmpdir(), 'vnm-sources-dl-'));
  try {
    await download(rev.archive.release, rev.archive.asset, dl);
    const archive = readFileSync(join(dl, rev.archive.asset));
    const got = sha256(archive);
    if (got !== rev.archive.sha256) throw new Error(`${rev.archive.asset} has sha256 ${got}, not the manifest's ${rev.archive.sha256}; nothing unpacked`);
    const files = open({ archive, key: k, year, revision: rev.date });
    const entries = pathNames(files);
    if (entries.length) throw new Error(`${entries.join('; ')}; nothing restored`);
    const want = new Map(listed.map((f) => [f.name, f.sha256]));
    for (const f of files) {
      const expected = want.get(f.name);
      if (expected === undefined) throw new Error(`the archive holds ${f.name}, which the manifest's revision ${rev.date} doesn't list`);
      if (expected !== f.sha256) throw new Error(`${f.name}: sha256 ${f.sha256}, not the manifest's ${expected}`);
    }
    const missing = [...want.keys()].filter((n) => !files.some((f) => f.name === n));
    if (missing.length) throw new Error(`the archive lacks ${missing.join(', ')}`);
    const dir = out ? resolve(out) : mkdtempSync(join(tmpdir(), `vnm-sources-${year}-${rev.date}-`));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of files) writeFileSync(join(dir, f.name), f.bytes, { mode: 0o600 });
    log(`sources: restored ${rev.archive.release} (${files.length} files) into ${dir}`);
    return { dir, revision: rev.date, files: files.map((f) => f.name) };
  } finally {
    rmSync(dl, { recursive: true, force: true });
  }
}

/** @param {string} dir */
export function hashDir(dir) {
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort().map((name) => ({ name, sha256: sha256(readFileSync(join(dir, name))) }));
}

const USAGE = 'usage: npm run sources -- keygen --out <path> | hash --from <dir> | publish --from <dir> [<year>] [--revision <date>] [--key <path>]'
  + ' | restore [<year>] [--revision <date>] [--key <path>] [--out <dir>]';

/**
 * @param {string[]} argv
 * @param {{ log?: (m: string) => void, upload?: Upload, download?: Download, root?: string, runsDir?: string, env?: NodeJS.ProcessEnv }} [deps]
 */
export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { out: { type: 'string' }, from: { type: 'string' }, revision: { type: 'string' }, key: { type: 'string' } } });
  } catch (err) {
    log(`${/** @type {Error} */ (err).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const year = positionals[0] ?? DEFAULT_ACAD_YEAR;
  try {
    if (command === 'keygen') {
      if (!values.out) { log(USAGE); return 2; }
      log(`sources: wrote a new key to ${keygen(values.out)} (mode 0600). Back it up in Bitwarden Secrets Manager as nusmodfinder/sources-archive-key (project apps).`);
      return 0;
    }
    if (command === 'hash') {
      if (!values.from) { log(USAGE); return 2; }
      for (const f of hashDir(values.from)) log(`${f.sha256}  ${f.name}`);
      return 0;
    }
    if (command === 'publish') {
      if (!values.from) { log(USAGE); return 2; }
      await publish({
        from: values.from, year, ...(values.revision ? { revision: values.revision } : {}), ...(values.key ? { key: values.key } : {}),
        ...(deps.root ? { root: deps.root } : {}), ...(deps.upload ? { upload: deps.upload } : {}), ...(deps.runsDir ? { runsDir: deps.runsDir } : {}),
        ...(deps.env ? { env: deps.env } : {}), log, args: argv,
      });
      return 0;
    }
    if (command === 'restore') {
      const r = await restore({
        year, ...(values.revision ? { revision: values.revision } : {}), ...(values.key ? { key: values.key } : {}), ...(values.out ? { out: values.out } : {}),
        ...(deps.root ? { root: deps.root } : {}), ...(deps.download ? { download: deps.download } : {}), ...(deps.env ? { env: deps.env } : {}), log,
      });
      log(r.dir);
      return 0;
    }
    log(USAGE);
    return 2;
  } catch (err) {
    log(`sources ${command}: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

export const SCRIPT = fileURLToPath(import.meta.url);
