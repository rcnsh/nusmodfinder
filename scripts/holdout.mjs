#!/usr/bin/env node
// @ts-check
// Holdout custody tooling (custodian only, except `verify`). AES-256-GCM; the
// key lives in $VNM_HOLDOUT_KEY_FILE (default ~/.config/vnm/holdout.key),
// never in the repo, never printed.
//
//   node scripts/holdout.mjs keygen                          create a key file (refuses to overwrite)
//   node scripts/holdout.mjs encrypt <plain.json> --as <name> [--dir eval/holdout] [--set holdout|test|selftest]
//                                                            write <dir>/<name>.enc, update the manifest
//   node scripts/holdout.mjs decrypt <file.enc> --out <path> [--set …]  plaintext to a path outside the repo
//
// Ciphertexts are bound to their set name. --set defaults to holdout under
// eval/holdout and test under eval/sealed, and is required anywhere else.
//   node scripts/holdout.mjs manifest [--dir eval/holdout]   rewrite MANIFEST.json from the ciphertexts
//   node scripts/holdout.mjs verify [--dir d ...]            CI: ciphertext sha256s match the manifests (no key)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decrypt, encrypt, generateKey, keyFilePath, readKey, updateManifest, verifyManifest } from '../eval/lib/crypto.mjs';
import { ENCRYPTED_SETS, REPO } from '../eval/lib/sets.mjs';

const ENCRYPTED_DIRS = ['eval/holdout', 'eval/sealed', 'eval/sealed-unfiltered'];
const NAMES = /^(queries|qrels|embeddings)\.json$|^(run|judge)-[A-Za-z0-9._-]+\.json$/;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: 'string' },
    dir: { type: 'string', multiple: true },
    out: { type: 'string' },
    set: { type: 'string' },
  },
});

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`holdout: ${msg}`);
  process.exit(1);
}

/** @param {string} p */
const insideRepo = (p) => !relative(REPO, resolve(p)).startsWith('..');

/**
 * The set a directory's ciphertexts belong to: --set, else by location.
 * @param {string} dir
 * @returns {string}
 */
function setFor(dir) {
  if (values.set) {
    if (!ENCRYPTED_SETS.includes(values.set)) fail(`--set ${values.set}: expected one of ${ENCRYPTED_SETS.join(', ')}`);
    return values.set;
  }
  const rel = relative(REPO, resolve(dir));
  if (rel === 'eval/holdout') return 'holdout';
  if (rel === 'eval/sealed') return 'test';
  return fail(`${dir} is not eval/holdout or eval/sealed; say which set it holds with --set ${ENCRYPTED_SETS.join('|')}`);
}

const [command, file] = positionals;
switch (command) {
  case 'keygen': {
    const path = await generateKey().catch((/** @type {Error} */ e) => fail(e.message));
    console.log(`wrote a new key to ${path} (0600). Back it up somewhere only the custodian can read.`);
    break;
  }
  case 'encrypt': {
    if (!file || !values.as) fail('usage: encrypt <plain.json> --as <queries.json|qrels.json|embeddings.json|run-<variant>.json|judge-<judge>.json> [--dir eval/holdout]');
    const name = /** @type {string} */ (values.as);
    if (!NAMES.test(name)) fail(`--as ${name}: expected queries.json, qrels.json, embeddings.json, run-<variant>.json or judge-<judge>.json`);
    const dir = resolve(values.dir?.[0] ?? join(REPO, 'eval/holdout'));
    const plain = await readFile(/** @type {string} */ (file));
    JSON.parse(plain.toString('utf8')); // refuse to encrypt something that is not JSON
    const out = join(dir, `${name}.enc`);
    await mkdir(dir, { recursive: true });
    await writeFile(out, encrypt(plain, await readKey(), out, setFor(dir)));
    await updateManifest(dir);
    console.log(`wrote ${out} and updated ${join(dir, 'MANIFEST.json')}. Delete the plaintext (${file}) once it is backed up.`);
    if (insideRepo(/** @type {string} */ (file))) console.warn(`warning: the plaintext ${file} is inside the repo; make sure it is never committed`);
    break;
  }
  case 'decrypt': {
    if (!file || !values.out) fail('usage: decrypt <file.enc> --out <path outside the repo>');
    if (insideRepo(/** @type {string} */ (values.out))) fail('refusing to write holdout plaintext inside the repo');
    const data = decrypt(await readFile(/** @type {string} */ (file)), await readKey(), basename(/** @type {string} */ (file)), setFor(dirname(resolve(/** @type {string} */ (file)))));
    await writeFile(/** @type {string} */ (values.out), data, { mode: 0o600 });
    console.log(`decrypted ${file} -> ${values.out}`);
    break;
  }
  case 'manifest': {
    const dir = resolve(values.dir?.[0] ?? join(REPO, 'eval/holdout'));
    const files = await updateManifest(dir);
    console.log(`${join(dir, 'MANIFEST.json')}: ${Object.keys(files).length} ciphertexts`);
    break;
  }
  case 'verify': {
    const dirs = values.dir?.map((d) => resolve(d)) ?? ENCRYPTED_DIRS.map((d) => join(REPO, d));
    let problems = 0;
    for (const dir of dirs) {
      const found = await verifyManifest(dir);
      for (const p of found) console.error(`  ${p}`);
      problems += found.length;
      console.log(`${relative(REPO, dir) || dir}: ${found.length ? 'MISMATCH' : 'ok'}`);
    }
    if (problems) process.exit(1);
    break;
  }
  case 'keypath':
    console.log(keyFilePath());
    break;
  default:
    fail('usage: holdout.mjs keygen | encrypt | decrypt | manifest | verify | keypath');
}
