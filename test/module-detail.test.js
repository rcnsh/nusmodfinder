// @ts-check
// /module/:code answers the exam
// dates, the workload as named hours, and the NUSMods link, with a short
// public cache on a 200 and none on a failure.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/rowhash.js';
import { adminCall, callJson, fixture, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;

/** A fixture module that `pick` matches. @param {(m: NormalisedModule) => boolean} pick */
const find = (pick) => {
  const m = fixture.modules.find(pick);
  if (!m) throw new Error('no fixture module matches');
  return m;
};
const twoExams = find((m) => m.examDates.length >= 2);
const noExam = find((m) => m.examDates.length === 0);
const zeroWorkload = find((m) => m.workload === '[0,0,0,0,0]');
/** MLE3104's workload as normalise() stores it: a moduleInfo string. */
const unparseable = { ...fixture.modules[0], code: 'XX3104', workload: JSON.stringify('3-.5-0--0-6.5') };

beforeAll(async () => {
  fakes = await seed();
  const res = await adminCall('/admin/ingest', fakes, { modules: [unparseable] });
  if (res.status !== 200) throw new Error(`ingest XX3104: HTTP ${res.status}`);
});

describe('/module/:code', () => {
  it('answers every exam: semester, ISO UTC date and duration in minutes, as the fixture has them', async () => {
    const { status, body } = await callJson(`/module/${twoExams.code}`);
    expect(status).toBe(200);
    expect(body.examDates).toEqual(twoExams.examDates);
    expect(body.examDates.map((/** @type {{ sem: number }} */ d) => d.sem)).toEqual(twoExams.examSemesters);
    expect(body).not.toHaveProperty('exam_dates');
  });

  it('answers [] for a module with no exam', async () => {
    expect((await callJson(`/module/${noExam.code}`)).body.examDates).toEqual([]);
  });

  it('answers the workload as named hours a week with their total', async () => {
    const { body } = await callJson('/module/CS1010S');
    const [lecture, tutorial, lab, project, prep] = JSON.parse(/** @type {string} */ (find((m) => m.code === 'CS1010S').workload));
    expect(body.workload).toEqual({ lecture, tutorial, lab, project, prep, total: lecture + tutorial + lab + project + prep });
  });

  it('answers an unparseable workload as { raw }, and an unlisted one (all zero) as null', async () => {
    expect((await callJson('/module/XX3104')).body.workload).toEqual({ raw: '3-.5-0--0-6.5' });
    expect((await callJson(`/module/${zeroWorkload.code}`)).body.workload).toBeNull();
  });

  it('answers prereqCohortOnly from the stored flag, for every fixture course', async () => {
    const flagged = fixture.modules.filter((m) => m.prereqCohortOnly);
    expect(flagged.length).toBeGreaterThan(5);
    for (const m of [...flagged, ...fixture.modules.filter((x) => !x.prereqCohortOnly && x.prerequisite).slice(0, 10)]) {
      const { body } = await callJson(`/module/${m.code}`);
      expect(body.prereqCohortOnly, m.code).toBe(m.prereqCohortOnly === true);
      expect(body, m.code).not.toHaveProperty('prereq_cohort_only');
    }
  });

  it('links the course on NUSMods by its code, upper-cased whatever the path\'s case', async () => {
    const { body } = await callJson('/module/cs1010s');
    expect(body.nusmodsUrl).toBe('https://nusmods.com/courses/CS1010S');
  });
});

describe('/module/:code caching', () => {
  it('a 200 is public for 5 minutes, with no ETag', async () => {
    const { status, headers } = await callJson('/module/CS1010S');
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('public, max-age=300');
    expect(headers.get('etag')).toBeNull();
  });

  it('a 404 is cached for a minute', async () => {
    const { status, headers } = await callJson('/module/XX9999');
    expect(status).toBe(404);
    expect(headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('a 502 (D1 failed) and a 500 (no route handled it) are never stored', async () => {
    const failing = {
      withSession: () => ({ prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1 down'); } }) }) }),
    };
    const d1 = await callJson('/module/CS1010S', { env: { DB: failing } });
    expect(d1.status).toBe(502);
    expect(d1.headers.get('cache-control')).toBe('no-store');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const internal = await callJson('/module/CS1010S', { env: { DB: undefined } });
      expect(internal.status).toBe(500);
      expect(internal.headers.get('cache-control')).toBe('no-store');
    } finally { errors.mockRestore(); }
  });

  it('a 400 (not a module code) carries no cache header', async () => {
    const { status, headers } = await callJson('/module/not-a-code');
    expect(status).toBe(400);
    expect(headers.get('cache-control')).toBeNull();
  });
});

// A course's other codes, its
// grading basis, and a 404 that says which kind of miss it is.
describe('/module/:code for the shortlist', () => {
  /**
   * The sha256 of every fixture code's 200 body, in code order, one JSON line each, without the
   * shortlist's fields (gradingBasis, otherCodes) and GRO's level 4000 note. The test strips those,
   * so any other change to the answer shows here.
   */
  const CORE_BODIES_SHA256 = '8e9e4e8b9c5bb426b65cbb9faac40591ee9ae00ced94d9e3e97c261f06ca678b';
  /** A catalogue-only code, seeded through /admin/catalogue as ingest loads them. */
  const CATALOGUE_ONLY = { code: 'CS1010J', title: 'Introduction to Programming', description: 'An introductory course in Java.', acadYear: '2026-2027' };

  beforeAll(async () => {
    const res = await adminCall('/admin/catalogue', fakes, { upsert: [CATALOGUE_ONLY] });
    if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status}`);
  });

  it('answers otherCodes: the course\'s group members other than itself, [] when it has none', async () => {
    expect((await callJson('/module/ACC1701XB')).body.otherCodes).toEqual(['ACC1701XA', 'ACC1701XC']);
    expect((await callJson('/module/CS2030S')).body.otherCodes).toEqual(['CS2030', 'CS2030DE']);
    expect((await callJson('/module/CS3244')).body.otherCodes).toEqual([]);
  });

  it('answers gradingBasis from the stored column, and no grading_basis', async () => {
    const { body } = await callJson('/module/PLS8002A');
    expect(body.gradingBasis).toBe('Completed Satisfactory/Unsatisfactory');
    expect(body).not.toHaveProperty('grading_basis');
    expect((await callJson('/module/CS1010S')).body.gradingBasis).toBe('Graded');
  });

  it('leaves every other field of every fixture course byte-identical to its answer without the shortlist fields', async () => {
    const lines = [];
    let gro = 0;
    for (const m of [...fixture.modules].sort((a, b) => (a.code < b.code ? -1 : 1))) {
      const { status, body } = await callJson(`/module/${m.code}`);
      expect(status, m.code).toBe(200);
      expect(body.gradingBasis, m.code).toBe(m.gradingBasis);
      delete body.gradingBasis;
      delete body.otherCodes;
      // GRO's level 4000 note (ADR 0007) is stripped with the shortlist fields.
      for (const e of body.exchange) {
        const kept = e.reasons.filter((/** @type {any} */ r) => r.id !== 'gro:level-4000');
        gro += e.reasons.length - kept.length;
        e.reasons = kept;
        if (e.status === 'note' && !kept.length) e.status = 'open';
      }
      lines.push(JSON.stringify(body));
    }
    expect(gro).toBeGreaterThan(0);
    expect(await sha256Hex(lines.join('\n'))).toBe(CORE_BODIES_SHA256);
  });

  it('a catalogue-only code 404s as catalogue-only, with its title, description and year', async () => {
    const { status, headers, body } = await callJson('/module/cs1010j');
    expect(status).toBe(404);
    expect(headers.get('cache-control')).toBe('public, max-age=60');
    expect(body).toEqual({
      error: 'not_found', kind: 'catalogue-only', message: expect.stringContaining('CS1010J'),
      code: 'CS1010J', title: CATALOGUE_ONLY.title, description: CATALOGUE_ONLY.description, acadYear: '2026-2027',
    });
  });

  it('an NG-listed code with no row 404s as ng-listed, read like a row with no classes (EE4407)', async () => {
    const { status, headers, body } = await callJson('/module/EE4407');
    expect(status).toBe(404);
    expect(headers.get('cache-control')).toBe('public, max-age=60');
    expect(body).toMatchObject({
      error: 'not_found', kind: 'ng-listed', acadYear: '2026-2027', code: 'EE4407', title: 'Analog Electronics',
      credits: 4, level: 4, faculty: 'College of Design and Engineering', department: 'Electrical and Computer Engineering',
      semesters: [], ngSemesters: [1], gradingBasis: 'Graded', otherCodes: [], examDates: [],
      workload: { lecture: 2, tutorial: 1, lab: 0.5, project: 1.5, prep: 5, total: 10 },
      nusmodsUrl: 'https://nusmods.com/courses/EE4407',
    });
    expect(body.message).toMatch(/EE4407.*Sem 1.*NUSMods shows no classes/);
    expect(body.description).toMatch(/^This course builds on the basic concepts in electronics/);
    expect(body.prerequisite).toMatch(/\S/);
    expect(body.exchange).toHaveLength(15);
    for (const e of body.exchange) {
      const ids = e.reasons.map((/** @type {{ id: string }} */ r) => r.id);
      if (e.sem === 2) expect(e, `sem 2 ${e.study}`).toMatchObject({ status: 'closed' });
      if (e.sem === 2) expect(ids).toContain('ng-list:not-in-semester');
      // NUS lists it for Sem 1, NUSMods shows no class: never plain open.
      if (e.sem !== 2) expect(e.status, `sem ${e.sem} ${e.study}`).not.toBe('open');
      if (e.status !== 'closed') expect(ids).toContain('ng-list:nusmods-semester-differs');
    }
  });

  it('works NUS\'s restrictions out for those codes: PF2102 closed at grad in Sem 1 by 4-be-l1234-grad, ESP4403\'s year note at ug2', async () => {
    const pf = (await callJson('/module/PF2102')).body;
    expect(pf.kind).toBe('ng-listed');
    const grad = pf.exchange.find((/** @type {any} */ e) => e.sem === 1 && e.study === 'grad');
    expect(grad.status).toBe('closed');
    expect(grad.reasons.map((/** @type {any} */ r) => r.id)).toContain('4-be-l1234-grad');
    expect(pf.exchange.find((/** @type {any} */ e) => e.sem === 1 && e.study === 'ug2').status).toBe('note');
    const esp = (await callJson('/module/ESP4403')).body;
    const ug2 = esp.exchange.find((/** @type {any} */ e) => e.sem === 2 && e.study === 'ug2');
    expect(ug2.status).toBe('note');
    expect(ug2.reasons.map((/** @type {any} */ r) => r.id)).toContain('prereq:year-of-study');
  });

  it('answers an ng-listed code\'s otherCodes over the offered rows and the file\'s codes: NGN2001D -> NGN2001F, NGN2001G', async () => {
    expect((await callJson('/module/NGN2001D')).body.otherCodes).toEqual(['NGN2001F', 'NGN2001G']);
  });

  it('a row wins over the file: an offered code is never answered as ng-listed (CS3223 is not in the fixture file)', async () => {
    expect((await callJson('/module/CS3223')).body.kind).toBe('unknown');
    const { status, body } = await callJson('/module/NGN2001F');
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('kind');
  });

  it('a code in neither table nor the file 404s as unknown, with the Worker\'s acad year', async () => {
    const { status, body } = await callJson('/module/CS9999');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found', kind: 'unknown', message: expect.stringContaining('CS9999'), acadYear: '2026-2027' });
  });

  it('answers unknown when the catalogue_only table is missing, and a 5xx with no-store on any other failed read', async () => {
    /** @param {(sql: string) => Promise<unknown>} first */
    const db = (first) => ({ withSession: () => ({ prepare: (/** @type {string} */ sql) => ({ bind: () => ({ first: () => first(sql) }) }) }) });
    const missingTable = db(async (sql) => {
      if (sql.includes('catalogue_only')) throw new Error('D1_ERROR: no such table: catalogue_only: SQLITE_ERROR');
      return null;
    });
    const unknown = await callJson('/module/CS1010J', { env: { DB: missingTable } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.kind).toBe('unknown');
    const failing = db(async (sql) => {
      if (sql.includes('catalogue_only')) throw new Error('D1_ERROR: network connection lost');
      return null;
    });
    const failed = await callJson('/module/CS1010J', { env: { DB: failing } });
    expect(failed.status).toBe(502);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    // An ng-listed code makes no catalogue read, so the same failure never reaches it.
    expect((await callJson('/module/EE4407', { env: { DB: failing } })).body.kind).toBe('ng-listed');
  });
});
