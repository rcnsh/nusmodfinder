// @ts-check
import { createModuleClient } from '../public/api.js';
import { emptyList } from '../public/list.js';
import { answerOf, workOut } from '../public/shortlist.js';
import { oracleShown } from './oracle/oracle.mjs';

const STUDIES = /** @type {const} */ (['ug1', 'ug2', 'ug3', 'ug4', 'grad']);
const TAKES_PART = ['counted', 'confirm', 'invite'];

/**
 * @typedef {{ code: string, title: string, department: string | null, faculty: string | null, level: number | null,
 *   semesters: number[], ng: boolean, ngSemesters: number[], prerequisite?: string | null }} OracleModule
 */

/**
 * @param {OracleModule[]} modules
 * @param {typeof fetch} pageFetch
 * @returns {Promise<{ wrong: string[], closed: number, shown: number, browse: number }>}
 */
export async function shortlistAgainstOracle(modules, pageFetch) {
  const client = createModuleClient({ fetch: pageFetch });
  /** @type {string[]} */
  const wrong = [];
  let closed = 0;
  let shown = 0;
  let browse = 0;
  for (const m of modules) {
    const answer = answerOf(await client.get(m.code));
    if (answer.kind !== 'row' && answer.kind !== 'ng-listed') { wrong.push(`${m.code}: answered ${answer.kind}`); continue; }
    const answers = new Map([[m.code, answer]]);
    for (const sem of /** @type {const} */ (['1', '2'])) {
      const list = { ...emptyList(), pick: [{ code: m.code, sem }] };
      for (const study of STUDIES) {
        const r = workOut({ list, sem, study, answers, rules: null });
        const w = r.entries[0];
        const t = r.sems[sem];
        const want = oracleShown(m, { sem: Number(sem) === 1 ? 1 : 2, study });
        const at = `${m.code} sem ${sem} ${study}`;
        if (want === 'closed') {
          closed++;
          if (w.standing !== 'out') wrong.push(`${at}: oracle closed, standing ${w.standing}`);
          if (t.counted || t.confirm || t.invite) wrong.push(`${at}: oracle closed, totals ${t.counted}/${t.confirm}/${t.invite}`);
          if (w.form.number !== null) wrong.push(`${at}: oracle closed, form number ${w.form.number}`);
          if (w.status !== 'closed') wrong.push(`${at}: oracle closed, stamp ${w.status}`);
        } else {
          shown++;
          if (!TAKES_PART.includes(w.standing)) wrong.push(`${at}: oracle ${want}, standing ${w.standing} (${w.why})`);
          if (w.status !== want) wrong.push(`${at}: oracle ${want}, stamp ${w.status}`);
        }
      }
      const r = workOut({ list, sem, study: '', answers, rules: null });
      browse++;
      if (r.entries[0].form.number !== null) wrong.push(`${m.code} sem ${sem} browse: form number ${r.entries[0].form.number}`);
    }
  }
  return { wrong, closed, shown, browse };
}
