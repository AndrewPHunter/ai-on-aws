// V11 to V16. search_label by strategy, against the search stand-in and the labelled model stand-in: the vector
// request; fusion; reranking; the index's embedding identity; each new failure; and keyword calling no model server.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { fuse } from '../src/search/fusion.ts';
import { EMBEDDING_REQUEST_MS, RERANK_REQUEST_MS, SEARCH_LIMIT_MS } from '../src/search/limits.ts';
import { retrieverFrom } from '../src/search/retriever.ts';
import { retrievalSettingsFrom } from '../src/search/settings.ts';
import { RERANK_MAX_TOKENS_PER_DOC, searchLabel, vectorRequest } from '../src/search/tools.ts';
import type { Passage, SearchLabelResult } from '../src/search/tools.ts';
import type { Strategy } from '../src/search/settings.ts';
import { QUERY_INSTRUCTION, queryText } from '../src/vectors/recipe.ts';
import { startModelStandIn, standInRelevance, standInVector } from './support/model-standin.ts';
import type { ModelStandIn } from './support/model-standin.ts';
import { SET_ID, indexedChunk, testEngine } from './support/retrieval.ts';
import { startSearchStandIn } from './support/search-standin.ts';
import type { SearchReply, SearchRequest, SearchStandIn } from './support/search-standin.ts';
import { CONCRETE, DIMENSIONS, IDENTITY, TEST_KEY, isVectorSearch, testRetriever, vectorEngine } from './support/vectors.ts';

const chunk = (n: number, text = `Invented passage ${n}.`, part = 'body') => indexedChunk(n, { id: `${SET_ID}/3/sec-${n}/${part}/1`, text, part });

async function rig(t: TestContext, strategy: Strategy, engine: (request: SearchRequest) => SearchReply) {
  const search = await startSearchStandIn(t);
  search.answer(engine);
  const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
  const { retriever, expire } = testRetriever(strategy, model);
  const searchEngine = testEngine(search.url);
  model.onHold(expire);
  search.onHold(searchEngine.expire);
  const run = (input: Record<string, unknown> = { set_id: SET_ID, query: 'invented dose' }) => searchLabel(searchEngine.engine, 'labels', input, retriever);
  return { search, model, run };
}

const embeddings = (model: ModelStandIn) => model.received.filter((r) => r.path === '/v1/embeddings');
const reranks = (model: ModelStandIn) => model.received.filter((r) => r.path === '/v1/rerank');
const ok = (outcome: { ok: boolean }): SearchLabelResult => {
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return (outcome as { ok: true; value: SearchLabelResult }).value;
};
const ids = (passages: Passage[]): string[] => passages.map((passage) => passage.chunk_id);

test('V11. vector: the exact script_score request with the set id, part and hasVector filters and the query vector; the instruction format', async (t) => {
  const { search, model, run } = await rig(t, 'vector', vectorEngine({ vector: [{ source: chunk(2), cosine: 0.9 }, { source: chunk(1), cosine: 0.5 }] }));

  const value = ok(await run({ set_id: SET_ID, query: 'invented dose', part: 'body', max_results: 2 }));

  const sent = embeddings(model);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.body, { model: 'test-embedding', input: [`Instruct: ${QUERY_INSTRUCTION}\nQuery:invented dose`], encoding_format: 'base64' });
  assert.equal(queryText('invented dose'), `Instruct: ${QUERY_INSTRUCTION}\nQuery:invented dose`);
  const vector = standInVector(queryText('invented dose'), DIMENSIONS);
  const request = search.received.find(isVectorSearch);
  assert.equal(request?.path, `/${CONCRETE}/_search`);
  assert.deepEqual(request?.body, vectorRequest(SET_ID, 'body', vector, 2));
  assert.deepEqual(request?.body, {
    size: 2,
    query: {
      script_score: {
        query: { bool: { filter: [{ term: { setId: SET_ID } }, { term: { part: 'body' } }, { term: { hasVector: true } }] } },
        script: { lang: 'knn', source: 'knn_score', params: { field: 'embedding', query_value: vector, space_type: 'cosinesimil' } },
      },
    },
    _source: ['id', 'text', 'context', 'part', 'type', 'section', 'position', 'setId', 'version', 'effectiveTime', 'kind', 'source'],
  });
  assert.equal(value.strategy, 'vector');
  assert.deepEqual(ids(value.passages), [chunk(2).id, chunk(1).id]);
  // The score is the cosine, from the engine's (1 + cosine) / 2.
  assert.ok(Math.abs((value.passages[0]?.score ?? 0) - 0.9) < 1e-12);
  assert.deepEqual(value.passages[0]?.ranks, { keyword: null, vector: 1, fused: null, reranked: null });
  assert.ok(Math.abs((value.passages[1]?.scores.vector ?? 0) - 0.5) < 1e-12);
});

test('V12. fused: the order and scores the formula gives, ties by chunk id; ranks and scores; a passage in one list only', () => {
  // a: keyword 1, vector 3; b: keyword 2 only; c: vector 1 only; d: keyword 3, vector 2.
  const fused = fuse(['a', 'b', 'd'], ['c', 'd', 'a']);
  const expected = new Map([
    ['a', 1 / 61 + 1 / 63],
    ['b', 1 / 62],
    ['c', 1 / 61],
    ['d', 1 / 63 + 1 / 62],
  ]);
  for (const entry of fused) assert.equal(entry.score, expected.get(entry.id), entry.id);
  assert.deepEqual(fused.map((entry) => entry.id), ['a', 'd', 'c', 'b']);
  assert.deepEqual(fused.map((entry) => [entry.keywordRank, entry.vectorRank, entry.fusedRank]), [[1, 3, 1], [3, 2, 2], [null, 1, 3], [2, null, 4]]);
  // A tie (x only in the keyword list at 1, y only in the vector list at 1) is broken by chunk id.
  assert.deepEqual(fuse(['y'], ['x']).map((entry) => entry.id), ['x', 'y']);
});

test('V12. fused, through the service: both lists from the same index, each passage with its ranks and scores', async (t) => {
  const { search, run } = await rig(
    t,
    'fused',
    vectorEngine({ keyword: [chunk(1), chunk(2), chunk(4)], vector: [{ source: chunk(3), cosine: 0.8 }, { source: chunk(4), cosine: 0.6 }, { source: chunk(1), cosine: 0.4 }] }),
  );

  const value = ok(await run({ set_id: SET_ID, query: 'invented dose', max_results: 10 }));

  assert.equal(value.strategy, 'fused');
  assert.deepEqual(ids(value.passages), [chunk(1).id, chunk(4).id, chunk(3).id, chunk(2).id]);
  const first = value.passages[0];
  assert.deepEqual(first?.ranks, { keyword: 1, vector: 3, fused: 1, reranked: null });
  assert.equal(first?.score, 1 / 61 + 1 / 63);
  assert.equal(first?.scores.keyword, 10);
  assert.ok(Math.abs((first?.scores.vector ?? 0) - 0.4) < 1e-12);
  assert.equal(first?.scores.fused, 1 / 61 + 1 / 63);
  assert.deepEqual(value.passages[3]?.ranks, { keyword: 2, vector: null, fused: 4, reranked: null });
  assert.equal(value.passages[3]?.scores.vector, null);
  // Each leg asked for 50, against the concrete index.
  const legs = search.received.filter((r) => r.path === `/${CONCRETE}/_search`);
  assert.equal(legs.length, 2);
  assert.ok(legs.every((r) => (r.body as { size: number }).size === 50));
});

test('V13. fused_reranked: the best 20 fused texts and max_tokens_per_doc 7000; ordered by the reranker, ties by fused rank', async (t) => {
  // 25 keyword hits; the vector leg returns nothing. Passages 1 to 25 fuse in keyword order.
  const texts = (n: number): string => (n === 7 ? 'Invented dose of examplamab daily.' : n === 3 || n === 5 ? 'Invented dose.' : `Invented passage ${n}.`);
  const keyword = Array.from({ length: 25 }, (_, i) => chunk(i + 1, texts(i + 1)));
  const { model, run } = await rig(t, 'fused_reranked', vectorEngine({ keyword, vector: [] }));

  const value = ok(await run({ set_id: SET_ID, query: 'dose daily', max_results: 5 }));

  const sent = reranks(model);
  assert.equal(sent.length, 1);
  const body = sent[0]?.body as { model: string; query: string; documents: string[]; max_tokens_per_doc: number };
  assert.equal(body.model, 'test-reranker');
  assert.equal(body.query, 'dose daily');
  assert.equal(body.max_tokens_per_doc, RERANK_MAX_TOKENS_PER_DOC);
  assert.equal(RERANK_MAX_TOKENS_PER_DOC, 7000);
  // The same text the vectors are made from: the context line, a newline, the text.
  assert.deepEqual(body.documents, keyword.slice(0, 20).map((source) => `${String(source.context)}\n${String(source.text)}`));
  // 7 holds both words; 3 and 5 hold one each (a tie, kept in fused order); then the rest by fused rank.
  assert.equal(standInRelevance('dose daily', texts(3)), standInRelevance('dose daily', texts(5)));
  assert.deepEqual(ids(value.passages), [chunk(7).id, chunk(3).id, chunk(5).id, chunk(1).id, chunk(2).id]);
  assert.deepEqual(value.passages[0]?.ranks, { keyword: 7, vector: null, fused: 7, reranked: 1 });
  assert.equal(value.passages[0]?.score, 1);
  assert.equal(value.passages[0]?.scores.reranked, 1);
  assert.equal(value.strategy, 'fused_reranked');
});

test('V13. as the service wires it: from its settings, each request reaches its own server with the key, within its own time limit', async (t) => {
  const embedServer = await startModelStandIn(t, { dimensions: DIMENSIONS, models: ['test-embedding'] });
  const rerankServer = await startModelStandIn(t, { models: ['test-reranker'] });
  const search = await startSearchStandIn(t);
  search.answer(vectorEngine({ keyword: [chunk(1, 'Invented dose.'), chunk(2)], vector: [{ source: chunk(2), cosine: 0.7 }] }));
  const settings = retrievalSettingsFrom({
    SEARCH_URL: 'http://search:9200',
    SEARCH_INDEX: 'labels',
    SEARCH_STRATEGY: 'fused_reranked',
    AUTH_DISCOVERY_URL: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
    AUTH_ISSUER: 'http://localhost:8090/realms/lab',
    AUTH_ALLOWED_AUDIENCE: 'lab-knowledge',
    AUTH_ALLOWED_CLIENTS: 'desk',
    AUTH_ROLES_CLAIM: 'roles',
    MODEL_EMBED_BASE_URL: embedServer.baseUrl,
    MODEL_RERANK_BASE_URL: rerankServer.baseUrl,
    MODEL_API_KEY: TEST_KEY,
    EMBED_MODEL_ID: 'test-embedding',
    RERANK_MODEL_ID: 'test-reranker',
    EMBED_MODEL_REPO: IDENTITY.repository,
    EMBED_MODEL_REVISION: IDENTITY.revision,
    EMBED_DIMENSIONS: String(DIMENSIONS),
  });
  const retriever = retrieverFrom(settings, globalThis.fetch);

  const value = ok(await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'invented dose' }, retriever));

  assert.equal(value.strategy, 'fused_reranked');
  assert.deepEqual(embedServer.received.map((r) => [r.path, r.authorization]), [['/v1/embeddings', `Bearer ${TEST_KEY}`]]);
  assert.deepEqual(rerankServer.received.map((r) => [r.path, r.authorization]), [['/v1/rerank', `Bearer ${TEST_KEY}`]]);
  assert.equal(EMBEDDING_REQUEST_MS, 3000);
  assert.equal(RERANK_REQUEST_MS, 5000);
  assert.equal(SEARCH_LIMIT_MS, 8000);
  assert.equal(retriever.limit.ms, 8000);
});

for (const [name, identity, error] of [
  ['an index built without vectors', null, 'vectors_not_built'],
  ['another revision', { ...IDENTITY, revision: 'f'.repeat(40) }, 'vectors_do_not_match'],
  ['other dimensions', { ...IDENTITY, dimensions: 1024 }, 'vectors_do_not_match'],
  ['another recipe', { ...IDENTITY, recipe: 'text-only/1' }, 'vectors_do_not_match'],
  ['another instruction', { ...IDENTITY, instruction: 'Find passages.' }, 'vectors_do_not_match'],
] as const) {
  test(`V14. ${name}: ${error}, and the embedding server is not called`, async (t) => {
    for (const strategy of ['vector', 'fused', 'fused_reranked'] as const) {
      const { search, model, run } = await rig(t, strategy, vectorEngine({ identity, keyword: [chunk(1)], vector: [{ source: chunk(1), cosine: 0.5 }] }));
      const outcome = await run();
      assert.equal(outcome.ok ? 'ok' : outcome.error.error, error, strategy);
      assert.equal(embeddings(model).length, 0, strategy);
      assert.equal(search.received.filter((r) => r.path.endsWith('/_search')).length, 0, strategy);
    }
  });
}

const failures: { name: string; server: 'embeddings' | 'rerank'; reply: 'drop' | 'hold' | { status: number }; error: string }[] = [
  { name: 'the embedding server unreachable', server: 'embeddings', reply: 'drop', error: 'embedding_unreachable' },
  { name: 'the embedding server timed out', server: 'embeddings', reply: 'hold', error: 'embedding_timed_out' },
  { name: 'the embedding server answering 500', server: 'embeddings', reply: { status: 500 }, error: 'embedding_error' },
  { name: 'the reranker unreachable', server: 'rerank', reply: 'drop', error: 'rerank_unreachable' },
  { name: 'the reranker timed out', server: 'rerank', reply: 'hold', error: 'rerank_timed_out' },
  { name: 'the reranker answering 500', server: 'rerank', reply: { status: 500 }, error: 'rerank_error' },
];

for (const row of failures) {
  test(`V15. ${row.name}: ${row.error}, and no passages`, async (t) => {
    const strategies: Strategy[] = row.server === 'embeddings' ? ['vector', 'fused', 'fused_reranked'] : ['fused_reranked'];
    for (const strategy of strategies) {
      const { model, run } = await rig(t, strategy, vectorEngine({ keyword: [chunk(1)], vector: [{ source: chunk(1), cosine: 0.5 }] }));
      model.queue(row.server === 'embeddings' ? '/v1/embeddings' : '/v1/rerank', row.reply);
      const outcome = await run();
      assert.equal(outcome.ok ? 'ok' : outcome.error.error, row.error, strategy);
      assert.equal('value' in outcome, false);
    }
  });
}

test('V15. a reranker answer that leaves out a passage is rerank_error', async (t) => {
  const { model, run } = await rig(t, 'fused_reranked', vectorEngine({ keyword: [chunk(1), chunk(2)], vector: [] }));
  model.queue('/v1/rerank', { status: 200, body: { results: [{ index: 0, relevance_score: 0.5 }] } });
  const outcome = await run();
  assert.equal(outcome.ok ? 'ok' : outcome.error.error, 'rerank_error');
});

test('V16. keyword: neither model server is called; the result says keyword, with keyword ranks', async (t) => {
  const search: SearchStandIn = await startSearchStandIn(t);
  search.answer(vectorEngine({ keyword: [chunk(1), chunk(2)] }));
  const model = await startModelStandIn(t);
  // Built from the settings as the service builds it: keyword gets no model client at all.
  const retriever = retrieverFrom({ strategy: 'keyword', models: null }, globalThis.fetch);

  const value = ok(await searchLabel(testEngine(search.url).engine, 'labels', { set_id: SET_ID, query: 'invented dose' }, retriever));

  assert.equal(value.strategy, 'keyword');
  assert.deepEqual(value.passages.map((passage) => passage.ranks), [
    { keyword: 1, vector: null, fused: null, reranked: null },
    { keyword: 2, vector: null, fused: null, reranked: null },
  ]);
  assert.equal(model.received.length, 0);
  // Keyword searches the alias itself, with no request for the mapping.
  assert.deepEqual(search.received.map((r) => r.path), ['/labels/_search']);
});
