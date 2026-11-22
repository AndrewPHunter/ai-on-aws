// S25 (T4, D8). Over MCP, a failure reaches the client as a result with isError true and the { error, detail }
// payload: an engine failure, a set id not in the index, and arguments outside what the service accepts
// (max_results 0 and 11, an unknown part, a query too long). Those arguments are refused by the service's own check,
// in the same shape, not by the protocol layer in its own words.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createRetrievalServer } from '../src/search/http.ts';
import { SET_ID, listen, startTokens, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';
import type { SearchReply, SearchRequest } from './support/search-standin.ts';

async function connected(t: TestContext, answer: (request: SearchRequest) => SearchReply): Promise<{ client: Client; sent: () => number }> {
  const standIn = await startSearchStandIn(t);
  standIn.answer(answer);
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check), t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokens.mint()}` } } }));
  t.after(() => client.close());
  return { client, sent: () => standIn.received.length };
}

function errorOf(result: Awaited<ReturnType<Client['callTool']>>): { isError: boolean; payload: unknown } {
  const content: unknown = result.content;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'text') : undefined;
  let payload: unknown;
  try {
    payload = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { isError: result.isError === true, payload };
}

function assertShape(result: { isError: boolean; payload: unknown }, error: string, what: string): void {
  assert.equal(result.isError, true, what);
  assert.equal(typeof result.payload, 'object', `${what}: ${JSON.stringify(result.payload)}`);
  const payload = result.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ['detail', 'error'], what);
  assert.equal(payload.error, error, what);
  assert.equal(typeof payload.detail, 'string', what);
}

test('S25. an engine failure and an unknown set id reach the client as isError with { error, detail }', async (t) => {
  const failing = await connected(t, () => ({ status: 500, body: { error: 'internal' } }));
  assertShape(errorOf(await failing.client.callTool({ name: 'find_labels', arguments: { drug: 'Examplamab' } })), 'search_error', 'find_labels, engine 500');
  assertShape(errorOf(await failing.client.callTool({ name: 'search_label', arguments: { set_id: SET_ID, query: 'dose' } })), 'search_error', 'search_label, engine 500');

  const empty = await connected(t, (request) => (request.path.endsWith('/_count') ? { status: 200, body: { count: 0 } } : hits([])));
  assertShape(errorOf(await empty.client.callTool({ name: 'search_label', arguments: { set_id: SET_ID, query: 'dose' } })), 'label_not_found', 'unknown set id');
});

test("S25. arguments outside what the service accepts are refused by the service's own check, as invalid_input", async (t) => {
  const { client, sent } = await connected(t, () => hits([]));
  const rows: { name: string; args: Record<string, unknown> }[] = [
    { name: 'max_results 0', args: { set_id: SET_ID, query: 'dose', max_results: 0 } },
    { name: 'max_results 11', args: { set_id: SET_ID, query: 'dose', max_results: 11 } },
    { name: 'max_results 2.5', args: { set_id: SET_ID, query: 'dose', max_results: 2.5 } },
    { name: 'an unknown part', args: { set_id: SET_ID, query: 'dose', part: 'appendix' } },
    { name: 'a query of 1,001 characters', args: { set_id: SET_ID, query: 'a'.repeat(1001) } },
    { name: 'a set id that is not a GUID', args: { set_id: 'not-a-guid', query: 'dose' } },
  ];
  for (const row of rows) {
    assertShape(errorOf(await client.callTool({ name: 'search_label', arguments: row.args })), 'invalid_input', row.name);
  }
  assertShape(errorOf(await client.callTool({ name: 'find_labels', arguments: { drug: 'a'.repeat(201) } })), 'invalid_input', 'a drug name of 201 characters');
  assert.equal(sent(), 0);
});
