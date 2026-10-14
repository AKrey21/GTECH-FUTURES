// Text similarity + hybrid retrieval over the engine's signal memory.
//
// Shared by two jobs:
//   - story threading (server.mjs buildThreads): TF-IDF / embedding cosine
//   - retrieval-augmented scanning (/api/retrieve): for each tracked topic and
//     for the team's mandate, find the signals that actually bear on it,
//     instead of handing the model whatever was newest or most novel.
//
// Retrieval is hybrid because each retriever fails differently: dense
// embeddings match meaning across paraphrase and language (a Nikkei story on
// "senior reskilling" for a topic "older workers") but blur exact names
// (SkillsFuture, PISA); sparse TF-IDF nails exact terms but misses paraphrase.
// Ranked lists are fused with weighted Reciprocal Rank Fusion (RRF, k=60) —
// rank-based, so cosine and TF-IDF scales never need calibrating against each
// other — plus a light recency list. Maximal Marginal Relevance (MMR) then
// picks the final k so three outlets reprinting one story don't fill a topic's
// evidence slots. Relevance floors on each retriever mean a topic with no real
// support returns NOTHING — itself a CSF signal (absence of expected change).

const STOPWORDS = new Set(('the a an and or of to in for on with as by at from is are was were be been this that these those it its ' +
  'we our you your they their he she his her not no but if then than so what which who how when where why will would can could ' +
  'has have had do does did more most much many new says said say').split(' '));

export function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  const words = (t.match(/[a-z0-9]{3,}/g) || []).filter(w => !STOPWORDS.has(w));
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]);
    if (i + 1 < words.length) out.push(words[i] + ' ' + words[i + 1]);
  }
  // Han + kana + hangul runs -> character bigrams (whitespace tokenization
  // fails for Chinese/Japanese; Korean spaces exist but particles glue words)
  for (const run of t.match(/[぀-ヿ一-鿿가-힯]{2,}/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

// Retrieval tokenizer. Threading keeps the plain tokenizer above (its 0.16
// threshold was calibrated on it); retrieval queries are short, so they also
// need (a) 2-letter acronyms — "AI", "HR", "5G" — which the 3-char rule drops,
// and (b) light stemming, so "apprenticeships" meets "apprenticeship".
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
export function retrievalTokens(text) {
  const s = String(text || '');
  const base = tokenize(s).map(t => t.split(' ').map(stem).join(' '));
  const acronyms = (s.match(/\b[A-Z][A-Z0-9]\b/g) || []).map(a => a.toLowerCase());
  return base.concat(acronyms);
}

export function tfidfVectors(docs, tok = tokenize) {
  const df = new Map();
  const tfs = docs.map((d) => {
    const tf = new Map();
    for (const t of tok(d)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    return tf;
  });
  const N = docs.length;
  return tfs.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [term, f] of tf) {
      const w = f * Math.log(1 + N / (df.get(term) || 1));
      v.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of v) v.set(term, w / norm);
    return v;
  });
}

export function cosineSim(a, b) {
  let s = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, w] of small) { const x = big.get(term); if (x) s += w * x; }
  return s;
}

export function dotVec(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;   // API vectors are unit-normalised, so dot = cosine
}

// Defaults are starting points, not calibrated values: tune them on the live
// store with /api/retrieve?debug=1 the way EMB_T was (see server.mjs).
export const RAG_DEFAULTS = {
  k: 4,             // evidence slots per query
  pool: 30,         // fused candidates MMR chooses from
  lambda: 0.7,      // MMR: 1 = pure relevance, 0 = pure diversity
  minDense: 0.30,   // embedding-cosine floor (text-embedding-3-small @256d)
  minSparse: 0.03,  // TF-IDF-cosine floor
  // Sparse matches must also cover this share of the query's IDF mass
  // (minimum-should-match): matching only "jobs" + "skills" — words every
  // article in a workforce corpus contains — is not evidence for "green jobs
  // and sustainability skills"; matching "green" or "sustainability" is.
  minCoverage: 0.4,
  rrfK: 60,
  weights: { dense: 1, sparse: 1, recency: 0.35 },
};

// docs:    [{ text, emb?, ts? }]
// queries: [{ text, emb? }]
// returns, per query: [{ i, score, dense, sparse, via }] — i indexes docs
export function hybridRetrieve(docs, queries, opts = {}) {
  const o = { ...RAG_DEFAULTS, ...opts, weights: { ...RAG_DEFAULTS.weights, ...(opts.weights || {}) } };
  const vecs = tfidfVectors([...docs.map(d => d.text), ...queries.map(q => q.text)], retrievalTokens);
  const dv = vecs.slice(0, docs.length);
  const qv = vecs.slice(docs.length);
  const simDocs = (a, b) => (docs[a].emb && docs[b].emb) ? dotVec(docs[a].emb, docs[b].emb) : cosineSim(dv[a], dv[b]);
  // Document frequency over the corpus, for the IDF-weighted coverage test.
  const docTerms = docs.map(d => new Set(retrievalTokens(d.text)));
  const N = docs.length;
  const idf = (t) => Math.log(1 + N / (1 + docTerms.reduce((a, s) => a + (s.has(t) ? 1 : 0), 0)));

  return queries.map((q, qi) => {
    const qTerms = [...new Set(retrievalTokens(q.text).filter(t => !t.includes(' ')))];
    const qIdf = qTerms.map(idf);
    const qMass = qIdf.reduce((a, b) => a + b, 0) || 1;
    const cands = [];
    docs.forEach((d, i) => {
      const sparse = cosineSim(qv[qi], dv[i]);
      const dense = (q.emb && d.emb) ? dotVec(q.emb, d.emb) : null;
      const passD = dense !== null && dense >= o.minDense;
      const coverage = sparse > 0 ? qTerms.reduce((a, t, j) => a + (docTerms[i].has(t) ? qIdf[j] : 0), 0) / qMass : 0;
      const passS = sparse >= o.minSparse && coverage >= o.minCoverage;
      if (passD || passS) cands.push({ i, dense, sparse, ts: d.ts || 0, via: passD && passS ? 'both' : passD ? 'dense' : 'sparse' });
    });
    if (!cands.length) return [];

    // Weighted RRF over the per-retriever rankings of the candidate set.
    const ranks = (key) => {
      const m = new Map();
      cands.filter(c => c[key] !== null).sort((a, b) => b[key] - a[key]).forEach((c, r) => m.set(c, r + 1));
      return m;
    };
    const rd = ranks('dense'), rs = ranks('sparse'), rr = ranks('ts');
    const w = o.weights;
    for (const c of cands) {
      c.score = (rd.has(c) ? w.dense / (o.rrfK + rd.get(c)) : 0)
              + (rs.has(c) ? w.sparse / (o.rrfK + rs.get(c)) : 0)
              + (rr.has(c) ? w.recency / (o.rrfK + rr.get(c)) : 0);
    }
    cands.sort((a, b) => b.score - a.score);

    // MMR over the fused pool.
    const pool = cands.slice(0, o.pool);
    const top = pool[0].score || 1;
    const picked = [];
    while (picked.length < o.k && pool.length) {
      let best = 0, bestV = -Infinity;
      pool.forEach((c, pi) => {
        const redundancy = picked.length ? Math.max(...picked.map(p => simDocs(c.i, p.i))) : 0;
        const v = o.lambda * (c.score / top) - (1 - o.lambda) * redundancy;
        if (v > bestV) { bestV = v; best = pi; }
      });
      picked.push(pool.splice(best, 1)[0]);
    }
    return picked.map(c => ({
      i: c.i, score: +c.score.toFixed(5), via: c.via,
      dense: c.dense === null ? null : +c.dense.toFixed(3), sparse: +c.sparse.toFixed(3),
    }));
  });
}

// Passage selection: the window of an article that best answers the query, so
// a long stored body contributes its relevant paragraph, not its lede.
export function bestPassage(text, query, maxLen = 420) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  const qTerms = new Set(tokenize(query).filter(x => !x.includes(' ')));
  const sents = t.split(/(?<=[.!?。！？])\s+/);
  let best = t.slice(0, maxLen), bestScore = -1;
  for (let i = 0; i < sents.length; i++) {
    let win = '';
    for (let j = i; j < sents.length && (win + ' ' + sents[j]).length <= maxLen; j++) win = (win ? win + ' ' : '') + sents[j];
    if (!win) win = sents[i].slice(0, maxLen);
    const toks = tokenize(win).filter(x => !x.includes(' '));
    const hit = new Set(toks.filter(x => qTerms.has(x))).size;
    const score = hit - i * 0.01;   // ties go to earlier text
    if (score > bestScore) { bestScore = score; best = win; }
  }
  return best;
}
