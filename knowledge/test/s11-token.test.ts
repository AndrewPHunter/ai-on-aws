// S11. The token check on the server: no token is 401 with the header and reason missing; a token whose audience
// lacks lab-knowledge is 401 wrong_audience; with the provider down it is 503; /ping needs no token; and with no
// token and a body that is not JSON the answer is 401, not 400.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { createRetrievalServer } from '../src/search/http.ts';
import { listen, startTokens, testEngine } from './support/retrieval.ts';
import type { Tokens } from './support/retrieval.ts';
import { hits, startSearchStandIn } from './support/search-standin.ts';

async function rig(t: TestContext): Promise<{ url: string; tokens: Tokens; searched: () => number }> {
  const standIn = await startSearchStandIn(t);
  standIn.answer(() => hits([]));
  const tokens = await startTokens(t);
  const server = createRetrievalServer(testEngine(standIn.url).engine, 'labels', tokens.check);
  return { url: await listen(server, t), tokens, searched: () => standIn.received.length };
}

const MCP_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

test('S11. no token: 401, the header, reason missing; a body that is not JSON changes nothing', async (t) => {
  const { url, searched } = await rig(t);
  for (const body of [MCP_LIST, 'this is not json {']) {
    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: mcpHeaders, body });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.error, 'unauthorized');
    assert.equal(payload.reason, 'missing');
    assert.equal(typeof payload.detail, 'string');
  }
  assert.equal(searched(), 0);
});

test('S11. a token whose audience lacks lab-knowledge: 401 wrong_audience', async (t) => {
  const { url, tokens } = await rig(t);
  const token = await tokens.mint({ claims: { aud: ['lab-agents', 'lab-case-system'] } });
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...mcpHeaders, authorization: `Bearer ${token}` }, body: MCP_LIST });
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as Record<string, unknown>).reason, 'wrong_audience');
});

test('S11. the provider down: 503', async (t) => {
  const { url, tokens } = await rig(t);
  const token = await tokens.mint();
  tokens.issuer.misbehave('no_answer');
  const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...mcpHeaders, authorization: `Bearer ${token}` }, body: MCP_LIST });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as Record<string, unknown>).error, 'identity_unavailable');
});

test('S11. /ping needs no token', async (t) => {
  const { url } = await rig(t);
  const response = await fetch(`${url}/ping`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'Healthy' });
});
