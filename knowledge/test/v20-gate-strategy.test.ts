// V20. The gate's pure parts for the strategy statements: which strategy the service named; whether each passage
// carries the ranks its strategy computes; and whether the identity the index records equals the configured one.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { carriesRanks, configuredIdentity, everyPassageCarriesRanks, recordedEmbedding, recordedIdentityDifferences, strategyOf, usesVectors } from '../src/gate/strategy.ts';
import { errorCode, errorSummary } from '../src/gate/service.ts';
import { CONCRETE, DIMENSIONS, IDENTITY, REPOSITORY, REVISION } from './support/vectors.ts';

const ranks = (keyword: number | null, vector: number | null, fused: number | null, reranked: number | null) => ({ keyword, vector, fused, reranked });

test('V20. the strategy named, and whether it uses vectors', () => {
  assert.equal(strategyOf({ strategy: 'fused' }), 'fused');
  assert.equal(strategyOf({ strategy: 'hybrid' }), null);
  assert.equal(strategyOf({}), null);
  assert.equal(usesVectors('keyword'), false);
  assert.equal(usesVectors('fused_reranked'), true);
});

test('V20. each strategy\'s ranks', () => {
  assert.equal(carriesRanks(ranks(1, null, null, null), 'keyword'), true);
  assert.equal(carriesRanks(ranks(null, 2, null, null), 'vector'), true);
  assert.equal(carriesRanks(ranks(1, null, null, null), 'vector'), false);
  assert.equal(carriesRanks(ranks(3, null, 4, null), 'fused'), true);
  assert.equal(carriesRanks(ranks(null, 1, 2, null), 'fused'), true);
  assert.equal(carriesRanks(ranks(null, null, 2, null), 'fused'), false);
  assert.equal(carriesRanks(ranks(1, 1, null, null), 'fused'), false);
  assert.equal(carriesRanks(ranks(1, 2, 1, 3), 'fused_reranked'), true);
  assert.equal(carriesRanks(ranks(1, 2, 1, null), 'fused_reranked'), false);
  assert.equal(carriesRanks(ranks(0, 2, 1, 1), 'fused_reranked'), false);
  assert.equal(carriesRanks(undefined, 'fused'), false);
  assert.equal(everyPassageCarriesRanks([{ ranks: ranks(1, 2, 1, 1) }, { ranks: ranks(null, 2, 1, 2) }], 'fused_reranked'), true);
  assert.equal(everyPassageCarriesRanks([{ ranks: ranks(1, 2, 1, 1) }, {}], 'fused_reranked'), false);
});

test('V20. what failed: each error code with its count and the first search it happened on, by position', () => {
  assert.equal(errorCode({ isError: true, payload: { error: 'rerank_timed_out', detail: 'x' } }), 'rerank_timed_out');
  assert.equal(errorCode({ isError: true, payload: { unparsed: true } }), 'unreadable');
  assert.equal(errorCode({ isError: true, payload: { error: 'Some text a payload should not carry' } }), 'unreadable');
  assert.equal(errorSummary([]), '');
  assert.equal(
    errorSummary([
      { position: 17, code: 'search_timed_out' },
      { position: 4, code: 'rerank_error' },
      { position: 40, code: 'search_timed_out' },
    ]),
    'rerank_error: 1 (first at search 4); search_timed_out: 2 (first at search 17)',
  );
});

test('V20. the recorded identity against the configured one', () => {
  const configured = configuredIdentity({ EMBED_MODEL_REPO: REPOSITORY, EMBED_MODEL_REVISION: REVISION, EMBED_DIMENSIONS: String(DIMENSIONS) });
  assert.deepEqual(configured, { repository: REPOSITORY, revision: REVISION, dimensions: DIMENSIONS });
  assert.equal(configuredIdentity({ EMBED_MODEL_REPO: REPOSITORY }), null);
  if (configured === null) return;
  const mapping = { [CONCRETE]: { mappings: { _meta: { embedding: IDENTITY } } } };
  assert.deepEqual(recordedEmbedding(mapping), IDENTITY);
  assert.equal(recordedEmbedding({ a: {}, b: {} }), undefined);
  assert.deepEqual(recordedIdentityDifferences(IDENTITY, configured), []);
  assert.deepEqual(recordedIdentityDifferences({ ...IDENTITY, revision: 'other', instruction: 'other' }, configured), ['revision', 'instruction']);
  assert.deepEqual(recordedIdentityDifferences(null, configured), ['identity']);
  assert.deepEqual(recordedIdentityDifferences({ repository: REPOSITORY }, configured), ['identity']);
});
