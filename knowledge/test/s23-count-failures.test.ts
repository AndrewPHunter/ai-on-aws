// S23 (T2). After a search with no passages, the count that tells "no such label" from "nothing matched" can fail
// in its own ways: no answer in time, status 500, an answer of an unexpected shape, the connection closing part way
// through the answer. Each is its own error result, never an empty list.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { searchLabel } from '../src/search/tools.ts';
import { SET_ID, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';
import type { SearchReply } from './support/search-standin.ts';

const rows: { name: string; reply: SearchReply; error: string }[] = [
  { name: 'does not answer in time', reply: 'hold', error: 'search_timed_out' },
  { name: 'answers 500', reply: { status: 500, body: { error: 'internal' } }, error: 'search_error' },
  { name: 'answers in an unexpected shape', reply: { status: 200, body: { counted: 'many' } }, error: 'search_unexpected_answer' },
  { name: 'closes the connection part way through its answer', reply: 'cut', error: 'search_unreachable' },
];

for (const row of rows) {
  test(`S23. the count after an empty search ${row.name}: ${row.error}`, async (t) => {
    const standIn = await startSearchStandIn(t);
    standIn.answer((request) => (request.path.endsWith('/_count') ? row.reply : hits([])));
    const { engine, expire } = testEngine(standIn.url);
    standIn.onHold(expire);

    const searched = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' });

    assert.equal(searched.ok, false);
    if (!searched.ok) assert.equal(searched.error.error, row.error);
    assert.deepEqual(standIn.received.map((r) => r.path), ['/labels/_search', '/labels/_count']);
  });
}
