// @ts-check
// Course review scores (ADR 0018): what students wrote under each course on
// NUSMods, as a few numbers per course in data/reviews.json. No comment text
// leaves .data/; the card links to NUSMods for the reviews themselves.
//
//   npm run reviews -- crawl            every thread and comment of the NUSMods Disqus forum
//   npm run reviews -- score [--limit N] [--max-usd N]
//                                       each comment rated by Claude, resumable
//   npm run reviews -- build            data/reviews.json from the scores
//
// crawl: Disqus's public API pages the forum 100 at a time (forums/listThreads,
// then forums/listPosts), 2 s apart, resumable from .data/reviews/crawl/*.cursor.
// score: one Claude Haiku 5.5 call per course thread (threads over 100 comments
// in chunks), structured output per comment; ANTHROPIC_API_KEY or an `ant auth`
// profile; stops at --max-usd (default 10). A chunk that comes back missing a
// comment is re-sent by running score again. build: reviews only (questions and
// replies dropped), repeats of one review dropped, each review weighted by age
// (half-life HALF_LIFE academic years before DEFAULT_ACAD_YEAR).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_ACAD_YEAR } from './lib.mjs';
import { startRun } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.data', 'reviews');
const CRAWL = join(DIR, 'crawl');
const SCORES = join(DIR, 'scores');
export const OUT = join(ROOT, 'data', 'reviews.json');
export const SCHEMA_ID = 'vnm-reviews/1';

const FORUM = 'nusmods-prod';
// Disqus's public embed key: the one every NUSMods page sends from the browser.
const DISQUS_KEY = 'E8Uh5l5fHZ6gD8U3KycjAIAk46f68Zw7C6eW8WSjZvCLXebZ7p0r1yrYDrLilk2F';
const GAP_MS = 2000;
export const MODEL = 'claude-haiku-5-5';
const CHUNK = 100;
/** $ per million tokens for MODEL: input, cache write (1 h), output. */
const PRICE = { input: 0.1, cacheWrite: 0.2, output: 0.5 };
export const HALF_LIFE = 3;
export const CODE_RE = /^[A-Z]{2,4}\d{4}[A-Z]{0,3}$/;

const score = { anyOf: [{ type: 'integer', enum: [1, 2, 3, 4, 5] }, { type: 'null' }] };
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['comments'],
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'is_review', 'taken', 'workload', 'difficulty', 'teaching', 'overall', 'note'],
        properties: {
          id: { type: 'string' },
          is_review: { type: 'boolean' },
          taken: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          workload: score,
          difficulty: score,
          teaching: score,
          overall: score,
          note: { type: 'string' },
        },
      },
    },
  },
};

// Checked against Claude Opus 5.5 on 419 comments: overall agrees exactly on 81%, within 1 on all.
export const SYSTEM = `You read the comment thread under one NUS course on NUSMods and rate each comment.

For every comment, return one entry with its id:
- is_review: true only if the writer took the course and gives their own account of it. Questions, replies to other people, ads, and second-hand hearsay are false.
- taken: the semester they took it, normalised like "AY22/23 S2", from the text; if the text has none, null. Never guess it from the posting date.
- workload, difficulty: 1 (very light / very easy) to 5 (very heavy / very hard).
- teaching: 1 (poor) to 5 (excellent), about lectures, tutors and materials.
- overall: how they feel about the course as a whole, 1 (very negative) to 5 (very positive). Judge their verdict on the course, not their grade or luck.
Rate only what the comment says or clearly implies; use null for anything it doesn't address. Fields other than is_review and note are null when is_review is false; overall is set on every review.
- note: at most 12 words on what drove your ratings, in your own words.`;

/** @typedef {{ id: string, ident: string[], posts: number, link: string }} Thread */
/** @typedef {{ id: string, thread: string, parent: string | null, createdAt: string, isDeleted: boolean, isSpam: boolean, text: string }} Post */
/** @typedef {{ id: string, is_review: boolean, taken: string | null, workload: number | null, difficulty: number | null, teaching: number | null, overall: number | null }} Scored */
/** @typedef {{ n: number, latest: string, overall: number | null, workload: number | null, difficulty: number | null, teaching: number | null }} CourseReviews */

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} file @returns {any[]} */
const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * The course code a thread is about: the identifier that is a code, else the code in its link.
 * @param {Thread} t
 * @returns {string | null}
 */
export function codeOf(t) {
  const code = t.ident.find((i) => CODE_RE.test(i)) ?? t.link.match(/\/(?:modules|courses)\/([A-Z0-9]+)/)?.[1];
  return code && CODE_RE.test(code) ? code : null;
}

/**
 * Each course's live comments, oldest first.
 * @param {Thread[]} threads
 * @param {Post[]} posts
 * @returns {Map<string, Post[]>}
 */
export function postsByCourse(threads, posts) {
  const code = new Map(threads.map((t) => [t.id, codeOf(t)]));
  /** @type {Map<string, Post[]>} */
  const out = new Map();
  for (const p of posts) {
    const c = code.get(p.thread);
    if (!c || p.isDeleted || p.isSpam || !p.text?.trim()) continue;
    if (!out.has(c)) out.set(c, []);
    out.get(c)?.push(p);
  }
  for (const ps of out.values()) ps.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

/**
 * The academic year a review is about, as its first year's last two digits: the semester the
 * writer names, else the academic year it was posted in (from August).
 * @param {Scored} c
 * @param {string | undefined} postedAt ISO date
 */
export function reviewYear(c, postedAt) {
  const m = /^AY(\d\d)/.exec(c.taken ?? '');
  if (m) return Number(m[1]);
  const d = postedAt ?? '2000-01-01';
  const y = Number(d.slice(2, 4));
  return Number(d.slice(5, 7)) >= 8 ? y : y - 1;
}

/**
 * One course's numbers from its scored comments: reviews only, a review posted again (same
 * opening 200 letters and digits) counted once, each score weighted by age.
 * @param {Scored[]} scored
 * @param {Map<string, Post>} postOf
 * @param {number} currentYear the current academic year's first year, two digits
 * @returns {CourseReviews | null}
 */
export function aggregate(scored, postOf, currentYear) {
  const seen = new Set();
  /** @type {Scored[]} */
  const reviews = [];
  const ordered = [...scored].sort((a, b) => (postOf.get(a.id)?.createdAt ?? '').localeCompare(postOf.get(b.id)?.createdAt ?? ''));
  for (const c of ordered) {
    if (!c.is_review) continue;
    const key = (postOf.get(c.id)?.text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    reviews.push(c);
  }
  if (!reviews.length) return null;
  const years = reviews.map((c) => reviewYear(c, postOf.get(c.id)?.createdAt));
  const weight = years.map((y) => 0.5 ** (Math.max(0, currentYear - y) / HALF_LIFE));
  /** @param {'overall' | 'workload' | 'difficulty' | 'teaching'} k */
  const mean = (k) => {
    let sum = 0;
    let w = 0;
    reviews.forEach((c, i) => {
      const v = c[k];
      if (v !== null) { sum += v * weight[i]; w += weight[i]; }
    });
    return w ? Math.round((sum / w) * 10) / 10 : null;
  };
  const latest = Math.max(...years);
  return {
    n: reviews.length,
    latest: `AY${String(latest).padStart(2, '0')}/${String(latest + 1).padStart(2, '0')}`,
    overall: mean('overall'), workload: mean('workload'), difficulty: mean('difficulty'), teaching: mean('teaching'),
  };
}

/** @param {string} endpoint @param {string} cursor @param {typeof fetch} doFetch */
async function disqusPage(endpoint, cursor, doFetch) {
  for (let attempt = 0; ; attempt++) {
    await sleep(GAP_MS);
    const url = `https://disqus.com/api/3.0/${endpoint}?forum=${FORUM}&limit=100&order=asc&api_key=${DISQUS_KEY}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await doFetch(url, { headers: { 'User-Agent': 'nusmodfinder-reviews', Referer: 'https://disqus.com/' } });
    if (res.ok) return /** @type {{ response: any[], cursor?: { hasNext: boolean, next: string } }} */ (await res.json());
    if (attempt >= 4) throw new Error(`Disqus ${endpoint}: HTTP ${res.status}`);
    console.log(`Disqus ${endpoint}: HTTP ${res.status}, waiting before retry ${attempt + 1}`);
    await sleep(60_000 * (attempt + 1));
  }
}

/** @param {string[]} argv */
async function crawl(argv) {
  const run = startRun('reviews-crawl', { target: `disqus:${FORUM}`, args: argv });
  run.guardExit();
  mkdirSync(CRAWL, { recursive: true });
  const doFetch = run.countingFetch(fetch);
  /** @param {string} name @param {string} endpoint @param {(x: any) => object} slim */
  const stage = async (name, endpoint, slim) => {
    const state = join(CRAWL, `${name}.cursor`);
    if (existsSync(state) && readFileSync(state, 'utf8').trim() === 'DONE') return;
    let cursor = existsSync(state) ? readFileSync(state, 'utf8').trim() : '';
    let pages = 0;
    do {
      const d = await disqusPage(endpoint, cursor, doFetch);
      if (d.response.length) appendFileSync(join(CRAWL, `${name}.jsonl`), d.response.map((x) => JSON.stringify(slim(x))).join('\n') + '\n');
      cursor = d.cursor?.hasNext ? d.cursor.next : '';
      writeFileSync(state, cursor || 'DONE');
      if (++pages % 20 === 0) console.log(`${name}: ${pages} pages`);
    } while (cursor);
  };
  await stage('threads', 'forums/listThreads', (t) => ({ id: t.id, ident: t.identifiers, posts: t.posts, link: t.link }));
  await stage('posts', 'forums/listPosts', (p) => ({
    id: p.id, thread: p.thread, parent: p.parent, createdAt: p.createdAt, isDeleted: p.isDeleted, isSpam: p.isSpam, text: p.raw_message,
  }));
  const threads = readJsonl(join(CRAWL, 'threads.jsonl')).length;
  const posts = readJsonl(join(CRAWL, 'posts.jsonl')).length;
  run.read('Disqus threads', { actual: threads }).read('Disqus comments', { actual: posts });
  console.log(`crawl: ${threads} threads, ${posts} comments in ${CRAWL}`);
  run.finish('ok', { exitCode: 0 });
}

/** Every scoring request: one per course, or per 100 comments of a longer thread. */
function requests() {
  const byCourse = postsByCourse(readJsonl(join(CRAWL, 'threads.jsonl')), readJsonl(join(CRAWL, 'posts.jsonl')));
  const out = [];
  for (const [code, posts] of byCourse) {
    for (let i = 0; i < posts.length; i += CHUNK) {
      const part = posts.slice(i, i + CHUNK);
      const body = part
        .map((p) => `<comment id="${p.id}" posted="${p.createdAt.slice(0, 10)}"${p.parent ? ` reply_to="${p.parent}"` : ''}>\n${p.text.trim()}\n</comment>`)
        .join('\n');
      out.push({ id: `${code}_${i / CHUNK}`, ids: part.map((p) => p.id), content: `Course: ${code}\n\n${body}` });
    }
  }
  return out;
}

/** @param {string[]} argv */
async function scoreAll(argv) {
  const flag = (/** @type {string} */ name, /** @type {number} */ dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) : dflt;
  };
  const limit = flag('--limit', Infinity);
  const maxUsd = flag('--max-usd', 10);
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  mkdirSync(SCORES, { recursive: true });
  /** @param {{ id: string, ids: string[] }} r */
  const complete = (r) => {
    const file = join(SCORES, `${r.id}.json`);
    if (!existsSync(file)) return false;
    const got = new Set(JSON.parse(readFileSync(file, 'utf8')).map((/** @type {Scored} */ c) => c.id));
    return r.ids.every((id) => got.has(id));
  };
  const todo = requests().filter((r) => !complete(r)).slice(0, limit);
  const run = startRun('reviews-score', { target: `anthropic:${MODEL}`, args: argv });
  run.guardExit();
  console.log(`score: ${todo.length} requests to send, cap $${maxUsd}`);
  const usage = { input: 0, cacheWrite: 0, output: 0 };
  const usd = () => (usage.input * PRICE.input + usage.cacheWrite * PRICE.cacheWrite + usage.output * PRICE.output) / 1e6;
  let next = 0;
  let failed = 0;
  let incomplete = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < todo.length && usd() < maxUsd) {
      const r = todo[next++];
      try {
        const msg = await client.messages.stream({
          model: MODEL,
          max_tokens: 32000,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
          system: SYSTEM,
          messages: [{ role: 'user', content: r.content }],
        }).finalMessage();
        usage.input += msg.usage.input_tokens;
        usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
        usage.output += msg.usage.output_tokens;
        run.request('/v1/messages');
        if (msg.stop_reason !== 'end_turn') throw new Error(`stop_reason ${msg.stop_reason}`);
        const block = msg.content.find((b) => b.type === 'text');
        const comments = /** @type {Scored[]} */ (JSON.parse(block?.type === 'text' ? block.text : '{}').comments ?? [])
          .filter((c) => r.ids.includes(c.id));
        const file = join(SCORES, `${r.id}.json`);
        const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
        writeFileSync(file, JSON.stringify([...new Map([...prev, ...comments].map((c) => [c.id, c])).values()]));
        if (r.ids.some((id) => !comments.some((c) => c.id === id))) incomplete++;
      } catch (err) {
        failed++;
        console.log(`${r.id}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }));
  run.wrote('scored chunks', { actual: todo.length - failed }).detail('usd', Math.round(usd() * 100) / 100).detail('usage', usage);
  console.log(`score: $${usd().toFixed(2)}; ${failed} failed, ${incomplete} missing a comment; run score again to re-send them`);
  run.finish(failed ? 'partial' : 'ok', { exitCode: failed ? 1 : 0 });
  if (failed) process.exitCode = 1;
}

function build() {
  const threads = readJsonl(join(CRAWL, 'threads.jsonl'));
  const posts = /** @type {Post[]} */ (readJsonl(join(CRAWL, 'posts.jsonl')));
  const postOf = new Map(posts.map((p) => [p.id, p]));
  const byCourse = postsByCourse(threads, posts);
  /** @type {Map<string, Scored[]>} */
  const scored = new Map();
  for (const f of readdirSync(SCORES)) {
    const code = f.replace(/_\d+\.json$/, '');
    scored.set(code, [...(scored.get(code) ?? []), ...JSON.parse(readFileSync(join(SCORES, f), 'utf8'))]);
  }
  const currentYear = Number(DEFAULT_ACAD_YEAR.slice(2, 4));
  /** @type {Record<string, CourseReviews>} */
  const courses = {};
  let unscored = 0;
  for (const code of [...byCourse.keys()].sort()) {
    const s = scored.get(code) ?? [];
    unscored += (byCourse.get(code) ?? []).filter((p) => !s.some((c) => c.id === p.id)).length;
    const r = aggregate(s, postOf, currentYear);
    if (r) courses[code] = r;
  }
  // One course per line, so a rebuild's diff reads course by course.
  const head = { schema: SCHEMA_ID, source: `NUSMods comments (Disqus forum ${FORUM})`, model: MODEL, halfLifeYears: HALF_LIFE };
  const lines = Object.entries(courses).map(([code, r]) => `${JSON.stringify(code)}:${JSON.stringify(r)}`);
  writeFileSync(OUT, `${JSON.stringify(head).slice(0, -1)},"courses":{\n${lines.join(',\n')}\n}}\n`);
  console.log(`build: ${Object.keys(courses).length} courses with reviews -> ${OUT}; ${unscored} comments unscored`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'crawl') await crawl(rest);
  else if (cmd === 'score') await scoreAll(rest);
  else if (cmd === 'build') build();
  else {
    console.error('usage: npm run reviews -- crawl | score [--limit N] [--max-usd N] | build');
    process.exit(2);
  }
}
