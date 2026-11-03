// BM25 keyword baseline, shared by the evaluation harness and the pool builder.
// Deliberately competitive: real BM25 with standard parameters over the whole
// corpus, a x3 title weight, and the exact-code shortcut handed to it for free.
export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

// Identical to the stopword list the Worker applies to its FTS5 query, so
// neither retriever is handed an easier version of the query.
export const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'own', 'the', 'to', 'with', 'you', 'your']);

export const tokenise = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t && !STOP.has(t));

// The Worker's FTS5 index uses porter stemming. Applying the same stemming here
// removes an asymmetry that otherwise silently favours the hybrid.
export function stem(token) {
  if (token.length <= 3) return token;
  return token
    .replace(/(ational|tional|ization|iveness|fulness|ousness|ization)$/, '')
    .replace(/(ing|edly|ed|ly|ies|es|s)$/, '')
    .replace(/(ment|ness|able|ible|ance|ence|ical|ic|al)$/, '')
    || token;
}

export const TITLE_WEIGHT = 3;

export function buildBaseline(modules, { stemming = true } = {}) {
  const prep = (s) => { const t = tokenise(s); return stemming ? t.map(stem) : t; };
  const docTokens = new Map();
  for (const m of modules) {
    docTokens.set(m.code, [
      ...Array(TITLE_WEIGHT).fill(prep(m.title)).flat(),
      ...prep(m.description ?? ''),
    ]);
  }
  const df = new Map();
  for (const tokens of docTokens.values()) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = modules.length;
  const avgdl = [...docTokens.values()].reduce((a, t) => a + t.length, 0) / N;
  const k1 = 1.2, b = 0.75;

  const matchesFilters = (m, f = {}) => {
    if (f.sem !== undefined && !m.semesters.includes(f.sem)) return false;
    if (f.level !== undefined && m.level !== f.level) return false;
    if (f.credits !== undefined && m.credits !== f.credits) return false;
    if (f.faculty !== undefined && m.faculty !== f.faculty) return false;
    // Exchange-student availability, if the NG list was loaded into the corpus.
    if (f.ng === true && m.ng !== true) return false;
    return true;
  };

  function search(query, filters, k) {
    const qTokens = prep(query);
    const upper = query.trim().toUpperCase();
    const scored = [];
    for (const m of modules) {
      if (!matchesFilters(m, filters)) continue;
      const tokens = docTokens.get(m.code);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of qTokens) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (tokens.length / avgdl))));
      }
      if (MODULE_CODE_RE.test(upper) && m.code === upper) score += 1000;
      if (score > 0) scored.push({ code: m.code, score });
    }
    scored.sort((x, y) => y.score - x.score || x.code.localeCompare(y.code));
    return scored.slice(0, k).map((s) => s.code);
  }

  return { search, matchesFilters };
}
