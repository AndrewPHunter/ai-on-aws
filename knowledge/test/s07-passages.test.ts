// S7. search_label turns the engine's answer into passages with every field the contract lists, in the engine's
// order.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { searchLabel } from '../src/search/tools.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

test('S7. passages, every field, in the engine order', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([indexedChunk(2, { part: 'highlights', type: 'table-rows', position: { ordinal: 9, firstRow: 1, lastRow: 4, rowCount: 8 } }), indexedChunk(1)]));
  const { engine } = testEngine(standIn.url);
  const outcome = await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'invented dosing' });
  assert.ok(outcome.ok);
  const source = `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SET_ID}&version=3`;
  assert.deepEqual(outcome.value, {
    set_id: SET_ID,
    passages: [
      {
        chunk_id: `${SET_ID}/3/sec-2/body/1`,
        text: 'Invented passage 2.',
        score: 10,
        part: 'highlights',
        type: 'table-rows',
        section: { number: '2.2', title: '2.2 Invented dosing', path: ['2 DOSAGE', '2.2 Invented dosing'] },
        position: { ordinal: 9, firstRow: 1, lastRow: 4, rowCount: 8 },
        label: { set_id: SET_ID, version: 3, effective_date: '20240102', kind: 'prescription', source },
      },
      {
        chunk_id: `${SET_ID}/3/sec-1/body/1`,
        text: 'Invented passage 1.',
        score: 9,
        part: 'body',
        type: 'text',
        section: { number: '2.1', title: '2.1 Invented dosing', path: ['2 DOSAGE', '2.1 Invented dosing'] },
        position: { ordinal: 1 },
        label: { set_id: SET_ID, version: 3, effective_date: '20240102', kind: 'prescription', source },
      },
    ],
  });
});
