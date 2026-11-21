// @ts-check
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';
import { previousYear } from '../scripts/ng-sources.mjs';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const Y = DEFAULT_ACAD_YEAR;
export const LAST = previousYear(Y);

const MANIFEST = JSON.parse(readFileSync(join(REPO, `data/ng-sources-${Y}.json`), 'utf8'));

export const TREE_FILES = [
  'scripts/lib.mjs', 'public/year.js', 'public/index.html',
  'data/corpus.json', 'data/ng-reasons.json', 'data/ng-unscheduled.json',
  `data/ng-sources-${Y}.json`, `data/ng-courses-${Y}.json`, `data/ng-restrictions-${Y}.json`,
  `scripts/ng-overlay/${Y}.mjs`, `test/oracle/oracle-${Y}.node.mjs`, 'test/oracle/oracle-shared.node.mjs',
  MANIFEST.register, MANIFEST.transcription,
  'src/level-note.js', 'public/shortlist.js', 'public/export.js',
];

/** @param {string} root */
export function copyTree(root) {
  for (const f of TREE_FILES) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(REPO, f), join(root, f));
  }
  return root;
}

/** @param {string} root @param {string} rel @returns {any} */
export const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
/** @param {string} root @param {string} rel @param {unknown} data @param {number} [indent] */
export const writeJson = (root, rel, data, indent = 1) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), `${JSON.stringify(data, null, indent)}\n`);
};
/** @param {Buffer | string} b */
export const sha = (b) => createHash('sha256').update(b).digest('hex');

export const EXTRACT_NG = join(REPO, 'scripts/extract-ng.py');

/** @param {{ acadYear: string, updatedAsAt: string, semesters: Record<string, string[]> }} courses */
export function fakeNgPages(courses) {
  const [a, b] = courses.acadYear.split('-');
  const pages = [`%PDF-1.4 fake NG list\nCourse Offered for Non-Graduating (NG) Students\nUpdated as at ${courses.updatedAsAt}\n`];
  for (const s of Object.keys(courses.semesters).sort()) {
    const head = s === '1' ? `For Semester 1 of AY${a}/${b} (August ${a} intake)` : `For Semester 2 of AY${a}/${b} (January ${b} intake)`;
    pages.push(`${head}\n${courses.semesters[s].map((c) => `Faculty | Department | ${c} | A course | 1 | Mon`).join('\n')}\n`);
  }
  return pages.join('\f');
}

/** @type {import('../scripts/year.mjs').NgExtractor} */
export const fromTextExtractor = async ({ pdf, year, published, out }) => {
  const r = spawnSync('python3', [EXTRACT_NG, '--from-text', pdf, '--year', year, '--published', published.join(','), '--out', out], { encoding: 'utf8' });
  return r.status === 0 ? { ok: true, message: r.stdout.trim() } : { ok: false, message: `${r.stderr || r.stdout}`.trim() || `exit ${r.status}` };
};

export const RULE_E_SENTENCE = 'Approval for any other courses not listed in this document will be granted on a case-by-case basis. If the courses cannot be found at the Course offerings list, they are not available during application stage but may be available during Course registration.';

/**
 * @param {string} dir
 * @param {{ restrictionsText?: string }} [o]
 * @returns {Record<string, Buffer>}
 */
export function fakeDocuments(dir, { restrictionsText = `Course restrictions\n${RULE_E_SENTENCE}\n` } = {}) {
  const committed = readJson(REPO, `data/ng-restrictions-${Y}.json`);
  /** @type {Record<string, Buffer>} */
  const files = {
    'ng-courses.pdf': Buffer.from(fakeNgPages(readJson(REPO, `data/ng-courses-${Y}.json`))),
    'non-graduating-course-restrictions.pdf': Buffer.from('%PDF-1.4 fake restrictions\n'),
    'non-graduating-course-restrictions.txt': Buffer.from(restrictionsText),
    'self-funded-graduate-courses.pdf': Buffer.from('%PDF-1.4 fake self-funded list\n'),
    'self-funded-graduate-courses.txt': Buffer.from(`${committed.rules.find((/** @type {any} */ r) => r.id === 'A-self-funded').match.codes.join('\n')}\n`),
    'law-compulsory-llb-courses.png': Buffer.from('fake png'),
  };
  for (const s of [1, 2]) {
    files[`yst-sem${s}-non-music-majors.txt`] = Buffer.from(committed.lists.ystElectives[s].map((/** @type {string} */ c) => `${c} A course (4 Units)`).join('\n'));
    files[`yst-sem${s}-non-music-majors.html`] = Buffer.from('<html><body><p>fake</p></body></html>');
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return files;
}

/**
 * @param {string} root
 * @param {Record<string, Buffer>} files
 */
export function useFakeDocuments(root, files) {
  const m = readJson(root, `data/ng-sources-${Y}.json`);
  const rev = m.revisions[m.revisions.length - 1];
  rev.archive = { ...rev.archive, sha256: null, pending: 'the fakes publish it' };
  rev.documents =rev.documents.filter((/** @type {any} */ d) => d.builder || d.id === 'restrictions').map((/** @type {any} */ d) => {
    const rest = { ...d };
    delete rest.confirm;
    const out = {
      ...rest, url: rest.url ?? 'https://example.test/doc', sha256: files[d.file] ? sha(files[d.file]) : d.sha256,
      ...(d.text ? { textSha256: files[d.text] ? sha(files[d.text]) : undefined } : {}),
    };
    return d.id === 'restrictions' ? out : { ...out, text: undefined };
  }).map((/** @type {any} */ d) => JSON.parse(JSON.stringify(d)));
  m.quotes = m.quotes.filter((/** @type {any} */ q) => q.id === 'rule-e');
  writeJson(root, `data/ng-sources-${Y}.json`, m);
  const rules = readJson(root, `data/ng-restrictions-${Y}.json`);
  rules.sourceSha256 = Object.fromEntries(Object.entries(files).filter(([n]) => n !== 'non-graduating-course-restrictions.txt').map(([n, b]) => [n, sha(b)]).sort(([a], [b]) => a.localeCompare(b)));
  writeJson(root, `data/ng-restrictions-${Y}.json`, rules);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * @param {string} root
 * @param {string} origin
 */
export function gitInit(root, origin) {
  git(origin, ['init', '--bare', '-q']);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.test']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'tag.gpgsign', 'false']);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'tree']);
}

/** @param {string} path */
export function throwawayKey(path) {
  writeFileSync(path, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
  return path;
}

/** @param {string} dir */
export function fakeReleases(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    /** @type {import('../scripts/sources.mjs').Upload} */
    upload: async (release, file) => { mkdirSync(join(dir, release), { recursive: true }); cpSync(file, join(dir, release, file.split('/').pop() ?? 'asset')); },
    /** @type {import('../scripts/sources.mjs').Download} */
    download: async (release, asset, dest) => { cpSync(join(dir, release, asset), join(dest, asset)); },
  };
}
