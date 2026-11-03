// @ts-check
// Encryption at rest for the holdout and sealed test sets: AES-256-GCM via
// node:crypto. The key is 32 random bytes, hex, in a file outside the repo
// ($VNM_HOLDOUT_KEY_FILE, default ~/.config/vnm/holdout.key). It is never
// printed, logged, or put in an error message.
//
// File format: "VNMENC2\n" (8 bytes) | IV (12) | GCM tag (16) | ciphertext.
// The set name and the file's name without ".enc" are bound as additional
// authenticated data ("holdout/qrels.json"), so a ciphertext cannot be renamed
// into another slot (qrels as queries) or copied into another set's directory
// (holdout files read as the test set or the self-test set).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DecryptionError, KeyFileError } from './errors.mjs';

const MAGIC = Buffer.from('VNMENC2\n', 'latin1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MANIFEST = 'MANIFEST.json';

/** The key file path: $VNM_HOLDOUT_KEY_FILE or ~/.config/vnm/holdout.key. */
export function keyFilePath() {
  return process.env.VNM_HOLDOUT_KEY_FILE || join(homedir(), '.config', 'vnm', 'holdout.key');
}

/**
 * Reads the key. Errors name the path, never the contents.
 * @param {string} [path]
 * @returns {Promise<Buffer>}
 */
export async function readKey(path = keyFilePath()) {
  let text;
  try {
    text = (await readFile(path, 'utf8')).trim();
  } catch {
    throw new KeyFileError(`holdout key not found at ${path}. Only the custodian has it; tuning agents must not run holdout commands.`);
  }
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new KeyFileError(`holdout key at ${path} is not 64 hex characters`);
  return Buffer.from(text, 'hex');
}

/**
 * Creates a new key file (0600, parent 0700). Refuses to overwrite.
 * @param {string} [path]
 */
export async function generateKey(path = keyFilePath()) {
  if (existsSync(path)) throw new Error(`refusing to overwrite the existing key at ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return path;
}

/**
 * @param {string} file
 * @param {string} set
 */
function aadFor(file, set) {
  if (typeof set !== 'string' || !/^[a-z][a-z0-9-]*$/.test(set)) throw new Error(`encryption needs a set name, got ${JSON.stringify(set)}`);
  return Buffer.from(`${set}/${basename(file).replace(/\.enc$/, '')}`, 'utf8');
}

/**
 * @param {Buffer} plaintext
 * @param {Buffer} key
 * @param {string} name logical file name, bound as AAD
 * @param {string} set set name (holdout, test, selftest), bound as AAD
 */
export function encrypt(plaintext, key, name, set) {
  const aad = aadFor(name, set);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/**
 * @param {Buffer} data
 * @param {Buffer} key
 * @param {string} name logical file name the ciphertext was written under
 * @param {string} set set name the ciphertext was written for
 */
export function decrypt(data, key, name, set) {
  const aad = aadFor(name, set);
  if (data.length < MAGIC.length + IV_BYTES + TAG_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new DecryptionError(`${basename(name)} is not a VNMENC2 file`);
  }
  const iv = data.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = data.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new DecryptionError(`${basename(name)}: decryption failed for the ${set} set (wrong key, renamed file, a file from another set, or tampered ciphertext)`);
  }
}

/**
 * @param {string} path ends in .enc
 * @param {unknown} value
 * @param {Buffer} key
 * @param {string} set
 */
export async function writeEncryptedJson(path, value, key, set) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encrypt(Buffer.from(JSON.stringify(value), 'utf8'), key, path, set));
}

/**
 * @param {string} path
 * @param {Buffer} key
 * @param {string} set
 * @returns {Promise<any>}
 */
export async function readEncryptedJson(path, key, set) {
  return JSON.parse(decrypt(await readFile(path), key, path, set).toString('utf8'));
}

/** @param {Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Every *.enc under `dir` (recursive), as paths relative to `dir`.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function encFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.enc'))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

/**
 * Rewrites `<dir>/MANIFEST.json` with the sha256 of every ciphertext.
 * @param {string} dir
 */
export async function updateManifest(dir) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const f of await encFiles(dir)) files[f] = sha256(await readFile(join(dir, f)));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MANIFEST), `${JSON.stringify({ schema: 'vnm-holdout-manifest/1', files }, null, 2)}\n`);
  return files;
}

/**
 * Checks ciphertexts against the manifest without any key: every listed file
 * exists with its recorded sha256, and no unlisted *.enc exists.
 * @param {string} dir
 * @returns {Promise<string[]>} problems; empty means OK
 */
export async function verifyManifest(dir) {
  const path = join(dir, MANIFEST);
  const actual = await encFiles(dir);
  // An encrypted-set directory holds only ciphertexts and the manifest: a
  // plaintext dropped beside them would be committed in the clear.
  /** @type {string[]} */
  const stray = [];
  if (existsSync(dir)) {
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const rel = join(e.parentPath, e.name).slice(dir.length + 1);
      if (rel !== MANIFEST && !rel.endsWith('.enc')) stray.push(`${join(dir, rel)} is not a ciphertext; only *.enc and ${MANIFEST} may live in ${dir}`);
    }
  }
  if (!existsSync(path)) return [...stray, ...(actual.length ? [`${path} is missing but ${actual.length} .enc files exist`] : [])];
  const { files = {} } = JSON.parse(await readFile(path, 'utf8'));
  const problems = [];
  for (const [f, want] of Object.entries(/** @type {Record<string, string>} */ (files))) {
    const p = join(dir, f);
    if (!existsSync(p)) { problems.push(`${p} is in the manifest but missing`); continue; }
    const got = sha256(await readFile(p));
    if (got !== want) problems.push(`${p} sha256 ${got} != manifest ${want}`);
  }
  for (const f of actual) if (!(f in files)) problems.push(`${join(dir, f)} is not in ${path}`);
  return [...stray, ...problems];
}
