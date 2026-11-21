// Drives the agent contract server over loopback with small handlers written in each test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { invocationResponseSchema } from '../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../shared/agent-contract.ts';
import { createContractServer } from '../src/contract/server.ts';
import type { Handler } from '../src/contract/server.ts';
import { IDENTITY, listen, message, stop } from './helpers.ts';

type Received = { url: string; received: InboundMessage[] };

async function startContract(t: TestContext, handler: Handler): Promise<Received> {
  const received: InboundMessage[] = [];
  const server = createContractServer(IDENTITY, (inbound) => {
    received.push(inbound);
    return handler(inbound);
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return { url, received };
}

const ANSWER: InvocationResponse = {
  agent: IDENTITY,
  outcome: 'completed',
  stop_reason: null,
  reply: 'No case was recorded.',
  citations: [],
  case_actions: [],
  steps: [{ kind: 'error', started_at: '2026-03-01T10:00:00.000Z', duration_ms: 0, message: 'example step' }],
};

function answering(response: InvocationResponse): Handler {
  return () => Promise.resolve(response);
}

async function post(url: string, body: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const parsed: unknown = await response.json();
  return { status: response.status, body: parsed };
}

test('GET /ping answers Healthy', async (t) => {
  const agent = await startContract(t, answering(ANSWER));
  const response = await fetch(`${agent.url}/ping`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'Healthy' });
});

test('a valid request reaches the handler and its response comes back', async (t) => {
  const agent = await startContract(t, answering(ANSWER));
  const inbound = message('msg-1', 'Hello');

  const answer = await post(agent.url, JSON.stringify({ message: inbound }));

  assert.equal(answer.status, 200);
  assert.deepEqual(invocationResponseSchema.parse(answer.body), ANSWER);
  assert.deepEqual(agent.received, [inbound]);
});

test('a body that is not JSON is 400 and the handler is not called', async (t) => {
  const agent = await startContract(t, answering(ANSWER));
  const answer = await post(agent.url, '{"message": ');
  assert.equal(answer.status, 400);
  assert.equal(agent.received.length, 0);
});

test('a request missing a field is 400 and the handler is not called', async (t) => {
  const agent = await startContract(t, answering(ANSWER));
  const { text: _dropped, ...withoutText } = message('msg-1', 'Hello');
  const answer = await post(agent.url, JSON.stringify({ message: withoutText }));
  assert.equal(answer.status, 400);
  assert.equal(agent.received.length, 0);
});

test('a handler that throws gives a failed outcome inside the contract', async (t) => {
  const agent = await startContract(t, () => Promise.reject(new Error('boom (expected by this test)')));
  const answer = await post(agent.url, JSON.stringify({ message: message('msg-1', 'Hello') }));
  assert.equal(answer.status, 200);
  const response = invocationResponseSchema.parse(answer.body);
  assert.equal(response.outcome, 'failed');
  assert.deepEqual(response.agent, IDENTITY);
  assert.equal(response.reply, '');
});

test('a handler that answers outside the contract gives 500', async (t) => {
  const agent = await startContract(
    t,
    answering({ ...ANSWER, steps: [{ kind: 'error', started_at: 'yesterday', duration_ms: -1, message: 'bad step' }] }),
  );
  const answer = await post(agent.url, JSON.stringify({ message: message('msg-1', 'Hello') }));
  assert.equal(answer.status, 500);
  assert.equal(agent.received.length, 1);
});

test('GET /invocations is 405', async (t) => {
  const agent = await startContract(t, answering(ANSWER));
  const response = await fetch(`${agent.url}/invocations`);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(agent.received.length, 0);
});

test('another path is 404', async (t) => {
  const agent = await startContract(t, answering(ANSWER));
  const response = await fetch(`${agent.url}/elsewhere`);
  assert.equal(response.status, 404);
});
