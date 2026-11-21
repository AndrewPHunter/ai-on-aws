// S5. find_labels: an exact name in any of the three kinds of name, in any case and with spaces around it, matches;
// a name with no exact match falls back to every-word matching; more than 10 are cut to 10 and reported as cut;
// newest first; no match is an empty list. The stand-in ranks nothing: these tests show the requests sent and what
// is made of the answers.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drugNames } from '../src/chunk/split.ts';
import { findLabels } from '../src/search/tools.ts';
import { chunk } from './support/chunking.ts';
import { P1_PRESCRIPTION } from './support/labels.ts';
import { testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

const label = (n: number) => ({
  setId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  version: 2,
  effectiveTime: `2024010${n % 10}`,
  kind: 'otc',
  format: 'old',
  drug: ['Sampleprin', 'sampleprin sodium', 'SAMPLEPRIN'],
  source: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=x${n}&version=2`,
});

type Body = { query: { bool: { filter: Record<string, unknown>[] } }; sort: unknown; size: number; collapse: unknown };

test('S5. the drug field holds product, generic and active-ingredient names, which the exact match compares', () => {
  const { chunks, document } = chunk(P1_PRESCRIPTION, { textLimit: 300, tableLimit: 300 });
  // Product name, generic name and active ingredient each end up in the one searched field.
  assert.deepEqual(chunks[0]?.drug, drugNames(document));
  assert.ok(chunks[0]?.drug.includes('Examplamab') && chunks[0].drug.includes('examplamab sodium') && chunks[0].drug.includes('TESTAZOLE'));
});

test('S5. an exact name, in any case and with spaces around it, is one exact request', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([label(1)]));
  const { engine } = testEngine(standIn.url);
  const outcome = await findLabels(engine, 'labels', { drug: '  SamplePRIN  ' });
  assert.ok(outcome.ok);
  assert.equal(outcome.value.matched_by, 'exact_name');
  assert.equal(outcome.value.labels[0]?.set_id, label(1).setId);
  assert.deepEqual(outcome.value.labels[0], {
    set_id: label(1).setId,
    version: 2,
    effective_date: '20240101',
    kind: 'otc',
    format: 'old',
    names: label(1).drug,
    source: label(1).source,
  });
  assert.equal(standIn.received.length, 1);
  const body = standIn.received[0]?.body as Body;
  assert.equal(standIn.received[0]?.path, '/labels/_search');
  assert.deepEqual(body.query.bool.filter, [{ term: { 'drug.exact': 'sampleprin' } }]);
  assert.deepEqual(body.collapse, { field: 'setId' });
  assert.deepEqual(body.sort, [{ effectiveTime: 'desc' }, { setId: 'asc' }]);
});

test('S5. no exact match falls back to every word', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer((request) => ('term' in ((request.body as Body).query.bool.filter[0] ?? {}) ? hits([]) : hits([label(2)])));
  const { engine } = testEngine(standIn.url);
  const outcome = await findLabels(engine, 'labels', { drug: 'sampleprin  sodium' });
  assert.ok(outcome.ok);
  assert.equal(outcome.value.matched_by, 'every_word');
  assert.equal(outcome.value.labels.length, 1);
  assert.deepEqual((standIn.received[1]?.body as Body).query.bool.filter, [{ match: { drug: { query: 'sampleprin  sodium', operator: 'and' } } }]);
});

test('S5. more than 10 are cut to 10 and reported as cut, in the engine order, newest first', async (t) => {
  const standIn = await startSearchStandIn(t);
  const many = Array.from({ length: 11 }, (_, i) => label(19 - i));
  standIn.answer(() => hits(many));
  const { engine } = testEngine(standIn.url);
  const outcome = await findLabels(engine, 'labels', { drug: 'Sampleprin' });
  assert.ok(outcome.ok);
  assert.equal(outcome.value.labels.length, 10);
  assert.equal(outcome.value.more_matched, true);
  assert.deepEqual(outcome.value.labels.map((l) => l.set_id), many.slice(0, 10).map((l) => l.setId));
  // Eleven are asked for, to know whether more than ten matched.
  assert.equal((standIn.received[0]?.body as Body).size, 11);
});

test('S5. no match is an empty list, not an error', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([]));
  const { engine } = testEngine(standIn.url);
  const outcome = await findLabels(engine, 'labels', { drug: 'nothing like it' });
  assert.deepEqual(outcome, { ok: true, value: { labels: [], more_matched: false, matched_by: 'none' } });
});
