// S20 (D6, T3). A document whose version is not a whole number makes the answer search_unexpected_answer in both
// tools, never a null version in a success. A hit from another label than the one asked for makes search_label's
// answer search_unexpected_answer.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLabels, searchLabel } from '../src/search/tools.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

for (const version of ['three', 3.5, '0', -1]) {
  test(`S20. a version of ${JSON.stringify(version)} is search_unexpected_answer in both tools`, async (t) => {
    const standIn = await startSearchStandIn(t);
    standIn.answer(() => hits([indexedChunk(1, { version })]));
    const { engine } = testEngine(standIn.url);

    const searched = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' });
    assert.equal(searched.ok ? 'ok' : searched.error.error, 'search_unexpected_answer', 'search_label');
    const found = await findLabels(engine, 'labels', { drug: 'Examplamab' });
    assert.equal(found.ok ? 'ok' : found.error.error, 'search_unexpected_answer', 'find_labels');
  });
}

test('S20. a version held as the text of a whole number is read as that number', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([indexedChunk(1, { version: '3' })]));
  const searched = await searchLabel(testEngine(standIn.url).engine, 'labels', { set_id: SET_ID, query: 'dose' });
  assert.equal(searched.ok && searched.value.passages[0]?.label.version, 3);
});

test('S20 (T3). a hit whose set id is not the one asked for is search_unexpected_answer', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([indexedChunk(1), indexedChunk(2, { setId: '00000000-0000-4000-8000-0000000000b2' })]));
  const searched = await searchLabel(testEngine(standIn.url).engine, 'labels', { set_id: SET_ID, query: 'dose' });
  assert.equal(searched.ok ? 'ok' : searched.error.error, 'search_unexpected_answer');
});
