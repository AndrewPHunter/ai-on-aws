// Drives the real servers over loopback with the MCP SDK's own client.

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { CONTEXT_HEADERS, RECEIPT_ALLOWANCE_MS, createAgentServer, createReviewServer } from '../src/http.ts';
import { TOOL_NAMES } from '../src/mcp.ts';
import { CaseStore } from '../src/store.ts';

type Running = { agentUrl: string; reviewUrl: string };

// What the agent server's clock reads throughout these tests.
const SERVER_TIME = new Date('2026-01-01T00:00:00Z');

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function start(t: TestContext): Promise<Running> {
  let seconds = 0;
  const store = new CaseStore(':memory:', () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)));
  const agent = createAgentServer(store, () => SERVER_TIME);
  const review = createReviewServer(store);
  t.after(() => {
    agent.close();
    review.close();
    agent.closeAllConnections();
    review.closeAllConnections();
    store.close();
  });
  return { agentUrl: await listen(agent), reviewUrl: await listen(review) };
}

const RIVERA = 'Dr A. Rivera, a.rivera@example.org';
const KATO = 'Dr M. Kato, m.kato@example.org';

function contextHeaders(messageId: string, sender = RIVERA): Record<string, string> {
  return {
    [CONTEXT_HEADERS.messageId]: messageId,
    [CONTEXT_HEADERS.receivedAt]: '2025-12-31T23:00:00Z',
    [CONTEXT_HEADERS.agentId]: 'intake-agent',
    [CONTEXT_HEADERS.sender]: encodeURIComponent(sender),
  };
}

async function connect(t: TestContext, agentUrl: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${agentUrl}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

type ToolReply = { isError: boolean; payload: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const result = await client.callTool({ name, arguments: args });
  const content: unknown = result.content;
  assert.ok(Array.isArray(content));
  const first: unknown = content[0];
  assert.ok(typeof first === 'object' && first !== null && 'text' in first);
  assert.ok(typeof first.text === 'string');
  const payload: unknown = JSON.parse(first.text);
  assert.ok(typeof payload === 'object' && payload !== null);
  return { isError: result.isError === true, payload: { ...payload } };
}

function caseIn(reply: ToolReply): Record<string, unknown> {
  const found = reply.payload['case'];
  assert.ok(typeof found === 'object' && found !== null);
  return { ...found };
}

const COMPLETE = {
  patient: 'JD, 54, male',
  reporter: 'Dr A. Rivera, a.rivera@example.org',
  suspect_drug: 'atorvastatin',
  event: 'severe muscle pain',
};

test('the model is offered exactly three tools, and none of them reviews a case', async (t) => {
  const { agentUrl } = await start(t);
  const client = await connect(t, agentUrl, {});
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  const createCase = tools.find((tool) => tool.name === 'create_case');
  assert.deepEqual(Object.keys(createCase?.inputSchema.properties ?? {}).sort(), [
    'event',
    'patient',
    'reporter',
    'suspect_drug',
  ]);
});

test('creating a case twice for one message gives one case, the second time as a replay', async (t) => {
  const { agentUrl, reviewUrl } = await start(t);
  const client = await connect(t, agentUrl, contextHeaders('m1'));

  const first = await call(client, 'create_case', COMPLETE);
  const second = await call(client, 'create_case', COMPLETE);

  assert.equal(first.isError, false);
  assert.equal(first.payload['outcome'], 'created');
  assert.equal(second.payload['outcome'], 'replayed');
  assert.equal(caseIn(second)['case_id'], caseIn(first)['case_id']);

  const listed: unknown = await (await fetch(`${reviewUrl}/cases`)).json();
  assert.ok(typeof listed === 'object' && listed !== null && 'cases' in listed && Array.isArray(listed.cases));
  assert.equal(listed.cases.length, 1);
});

test('a second create for the same message with different content is refused and names the case', async (t) => {
  const { agentUrl } = await start(t);
  const client = await connect(t, agentUrl, contextHeaders('m1'));

  await call(client, 'create_case', COMPLETE);
  const second = await call(client, 'create_case', { ...COMPLETE, event: 'reworded by the model' });

  assert.equal(second.isError, true);
  assert.equal(second.payload['error'], 'case_already_opened_for_this_message');
  assert.equal(caseIn(second)['case_id'], 'AE-000001');
});

test('find_case from this message answers "did my create go through?"', async (t) => {
  const { agentUrl } = await start(t);
  const first = await connect(t, agentUrl, contextHeaders('m1'));
  const other = await connect(t, agentUrl, contextHeaders('m2'));

  await call(first, 'create_case', COMPLETE);
  const mine = await call(first, 'find_case', { from_this_message: true });
  const theirs = await call(other, 'find_case', { from_this_message: true });
  const none = await call(first, 'find_case', {});

  assert.ok(Array.isArray(mine.payload['cases']));
  assert.equal(mine.payload['cases'].length, 1);
  assert.deepEqual(theirs.payload['cases'], []);
  assert.equal(none.isError, true);
  assert.equal(none.payload['error'], 'filter_required');
});

test('a follow-up from a later message completes an incomplete case', async (t) => {
  const { agentUrl } = await start(t);
  const first = await connect(t, agentUrl, contextHeaders('m1'));
  const later = await connect(t, agentUrl, contextHeaders('m2'));

  const created = await call(first, 'create_case', { suspect_drug: 'atorvastatin', event: 'rash' });
  assert.equal(caseIn(created)['status'], 'incomplete');

  const followed = await call(later, 'add_follow_up', {
    case_id: 'AE-000001',
    patient: 'JD, 54',
    reporter: 'Dr Rivera',
  });
  assert.equal(followed.payload['outcome'], 'recorded');
  assert.equal(caseIn(followed)['status'], 'awaiting_review');
  assert.equal(caseIn(followed)['version'], 2);
});

test('without the context headers a write is refused and nothing is recorded', async (t) => {
  const { agentUrl, reviewUrl } = await start(t);
  const client = await connect(t, agentUrl, {});

  const created = await call(client, 'create_case', COMPLETE);
  assert.equal(created.isError, true);
  assert.equal(created.payload['error'], 'call_context_missing');

  const listed: unknown = await (await fetch(`${reviewUrl}/cases`)).json();
  assert.deepEqual(listed, { cases: [], truncated: false });
});

test('context headers that are incomplete or not a time are refused with 400', async (t) => {
  const { agentUrl } = await start(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  const partial = await fetch(`${agentUrl}/mcp`, {
    method: 'POST',
    headers: { ...base, [CONTEXT_HEADERS.messageId]: 'm1' },
    body,
  });
  assert.equal(partial.status, 400);

  const badTime = await fetch(`${agentUrl}/mcp`, {
    method: 'POST',
    headers: { ...base, ...contextHeaders('m1'), [CONTEXT_HEADERS.receivedAt]: 'yesterday-ish' },
    body,
  });
  assert.equal(badTime.status, 400);
});

test('a request carrying the session headers AgentCore Runtime forwards is not rejected', async (t) => {
  const { agentUrl } = await start(t);
  const response = await fetch(`${agentUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': '3f1c2a9e-0000-4000-8000-000000000000',
      'x-amzn-bedrock-agentcore-runtime-session-id': 'a-session-identifier-of-thirty-three-chars',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 200);
});

test('a receipt time in the future is refused, apart from a small allowance for clocks that disagree', async (t) => {
  const { agentUrl, reviewUrl } = await start(t);
  const sendAt = (offsetMs: number): Promise<Response> =>
    fetch(`${agentUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...contextHeaders('m1'),
        [CONTEXT_HEADERS.receivedAt]: new Date(SERVER_TIME.getTime() + offsetMs).toISOString(),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_case', arguments: COMPLETE },
      }),
    });

  const tooLate = await sendAt(RECEIPT_ALLOWANCE_MS + 1000);
  assert.equal(tooLate.status, 400);
  const nothing: unknown = await (await fetch(`${reviewUrl}/cases`)).json();
  assert.deepEqual(nothing, { cases: [], truncated: false });

  const withinAllowance = await sendAt(RECEIPT_ALLOWANCE_MS - 1000);
  assert.equal(withinAllowance.status, 200);
});

test('a sender finds only their own cases and cannot add to another sender\'s case', async (t) => {
  const { agentUrl, reviewUrl } = await start(t);
  const rivera = await connect(t, agentUrl, contextHeaders('m1'));
  const kato = await connect(t, agentUrl, contextHeaders('m2', KATO));
  await call(rivera, 'create_case', COMPLETE);

  const own = await call(rivera, 'find_case', { suspect_drug: 'atorvastatin' });
  const others = await call(kato, 'find_case', { suspect_drug: 'atorvastatin' });
  const byId = await call(kato, 'find_case', { case_id: 'AE-000001' });
  assert.ok(Array.isArray(own.payload['cases']));
  assert.equal(own.payload['cases'].length, 1);
  assert.deepEqual(others.payload['cases'], []);
  assert.deepEqual(byId.payload['cases'], []);

  const added = await call(kato, 'add_follow_up', { case_id: 'AE-000001', event: 'something else' });
  const missing = await call(kato, 'add_follow_up', { case_id: 'AE-000099', event: 'something else' });
  assert.equal(added.isError, true);
  assert.equal(added.payload['error'], 'case_not_found');
  assert.equal(missing.payload['error'], 'case_not_found');

  const detail: unknown = await (await fetch(`${reviewUrl}/cases/AE-000001`)).json();
  assert.ok(typeof detail === 'object' && detail !== null && 'versions' in detail && Array.isArray(detail.versions));
  assert.equal(detail.versions.length, 1);
});

test('a lookup without the context headers is refused, because it is always on behalf of a sender', async (t) => {
  const { agentUrl } = await start(t);
  const withContext = await connect(t, agentUrl, contextHeaders('m1'));
  const without = await connect(t, agentUrl, {});
  await call(withContext, 'create_case', COMPLETE);

  const found = await call(without, 'find_case', { suspect_drug: 'atorvastatin' });
  assert.equal(found.isError, true);
  assert.equal(found.payload['error'], 'call_context_missing');
});

test('a sender header that is not percent-encoded text is refused with 400', async (t) => {
  const { agentUrl } = await start(t);
  const response = await fetch(`${agentUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...contextHeaders('m1'),
      [CONTEXT_HEADERS.sender]: '%E0%A4%A',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 400);
});

test('the agent server answers the health check and has no review route', async (t) => {
  const { agentUrl } = await start(t);

  const ping = await fetch(`${agentUrl}/ping`);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { status: 'Healthy' });

  const review = await fetch(`${agentUrl}/cases/AE-000001/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewer: 'r.okafor', decision: 'approve' }),
  });
  assert.equal(review.status, 404);
});

test('a named reviewer approves through the review server, and the decision is in the audit trail', async (t) => {
  const { agentUrl, reviewUrl } = await start(t);
  const client = await connect(t, agentUrl, contextHeaders('m1'));
  await call(client, 'create_case', COMPLETE);

  const post = (payload: unknown): Promise<Response> =>
    fetch(`${reviewUrl}/cases/AE-000001/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  assert.equal((await post({ decision: 'approve' })).status, 400);
  assert.equal((await post({ reviewer: 'r.okafor', decision: 'close' })).status, 400);

  const approved = await post({ reviewer: 'r.okafor', decision: 'approve' });
  assert.equal(approved.status, 200);
  assert.equal((await post({ reviewer: 'r.okafor', decision: 'approve' })).status, 409);

  const detail: unknown = await (await fetch(`${reviewUrl}/cases/AE-000001`)).json();
  assert.ok(typeof detail === 'object' && detail !== null && 'audit' in detail && Array.isArray(detail.audit));
  const actions: unknown[] = detail.audit.map((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'action' in entry ? entry.action : undefined,
  );
  assert.deepEqual(actions, ['case_created', 'review_approve']);
});
