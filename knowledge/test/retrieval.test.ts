// The retrieval service's invariants ("Always true" 32 to 36, 38 and 39 in docs/architecture/knowledge.md), one test
// each. The tools are called as functions with an engine and a model client as in-memory objects; the engine
// interprets nothing, so a test that relies on a query asserts the request that was sent. The HTTP server is started
// once for the file, with its token check as a function.

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createEngine } from '../src/search/engine.ts';
import { createRetrievalServer } from '../src/search/http.ts';
import { retrieverFrom } from '../src/search/retriever.ts';
import { STRATEGIES, retrievalSettingsFrom } from '../src/search/settings.ts';
import type { Strategy } from '../src/search/settings.ts';
import { findLabels, searchLabel } from '../src/search/tools.ts';
import type { Outcome, Retriever } from '../src/search/tools.ts';
import type { ModelClient } from '../src/vectors/model-client.ts';
import { DOCUMENT_RECIPE, QUERY_INSTRUCTION, encodeVector } from '../src/vectors/recipe.ts';
import {
  DIMENSIONS,
  GOOD_TOKEN,
  chunked,
  cli,
  folders,
  guid,
  hits,
  hitsBody,
  indexed,
  json,
  label,
  ok,
  recorder,
  scriptedEngine,
  scriptedModels,
  tokenCheck,
} from './support.ts';
import type { Answer, EngineRequest } from './support.ts';

const SET = guid(1);
const CONCRETE = 'labels-0123456789abcdef';
const LIMIT = { ms: 8_000, now: () => 0 };
const IDENTITY = { repository: 'example/embed', revision: 'r1', dimensions: DIMENSIONS, recipe: DOCUMENT_RECIPE, instruction: QUERY_INSTRUCTION, vectorsSha256: 'f'.repeat(64) };

const shared = scriptedEngine(() => hits(indexed(SET, 1)));
let server: Server;
let port = 0;
before(async () => {
  server = createRetrievalServer(shared.engine, 'labels', tokenCheck);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// A request sent as written: fetch would normalise a target such as //.
function raw(path: string, options: { method?: string; token?: string; body?: string } = {}): Promise<number> {
  const headers: Record<string, string | number> = options.token === undefined ? {} : { authorization: `Bearer ${options.token}` };
  if (options.body !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(options.body) });
  return new Promise((resolve, reject) => {
    const sent = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end(options.body);
  });
}

const code = (outcome: Outcome<unknown>): string => (outcome.ok ? 'ok' : outcome.error.error);

function retriever(strategy: Strategy, models: ModelClient, revision = 'r1'): Retriever {
  const embedding = strategy === 'keyword' ? null : { client: models, modelId: 'embed-model', identity: { repository: 'example/embed', revision, dimensions: DIMENSIONS } };
  return { strategy, embedding, rerank: { client: models, modelId: 'rerank-model' }, verdicts: new Map(), limit: LIMIT };
}

// An engine whose alias points at one index recording the given embedding identity.
const vectorEngine = (embedding: unknown = IDENTITY, search: (request: EngineRequest) => ReturnType<typeof hits> = () => hits(indexed(SET, 1), indexed(SET, 2))) =>
  scriptedEngine((request) => (request.method === 'GET' ? ok({ [CONCRETE]: { mappings: { _meta: { embedding } } } }) : search(request)));

test('knowledge 32. every request but GET /ping needs a valid token, judged before anything else of the request: the target, then the body', async () => {
  const sentBefore = shared.sent.length;
  assert.equal(await raw('/ping'), 200, 'GET /ping with no token');
  const rows: { name: string; path: string; method?: string; body?: string; valid?: number }[] = [
    { name: 'no token', path: '/mcp', method: 'POST', body: '{}' },
    { name: 'a path that does not exist', path: '/nowhere', valid: 404 },
    { name: 'a target that is not a path', path: '//[not-a-host', valid: 400 },
    { name: 'a body that is not JSON', path: '/mcp', method: 'POST', body: 'not json', valid: 400 },
    { name: 'POST /ping', path: '/ping', method: 'POST', body: '{}', valid: 404 },
  ];
  for (const row of rows) {
    const request = { ...(row.method === undefined ? {} : { method: row.method }), ...(row.body === undefined ? {} : { body: row.body }) };
    assert.equal(await raw(row.path, row.valid === undefined ? request : { ...request, token: 'forged' }), 401, `${row.name}: refused token`);
    if (row.valid !== undefined) assert.equal(await raw(row.path, { ...request, token: GOOD_TOKEN }), row.valid, `${row.name}: valid token`);
  }
  assert.equal(shared.sent.length, sentBefore, 'a refused request reached the engine');
});

test('knowledge 33. search_label searches one label: the set id is an exact filter set in code, the query only a full-text match; input outside the limits is refused before anything is sent', async () => {
  const { engine, sent } = scriptedEngine(() => hits());
  const rows: [string, () => Promise<Outcome<unknown>>][] = [
    ['a query over 1,000 characters', () => searchLabel(engine, 'labels', { set_id: SET, query: 'q'.repeat(1001) })],
    ['a drug name over 200 characters', () => findLabels(engine, 'labels', { drug: 'd'.repeat(201) }, LIMIT)],
    ['max_results 0', () => searchLabel(engine, 'labels', { set_id: SET, query: 'dose', max_results: 0 })],
    ['max_results 11', () => searchLabel(engine, 'labels', { set_id: SET, query: 'dose', max_results: 11 })],
    ['max_results 2.5', () => searchLabel(engine, 'labels', { set_id: SET, query: 'dose', max_results: 2.5 })],
    ['an unknown part', () => searchLabel(engine, 'labels', { set_id: SET, query: 'dose', part: 'appendix' })],
    ['a set id not a lowercase GUID', () => searchLabel(engine, 'labels', { set_id: guid(171).toUpperCase(), query: 'dose' })],
  ];
  for (const [name, call] of rows) assert.equal(code(await call()), 'invalid_input', name);
  assert.equal(sent.length, 0, 'a refused input was sent');

  const words = 'setId:other* OR {"term": {"setId": "x"}}';
  const searched = scriptedEngine(() => hits(indexed(SET, 1)));
  assert.equal(code(await searchLabel(searched.engine, 'labels', { set_id: SET, query: words })), 'ok');
  const body = searched.sent[0]?.body as { query: { bool: { filter: unknown; must: { multi_match: { query: string } }[] } } };
  assert.deepEqual(body.query.bool.filter, [{ term: { setId: SET } }]);
  assert.equal(body.query.bool.must[0]?.multi_match.query, words);
  assert.equal(JSON.stringify(body).split(JSON.stringify(words).slice(1, -1)).length, 2, 'the query is somewhere else too');
  const stray = scriptedEngine(() => hits(indexed(SET, 1), indexed(guid(2), 2)));
  assert.equal(code(await searchLabel(stray.engine, 'labels', { set_id: SET, query: 'dose' })), 'search_unexpected_answer', 'a passage of another label');
  assert.equal(await raw('/mcp', { method: 'POST', token: GOOD_TOKEN, body: JSON.stringify({ pad: 'x'.repeat(100_001) }) }), 400, 'a body over 100 kB');
});

test('knowledge 34. the strategy is the service\'s: no argument names it, every strategy searches under the same filters, a failure is an error never another strategy, and vectors come only from a matching index, which both legs search', async () => {
  const terms = (body: unknown): string[] => {
    const out: string[] = [];
    JSON.stringify(body, (key, value: unknown) => (key === 'term' && out.push(JSON.stringify(value)), value));
    return out;
  };
  for (const strategy of STRATEGIES) {
    const { engine, sent } = vectorEngine();
    const result = await searchLabel(engine, 'labels', { set_id: SET, query: 'dose', part: 'highlights' }, retriever(strategy, scriptedModels().models));
    assert.equal(result.ok && result.value.strategy, strategy);
    const searches = sent.filter((request) => request.path.endsWith('/_search'));
    assert.ok(searches.length > 0, strategy);
    for (const search of searches) {
      assert.deepEqual([JSON.stringify({ setId: SET }), JSON.stringify({ part: 'highlights' })].filter((term) => !terms(search.body).includes(term)), [], `${strategy}: a filter missing`);
      if (strategy !== 'keyword') assert.equal(search.path, `/${CONCRETE}/_search`, `${strategy}: not the index the alias points at`);
    }
  }

  const failures: { name: string; embedding?: unknown; revision?: string; models?: Parameters<typeof scriptedModels>[0]; search?: (request: EngineRequest) => ReturnType<typeof hits>; error: string; modelCalls?: number }[] = [
    { name: 'an index without vectors', embedding: null, error: 'vectors_not_built', modelCalls: 0 },
    { name: 'vectors of another revision', revision: 'r2', error: 'vectors_do_not_match', modelCalls: 0 },
    { name: 'the embedding server not reached', models: { embed: () => ({ kind: 'unreachable' }) }, error: 'embedding_unreachable' },
    { name: 'the reranker failing', models: { rerank: () => ({ kind: 'status', status: 500 }) }, error: 'rerank_error' },
    { name: 'the keyword leg failing', search: (request) => (JSON.stringify(request.body).includes('multi_match') ? ok({}, 500) : hits(indexed(SET, 1))), error: 'search_error' },
  ];
  for (const row of failures) {
    const { engine } = vectorEngine(row.embedding === undefined ? IDENTITY : row.embedding, row.search);
    const { models, calls } = scriptedModels(row.models);
    const result = await searchLabel(engine, 'labels', { set_id: SET, query: 'dose' }, retriever('fused_reranked', models, row.revision));
    assert.equal(code(result), row.error, row.name);
    if (row.modelCalls !== undefined) assert.equal(calls.length, row.modelCalls, `${row.name}: the embedding server was called`);
  }

  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${GOOD_TOKEN}` } } }));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).includes('strategy')]).sort(), [['find_labels', false], ['search_label', false]]);
    const called = await client.callTool({ name: 'search_label', arguments: { set_id: SET, query: 'dose', strategy: 'vector' } });
    const [item] = called.content as unknown as { text: string }[];
    assert.equal((JSON.parse(item?.text ?? '{}') as { strategy: string }).strategy, 'keyword');
  } finally {
    await client.close();
  }
});

test('knowledge 35. the model servers\' key is sent to the two model servers only, and appears in no result, error or output line', async (t) => {
  const KEY = 'model-key-never-to-be-repeated';
  const models = (fault: string): Answer => (sent) => {
    const url = new URL(sent.url);
    const body = (sent.body === '' ? {} : JSON.parse(sent.body)) as { input?: string[]; documents?: string[] };
    if (url.host === 'search.test') return json(url.pathname.endsWith('/_mapping') ? { [CONCRETE]: { mappings: { _meta: { embedding: IDENTITY } } } } : hitsBody(indexed(SET, 1)));
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'embed-model' }] });
    if (url.pathname === '/v1/embeddings') return fault === 'embed' ? json({ error: { message: `refused for ${KEY}` } }, 401) : json({ data: (body.input ?? []).map((_, index) => ({ index, embedding: encodeVector([1, 0, 0, 0]) })) });
    if (url.pathname === '/v1/rerank') return fault === 'rerank' ? json({ detail: KEY }, 500) : json({ results: (body.documents ?? []).map((_, index) => ({ index, relevance_score: index })) });
    return new Response('', { status: 404 });
  };
  const toModels = (sent: { url: string }): boolean => /^http:\/\/(embed|rerank)\.test\/v1\//.test(sent.url);
  const settings = retrievalSettingsFrom({
    SEARCH_URL: 'http://search.test', SEARCH_INDEX: 'labels', SEARCH_STRATEGY: 'fused_reranked', AUTH_DISCOVERY_URL: 'http://identity.test/discovery', AUTH_ISSUER: 'http://identity.test',
    AUTH_ALLOWED_AUDIENCE: 'lab-knowledge', AUTH_ALLOWED_CLIENTS: 'desk', AUTH_REQUIRED_SCOPES: 'labels:search', AUTH_ROLES_CLAIM: 'roles', MODEL_EMBED_BASE_URL: 'http://embed.test/v1', EMBED_MODEL_ID: 'embed-model',
    MODEL_API_KEY: KEY, EMBED_MODEL_REPO: 'example/embed', EMBED_MODEL_REVISION: 'r1', EMBED_DIMENSIONS: String(DIMENSIONS), MODEL_RERANK_BASE_URL: 'http://rerank.test/v1', RERANK_MODEL_ID: 'rerank-model',
  });
  for (const [fault, expected] of [['none', 'ok'], ['embed', 'embedding_error'], ['rerank', 'rerank_error']] as const) {
    const web = recorder(models(fault));
    const engine = createEngine({ baseUrl: settings.searchUrl, fetch: web.fetch, deadline: () => new AbortController().signal });
    const result = await searchLabel(engine, settings.searchIndex, { set_id: SET, query: 'dose' }, retrieverFrom(settings, web.fetch, LIMIT));
    assert.equal(code(result), expected, fault);
    assert.equal(JSON.stringify(result).includes(KEY), false, `${fault}: the key is in the result`);
    const carrying = web.sent.filter((sent) => JSON.stringify(sent).includes(KEY));
    assert.ok(carrying.length > 0 && carrying.every(toModels), `${fault}: the key went elsewhere`);
  }

  const where = await folders(t);
  await chunked(where, [label(1)]);
  const env = { MODEL_EMBED_BASE_URL: 'http://embed.test/v1', MODEL_API_KEY: KEY, EMBED_MODEL_ID: 'embed-model', EMBED_MODEL_REPO: 'example/embed', EMBED_MODEL_REVISION: 'r1', EMBED_DIMENSIONS: String(DIMENSIONS) };
  for (const [fault, exit] of [['none', 0], ['embed', 1]] as const) {
    const web = recorder(models(fault));
    const run = await cli(['embed', '--data', where.dataDir, '--batch-size', '32', '--attempts', '1', '--waits-ms', '0', '--timeout-ms', '5000'], web.fetch, env);
    assert.equal(run.code, exit, `embed, ${fault}`);
    assert.equal([...run.out, ...run.err].some((line) => line.includes(KEY)), false, `embed, ${fault}: the key is in the output`);
    assert.ok(web.sent.every(toModels), `embed, ${fault}: a request went elsewhere`);
  }
});

test('knowledge 36. an engine answer is read as a result only when it is whole', async () => {
  const rows: { name: string; search: ReturnType<typeof hits>; count?: ReturnType<typeof hits>; error: string }[] = [
    { name: 'it says it timed out', search: ok({ timed_out: true, hits: { hits: [] } }), error: 'search_timed_out' },
    { name: 'a shard failed', search: ok({ _shards: { failed: 1 }, hits: { hits: [{ _score: 1, _source: indexed(SET, 1) }] } }), error: 'search_error' },
    { name: 'a version of 0', search: hits(indexed(SET, 1, { version: '0' })), error: 'search_unexpected_answer' },
    { name: 'a version of 1.5', search: hits(indexed(SET, 1, { version: 1.5 })), error: 'search_unexpected_answer' },
    { name: 'a count that says it timed out', search: hits(), count: ok({ count: 3, timed_out: true }), error: 'search_timed_out' },
  ];
  for (const row of rows) {
    const { engine } = scriptedEngine((request) => (request.path.endsWith('/_count') ? (row.count ?? ok({ count: 1 })) : row.search));
    assert.equal(code(await searchLabel(engine, 'labels', { set_id: SET, query: 'dose' })), row.error, row.name);
  }
});

test('knowledge 38. no failure of the engine reads as an empty answer: each is an error naming its kind, and a set id with no documents is label_not_found', async () => {
  const rows: { name: string; search: ReturnType<typeof hits>; count?: ReturnType<typeof hits>; find?: boolean; error: string }[] = [
    { name: 'no answer in time', search: { kind: 'timeout' }, error: 'search_timed_out' },
    { name: 'not reached', search: { kind: 'unreachable' }, error: 'search_unreachable' },
    { name: 'an error status', search: ok({}, 500), error: 'search_error' },
    { name: 'no such index', search: ok({ error: { type: 'index_not_found_exception' } }, 404), error: 'index_not_built' },
    { name: 'an answer of another form', search: ok({ took: 1 }), error: 'search_unexpected_answer' },
    { name: 'no documents for the set id', search: hits(), count: ok({ count: 0 }), error: 'label_not_found' },
    { name: 'the count failing', search: hits(), count: ok({}, 503), error: 'search_error' },
    { name: 'find_labels, an error status', search: ok({}, 500), find: true, error: 'search_error' },
  ];
  for (const row of rows) {
    const { engine } = scriptedEngine((request) => (request.path.endsWith('/_count') ? (row.count ?? ok({ count: 1 })) : row.search));
    const outcome = row.find === true ? await findLabels(engine, 'labels', { drug: 'Examplamab' }, LIMIT) : await searchLabel(engine, 'labels', { set_id: SET, query: 'dose' });
    assert.equal(code(outcome), row.error, row.name);
  }
});

test('knowledge 39. the retrieval service reaches the engine with fetch and its REST API, and every request has a time limit: one that gets no answer ends as a timeout', async () => {
  const deadline = new AbortController();
  const web = recorder((_sent, signal) =>
    signal === undefined ? Promise.reject(new Error('sent with no time limit')) : new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error))),
  );
  const engine = createEngine({ baseUrl: 'http://search.test', fetch: web.fetch, deadline: () => deadline.signal });
  const pending = engine.send('POST', '/labels/_search', { query: { match_all: {} } });
  deadline.abort();
  assert.deepEqual(await pending, { kind: 'timeout' });
  assert.deepEqual(web.sent.map((sent) => [sent.method, sent.url]), [['POST', 'http://search.test/labels/_search']]);
});
