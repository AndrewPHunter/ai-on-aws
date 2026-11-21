// S8. Refusals before anything is sent: an empty query, max_results 0 and 11, an unknown part, a set id that is not
// a GUID.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { searchLabel } from '../src/search/tools.ts';
import { SET_ID, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

const rows = [
  { name: 'an empty query', input: { set_id: SET_ID, query: '   ' } },
  { name: 'max_results 0', input: { set_id: SET_ID, query: 'dose', max_results: 0 } },
  { name: 'max_results 11', input: { set_id: SET_ID, query: 'dose', max_results: 11 } },
  { name: 'an unknown part', input: { set_id: SET_ID, query: 'dose', part: 'appendix' } },
  { name: 'a set id that is not a GUID', input: { set_id: 'not-a-guid', query: 'dose' } },
  { name: 'a set id in capitals', input: { set_id: SET_ID.toUpperCase(), query: 'dose' } },
];

for (const row of rows) {
  test(`S8. refused before anything is sent: ${row.name}`, async (t) => {
    const standIn = await startSearchStandIn(t);
    standIn.answer(() => hits([]));
    const { engine } = testEngine(standIn.url);
    const outcome = await searchLabel(engine, 'labels', row.input);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.error, 'invalid_input');
    assert.equal(standIn.received.length, 0);
  });
}
