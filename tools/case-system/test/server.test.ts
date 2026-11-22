// The case system's invariant 8 ("Always true" in tools/case-system/README.md), and three probes of the wiring
// the store's tests cannot show (P1 to P3), on the real servers over loopback. The access token check is a
// function that names a caller, refuses, or is unavailable: these tests are not about verifying a token.

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { AccessTokenCheck, Caller } from '../../../shared/access-token.ts';
import { CONTEXT_HEADERS, createAgentServer, createReviewServer } from '../src/http.ts';
import { CaseStore } from '../src/store.ts';
import type { CallContext } from '../src/store.ts';

const NOW = new Date('2026-01-01T09:00:00.000Z');
const RIVERA = 'Dr A. Rivera, a.rivera@example.org';
const KATO = 'Dr M. Kato, m.kato@example.org';
const COMPLETE = { patient: 'JD, 54, male', reporter: RIVERA, suspect_drug: 'examplamab', event: 'muscle pain' };

const person = (name: string, roles: string[]): Caller => ({
  subject: `subject-${name}`,
  username: name,
  name,
  clientId: 'desk',
  roles,
  expiresAt: new Date('2026-01-01T10:00:00.000Z'),
  token: name,
});
const CALLERS: Record<string, Caller> = { 'Bearer dana': person('dana', []), 'Bearer riley': person('riley', ['reviewer']) };

const checkToken: AccessTokenCheck = (authorization) => {
  if (authorization === 'Bearer down') return Promise.resolve({ kind: 'unavailable', detail: 'The provider is down.' });
  const caller = authorization === undefined ? undefined : CALLERS[authorization];
  return Promise.resolve(caller ? { kind: 'caller', caller } : { kind: 'refused', reason: 'bad_signature', detail: 'Refused.' });
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function start(t: TestContext): Promise<{ store: CaseStore; agent: string; review: string }> {
  const store = new CaseStore(':memory:', () => NOW);
  const servers = [createAgentServer(store, () => NOW, checkToken), createReviewServer(store, checkToken, 'reviewer')];
  t.after(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    store.close();
  });
  const [agent, review] = await Promise.all(servers.map(listen));
  assert.ok(agent !== undefined && review !== undefined);
  return { store, agent, review };
}

const headersFor = (messageId: string, sender: string): Record<string, string> => ({
  [CONTEXT_HEADERS.messageId]: messageId,
  [CONTEXT_HEADERS.receivedAt]: '2026-01-01T08:00:00.000Z',
  [CONTEXT_HEADERS.agentId]: 'intake-agent',
  [CONTEXT_HEADERS.sender]: encodeURIComponent(sender),
});

async function connect(t: TestContext, agent: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'probe', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${agent}/mcp`), { requestInit: { headers: { ...headers, authorization: 'Bearer dana' } } }));
  t.after(() => client.close());
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  assert.ok(first !== undefined);
  return { isError: result.isError === true, payload: JSON.parse(first.text) as Record<string, unknown> };
}

const context = (messageId: string, sender: string): CallContext => ({
  messageId,
  receivedAt: '2026-01-01T08:00:00.000Z',
  agentId: 'intake-agent',
  actingFor: { name: 'dana', subject: 'subject-dana' },
  sender,
});

test('case-system 8. no call is accepted without knowing who is calling, and the token is judged before the headers or the body', async (t) => {
  const { store, agent, review } = await start(t);
  const id = store.createCase(context('m1', RIVERA), COMPLETE).case.case_id;
  const broken = { [CONTEXT_HEADERS.messageId]: 'm2', 'content-type': 'application/json' };
  const rows: { url: string; method: string; authorization?: string; body?: string; status: number }[] = [
    { url: `${agent}/mcp`, method: 'POST', body: 'not json', status: 401 },
    { url: `${agent}/mcp`, method: 'POST', authorization: 'Bearer forged', body: 'not json', status: 401 },
    { url: `${agent}/mcp`, method: 'POST', authorization: 'Bearer down', body: 'not json', status: 503 },
    { url: `${review}/cases/${id}`, method: 'GET', status: 401 },
    { url: `${review}/cases/${id}/review`, method: 'POST', authorization: 'Bearer forged', body: 'not json', status: 401 },
    { url: `${review}/cases/${id}/review`, method: 'POST', authorization: 'Bearer down', body: '{"decision":"approve"}', status: 503 },
  ];
  for (const row of rows) {
    const headers = row.authorization === undefined ? broken : { ...broken, authorization: row.authorization };
    const response = await fetch(row.url, { method: row.method, headers, body: row.body ?? null });
    await response.body?.cancel();
    assert.equal(response.status, row.status, `${row.method} ${row.url} with ${row.authorization ?? 'no token'}`);
  }
  assert.deepEqual([store.find({}).cases.length, store.getCase(id)?.status, store.auditTrail(id).length], [1, 'awaiting_review', 1]);
});

test("case-system P1. over MCP the agent is offered exactly the three tools, and a create is recorded against the headers and the token's caller", async (t) => {
  const { store, agent } = await start(t);
  const client = await connect(t, agent, headersFor('m1', RIVERA));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['add_follow_up', 'create_case', 'find_case']);
  assert.equal((await call(client, 'create_case', COMPLETE)).payload['outcome'], 'created');
  const [entry] = store.auditTrail('AE-000001');
  assert.deepEqual([entry?.actor, entry?.acting_for, entry?.detail], ['intake-agent', { name: 'dana', subject: 'subject-dana' }, { message_id: 'm1', missing: [] }]);
  assert.equal(store.versions('AE-000001')[0]?.sender, RIVERA);
});

test("case-system P2. a decision through the review route is recorded under the token's caller; a named reviewer or a caller without the role is refused", async (t) => {
  const { store, review } = await start(t);
  const id = store.createCase(context('m1', RIVERA), COMPLETE).case.case_id;
  const decide = async (authorization: string, body: unknown): Promise<number> => {
    const response = await fetch(`${review}/cases/${id}/review`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await response.body?.cancel();
    return response.status;
  };
  assert.equal(await decide('Bearer dana', { decision: 'approve' }), 403);
  assert.equal(await decide('Bearer riley', { decision: 'approve', reviewer: 'Someone Else' }), 400);
  assert.equal(store.getCase(id)?.status, 'awaiting_review');
  assert.equal(await decide('Bearer riley', { decision: 'approve' }), 200);
  const last = store.auditTrail(id).at(-1);
  assert.deepEqual([store.getCase(id)?.status, last?.actor, last?.actor_subject], ['approved', 'riley', 'subject-riley']);
});

test("case-system P3. over MCP, another sender's case is answered as one that does not exist", async (t) => {
  const { store, agent } = await start(t);
  const rivera = await connect(t, agent, headersFor('m1', RIVERA));
  await call(rivera, 'create_case', COMPLETE);
  assert.equal(((await call(rivera, 'find_case', { case_id: 'AE-000001' })).payload['cases'] as unknown[]).length, 1, 'the owner finds it');
  const kato = await connect(t, agent, headersFor('m2', KATO));
  assert.deepEqual((await call(kato, 'find_case', { case_id: 'AE-000001' })).payload['cases'], []);
  const theirs = await call(kato, 'add_follow_up', { case_id: 'AE-000001', event: 'fever' });
  const none = await call(kato, 'add_follow_up', { case_id: 'AE-999999', event: 'fever' });
  assert.deepEqual([theirs.isError, theirs.payload['error']], [none.isError, none.payload['error']]);
  assert.equal(store.versions('AE-000001').length, 1);
});
