// S10. A set id with no documents gives the error result that names it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { searchLabel } from '../src/search/tools.ts';
import { SET_ID, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

test('S10. no passages and no documents for the set id: the error names it', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer((request) => (request.path.endsWith('/_count') ? { status: 200, body: { count: 0 } } : hits([])));
  const { engine } = testEngine(standIn.url);
  const outcome = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.error, 'label_not_found');
    assert.match(outcome.error.detail, new RegExp(SET_ID));
  }
  assert.deepEqual(standIn.received.map((r) => r.path), ['/labels/_search', '/labels/_count']);
  assert.deepEqual(standIn.received[1]?.body, { query: { term: { setId: SET_ID } } });
});

test('S10. no passages but the label is there: an empty list, which is an answer', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer((request) => (request.path.endsWith('/_count') ? { status: 200, body: { count: 12 } } : hits([])));
  const { engine } = testEngine(standIn.url);
  const outcome = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'nothing about this' });
  assert.deepEqual(outcome, { ok: true, value: { set_id: SET_ID, strategy: 'keyword', passages: [] } });
});
