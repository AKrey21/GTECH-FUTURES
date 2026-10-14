import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforce, extractJson, refsInPrompt, repairMessages } from '../lib/structured.mjs';

const trend = (over = {}) => ({
  title: 'Mid-career reskilling demand rises', dimension: 'Future of Learning', confidence: 'Medium',
  trajectory: 'Rising', horizon: '1-3 years',
  what: 'Several outlets report employers funding mid-career reskilling.',
  why: 'Training providers may see demand shift to shorter modules.',
  options: ['Which programme would absorb this demand?'],
  sources: [{ label: 'Straits Times', ref: 'L1' }],
  ...over,
});
const prompt = [{ role: 'user', content: 'signal one [L1]\nsignal two [L2]\nTHREAD: x [L3, L4]' }];

test('valid trends pass first time, untouched', () => {
  const v = enforce('trends', JSON.stringify([trend()]), { messages: prompt });
  assert.equal(v.ok, true);
  assert.equal(v.stats.coercions, 0);
  assert.equal(v.stats.dropped, 0);
  assert.equal(v.stats.ungroundedRefs, 0);
});

test('code fences and leading prose are stripped', () => {
  const v = enforce('trends', 'Here you go:\n```json\n' + JSON.stringify([trend()]) + '\n```', { messages: prompt });
  assert.equal(v.ok, true);
});

test('lossless coercions: enum casing, [L#] refs, bare-string citations, scalar options, fuzzy dimension', () => {
  const raw = [trend({ confidence: 'high', dimension: 'work', options: 'Who owns this?', sources: ['Straits Times', { label: 'CNA', ref: '[l2]' }] })];
  const v = enforce('trends', JSON.stringify(raw), { messages: prompt });
  assert.equal(v.ok, true);
  const t = v.value[0];
  assert.equal(t.confidence, 'High');
  assert.equal(t.dimension, 'Future of Work');
  assert.deepEqual(t.options, ['Who owns this?']);
  assert.deepEqual(t.sources[0], { label: 'Straits Times' });
  assert.equal(t.sources[1].ref, 'L2');
  assert.ok(v.stats.coercions >= 5);
});

test('invented citation codes are nulled and counted (grounding)', () => {
  const v = enforce('trends', JSON.stringify([trend({ sources: [{ label: 'A', ref: 'L1' }, { label: 'B', ref: 'L99' }, { label: 'C', ref: 'L4' }] })]), { messages: prompt });
  assert.equal(v.ok, true);
  assert.equal(v.stats.citedRefs, 3);
  assert.equal(v.stats.ungroundedRefs, 1);
  assert.equal(v.value[0].sources[1].ref, null);
  assert.equal(v.value[0].sources[2].ref, 'L4', 'refs listed inside a THREAD bracket count as shown');
});

test('partial acceptance: one malformed trend is dropped, the rest survive', () => {
  const v = enforce('trends', JSON.stringify([trend(), { title: 'x' }, trend({ title: 'Another valid trend' })]), { messages: prompt });
  assert.equal(v.ok, true);
  assert.equal(v.value.length, 2);
  assert.equal(v.stats.dropped, 1);
  assert.ok(v.stats.errors.some(e => e.path.startsWith('/1/')));
});

test('truncated array (token cap) salvages the complete objects', () => {
  const full = JSON.stringify([trend(), trend({ title: 'Second trend title' })]);
  const cut = full.slice(0, full.length - 40);
  const v = enforce('trends', cut, { messages: prompt });
  assert.equal(v.ok, true);
  assert.equal(v.stats.salvaged, true);
  assert.equal(v.value.length, 1);
});

test('nothing usable -> not ok, so the caller repairs', () => {
  assert.equal(enforce('trends', 'I could not find any trends.').ok, false);
  assert.equal(enforce('trends', JSON.stringify([{ title: 'only a title' }])).ok, false);
  assert.equal(enforce('brief', '{"subject":"Hi"}').ok, false);
});

test('brief and audit schemas', () => {
  const brief = { subject: 'Futures briefing', intro: 'Two trends lead this cycle.', sections: { 'Future of Work': 'Lead-in.' }, closing: 'Flag what matters.' };
  assert.equal(enforce('brief', JSON.stringify(brief)).ok, true);
  const audit = enforce('audit', '{"fits":[{"i":"0","fit":"false","note":"overreach"}],"emptyTopics":[]}');
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.value.fits[0], { i: 0, fit: false, note: 'overreach' });
});

test('triage keeps the old tolerance: stems and out-of-range novelty normalise', () => {
  const v = enforce('triage', JSON.stringify([
    { i: 0, keep: true, domain: 'Technology', novelty: 7 },
    { i: 1, keep: false, domain: 'environment', novelty: '2' },
    { i: 2, keep: true, domain: 'Sports', novelty: 3 },
  ]));
  assert.equal(v.value.length, 2);
  assert.deepEqual(v.value[0], { i: 0, keep: true, domain: 'Technological', novelty: 5 });
  assert.equal(v.value[1].domain, 'Environmental');
  assert.equal(v.stats.dropped, 1, 'an unmappable domain drops the item (it stays untriaged = keep)');
});

test('extractJson finds the right root type', () => {
  assert.deepEqual(extractJson('noise {"a":[1]} tail', 'object').value, { a: [1] });
  assert.throws(() => extractJson('no json here', 'array'));
});

test('refsInPrompt ignores the system prompt', () => {
  const refs = refsInPrompt([{ role: 'system', content: 'e.g. [L7]' }, ...prompt]);
  assert.deepEqual([...refs].sort(), ['L1', 'L2', 'L3', 'L4']);
});

test('repair prompt carries the schema (without hook functions) and the errors', () => {
  const m = repairMessages('trends', '[{"title":"x"}]', [{ path: '/0/what', msg: 'required' }]);
  assert.equal(m.length, 2);
  assert.match(m[1].content, /"required":\["title"/);
  assert.match(m[1].content, /\/0\/what: required/);
  assert.doesNotMatch(m[1].content, /normalize/);
});
