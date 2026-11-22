// The case system requires a valid access token on both servers. Real signed tokens from the stand-in
// issuer, checked by the real shared check; the MCP SDK's own client for the agent server.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { MintOptions } from '../../../test-support/issuer.ts';
import { CONTEXT_HEADERS, createAgentServer, createReviewServer } from '../src/http.ts';
import { settingsFrom } from '../src/settings.ts';
import { CaseStore } from '../src/store.ts';
import { DANA, REVIEWER_ROLE, RILEY, bearer, startTokens } from './tokens.ts';
import type { Tokens } from './tokens.ts';

const NOW = new Date('2026-01-01T00:00:00Z');

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

type Rig = { store: CaseStore; agentUrl: string; reviewUrl: string; tokens: Tokens };

async function start(t: TestContext): Promise<Rig> {
  let seconds = 0;
  const store = new CaseStore(':memory:', () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)));
  const tokens = await startTokens(t, () => NOW);
  const agent = createAgentServer(store, () => NOW, tokens.check);
  const review = createReviewServer(store, tokens.check, REVIEWER_ROLE);
  t.after(() => {
    agent.close();
    review.close();
    agent.closeAllConnections();
    review.closeAllConnections();
    store.close();
  });
  return { store, agentUrl: await listen(agent), reviewUrl: await listen(review), tokens };
}

const CONTEXT = {
  [CONTEXT_HEADERS.messageId]: 'm1',
  [CONTEXT_HEADERS.receivedAt]: '2025-12-31T23:00:00Z',
  [CONTEXT_HEADERS.agentId]: 'intake-agent',
  [CONTEXT_HEADERS.sender]: encodeURIComponent('Dr A. Rivera, a.rivera@example.org'),
};

const COMPLETE = { patient: 'JD, 54, male', reporter: 'Dr A. Rivera', suspect_drug: 'atorvastatin', event: 'severe muscle pain' };

const CREATE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_case', arguments: COMPLETE } });

function postMcp(rig: Rig, headers: Record<string, string>): Promise<Response> {
  return fetch(`${rig.agentUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...CONTEXT, ...headers },
    body: CREATE,
  });
}

async function reasonOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as Record<string, unknown>;
  return body.reason;
}

async function createAs(rig: Rig, token: string): Promise<void> {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${rig.agentUrl}/mcp`), {
    requestInit: { headers: { ...CONTEXT, ...bearer(token) } },
  });
  await client.connect(transport);
  const created = await client.callTool({ name: 'create_case', arguments: COMPLETE });
  assert.notEqual(created.isError, true);
  await client.close();
}

test('D1. POST /mcp with no token is 401 with the header and reason missing; nothing is stored; /ping needs no token', async (t) => {
  const rig = await start(t);
  const response = await postMcp(rig, {});
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  assert.equal(await reasonOf(response), 'missing');
  assert.equal(rig.store.find({}).cases.length, 0);
  for (const url of [rig.agentUrl, rig.reviewUrl]) {
    const ping = await fetch(`${url}/ping`);
    assert.equal(ping.status, 200, url);
    await ping.body?.cancel();
  }
});

test('D2. a token signed by another key, from another issuer, for lab-agents only, from another client, or expired is 401 with that reason', async (t) => {
  const rig = await start(t);
  const rows: { reason: string; options: Partial<MintOptions> }[] = [
    { reason: 'bad_signature', options: { signedBy: 'other_key' } },
    { reason: 'wrong_issuer', options: { claims: { iss: 'http://elsewhere.example.org/realms/lab' } } },
    { reason: 'wrong_audience', options: { claims: { aud: ['lab-agents'] } } },
    { reason: 'wrong_client', options: { claims: { client_id: 'other-client' } } },
    { reason: 'expired', options: { lifetimeSeconds: -1 } },
  ];
  for (const row of rows) {
    const response = await postMcp(rig, bearer(await rig.tokens.mint(row.options)));
    assert.equal(response.status, 401, row.reason);
    assert.equal(await reasonOf(response), row.reason);
  }
  assert.equal(rig.store.find({}).cases.length, 0);
});

test("I04. agents' server: a token without any case-system scope is 403 insufficient_scope naming the scopes; another refusal is still 401; nothing is stored", async (t) => {
  const rig = await start(t);
  const token = await rig.tokens.mint({ claims: { scope: 'openid agents:intake' } });
  const lacking = await postMcp(rig, bearer(token));
  assert.equal(lacking.status, 403);
  assert.equal(lacking.headers.get('www-authenticate'), 'Bearer error="insufficient_scope", scope="cases:write cases:lookup cases:read cases:review"');
  const text = await lacking.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.error, 'forbidden');
  assert.equal(body.reason, 'insufficient_scope');
  assert.equal(typeof body.detail, 'string');
  assert.ok(!text.includes(token), 'the answer contains the token');

  const other = await postMcp(rig, bearer(await rig.tokens.mint({ claims: { aud: ['lab-agents'] } })));
  assert.equal(other.status, 401);
  assert.equal(other.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  assert.equal(await reasonOf(other), 'wrong_audience');
  assert.equal(rig.store.find({}).cases.length, 0);
});

test('I04. review server: a token without any case-system scope is 403 insufficient_scope naming the scopes on every route; another refusal is still 401', async (t) => {
  const rig = await start(t);
  const token = await rig.tokens.mint({ claims: { scope: 'openid agents:intake' } });
  const routes: [string, RequestInit][] = [
    [`${rig.reviewUrl}/cases`, {}],
    [`${rig.reviewUrl}/cases/AE-000001`, {}],
    [`${rig.reviewUrl}/cases/AE-000001/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }],
  ];
  for (const [url, init] of routes) {
    const lacking = await fetch(url, { ...init, headers: bearer(token) });
    assert.equal(lacking.status, 403, url);
    assert.equal(lacking.headers.get('www-authenticate'), 'Bearer error="insufficient_scope", scope="cases:write cases:lookup cases:read cases:review"', url);
    const text = await lacking.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.error, 'forbidden', url);
    assert.equal(body.reason, 'insufficient_scope', url);
    assert.ok(!text.includes(token), `${url}: the answer contains the token`);
  }
  const other = await fetch(`${rig.reviewUrl}/cases`, { headers: bearer(await rig.tokens.mint({ claims: { client_id: 'other-client' } })) });
  assert.equal(other.status, 401);
  assert.equal(other.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  assert.equal(await reasonOf(other), 'wrong_client');
});

test('D3. with the provider down both servers answer 503 identity_unavailable; once it is back the next request succeeds', async (t) => {
  const rig = await start(t);
  const token = await rig.tokens.mint();
  rig.tokens.issuer.misbehave('no_answer');
  const agent = await postMcp(rig, bearer(token));
  const review = await fetch(`${rig.reviewUrl}/cases`, { headers: bearer(token) });
  for (const response of [agent, review]) {
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as Record<string, unknown>).error, 'identity_unavailable');
  }
  rig.tokens.issuer.misbehave('none');
  const back = await fetch(`${rig.reviewUrl}/cases`, { headers: bearer(token) });
  assert.equal(back.status, 200);
  await back.body?.cancel();
});

test("D4. an agent's create_case with a valid token records the agent as actor and the token's user as acting_for", async (t) => {
  const rig = await start(t);
  await createAs(rig, await rig.tokens.mint({ claims: DANA }));
  const [entry] = rig.store.auditTrail('AE-000001');
  assert.equal(entry?.action, 'case_created');
  assert.equal(entry?.actor, 'intake-agent');
  assert.equal(entry?.actor_kind, 'agent');
  assert.deepEqual(entry?.acting_for, { name: 'Dana Desk', subject: DANA.sub });
  assert.equal(entry?.actor_subject, null);
});

test('D5. the review routes with no token are 401 each', async (t) => {
  const rig = await start(t);
  const requests: [string, RequestInit][] = [
    [`${rig.reviewUrl}/cases`, {}],
    [`${rig.reviewUrl}/cases/AE-000001`, {}],
    [`${rig.reviewUrl}/cases/AE-000001/review`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }],
  ];
  for (const [url, init] of requests) {
    const response = await fetch(url, init);
    assert.equal(response.status, 401, url);
    assert.equal(await reasonOf(response), 'missing');
  }
});

test("D6. a review is recorded under the token's name and subject; a body naming a reviewer is 400; a non-reviewer is 403 and nothing changes", async (t) => {
  const rig = await start(t);
  await createAs(rig, await rig.tokens.mint({ claims: DANA }));
  const review = async (claims: Record<string, unknown>, caseId: string, body: unknown): Promise<Response> =>
    fetch(`${rig.reviewUrl}/cases/${caseId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(await rig.tokens.mint({ claims })) },
      body: JSON.stringify(body),
    });

  const named = await review(RILEY, 'AE-000001', { reviewer: 'Someone Else', decision: 'approve' });
  assert.equal(named.status, 400);
  await named.body?.cancel();
  assert.equal(rig.store.getCase('AE-000001')?.status, 'awaiting_review');

  const trailBefore = rig.store.auditTrail('AE-000001');
  for (const caseId of ['AE-000001', 'AE-999999']) {
    const refused = await review(DANA, caseId, { decision: 'approve' });
    assert.equal(refused.status, 403, caseId);
    assert.equal(((await refused.json()) as Record<string, unknown>).error, 'not_a_reviewer', caseId);
  }
  assert.equal(rig.store.getCase('AE-000001')?.status, 'awaiting_review');
  assert.deepEqual(rig.store.auditTrail('AE-000001'), trailBefore);

  const approved = await review(RILEY, 'AE-000001', { decision: 'approve' });
  assert.equal(approved.status, 200);
  await approved.body?.cancel();
  const decision = rig.store.auditTrail('AE-000001').at(-1);
  assert.equal(decision?.action, 'review_approve');
  assert.equal(decision?.actor, 'Riley Reviewer');
  assert.equal(decision?.actor_kind, 'reviewer');
  assert.equal(decision?.actor_subject, RILEY.sub);
  assert.equal(decision?.acting_for, null);
});

const ENV = {
  CASE_DB_PATH: '/data/cases.sqlite',
  AUTH_DISCOVERY_URL: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
  AUTH_ISSUER: 'http://localhost:8090/realms/lab',
  AUTH_ALLOWED_AUDIENCE: 'lab-case-system',
  AUTH_ALLOWED_CLIENTS: 'desk',
  AUTH_REQUIRED_SCOPES: 'cases:write,cases:lookup,cases:read,cases:review',
  AUTH_ROLES_CLAIM: 'roles',
  AUTH_REVIEWER_ROLE: 'reviewer',
};

test('D7. each setting is required and named when missing', () => {
  assert.deepEqual(settingsFrom(ENV), {
    databasePath: '/data/cases.sqlite',
    auth: {
      discoveryUrl: 'http://identity:8080/realms/lab/.well-known/openid-configuration',
      issuer: 'http://localhost:8090/realms/lab',
      audience: 'lab-case-system',
      allowedClients: ['desk'],
      requiredScopes: ['cases:write', 'cases:lookup', 'cases:read', 'cases:review'],
      rolesClaim: 'roles',
      minRemainingSeconds: 0,
    },
    reviewerRole: 'reviewer',
  });
  for (const name of Object.keys(ENV)) {
    const missing: Record<string, string | undefined> = { ...ENV };
    delete missing[name];
    assert.throws(() => settingsFrom(missing), new RegExp(`^Error: ${name} is not set`), name);
    assert.throws(() => settingsFrom({ ...ENV, [name]: '  ' }), new RegExp(`^Error: ${name} is not set`), name);
  }
});

test('D9. with no token, a body that is not JSON or broken context headers is 401, not 400, on both servers', async (t) => {
  const rig = await start(t);
  const notJson = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const requests: [string, RequestInit][] = [
    [`${rig.agentUrl}/mcp`, { method: 'POST', headers: notJson, body: '{"jsonrpc": ' }],
    [`${rig.agentUrl}/mcp`, { method: 'POST', headers: { ...notJson, [CONTEXT_HEADERS.messageId]: 'm1', [CONTEXT_HEADERS.receivedAt]: 'yesterday-ish' }, body: CREATE }],
    [`${rig.reviewUrl}/cases/AE-000001/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"decision": ' }],
    [`${rig.reviewUrl}/cases/AE-000001/review`, { method: 'POST', headers: { 'content-type': 'application/json', ...CONTEXT, [CONTEXT_HEADERS.receivedAt]: 'yesterday-ish' }, body: '{}' }],
  ];
  for (const [url, init] of requests) {
    const response = await fetch(url, init);
    assert.equal(response.status, 401, url);
    assert.equal(await reasonOf(response), 'missing', url);
  }
  assert.equal(rig.store.find({}).cases.length, 0);
});

test('D8. a store written before the new audit columns opens; old entries give null; a new entry has them', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'case-store-audit-')), 'cases.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    create table cases (
      n integer primary key, case_id text not null unique, status text not null,
      current_version integer not null, received_at text not null, created_at text not null
    ) strict;
    create table audit (
      seq integer primary key autoincrement, at text not null, actor text not null,
      actor_kind text not null check (actor_kind in ('agent', 'reviewer')), action text not null,
      case_id text not null references cases(case_id), version integer, detail text not null
    ) strict;
    insert into cases values (1, 'AE-000001', 'awaiting_review', 1, '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z');
    insert into audit (at, actor, actor_kind, action, case_id, version, detail)
      values ('2026-01-01T00:00:00.000Z', 'old-agent', 'agent', 'case_created', 'AE-000001', 1, '{}');
  `);
  old.close();

  const store = new CaseStore(path, () => NOW);
  const [entry] = store.auditTrail('AE-000001');
  assert.equal(entry?.actor, 'old-agent');
  assert.equal(entry?.acting_for, null);
  assert.equal(entry?.actor_subject, null);

  const created = store.createCase(
    {
      messageId: 'm-new',
      receivedAt: '2025-12-31T23:00:00.000Z',
      agentId: 'intake-agent',
      actingFor: { name: 'Dana Desk', subject: DANA.sub },
      sender: 'Dr A. Rivera, a.rivera@example.org',
    },
    COMPLETE,
  );
  const [fresh] = store.auditTrail(created.case.case_id);
  assert.deepEqual(fresh?.acting_for, { name: 'Dana Desk', subject: DANA.sub });
  assert.equal(fresh?.actor_subject, null);
  store.close();
});
