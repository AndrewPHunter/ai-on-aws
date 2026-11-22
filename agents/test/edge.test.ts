// The local stand-in for AgentCore Runtime's front door (agents/src/contract/edge.ts), in front of a recording
// upstream of the test's own. Real signed tokens from the stand-in issuer, checked by the real shared check.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { createLocalEdge, UPSTREAM_SILENT } from '../src/contract/edge.ts';
import type { Address } from '../src/contract/runtime-contract.ts';
import { deadUrl, listen, message, prop, startTokenRig, stop } from './helpers.ts';
import type { TokenRig } from './helpers.ts';

// --- Test double: the recording upstream -----------------------------------------------------------------
// STAND-IN for the SDK app. NOT a BedrockAgentCoreApp. An HTTP server that records every request it receives
// (method, path, headers, body) and answers each with the status and body the test set, after the delay the test
// set. agents/test/sdk-server.test.ts drives the real SDK app.

type Received = { method: string | undefined; path: string | undefined; headers: IncomingHttpHeaders; body: string };

type Upstream = { address: Address; received: Received[] };

async function startUpstream(t: TestContext, answer: { status: number; body: unknown; delayMs?: number } = { status: 200, body: { answered: 'by the upstream' } }): Promise<Upstream> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      setTimeout(() => {
        response.writeHead(answer.status, { 'content-type': 'application/json', 'x-from-upstream': 'yes' });
        response.end(JSON.stringify(answer.body));
      }, answer.delayMs ?? 0);
    });
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return { address: addressOf(url), received };
}

function addressOf(url: string): Address {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) };
}

type Edge = { url: string; tokens: TokenRig; logged: string[] };

async function startEdge(t: TestContext, upstream: Address): Promise<Edge> {
  const tokens = await startTokenRig(t);
  const logged: string[] = [];
  // The ids are made as the agent makes them, so R04 checks the length the agent gives.
  const server = createLocalEdge({
    upstream,
    checkToken: tokens.check,
    newId: randomUUID,
    log: (line) => logged.push(line),
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return { url, tokens, logged };
}

const BODY = JSON.stringify({ message: message('msg-1', 'Hello') });
const SESSION = 'x-amzn-bedrock-agentcore-runtime-session-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function invoke(edge: Edge, headers: Record<string, string>, body = BODY): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(`${edge.url}/invocations`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) };
}

test('R01. no token, and a bad token: 401 with the hand-written server\'s body and header; the upstream receives nothing', async (t) => {
  const upstream = await startUpstream(t);
  const edge = await startEdge(t, upstream.address);

  const none = await invoke(edge, {});
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  assert.equal(prop(none.body, 'error'), 'unauthorized');
  assert.equal(prop(none.body, 'reason'), 'missing');
  assert.equal(typeof prop(none.body, 'detail'), 'string');

  const badToken = await edge.tokens.mint({ signedBy: 'other_key' });
  const bad = await invoke(edge, { authorization: `Bearer ${badToken}` });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  assert.equal(prop(bad.body, 'reason'), 'bad_signature');
  assert.equal(JSON.stringify(bad.body).includes(badToken), false);

  assert.equal(upstream.received.length, 0);
});

test('R02. the identity provider cannot be asked: 503 identity_unavailable; the upstream receives nothing', async (t) => {
  const upstream = await startUpstream(t);
  const edge = await startEdge(t, upstream.address);
  const token = await edge.tokens.mint();
  edge.tokens.issuer.misbehave('no_answer');

  const answer = await invoke(edge, { authorization: `Bearer ${token}` });
  assert.equal(answer.status, 503);
  assert.equal(prop(answer.body, 'error'), 'identity_unavailable');
  assert.equal(typeof prop(answer.body, 'detail'), 'string');
  assert.equal(upstream.received.length, 0);
});

test('R03. a valid token: the upstream receives Authorization, a session id, a request id, the content type and a custom header, and nothing else the caller sent', async (t) => {
  const upstream = await startUpstream(t);
  const edge = await startEdge(t, upstream.address);
  const token = await edge.tokens.mint();

  const answer = await invoke(edge, {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Desk': 'front-desk-1',
    cookie: 'session=abc',
    'x-forwarded-for': '203.0.113.9',
    'x-anything': 'arbitrary',
    'x-amzn-bedrock-agentcore-runtime-request-id': 'chosen-by-the-caller',
    'x-amz-bedrock-agentcore-identity-wat': 'workload-token-from-the-caller',
  });

  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { answered: 'by the upstream' });
  assert.equal(answer.headers.get('x-from-upstream'), 'yes');
  assert.equal(upstream.received.length, 1);
  const [received] = upstream.received;
  assert.equal(received?.method, 'POST');
  assert.equal(received?.path, '/invocations');
  assert.equal(received?.body, BODY);
  const headers = received?.headers ?? {};
  assert.equal(headers.authorization, `Bearer ${token}`);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['x-amzn-bedrock-agentcore-runtime-custom-desk'], 'front-desk-1');
  assert.match(String(headers[SESSION]), UUID);
  assert.match(String(headers['x-amzn-bedrock-agentcore-runtime-request-id']), UUID);
  assert.notEqual(headers['x-amzn-bedrock-agentcore-runtime-request-id'], headers[SESSION]);
  assert.equal(headers['content-length'], String(Buffer.byteLength(BODY)));
  for (const dropped of ['cookie', 'x-forwarded-for', 'x-anything', 'x-amz-bedrock-agentcore-identity-wat']) {
    assert.equal(headers[dropped], undefined, dropped);
  }
});

test('R04. session id: none given is generated, at least 33 characters; 33 and 256 pass unchanged; 32 and 257 are 400', async (t) => {
  const upstream = await startUpstream(t);
  const edge = await startEdge(t, upstream.address);
  const authorization = `Bearer ${await edge.tokens.mint()}`;

  const none = await invoke(edge, { authorization });
  assert.equal(none.status, 200);
  assert.ok(String(upstream.received[0]?.headers[SESSION]).length >= 33);

  for (const length of [33, 256]) {
    const id = 's'.repeat(length);
    const passed = await invoke(edge, { authorization, [SESSION]: id });
    assert.equal(passed.status, 200, String(length));
    assert.equal(upstream.received.at(-1)?.headers[SESSION], id, String(length));
  }
  const before = upstream.received.length;
  for (const length of [32, 257]) {
    const refused = await invoke(edge, { authorization, [SESSION]: 's'.repeat(length) });
    assert.equal(refused.status, 400, String(length));
    assert.equal(prop(refused.body, 'error'), 'bad_request');
    assert.equal(typeof prop(refused.body, 'detail'), 'string');
  }
  assert.equal(upstream.received.length, before);
});

test('R05. another path is 404, another method on /invocations is 405, GET /ping is passed to the upstream', async (t) => {
  const upstream = await startUpstream(t, { status: 200, body: { status: 'Healthy', time_of_last_update: 1 } });
  const edge = await startEdge(t, upstream.address);

  const elsewhere = await fetch(`${edge.url}/elsewhere`);
  assert.equal(elsewhere.status, 404);
  assert.deepEqual(await elsewhere.json(), { error: 'not_found', detail: 'There is no /elsewhere here.' });

  const get = await fetch(`${edge.url}/invocations`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.deepEqual(await get.json(), { error: 'method_not_allowed', detail: '/invocations accepts POST.' });
  assert.equal(upstream.received.length, 0);

  const ping = await fetch(`${edge.url}/ping`);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { status: 'Healthy', time_of_last_update: 1 });
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0]?.method, 'GET');
  assert.equal(upstream.received[0]?.path, '/ping');
});

test('R06. the upstream closed: 502 with its sentence; the upstream slower than a few seconds: its answer still comes back', async (t) => {
  const closed = await startEdge(t, addressOf(await deadUrl(t)));
  const authorization = `Bearer ${await closed.tokens.mint()}`;
  const refused = await invoke(closed, { authorization });
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.body, { error: 'bad_gateway', detail: UPSTREAM_SILENT });
  assert.equal(closed.logged.length, 1);
  assert.equal(closed.logged.join('\n').includes(authorization.split(' ')[1] ?? ''), false);

  const slow = await startUpstream(t, { status: 200, body: { answered: 'late' }, delayMs: 6500 });
  const edge = await startEdge(t, slow.address);
  const late = await invoke(edge, { authorization: `Bearer ${await edge.tokens.mint()}` });
  assert.equal(late.status, 200);
  assert.deepEqual(late.body, { answered: 'late' });
});
