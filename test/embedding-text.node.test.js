// @ts-check
// 3A-2's embedding-text variants (docs/plans/phase3.md 3A-2,
// docs/plans/phase3-prereg.md §2, eval/prereg/grids.json `3A-2`): the exact
// text each variant builds for records copied from the pinned corpus, and the
// level labels. Runs in Node (vitest project "node").
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_TEXT_VARIANT, EMBEDDING_TEXT_VARIANTS, EMBEDDING_TEXT_VERSION, MAX_BLOB_CHARS, embeddingText, embeddingTextFor, levelLabel, levelOf,
} from '../scripts/lib.mjs';

/** @typedef {import('../scripts/lib.mjs').NusModsRecord} NusModsRecord */

/** Level 5: the first graduate label. @type {NusModsRecord} */
const CS5242 = {
  moduleCode: 'CS5242', title: 'Neural Networks and Deep Learning', department: 'Computer Science', faculty: 'Computing',
  description: 'This course provides students with the knowledge of deep neural network and enables them to apply deep learning methods effectively on real world problems. The course emphasizes on the understanding of the principles of neural networks and deep learning; practical guidelines and techniques for deep learning; and their applications. Through assignments and projects, students will design, develop, and evaluate deep learning-based solutions to practical problems, such as those in the areas of computer vision, bioinformatics, fintech, cybersecurity, and games.',
};

/** Level 8 (choice C24: "graduate"). @type {NusModsRecord} */
const PLS8001 = {
  moduleCode: 'PLS8001', title: 'Cultivating Collaboration', department: 'Psychology', faculty: 'Arts and Social Science',
  description: 'This 1-unit course is part of the Roots & Wings 2.0 programme. It focuses on soft skills on the interpersonal level in terms of more effective working with other people and reaching for better outcomes jointly. Through various experiential activities (e.g., role-play, negotiation exercises), students learn to understand the importance of collaboration in various settings and to apply basic techniques to help resolve conflicts and to strive for win-win situations when collaborating with other people in task accomplishment.',
};

/** CS3244 with its department removed (no pinned record lacks one), level 3. @type {NusModsRecord} */
const CS3244_NO_DEPARTMENT = {
  moduleCode: 'CS3244', title: 'Machine Learning', faculty: 'Computing',
  description: 'This course introduces basic concepts and algorithms in machine learning and neural networks. The main reason for studying computational learning is to make better use of powerful computers to learn knowledge (or regularities) from the raw data. The ultimate objective is to build self-learning systems to relieve human from some of already-too-many programming tasks. At the end of the course, students are expected to be familiar with the theories and paradigms of computational learning, and capable of implementing basic learning systems.',
};

/** 1,929-character description: every variant hits MAX_BLOB_CHARS. @type {NusModsRecord} */
const BMS5130 = {
  moduleCode: 'BMS5130', title: 'AI, Ethics & Venture Creation', department: 'BIZ Dean\'s Office', faculty: 'NUS Business School',
  description: 'With the accelerated usage of AI in all businesses, it is worthwhile to understand how to leverage AI as a growing tool within ethical business practices. This class is hands-on learning to teach students to build their own AI based venture or acquiring one using AI from a governance, responsibility and risk management perspective. Students will learn about AI risks and failures and leverage those to ensure a successful AI based venture which is in full compliance from a corporate governance and regulatory perspective as well. There will be real life learning from the instructor’s experience in restructuring a US-based AI venture. The purpose of this course is to ensure students understand and apply the following in to create their own AI based ethical business venture. It is also to understand and leverage AI from a governance, responsibility and risk management perspective, rather than from a technical and implementation standpoint. Specifically, students will learn the major reasons for business failures through AI ethical misconducts in terms of business, operational, ethical practices. They will conduct analysis of global cases of AI ethical business failures with lessons learned (eg: Amazon AI hiring tool, Facebook AI engagement algorithm, Open AI copyright data training, Microsoft Tay Chatbot, IBM Watson for Oncology, YouTube AI content monitoring, etc). They will conduct a diagnostic of key failure elements due to financial and stakeholder negligence (eg: customers, supply chain, shareholders) and investor impact, define the elements of a growth strategy (immediate and longer term) based on required ethical organizational practices and policies and the methodologies and metrics required to successfully implement and manage an AI ethical new venture. They will also learn about the usage of AI to develop and successfully run an ethical new venture, including risks and mitigation strategies.',
};

const D = (/** @type {NusModsRecord} */ r) => /** @type {string} */ (r.description);

describe('3A-2 level labels', () => {
  it('1 introductory, 2–3 intermediate, 4 advanced, 5–8 graduate (C24), anything else none', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(levelLabel)).toEqual([
      'introductory', 'intermediate', 'intermediate', 'advanced', 'graduate', 'graduate', 'graduate', 'graduate']);
    expect([0, 9, null].map(levelLabel)).toEqual([null, null, null]);
  });

  it('agrees with the pre-registered table in eval/prereg/grids.json', async () => {
    const grids = JSON.parse(await readFile(new URL('../eval/prereg/grids.json', import.meta.url), 'utf8'));
    for (const [level, label] of Object.entries(grids['3A-2'].levelLabels)) expect(levelLabel(Number(level)), level).toBe(label);
  });

  it('N is the code\'s level digit, as levelOf reads it', () => {
    expect(levelOf('PLS8002A')).toBe(8);
    expect(embeddingTextFor({ ...PLS8001, moduleCode: 'PLS8002A' }, 'v1')).toMatch(/^PLS8002A\. Cultivating Collaboration\. Level 8 \(graduate\)\. /);
  });
});

describe('3A-2 variant texts', () => {
  it('the variants are the three pre-registered field orders', async () => {
    const grids = JSON.parse(await readFile(new URL('../eval/prereg/grids.json', import.meta.url), 'utf8'));
    const spelled = { code: 'CODE', title: 'Title', level: 'Level N (label)', description: 'Description', department: 'Department', faculty: 'Faculty' };
    for (const [v, fields] of Object.entries(EMBEDDING_TEXT_VARIANTS)) {
      expect(fields.map((f) => `${spelled[f]}.`).join(' '), v).toBe(grids['3A-2'].variants[v]);
    }
    expect(Object.keys(EMBEDDING_TEXT_VARIANTS)).toEqual(Object.keys(grids['3A-2'].variants));
  });

  it('level 5 (CS5242)', () => {
    expect(embeddingTextFor(CS5242, 'v1')).toBe(`CS5242. Neural Networks and Deep Learning. Level 5 (graduate). ${D(CS5242)} Computer Science. Computing.`);
    expect(embeddingTextFor(CS5242, 'v2')).toBe(`CS5242. Neural Networks and Deep Learning. Level 5 (graduate). ${D(CS5242)}`);
    expect(embeddingTextFor(CS5242, 'v3')).toBe(`Neural Networks and Deep Learning. Level 5 (graduate). ${D(CS5242)} Computer Science. Computing.`);
  });

  it('level 8 (PLS8001)', () => {
    expect(embeddingTextFor(PLS8001, 'v1')).toBe(`PLS8001. Cultivating Collaboration. Level 8 (graduate). ${D(PLS8001)} Psychology. Arts and Social Science.`);
    expect(embeddingTextFor(PLS8001, 'v2')).toBe(`PLS8001. Cultivating Collaboration. Level 8 (graduate). ${D(PLS8001)}`);
    expect(embeddingTextFor(PLS8001, 'v3')).toBe(`Cultivating Collaboration. Level 8 (graduate). ${D(PLS8001)} Psychology. Arts and Social Science.`);
  });

  it('a missing department is skipped, not left as an empty sentence (CS3244, level 3)', () => {
    const d = D(CS3244_NO_DEPARTMENT);
    expect(embeddingTextFor(CS3244_NO_DEPARTMENT, 'v1')).toBe(`CS3244. Machine Learning. Level 3 (intermediate). ${d} Computing.`);
    expect(embeddingTextFor(CS3244_NO_DEPARTMENT, 'v2')).toBe(`CS3244. Machine Learning. Level 3 (intermediate). ${d}`);
    expect(embeddingTextFor(CS3244_NO_DEPARTMENT, 'v3')).toBe(`Machine Learning. Level 3 (intermediate). ${d} Computing.`);
    // A blank department is the same as none.
    expect(embeddingTextFor({ ...CS3244_NO_DEPARTMENT, department: '  ' }, 'v1')).toBe(embeddingTextFor(CS3244_NO_DEPARTMENT, 'v1'));
  });

  it('a long description is cut at MAX_BLOB_CHARS, losing the fields after it (BMS5130)', () => {
    expect(MAX_BLOB_CHARS).toBe(1900);
    const d = D(BMS5130);
    expect(d.length).toBe(1929);
    const v1 = embeddingTextFor(BMS5130, 'v1');
    const v2 = embeddingTextFor(BMS5130, 'v2');
    const v3 = embeddingTextFor(BMS5130, 'v3');
    expect(v1).toBe(`BMS5130. AI, Ethics & Venture Creation. Level 5 (graduate). ${d}`.slice(0, 1900));
    expect(v2).toBe(v1);
    expect(v3).toBe(`AI, Ethics & Venture Creation. Level 5 (graduate). ${d}`.slice(0, 1900));
    expect([v1.length, v3.length]).toEqual([1900, 1900]);
    expect(v1.endsWith('so learn about the usage of AI to develo')).toBe(true);
    expect(v3.endsWith('about the usage of AI to develop and suc')).toBe(true);
    expect(v1).not.toContain('NUS Business School');
  });

  it('collapses whitespace inside and around fields, and adds no second full stop', () => {
    const r = { moduleCode: 'XX1001', title: ' Intro\n to  X ', department: 'Dept\tOf X', faculty: 'Science', description: '  First line.\n\nSecond?  ' };
    expect(embeddingTextFor(r, 'v1')).toBe('XX1001. Intro to X. Level 1 (introductory). First line. Second? Dept Of X. Science.');
    // A description with no closing mark gets one; "!" and "?" are kept as the mark.
    expect(embeddingTextFor({ ...r, description: 'No mark' }, 'v2')).toBe('XX1001. Intro to X. Level 1 (introductory). No mark.');
    expect(embeddingTextFor({ ...r, title: 'What is a Planet?' }, 'v3')).toBe('What is a Planet? Level 1 (introductory). First line. Second? Dept Of X. Science.');
  });

  it('a level with no label leaves the Level field out', () => {
    expect(embeddingTextFor({ ...PLS8001, moduleCode: 'XX9001' }, 'v1')).toBe(`XX9001. Cultivating Collaboration. ${D(PLS8001)} Psychology. Arts and Social Science.`);
  });

  it('refuses an unknown variant', () => {
    expect(() => embeddingTextFor(CS5242, /** @type {any} */ ('v4'))).toThrow(/unknown embedding text variant "v4"/);
  });

  it('the workerd tests\' copies of EMBEDDING_TEXT_VERSION are lib.mjs\'s (they cannot import it)', async () => {
    for (const f of ['runbook.test.js', 'ingest.test.js']) {
      const src = await readFile(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src.match(/^const EMBEDDING_TEXT_VERSION = (\d+);$/m)?.[1], f).toBe(String(EMBEDDING_TEXT_VERSION));
    }
  });

  it('embeddingText builds the selected variant\'s text', () => {
    for (const r of [CS5242, PLS8001, CS3244_NO_DEPARTMENT, BMS5130]) expect(embeddingText(r)).toBe(embeddingTextFor(r, EMBEDDING_TEXT_VARIANT));
    expect(EMBEDDING_TEXT_VERSION).toBe(2);
  });
});
