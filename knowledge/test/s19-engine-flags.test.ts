// S19 (D5). An engine answer of status 200 that says it timed out, or that a shard failed, is not an answer: timed
// out is search_timed_out, a failed shard is search_error. In both tools, and for the count a search with no
// passages makes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLabels, searchLabel } from '../src/search/tools.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

const answered = hits([indexedChunk(1)]).body as Record<string, unknown>;

const rows = [
  { name: 'timed_out: true', body: { ...answered, timed_out: true }, count: { count: 1, timed_out: true }, error: 'search_timed_out' },
  {
    name: 'a failed shard',
    body: { ...answered, timed_out: false, _shards: { total: 1, successful: 0, skipped: 0, failed: 1 } },
    count: { count: 1, _shards: { total: 1, successful: 0, skipped: 0, failed: 1 } },
    error: 'search_error',
  },
];

for (const row of rows) {
  test(`S19. an answer of status 200 with ${row.name} is ${row.error}, in both tools`, async (t) => {
    const standIn = await startSearchStandIn(t);
    standIn.answer(() => ({ status: 200, body: row.body }));
    const { engine } = testEngine(standIn.url);

    const searched = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' });
    assert.equal(searched.ok ? 'ok' : searched.error.error, row.error, 'search_label');
    const found = await findLabels(engine, 'labels', { drug: 'Examplamab' });
    assert.equal(found.ok ? 'ok' : found.error.error, row.error, 'find_labels');
  });

  test(`S19. the count after an empty search, answered 200 with ${row.name}, is ${row.error}`, async (t) => {
    const standIn = await startSearchStandIn(t);
    standIn.answer((request) => (request.path.endsWith('/_count') ? { status: 200, body: row.count } : hits([])));
    const { engine } = testEngine(standIn.url);

    const searched = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' });
    assert.equal(searched.ok ? 'ok' : searched.error.error, row.error);
  });
}

test('S19. an answer that says it did not time out and that every shard succeeded is an answer', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => ({ status: 200, body: { ...answered, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 } } }));
  const searched = await searchLabel(testEngine(standIn.url).engine, 'labels', { set_id: SET_ID, query: 'dose' });
  assert.equal(searched.ok, true);
});
