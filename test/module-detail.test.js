// @ts-check
// Phase 5 5A (docs/plans/phase5.md §3 "5A"): /module/:code answers the exam
// dates, the workload as named hours, and the NUSMods link, with a short
// public cache on a 200 and none on a failure.
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('/module/:code (5A)', () => {
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

  it('answers prereqCohortOnly from the stored flag, for every fixture course (5D)', async () => {
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

describe('/module/:code caching (5A)', () => {
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
