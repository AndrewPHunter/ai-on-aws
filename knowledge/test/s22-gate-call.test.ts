// S22 (D8). The gate's call to the retrieval service: a thrown error (the service down, a refused token, the network)
// is "could not run", never a result a statement can read as a refusal. A refusal counts only when it is the
// service's own invalid_input result: max_results 11 over MCP is one; the protocol layer's own words are not.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { CouldNotRun } from '../src/gate/data.ts';
import { call, refusedByService } from '../src/gate/service.ts';
import { createRetrievalServer } from '../src/search/http.ts';
import { SET_ID, listen, startTokens, testEngine } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

test('S22. a call that throws is "could not run"', async () => {
  for (const thrown of [new Error('fetch failed'), new Error('Streamable HTTP error: 401'), new TypeError('network')]) {
    const client = { callTool: () => Promise.reject(thrown) };
    await assert.rejects(call(client, 'search_label', { set_id: SET_ID, query: 'dose', max_results: 11 }), (error: unknown) => error instanceof CouldNotRun);
  }
});

test("S22. only the service's own invalid_input is a refusal", () => {
  assert.equal(refusedByService({ isError: true, payload: { error: 'invalid_input', detail: 'x' } }), true);
  assert.equal(refusedByService({ isError: true, payload: { error: 'search_error', detail: 'x' } }), false);
  assert.equal(refusedByService({ isError: true, payload: { unparsed: true } }), false);
  assert.equal(refusedByService({ isError: false, payload: { error: 'invalid_input' } }), false);
});

test('S22. max_results 11, over MCP to the service, is the service\'s own refusal', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([]));
  const tokens = await startTokens(t);
  const url = await listen(createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check), t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokens.mint()}` } } }));
  t.after(() => client.close());

  const reply = await call(client, 'search_label', { set_id: SET_ID, query: 'dose', max_results: 11 });

  assert.equal(refusedByService(reply), true, JSON.stringify(reply));
  assert.equal(standIn.received.length, 0);
});

test('S22. the service stopped: the call is "could not run"', async (t) => {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([]));
  const tokens = await startTokens(t);
  const server = createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check);
  const url = await listen(server, t);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${await tokens.mint()}` } } }));
  t.after(() => client.close());
  server.close();
  server.closeAllConnections();

  await assert.rejects(call(client, 'search_label', { set_id: SET_ID, query: 'dose', max_results: 11 }), (error: unknown) => error instanceof CouldNotRun);
});
