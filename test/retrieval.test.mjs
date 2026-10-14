import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hybridRetrieve, bestPassage } from '../lib/retrieval.mjs';

// Unit vectors on a few "meaning" axes, standing in for embeddings.
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const AGEING = unit([1, 0, 0, 0.1]), GREEN = unit([0, 1, 0, 0.1]), AI = unit([0, 0, 1, 0.1]);

const docs = [
  { text: 'Japan expands reskilling subsidies for workers over 60', emb: AGEING, ts: 5 },
  // Same theme, different story: related (~0.8) but not a duplicate (1.0).
  { text: 'Nikkei: firms rehire retirees as senior workforce grows', emb: unit([0.8, 0, 0.5, 0.1]), ts: 4 },
  { text: 'Japan expands reskilling subsidies for workers over 60 (wire copy)', emb: AGEING, ts: 3 },
  { text: 'Solar installers face technician shortage', emb: GREEN, ts: 2 },
  { text: 'Agents automate claims processing at insurers', emb: AI, ts: 1 },
];

test('dense retrieval finds paraphrase that keywords miss', () => {
  const [hits] = hybridRetrieve(docs, [{ text: 'older employees', emb: unit([1, 0, 0.02, 0.1]) }], { k: 2 });
  const got = hits.map(h => h.i);
  assert.ok(got.includes(0) || got.includes(2));
  assert.ok(got.includes(1), 'the "retirees" story has no shared keyword but matches on meaning');
  assert.ok(hits.every(h => h.via !== 'sparse'));
});

test('MMR skips the near-duplicate wire copy in favour of a distinct story', () => {
  const [hits] = hybridRetrieve(docs, [{ text: 'reskilling subsidies older workers', emb: AGEING }], { k: 2, lambda: 0.5 });
  const got = hits.map(h => h.i).sort();
  assert.deepEqual(got, [0, 1], 'doc 2 duplicates doc 0, so the second slot goes to doc 1');
});

test('a topic with no support returns nothing (absence is reported, not padded)', () => {
  const [hits] = hybridRetrieve(docs, [{ text: 'maritime port labour', emb: unit([0, 0, 0, 1]) }]);
  assert.deepEqual(hits, []);
});

test('sparse-only mode still works without embeddings', () => {
  const plain = docs.map(d => ({ text: d.text, ts: d.ts }));
  const [hits] = hybridRetrieve(plain, [{ text: 'solar technician shortage' }]);
  assert.equal(hits[0].i, 3);
  assert.equal(hits[0].via, 'sparse');
  assert.equal(hits[0].dense, null);
});

test('bestPassage returns the window that answers the query', () => {
  const body = 'The ministry released its annual report today. Most of it covers budgets. ' +
    'Separately, eldercare employers say nurse aides need dementia training. ' +
    'The report closes with a note on procurement.';
  assert.match(bestPassage(body, 'dementia training for eldercare aides', 90), /dementia training/);
});
