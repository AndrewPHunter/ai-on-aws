// V15 (the whole search's limit). One time limit covers a whole search: every request it makes gets the smaller of
// its own limit and what is left. When nothing is left the answer is search_timed_out, with a detail that says the
// search as a whole ran out of time and which step it was on. The service's own limit is 8 s. In the first two tests
// the search has 10 s and every kind of request 30 s of its own, so each request is given what is left of the search
// (never a tie with its own limit), the requests meant to be quick have 10 s between them however busy the machine,
// and the slow step never answers, so the search's limit running out is the only way the search can end.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SearchBudget } from '../src/search/limits.ts';
import type { RequestKind } from '../src/search/limits.ts';
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

// Every kind of request's own limit, longer than the first two tests' search.
const OWN_30_S: Record<RequestKind, number> = { engine: 30_000, embedding: 30_000, rerank: 30_000 };

function errorOf(outcome: { ok: boolean; error?: ToolError }): ToolError {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  return outcome.error as ToolError;
}

test('V15. a slow mapping read and a slow vector search cannot take the search past its limit; the detail names the step', async (t) => {
  const search = await startSearchStandIn(t);
  // The mapping read takes 1 s, inside its own limit; the vector search then never answers, and is cut at what is left.
  search.answer((request: SearchRequest) =>
    request.path.endsWith('/_mapping') ? { ...(mappingAnswer(IDENTITY) as { status: number; body: unknown }), delayMs: 1000 } : isVectorSearch(request) ? 'hold' : vectorHits(),
  );
  const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
  const { retriever } = testRetriever('vector', model, { ms: 10_000, now: () => performance.now(), requestMs: OWN_30_S });

  const started = performance.now();
  const outcome = await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever);
  const took = performance.now() - started;

  const error = errorOf(outcome);
  assert.equal(error.error, 'search_timed_out');
  assert.equal(error.detail, 'The search as a whole ran out of time (its limit is 10 s) while running the vector search.');
  // The vector search alone was allowed 30 s; the search stopped at its limit of 10 s (with room for a loaded machine).
  assert.ok(took < 25_000, `${Math.round(took)} ms`);
});

test('V15. the step is named: the mapping read, the embedding request, the reranker', async (t) => {
  const rows: { name: string; strategy: 'vector' | 'fused_reranked'; slowMapping?: boolean; slow?: '/v1/embeddings' | '/v1/rerank'; step: string }[] = [
    { name: 'mapping', strategy: 'vector', slowMapping: true, step: 'reading which index the alias points at' },
    { name: 'embedding', strategy: 'vector', slow: '/v1/embeddings', step: 'asking the embedding server for the query vector' },
    { name: 'reranker', strategy: 'fused_reranked', slow: '/v1/rerank', step: 'asking the reranker' },
  ];
  for (const row of rows) {
    const search = await startSearchStandIn(t);
    search.answer((request: SearchRequest) =>
      request.path.endsWith('/_mapping') ? (row.slowMapping === true ? 'hold' : (mappingAnswer(IDENTITY) as SearchReply)) : vectorHits(),
    );
    const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
    if (row.slow !== undefined) model.queue(row.slow, 'hold');
    const { retriever } = testRetriever(row.strategy, model, { ms: 10_000, now: () => performance.now(), requestMs: OWN_30_S });

    const error = errorOf(await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever));

    assert.equal(error.error, 'search_timed_out', row.name);
    assert.equal(error.detail, `The search as a whole ran out of time (its limit is 10 s) while ${row.step}.`, row.name);
  }
});

test("V15. a request given its own limit (less than what is left of the search) that runs out is the request's own failure, named as before", async (t) => {
  // The search has 60 s; the slow kind of request is given 200 ms of its own, and its answer takes 2 s. Nothing ties.
  // The other requests keep their own limits (seconds), so a busy machine cannot make one of them the failure.
  const rows: { name: string; strategy: 'keyword' | 'vector' | 'fused_reranked'; kind: RequestKind; slowMapping?: boolean; slowKeyword?: boolean; slow?: '/v1/embeddings' | '/v1/rerank'; error: string; detail: string }[] = [
    { name: 'the engine (keyword search)', strategy: 'keyword', kind: 'engine', slowKeyword: true, error: 'search_timed_out', detail: 'The search engine did not answer in time.' },
    { name: 'the engine (mapping read)', strategy: 'vector', kind: 'engine', slowMapping: true, error: 'search_timed_out', detail: 'The search engine did not answer in time.' },
    { name: 'the embedding server', strategy: 'vector', kind: 'embedding', slow: '/v1/embeddings', error: 'embedding_timed_out', detail: 'The embedding server did not answer in time.' },
    { name: 'the reranker', strategy: 'fused_reranked', kind: 'rerank', slow: '/v1/rerank', error: 'rerank_timed_out', detail: 'The reranker did not answer in time.' },
  ];
  for (const row of rows) {
    const search = await startSearchStandIn(t);
    search.answer((request: SearchRequest) =>
      request.path.endsWith('/_mapping')
        ? { ...(mappingAnswer(IDENTITY) as { status: number; body: unknown }), ...(row.slowMapping === true ? { delayMs: 2000 } : {}) }
        : vectorHits(row.slowKeyword === true ? 2000 : undefined),
    );
    const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
    if (row.slow !== undefined) model.queue(row.slow, { delayMs: 2000 });
    const { retriever } = testRetriever(row.strategy, model, { ms: 60_000, now: () => performance.now(), requestMs: { [row.kind]: 200 } });

    const error = errorOf(await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever));

    assert.equal(error.error, row.error, row.name);
    assert.equal(error.detail, row.detail, row.name);
  }
});

test('V15. the reason is decided by what a request was given, not by which timer fired first', () => {
  // A clock the test moves: 8 s for the search, the engine's own 5 s.
  let now = 0;
  const budget = new SearchBudget({ ms: 8000, now: () => now });
  const first = budget.allot('engine');
  assert.deepEqual([first.ms, first.bySearch], [5000, false]);
  now = 3000; // 5 s left: equal to the engine's own limit, so it is the request's own.
  const second = budget.allot('engine');
  assert.deepEqual([second.ms, second.bySearch], [5000, false]);
  now = 3001; // 4.999 s left: the search's remainder.
  const third = budget.allot('engine');
  assert.deepEqual([third.ms, third.bySearch], [4999, true]);
  const embedding = budget.allot('embedding');
  assert.deepEqual([embedding.ms, embedding.bySearch], [3000, false]);
  now = 8000;
  assert.equal(budget.spent(), true);
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
