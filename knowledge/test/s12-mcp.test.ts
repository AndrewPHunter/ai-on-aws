// S12. With a valid token, an MCP client lists exactly the two tools, and a call to each reaches the stand-in engine
// and returns its result.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createRetrievalServer } from '../src/search/http.ts';
import { SET_ID, indexedChunk, listen, startTokens, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content: unknown = result.content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined;
  return JSON.parse(typeof text === 'string' ? text : '{}') as Record<string, unknown>;
}

test('S12. two tools, each reaching the engine', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([indexedChunk(1)]));
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check), t);

  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokens.mint()}` } } }));
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['find_labels', 'search_label']);

  const found = await client.callTool({ name: 'find_labels', arguments: { drug: 'Examplamab' } });
  assert.equal(found.isError, false);
  assert.deepEqual((payloadOf(found).labels as { set_id: string }[]).map((label) => label.set_id), [SET_ID]);

  const searched = await client.callTool({ name: 'search_label', arguments: { set_id: SET_ID, query: 'invented', max_results: 2 } });
  assert.equal(searched.isError, false);
  assert.deepEqual((payloadOf(searched).passages as { chunk_id: string }[]).map((p) => p.chunk_id), [`${SET_ID}/3/sec-1/body/1`]);

  assert.deepEqual(standIn.received.map((r) => r.path), ['/labels/_search', '/labels/_search']);
});
