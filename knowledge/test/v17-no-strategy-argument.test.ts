// V17, V18. Over MCP, search_label has no parameter that names a strategy, and an argument named strategy changes
// nothing. The key appears in no result, no error, no log line, and no request to the search engine.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createRetrievalServer } from '../src/search/http.ts';
import { searchLabel } from '../src/search/tools.ts';
import { command } from './support/command.ts';
import { writeChunks } from './support/fake-engine.ts';
import { folders } from './support/fixture.ts';
import { startModelStandIn } from './support/model-standin.ts';
import { SET_ID, indexedChunk, listen, startTokens, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';
import { DIMENSIONS, TEST_KEY, embedArgs, embedEnv, testRetriever, vectorEngine } from './support/vectors.ts';

test('V17. search_label has no strategy parameter, and an argument named strategy changes nothing', async (t) => {
  const search = await startSearchStandIn(t);
  search.answer(() => hits([indexedChunk(1)]));
  const model = await startModelStandIn(t);
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(testEngine(search.url).engine, 'labels', tokens.check), t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokens.mint()}` } } }));
  t.after(() => client.close());

  const listed = await client.listTools();
  const searchTool = listed.tools.find((tool) => tool.name === 'search_label');
  const properties = Object.keys((searchTool?.inputSchema.properties ?? {}) as object).sort();
  assert.deepEqual(properties, ['max_results', 'part', 'query', 'set_id']);
  assert.ok(!JSON.stringify(listed).includes('strategy'));

  const result = await client.callTool({ name: 'search_label', arguments: { set_id: SET_ID, query: 'dose', strategy: 'fused_reranked' } });
  const content = result.content as { text: string }[];
  const payload = JSON.parse(content[0]?.text ?? '{}') as { strategy: string };
  assert.equal(result.isError, false);
  assert.equal(payload.strategy, 'keyword');
  assert.equal(model.received.length, 0);
  assert.deepEqual(search.received.map((r) => r.path), ['/labels/_search']);
});

test('V18. the key is in no result, no error, no output line, and never sent to the search engine', async (t) => {
  // The embedding stage: its output, on success and on failure.
  const where = await folders(t);
  await writeChunks(where.dataDir, 3);
  const model = await startModelStandIn(t, { dimensions: DIMENSIONS });
  const done = await command(embedArgs(where.dataDir), embedEnv(model));
  model.queue('/v1/embeddings', { status: 500 }, { status: 500 }, { status: 500 });
  const failed = await command(embedArgs(where.dataDir), embedEnv(model));
  const unlisted = await command(embedArgs(where.dataDir), embedEnv(model, { EMBED_MODEL_ID: 'absent-model' }));
  for (const outcome of [done, failed, unlisted]) {
    assert.ok(![...outcome.out, ...outcome.err].join('\n').includes(TEST_KEY));
  }
  assert.deepEqual([done.code, failed.code, unlisted.code], [0, 1, 2]);

  // The service: a result and each failure, and what reached the engine.
  const search = await startSearchStandIn(t);
  search.answer(vectorEngine({ keyword: [indexedChunk(1)], vector: [{ source: indexedChunk(1), cosine: 0.5 }] }));
  const { retriever } = testRetriever('fused_reranked', model);
  const engine = testEngine(search.url).engine;
  const outcomes = [await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever)];
  model.queue('/v1/embeddings', { status: 401, body: { error: `invalid key ${TEST_KEY}` } });
  outcomes.push(await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever));
  model.queue('/v1/rerank', 'drop');
  outcomes.push(await searchLabel(engine, 'labels', { set_id: SET_ID, query: 'dose' }, retriever));
  assert.deepEqual(outcomes.map((outcome) => (outcome.ok ? 'ok' : outcome.error.error)), ['ok', 'embedding_error', 'rerank_unreachable']);
  for (const outcome of outcomes) assert.ok(!JSON.stringify(outcome).includes(TEST_KEY));
  assert.ok(search.received.every((r) => !JSON.stringify(r.headers).includes(TEST_KEY) && !r.raw.includes(TEST_KEY)));
  assert.ok(model.received.every((r) => r.authorization === `Bearer ${TEST_KEY}`));

  // The service over MCP with a vector strategy: nothing it logs carries the key, on an answer or a failure.
  const logged: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(engine, 'labels', tokens.check, retriever), t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokens.mint()}` } } }));
  t.after(() => client.close());
  const answered = await client.callTool({ name: 'search_label', arguments: { set_id: SET_ID, query: 'dose' } });
  model.queue('/v1/embeddings', { status: 500, body: { error: `key ${TEST_KEY} refused` } });
  const refused = await client.callTool({ name: 'search_label', arguments: { set_id: SET_ID, query: 'dose' } });
  assert.deepEqual([answered.isError, refused.isError], [false, true]);
  assert.ok(!JSON.stringify([answered, refused]).includes(TEST_KEY));
  assert.ok(!logged.join('\n').includes(TEST_KEY));
});
