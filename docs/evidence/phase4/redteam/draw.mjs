#!/usr/bin/env node
// @ts-check
// Persona red team, step 1 (docs/plans/phase4.md §7): draws the code-lookup
// sample in advance, with a fixed seed, from the production-normalised modules
// (the cached catalogue ingest reads). Sends nothing. Writes sample.json.
//
//   node docs/evidence/phase4/redteam/draw.mjs [.data/cache/2026-2027-moduleInfo.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, offeredModules } from '../../../../scripts/lib.mjs';

const SEED = 20261110;
const path = process.argv[2] ?? `.data/cache/${DEFAULT_ACAD_YEAR}-moduleInfo.json`;
const raw = JSON.parse(readFileSync(path, 'utf8'));
const { modules } = offeredModules(Array.isArray(raw) ? raw : raw.data, DEFAULT_ACAD_YEAR, await loadNgCourses(DEFAULT_ACAD_YEAR));
const byCode = new Map(modules.map((m) => [m.code, m]));

/** mulberry32 */
let s = SEED;
const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
/** @param {string[]} xs @param {number} n */
const draw = (xs, n) => { const a = [...xs].sort(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n).sort(); };

const ng = modules.filter((m) => m.ng).map((m) => m.code);
const offList = modules.filter((m) => !m.ng);
const q1 = ['LL4011V', 'GEC1011', 'GEH1043', 'HSI2003', 'LI5202', 'LI5204', 'AR5801', 'AR5802', 'CM5223', 'CM5225', 'CM5244', 'CM5268', 'PC5202', 'PC5206', 'PC5211',
  ...ng.filter((c) => /^(CG|DSA|GEH)\d/.test(c))];
const arPairs = ['AR5221', 'AR4220', 'AR5321', 'AR4321', 'AR5601', 'AR4601'];
const q5 = modules.filter((m) => m.ng && m.ngSemesters.some((n) => !m.semesters.includes(n))).map((m) => m.code);
const taken = new Set([...q1, ...arPairs, ...q5]);
const randomNg = draw(ng.filter((c) => !taken.has(c)), 20);
const randomOff = draw(offList.map((m) => m.code), 20);
const business = draw(offList.filter((m) => m.faculty === 'NUS Business School' && !randomOff.includes(m.code)).map((m) => m.code), 5);
const ceIse = draw(offList.filter((m) => /^(Civil and Environmental Engineering|Industrial Systems Engineering and Management)$/.test(m.department ?? '') && !randomOff.includes(m.code)).map((m) => m.code), 5);

const groups = { q1: [...new Set(q1)].sort(), arPairs, q5: q5.sort(), randomNg, randomOff, business, ceIse };
for (const [k, v] of Object.entries(groups)) for (const c of v) if (!byCode.has(c)) throw new Error(`${k}: ${c} is not offered this year`);
const codes = [...new Set(Object.values(groups).flat())].sort();
writeFileSync(new URL('./sample.json', import.meta.url), `${JSON.stringify({ seed: SEED, catalogue: path, groups, codes }, null, 1)}\n`);
console.log(Object.entries(groups).map(([k, v]) => `${k} ${v.length}`).join(', '), `; ${codes.length} codes`);
