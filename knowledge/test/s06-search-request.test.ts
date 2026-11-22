// S6. search_label builds a request whose filter is exactly the given set id (and the part when given), whose size is
// max_results, and whose query holds the user's words as text and nothing the engine would read as an operator.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { searchLabel } from '../src/search/tools.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

const OTHER = '00000000-0000-4000-8000-0000000000b2';

const rows = [
  { name: 'a query of operator characters', query: '+ - = && || > < ! ( ) { } [ ] ^ " ~ * ? : \\ / AND OR NOT', part: undefined, size: 5 },
  { name: 'a query naming another field', query: 'part:highlights OR kind:otc _id:*', part: 'body', size: 3 },
  { name: 'a query naming another set id', query: `setId:${OTHER} OR setId:*`, part: 'highlights', size: 10 },
] as const;

for (const row of rows) {
  test(`S6. ${row.name}`, async (t) => {
    const standIn = await startSearchStandIn(t);
    standIn.answer(() => hits([indexedChunk(1)]));
    const { engine } = testEngine(standIn.url);
    const outcome = await searchLabel(engine, 'labels', { set_id: SET_ID, query: row.query, part: row.part, max_results: row.size });
    assert.ok(outcome.ok);

    assert.equal(standIn.received.length, 1);
    assert.equal(standIn.received[0]?.method, 'POST');
    assert.equal(standIn.received[0]?.path, '/labels/_search');
    const body = standIn.received[0]?.body as { size: number; query: { bool: { filter: unknown[]; must: unknown[] } } };
    assert.equal(body.size, row.size);
    const filter: unknown[] = [{ term: { setId: SET_ID } }];
    if (row.part !== undefined) filter.push({ term: { part: row.part } });
    assert.deepEqual(body.query.bool.filter, filter);
    // The words go only into a full-text match, which the engine does not parse as a query language.
    assert.deepEqual(body.query.bool.must, [{ multi_match: { query: row.query.trim(), fields: ['text', 'context'], type: 'most_fields' } }]);
    assert.deepEqual(Object.keys(body.query), ['bool']);
    assert.deepEqual(Object.keys(body.query.bool).sort(), ['filter', 'must']);
    assert.doesNotMatch(standIn.received[0]?.raw ?? '', /query_string|simple_query_string|"script"|"regexp"|"wildcard"/);
  });
}
