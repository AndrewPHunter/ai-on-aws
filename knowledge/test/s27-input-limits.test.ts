// S27 (T6). invalid_input at the limits a caller can hit: a query of 1,001 characters (1,000 is accepted), an empty
// drug name, and a drug name of 201 characters (200 is accepted). Nothing is sent for a refusal.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLabels, searchLabel } from '../src/search/tools.ts';
import { SET_ID, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

test('S27. the query and drug name limits', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([]));
  const { engine } = testEngine(standIn.url);
  const errorOf = (outcome: { ok: boolean; error?: { error: string } }): string => (outcome.ok ? 'ok' : (outcome.error?.error ?? ''));

  assert.equal(errorOf(await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'a'.repeat(1001) })), 'invalid_input');
  assert.equal(errorOf(await findLabels(engine, 'labels', { drug: '' })), 'invalid_input');
  assert.equal(errorOf(await findLabels(engine, 'labels', { drug: '   ' })), 'invalid_input');
  assert.equal(errorOf(await findLabels(engine, 'labels', { drug: 'a'.repeat(201) })), 'invalid_input');
  assert.equal(standIn.received.length, 0);

  // At the limit, each is sent.
  await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'a'.repeat(1000) });
  await findLabels(engine, 'labels', { drug: 'a'.repeat(200) });
  assert.ok(standIn.received.length >= 2);
});
