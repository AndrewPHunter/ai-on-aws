// The agent's server requires a valid access token on POST /invocations. Real signed tokens from the
// stand-in issuer (test-support/), checked by the real shared check; a small handler records what reaches it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Caller } from '../../shared/access-token.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import type { MintOptions } from '../../test-support/issuer.ts';
import { createContractServer } from '../src/contract/server.ts';
import { settingsFrom } from '../src/intake/serve.ts';
import { TOKEN_CLAIMS, TOKEN_MIN_REMAINING_SECONDS, listen, message, startTokenRig, stop } from './helpers.ts';
import type { TokenRig } from './helpers.ts';

const IDENTITY = { id: 'auth-test-agent', implementation: 'none: a recording handler' };

const ANSWER: InvocationResponse = {
  agent: IDENTITY,
  outcome: 'completed',
  stop_reason: null,
  reply: 'Received.',
  citations: [],
  case_actions: [],
  steps: [],
};

type Agent = { url: string; callers: Caller[]; tokens: TokenRig };

async function startAgent(t: TestContext): Promise<Agent> {
  const tokens = await startTokenRig(t);
  const callers: Caller[] = [];
  const server = createContractServer(
    IDENTITY,
    (_inbound, caller) => {
      callers.push(caller);
      return Promise.resolve(ANSWER);
    },
    tokens.check,
  );
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return { url, callers, tokens };
}

const BODY = JSON.stringify({ message: message('msg-1', 'Hello') });

async function invoke(agent: Agent, authorization: string | undefined, body = BODY): Promise<{ status: number; headers: Headers; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  const response = await fetch(`${agent.url}/invocations`, { method: 'POST', headers, body });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function reasonOf(text: string): unknown {
  const body: unknown = JSON.parse(text);
  return typeof body === 'object' && body !== null ? Reflect.get(body, 'reason') : undefined;
}

test('A1. POST /invocations without a token is 401 with WWW-Authenticate and reason missing; the handler is not called', async (t) => {
  const agent = await startAgent(t);
  const answer = await invoke(agent, undefined);
  assert.equal(answer.status, 401);
  assert.equal(answer.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  const body: unknown = JSON.parse(answer.text);
  assert.equal(Reflect.get(body as object, 'error'), 'unauthorized');
  assert.equal(Reflect.get(body as object, 'reason'), 'missing');
  assert.equal(typeof Reflect.get(body as object, 'detail'), 'string');
  assert.equal(agent.callers.length, 0);
});

test('A2. each refusal reaching the server is 401 with its reason, calls no handler, and returns no token', async (t) => {
  const agent = await startAgent(t);
  const rows: { reason: string; header: () => Promise<string> }[] = [
    { reason: 'malformed', header: () => Promise.resolve('Bearer not.a.jwt') },
    { reason: 'bad_signature', header: async () => `Bearer ${await agent.tokens.mint({ signedBy: 'other_key' })}` },
    { reason: 'wrong_issuer', header: async () => `Bearer ${await agent.tokens.mint({ claims: { iss: 'http://elsewhere.example.org/realms/lab' } })}` },
    { reason: 'wrong_audience', header: async () => `Bearer ${await agent.tokens.mint({ claims: { aud: ['lab-case-system'] } })}` },
    { reason: 'wrong_client', header: async () => `Bearer ${await agent.tokens.mint({ claims: { client_id: 'other-client' } })}` },
    { reason: 'expired', header: async () => `Bearer ${await agent.tokens.mint({ lifetimeSeconds: -1 })}` },
    {
      reason: 'expires_too_soon',
      header: async () => `Bearer ${await agent.tokens.mint({ lifetimeSeconds: TOKEN_MIN_REMAINING_SECONDS - 1 } satisfies Partial<MintOptions>)}`,
    },
  ];
  for (const row of rows) {
    const header = await row.header();
    const answer = await invoke(agent, header);
    assert.equal(answer.status, 401, row.reason);
    assert.equal(answer.headers.get('www-authenticate'), 'Bearer error="invalid_token"', row.reason);
    assert.equal(reasonOf(answer.text), row.reason);
    const token = header.split(' ')[1] ?? '';
    assert.ok(!answer.text.includes(token), `${row.reason}: the answer contains the token`);
  }
  assert.equal(agent.callers.length, 0);
});

test('A3. no token and a body outside the contract is 401, not 400', async (t) => {
  const agent = await startAgent(t);
  const answer = await invoke(agent, undefined, '{"message": ');
  assert.equal(answer.status, 401);
  assert.equal(reasonOf(answer.text), 'missing');
});

test('A4. a valid token is 200 and the handler is given the caller', async (t) => {
  const agent = await startAgent(t);
  const token = await agent.tokens.mint();
  const answer = await invoke(agent, `Bearer ${token}`);
  assert.equal(answer.status, 200);
  assert.equal(agent.callers.length, 1);
  const caller = agent.callers[0];
  assert.equal(caller?.subject, TOKEN_CLAIMS.sub);
  assert.equal(caller?.name, TOKEN_CLAIMS.name);
  assert.equal(caller?.clientId, 'desk');
  assert.deepEqual(caller?.roles, TOKEN_CLAIMS.roles);
  assert.equal(caller?.token, token);
});

test('A5. GET /ping answers 200 with no token', async (t) => {
  const agent = await startAgent(t);
  const response = await fetch(`${agent.url}/ping`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'Healthy' });
});

test('A6. with the provider down the answer is 503 identity_unavailable; once it is back the next request succeeds', async (t) => {
  const agent = await startAgent(t);
  const token = await agent.tokens.mint();
  agent.tokens.issuer.misbehave('no_answer');
  const down = await invoke(agent, `Bearer ${token}`);
  assert.equal(down.status, 503);
  assert.equal(Reflect.get(JSON.parse(down.text) as object, 'error'), 'identity_unavailable');
  assert.equal(agent.callers.length, 0);

  agent.tokens.issuer.misbehave('none');
  const back = await invoke(agent, `Bearer ${token}`);
  assert.equal(back.status, 200);
  assert.equal(agent.callers.length, 1);
});

const ENV = {
  MODEL_BASE_URL: 'http://model:8000/v1/',
  MODEL_API_KEY: 'not-a-real-key',
  CASE_MCP_URL: 'http://case-system:8000/mcp',
  AGENT_ID: 'intake-handwritten',
  AUTH_DISCOVERY_URL: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
  AUTH_ISSUER: 'http://localhost:8090/realms/lab',
  AUTH_ALLOWED_AUDIENCE: 'lab-agents',
  AUTH_ALLOWED_CLIENTS: ' desk , other-client ',
  AUTH_ROLES_CLAIM: 'roles',
};

test('A7. each AUTH_ setting is required and named when missing; the client list splits on commas and trims', () => {
  const settings = settingsFrom(ENV);
  assert.deepEqual(settings.auth, {
    discoveryUrl: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
    issuer: 'http://localhost:8090/realms/lab',
    audience: 'lab-agents',
    allowedClients: ['desk', 'other-client'],
    rolesClaim: 'roles',
    minRemainingSeconds: 150,
  });
  for (const name of ['AUTH_DISCOVERY_URL', 'AUTH_ISSUER', 'AUTH_ALLOWED_AUDIENCE', 'AUTH_ALLOWED_CLIENTS', 'AUTH_ROLES_CLAIM'] as const) {
    const missing: Record<string, string | undefined> = { ...ENV };
    delete missing[name];
    assert.throws(() => settingsFrom(missing), new RegExp(`^Error: ${name} is not set`), name);
    assert.throws(() => settingsFrom({ ...ENV, [name]: '  ' }), new RegExp(`^Error: ${name} is not set`), name);
  }
  assert.throws(() => settingsFrom({ ...ENV, AUTH_ALLOWED_CLIENTS: ' , ' }), /AUTH_ALLOWED_CLIENTS names no client id/);
});
