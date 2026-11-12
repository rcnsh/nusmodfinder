// Probes the NUSMods data and sizes the Vectorize index. Verifies the acad year
// exists, the record shape is what ingest expects, and
// whether the corpus fits under the Vectorize free-plan stored-dimension cap.
import {
  DEFAULT_ACAD_YEAR, EMBEDDING_MODEL, EMBEDDING_DIMS, MODULE_CODE_RE,
  fetchAcadYearFile, assertExpectedShape, offeredModules, embeddingText,
} from './lib.mjs';

const FREE_STORED_DIMS = 5_000_000;
const FREE_QUERIED_DIMS = 30_000_000;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const acadYear = arg('year', DEFAULT_ACAD_YEAR);
const line = (s = '') => console.log(s);

line(`# NUSMods probe — acad year ${acadYear}`);
line();

line('## Acad year availability');
// The probed year, two before it and one after (from the year, no literals).
const first = Number(acadYear.slice(0, 4));
for (const y of [-2, -1, 0, 1].map((d) => `${first + d}-${first + d + 1}`)) {
  const res = await fetch(`https://api.nusmods.com/v2/${y}/moduleList.json`, { method: 'HEAD' });
  line(`- ${y}: HTTP ${res.status}`);
}
line();

const list = await fetchAcadYearFile(acadYear, 'moduleList.json');
const info = await fetchAcadYearFile(acadYear, 'moduleInfo.json');
assertExpectedShape(info.data);

line('## Files');
line(`- moduleList.json: ${list.data.length} entries, ${(list.bytes / 1e6).toFixed(2)} MB`);
line(`- moduleInfo.json: ${info.data.length} records, ${(info.bytes / 1e6).toFixed(2)} MB`);
line();

const keys = [...new Set(info.data.flatMap((r) => Object.keys(r)))].sort();
line('## Per-module keys (union across all records)');
line(`- ${keys.join(', ')}`);
line(`- moduleCredit runtime type(s): ${[...new Set(info.data.map((r) => typeof r.moduleCredit))].join(', ')}`);
line();

const { modules, skipped } = offeredModules(info.data, acadYear);
const listCodes = new Set(list.data.map((m) => m.moduleCode));
line('## Corpus');
line(`- records in moduleInfo.json (whole catalogue): ${info.data.length}`);
line(`- offered this acad year (>=1 semesterData): ${modules.length + skipped.length}`);
line(`- usable after title/description validation: ${modules.length}`);
line(`- skipped for missing fields: ${skipped.length}`);
line(`- offered codes absent from moduleList.json: ${modules.filter((m) => !listCodes.has(m.code)).length}`);
line();

const badCodes = modules.filter((m) => !MODULE_CODE_RE.test(m.code));
line('## Field shapes');
line(`- codes not matching ${MODULE_CODE_RE}: ${badCodes.length}${badCodes.length ? ` (${badCodes.slice(0, 5).map((m) => m.code).join(', ')})` : ''}`);
line(`- distinct faculties: ${new Set(modules.map((m) => m.faculty)).size}`);
line(`- longest faculty name: ${Math.max(...modules.map((m) => Buffer.byteLength(m.faculty ?? '')))} bytes (metadata index limit is 64)`);
line(`- semester values seen: ${[...new Set(modules.flatMap((m) => m.semesters))].sort().join(', ')}`);
line(`- modules offered in >1 semester: ${modules.filter((m) => m.semesters.length > 1).length}`);
line(`- levels seen: ${[...new Set(modules.map((m) => m.level))].sort().join(', ')}`);
line(`- credits range: ${Math.min(...modules.map((m) => m.credits))} – ${Math.max(...modules.map((m) => m.credits))}`);
line();

const rawLens = info.data.filter((r) => r.description).map((r) => embeddingText(r).length);
const truncated = modules.filter((m) => m.text.length >= 1900).length;
line('## Embedding blob');
line(`- model: ${EMBEDDING_MODEL} at ${EMBEDDING_DIMS} dims, 512 max input tokens`);
line(`- blob chars max across corpus: ${Math.max(...rawLens)}`);
line(`- blobs truncated to the 1900-char cap: ${truncated}`);
line();

const stored = modules.length * EMBEDDING_DIMS;
const queryBudget = Math.floor(FREE_QUERIED_DIMS / EMBEDDING_DIMS) - modules.length;
line('## Free-plan budget (Vectorize)');
line(`- stored dimensions: ${modules.length} x ${EMBEDDING_DIMS} = ${stored.toLocaleString()} of ${FREE_STORED_DIMS.toLocaleString()} (${((stored / FREE_STORED_DIMS) * 100).toFixed(1)}%)`);
line(`- queried dimensions billed as (queries + stored) x dims; free cap ${FREE_QUERIED_DIMS.toLocaleString()}/month`);
line(`- searches available per month: ~${queryBudget.toLocaleString()}`);
line();
line(`## Verdict: ${stored <= FREE_STORED_DIMS ? 'GO' : 'NO-GO'}`);
if (stored > FREE_STORED_DIMS) {
  line(`- corpus must shrink to <= ${Math.floor(FREE_STORED_DIMS / EMBEDDING_DIMS).toLocaleString()} vectors at ${EMBEDDING_DIMS} dims`);
}
