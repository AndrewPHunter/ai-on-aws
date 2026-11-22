// V15 (the whole search's limit). One time limit covers a whole search: every request it makes gets the smaller of
// its own limit and what is left. When nothing is left the answer is search_timed_out, with a detail that says the
// search as a whole ran out of time and which step it was on. Short limits here; the service's own is 8 s.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLabels, searchLabel } from '../src/search/tools.ts';
import type { ToolError } from '../src/search/tools.ts';
import { startModelStandIn } from './support/model-standin.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';
import type { SearchReply, SearchRequest } from './support/search-standin.ts';
import { DIMENSIONS, isVectorSearch, mappingAnswer, testRetriever, IDENTITY } from './support/vectors.ts';

const chunk = (n: number) => indexedChunk(n, { id: `${SET_ID}/3/sec-${n}/body/1` });
const vectorHits = (delayMs?: number): SearchReply => ({
  status: 200,
  body: { hits: { hits: [{ _score: 0.9, _source: chunk(1) }] } },
  ...(delayMs === undefined ? {} : { delayMs }),
});

function errorOf(outcome: { ok: boolean; error?: ToolError }): ToolError {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  return outcome.error as ToolError;
}

test('V15. a slow mapping read and a slow vector search cannot take the search past its limit; the detail names the step', async (t) => {
  const search = await startSearchStandIn(t);
  // Each request alone is inside its own limit; together they are over the search's.
  search.answer((request: SearchRequest) =>
    request.path.endsWith('/_mapping') ? { ...(mappingAnswer(IDENTITY) as { status: number; body: unknown }), delayMs: 350 } : isVectorSearch(request) ? vectorHits(1000) : vectorHits(),
  );
  const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
  const { retriever } = testRetriever('vector', model, { ms: 600, now: () => performance.now() });

  const started = performance.now();
  const outcome = await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever);
  const took = performance.now() - started;

  const error = errorOf(outcome);
  assert.equal(error.error, 'search_timed_out');
  assert.equal(error.detail, 'The search as a whole ran out of time (its limit is 0.6 s) while running the vector search.');
  // 350 + 1000 would be 1350 ms; the search stopped at its limit of 600 (with room for a loaded machine).
  assert.ok(took < 1200, `${Math.round(took)} ms`);
});

test('V15. the step is named: the mapping read, the embedding request, the reranker', async (t) => {
  const rows: { name: string; strategy: 'vector' | 'fused_reranked'; mappingDelay?: number; slow?: '/v1/embeddings' | '/v1/rerank'; step: string }[] = [
    { name: 'mapping', strategy: 'vector', mappingDelay: 1000, step: 'reading which index the alias points at' },
    { name: 'embedding', strategy: 'vector', slow: '/v1/embeddings', step: 'asking the embedding server for the query vector' },
    { name: 'reranker', strategy: 'fused_reranked', slow: '/v1/rerank', step: 'asking the reranker' },
  ];
  for (const row of rows) {
    const search = await startSearchStandIn(t);
    search.answer((request: SearchRequest) =>
      request.path.endsWith('/_mapping')
        ? { ...(mappingAnswer(IDENTITY) as { status: number; body: unknown }), ...(row.mappingDelay === undefined ? {} : { delayMs: row.mappingDelay }) }
        : vectorHits(),
    );
    const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
    if (row.slow !== undefined) model.queue(row.slow, { delayMs: 1000 });
    const { retriever } = testRetriever(row.strategy, model, { ms: 300, now: () => performance.now() });

    const error = errorOf(await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever));

    assert.equal(error.error, 'search_timed_out', row.name);
    assert.equal(error.detail, `The search as a whole ran out of time (its limit is 0.3 s) while ${row.step}.`, row.name);
  }
});

test('V15. nothing left before a request: it is not sent', async (t) => {
  const search = await startSearchStandIn(t);
  search.answer(() => vectorHits());
  // A clock that has already passed the limit by the time the search makes its first request.
  let reads = 0;
  const now = (): number => (reads++ === 0 ? 0 : 10_000);

  const error = errorOf(await findLabels(testEngine(search.url).engine, 'labels', { drug: 'Examplamab' }, { ms: 8000, now }));

  assert.equal(error.error, 'search_timed_out');
  assert.equal(error.detail, 'The search as a whole ran out of time (its limit is 8 s) while looking for labels with that exact name.');
  assert.equal(search.received.length, 0);
});

test('V15. a request\'s own time limit, inside the search\'s, is still its own failure', async (t) => {
  const search = await startSearchStandIn(t);
  search.answer(() => 'hold');
  const engine = testEngine(search.url);
  search.onHold(engine.expire);
  const error = errorOf(await searchLabel(engine.engine, 'labels', { set_id: SET_ID, query: 'dose' }));
  assert.equal(error.error, 'search_timed_out');
  assert.equal(error.detail, 'The search engine did not answer in time.');
});
