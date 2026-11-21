// Signing desk staff in and out, sessions, and the access token sent downstream. Against the stand-in
// OpenID Connect issuer (test-support/issuer.ts), with a recording agent and case system below.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import type { Misbehaviour } from '../../test-support/issuer.ts';
import {
  APP_ORIGIN,
  CLIENT_ID,
  CLIENT_SECRET,
  DANA,
  EXAMPLE_RESPONSE,
  POST_LOGOUT_REDIRECT_URI,
  REDIRECT_URI,
  RILEY,
  authorizeAt,
  cookieFor,
  cookiePair,
  deadUrl,
  eventually,
  getJson,
  listen,
  postJson,
  prop,
  setCookie,
  signInSteps,
  startClient,
  stop,
  tempDir,
} from './helpers.ts';
import type { RunningClient } from './helpers.ts';

// --- Recording stand-ins for an agent and the case system's review server ---------------------------
// NOT an agent and NOT the case system: each answers with a fixed body and records what it was sent.

type Recorded = { method: string; path: string; authorization: string | undefined; body: unknown };

type Recorder = { url: string; received: Recorded[] };

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? null : (JSON.parse(text) as unknown);
}

async function startRecorder(t: TestContext, answer: (request: Recorded) => unknown): Promise<Recorder> {
  const received: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    bodyOf(request)
      .then((body) => {
        const recorded = { method: request.method ?? '', path: request.url ?? '', authorization: request.headers.authorization, body };
        received.push(recorded);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer(recorded)));
      })
      .catch((error: unknown) => {
        response.writeHead(400);
        response.end(String(error));
      });
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
  });
  return { url, received };
}

const startAgent = (t: TestContext): Promise<Recorder> =>
  startRecorder(t, (request) => (request.path === '/ping' ? { status: 'Healthy' } : EXAMPLE_RESPONSE));

const startCaseSystem = (t: TestContext): Promise<Recorder> =>
  startRecorder(t, (request) => (request.path === '/ping' ? { status: 'Healthy' } : { case: { case_id: 'AE-000001' } }));

const invocations = (agent: Recorder): Recorded[] => agent.received.filter((entry) => entry.path === '/invocations');
const pings = (recorder: Recorder): Recorded[] => recorder.received.filter((entry) => entry.path === '/ping');

const INQUIRY = { sender: 'Dr. Priya Raman, p.raman@example.org', text: 'Is 80 mg too much?', agent_id: 'stand-in' };

async function withAgent(t: TestContext, user = RILEY): Promise<{ agent: Recorder; client: RunningClient }> {
  const agent = await startAgent(t);
  const client = await startClient(t, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: 'Records what it is sent.', url: agent.url }],
    caseReviewUrl: await deadUrl(t),
    webRoot: tempDir(t),
    user,
  });
  return { agent, client };
}

function lastIssued(client: RunningClient): { access_token: string; refresh_token: string; id_token: string } {
  const tokens = client.issuer.issued.at(-1);
  assert.ok(tokens !== undefined, 'the stand-in has issued no token');
  return tokens;
}

function webRootWithApp(t: TestContext): string {
  const webRoot = join(tempDir(t), 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Medical information desk</title>');
  return webRoot;
}

async function assertShellAndPing(url: string): Promise<void> {
  const pinged = await fetch(`${url}/ping`);
  assert.equal(pinged.status, 200);
  assert.deepEqual(await pinged.json(), { status: 'Healthy' });
  const shell = await fetch(`${url}/inquiries`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Medical information desk/);
}

// --- Tests ------------------------------------------------------------------------------------------

test('C1. without a session every API route and sign-out answer 401 not_signed_in; /ping and the app shell answer 200', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: webRootWithApp(t), user: null });
  const requests: [string, string][] = [
    ['GET', '/api/status'],
    ['GET', '/api/agents'],
    ['GET', '/api/samples'],
    ['GET', '/api/inquiries'],
    ['GET', '/api/cases'],
    ['GET', '/api/session'],
    ['POST', '/api/inquiries'],
    ['POST', '/auth/logout'],
  ];
  for (const [method, path] of requests) {
    const response = await fetch(`${client.url}${path}`, method === 'POST' ? { method, body: JSON.stringify(INQUIRY) } : {});
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(prop(await response.json(), 'error'), 'not_signed_in', `${method} ${path}`);
  }
  await assertShellAndPing(client.url);
});

test('C2. /auth/login redirects to the authorization endpoint with every parameter, fresh for each sign-in', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t), user: null });
  const starts: URLSearchParams[] = [];
  for (let n = 0; n < 2; n++) {
    const response = await fetch(`${client.url}/auth/login`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get('location') ?? '');
    assert.equal(`${target.origin}${target.pathname}`, `${client.issuer.url}/authorize`);
    const query = target.searchParams;
    assert.equal(query.get('response_type'), 'code');
    assert.equal(query.get('client_id'), 'desk');
    assert.equal(query.get('redirect_uri'), REDIRECT_URI);
    assert.ok((query.get('scope') ?? '').split(' ').includes('openid'));
    assert.equal(query.get('code_challenge_method'), 'S256');
    for (const name of ['state', 'nonce', 'code_challenge']) {
      assert.ok((query.get(name) ?? '').length >= 43, `${name} is missing or short`);
    }
    starts.push(query);
  }
  for (const name of ['state', 'nonce', 'code_challenge']) {
    assert.notEqual(starts[0]?.get(name), starts[1]?.get(name), `${name} was reused`);
  }
});

test('C3. a full sign-in sets an HttpOnly, SameSite=Lax, Path=/ cookie and the session shows the user from the ID token', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t), user: null });
  const { login, callback } = await signInSteps(client.url, client.issuer, RILEY);
  const [signInPair, ...signInAttributes] = (setCookie(login, 'desk_signin') ?? '').split(';').map((part) => part.trim());
  assert.match(signInPair ?? '', /^desk_signin=[A-Za-z0-9_-]{43,}$/);
  assert.deepEqual(signInAttributes.sort(), ['HttpOnly', 'Max-Age=600', 'Path=/auth', 'SameSite=Lax']);

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  const [pair, ...attributes] = (setCookie(callback, 'desk_session') ?? '').split(';').map((part) => part.trim());
  assert.match(pair ?? '', /^desk_session=[A-Za-z0-9_-]{43,}$/);
  assert.deepEqual(attributes.sort(), ['HttpOnly', 'Path=/', 'SameSite=Lax']);
  assert.equal(setCookie(callback, 'desk_signin'), 'desk_signin=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0');

  const session = await fetch(`${client.url}/api/session`, { headers: { cookie: pair ?? '' } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    user: { name: 'Riley Reviewer', username: 'riley.reviewer', roles: ['default-roles-lab', 'reviewer'], is_reviewer: true },
  });

  const authorized = client.issuer.received.find((request) => request.path === '/authorize');
  const exchanged = client.issuer.received.find((request) => request.path === '/token');
  assert.ok(authorized !== undefined && exchanged !== undefined);
  assert.equal(exchanged.form.grant_type, 'authorization_code');
  assert.equal(exchanged.form.client_secret, CLIENT_SECRET);
  const challenge = createHash('sha256').update(exchanged.form.code_verifier ?? '', 'ascii').digest('base64url');
  assert.equal(challenge, authorized.query.code_challenge);
});

type CallbackRow = { name: string; status: number; pageSays: RegExp; arrange: (client: RunningClient) => Promise<Response> };

// Each row signs in some wrong way and returns the client's answer to the callback.
const CALLBACK_REFUSALS: CallbackRow[] = [
  {
    name: 'unknown state',
    status: 400,
    pageSays: /not valid or has expired/,
    arrange: (client) => fetch(`${client.url}/auth/callback?code=abc&state=never-issued`, { redirect: 'manual' }),
  },
  {
    name: 'the same state used twice',
    status: 400,
    pageSays: /not valid or has expired/,
    arrange: async (client) => {
      const { callback, callbackQuery, signInCookie } = await signInSteps(client.url, client.issuer, RILEY);
      await callback.body?.cancel();
      assert.equal(callback.status, 302, 'the first use should sign in');
      return fetch(`${client.url}/auth/callback${callbackQuery}`, { redirect: 'manual', headers: { cookie: signInCookie } });
    },
  },
  {
    // A sign-in must complete in under 10 minutes, so one exactly 10 minutes old is already too old.
    name: 'a state 10 minutes old',
    status: 400,
    pageSays: /not valid or has expired/,
    arrange: async (client) => {
      client.issuer.signInAs(RILEY);
      const login = await fetch(`${client.url}/auth/login`, { redirect: 'manual' });
      const { callbackQuery } = await authorizeAt(login);
      client.clock.advance(10 * 60 * 1000);
      const cookie = cookiePair(setCookie(login, 'desk_signin'));
      return fetch(`${client.url}/auth/callback${callbackQuery}`, { redirect: 'manual', headers: { cookie } });
    },
  },
  {
    name: 'error=access_denied from the provider',
    status: 400,
    pageSays: /access_denied/,
    arrange: async (client) => {
      client.issuer.misbehave('deny_sign_in');
      return (await signInSteps(client.url, client.issuer, RILEY)).callback;
    },
  },
  {
    name: 'a code the provider refuses',
    status: 502,
    pageSays: /could not be completed/,
    arrange: async (client) => {
      client.issuer.misbehave('refuse_code');
      return (await signInSteps(client.url, client.issuer, RILEY)).callback;
    },
  },
];

async function assertNoSession(client: RunningClient, response: Response, row: string): Promise<string> {
  assert.equal(setCookie(response, 'desk_session'), undefined, `${row}: a session cookie was set`);
  const session = await fetch(`${client.url}/api/session`);
  assert.equal(session.status, 401, row);
  await session.body?.cancel();
  return response.text();
}

test('C4. callback refusals: unknown, reused and stale state, a provider error, a refused code; none gives a session', async (t) => {
  for (const row of CALLBACK_REFUSALS) {
    const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t), user: null });
    const response = await row.arrange(client);
    assert.equal(response.status, row.status, row.name);
    const page = await assertNoSession(client, response, row.name);
    assert.match(page, row.pageSays, row.name);
  }
});

test('C5. an ID token with a wrong nonce, audience or issuer, another key, or past its expiry is refused with 502', async (t) => {
  const rows: Misbehaviour[] = ['wrong_nonce', 'wrong_audience', 'wrong_issuer', 'other_key', 'expired'];
  for (const misbehaviour of rows) {
    const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t), user: null });
    client.issuer.misbehave(misbehaviour);
    const { callback } = await signInSteps(client.url, client.issuer, RILEY);
    assert.equal(callback.status, 502, misbehaviour);
    const page = await assertNoSession(client, callback, misbehaviour);
    assert.match(page, /could not be completed/, misbehaviour);
  }
});

test('C6. an inquiry reaches the agent with the session access token, and records who entered and started it', async (t) => {
  const { agent, client } = await withAgent(t);
  const accepted = await postJson(`${client.url}/api/inquiries`, INQUIRY);
  assert.equal(accepted.status, 202);
  await eventually(
    async () => invocations(agent).length,
    (count) => count === 1,
  );
  assert.equal(invocations(agent)[0]?.authorization, `Bearer ${lastIssued(client).access_token}`);

  const stored = client.store.getInquiry('id-1');
  assert.deepEqual(stored?.entered_by, { name: 'Riley Reviewer' });
  assert.deepEqual(stored?.runs[0]?.started_by, { name: 'Riley Reviewer' });
});

test('C7. a token with under 180 seconds left is renewed before the agent is called; a refused renewal ends the session', async (t) => {
  const { agent, client } = await withAgent(t);
  const first = lastIssued(client).access_token;
  client.clock.advance((600 - 179) * 1000);

  assert.equal((await postJson(`${client.url}/api/inquiries`, INQUIRY)).status, 202);
  await eventually(
    async () => invocations(agent).length,
    (count) => count === 1,
  );
  const renewed = lastIssued(client).access_token;
  assert.notEqual(renewed, first);
  assert.equal(invocations(agent)[0]?.authorization, `Bearer ${renewed}`);
  assert.ok(client.issuer.received.some((request) => request.form.grant_type === 'refresh_token'));

  client.issuer.misbehave('refuse_refresh');
  client.clock.advance((600 - 179) * 1000);
  const refused = await postJson(`${client.url}/api/inquiries`, INQUIRY);
  assert.equal(refused.status, 401);
  assert.equal(prop(refused.body, 'error'), 'not_signed_in');
  assert.equal(invocations(agent).length, 1, 'the agent was called with a token that could not be renewed');
  assert.equal(client.store.listInquiries().inquiries.length, 1, 'an inquiry was stored for the refused request');
  assert.equal(client.store.getInquiry('id-1')?.runs.length, 1, 'a run was started for the refused request');
  assert.equal((await getJson(`${client.url}/api/session`)).status, 401, 'the session survived');
});

test('C8. list, get and review carry the bearer token; health checks carry no Authorization header', async (t) => {
  const agent = await startAgent(t);
  const cases = await startCaseSystem(t);
  const client = await startClient(t, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: '', url: agent.url }],
    caseReviewUrl: cases.url,
    webRoot: tempDir(t),
  });
  assert.equal((await getJson(`${client.url}/api/cases`)).status, 200);
  assert.equal((await getJson(`${client.url}/api/cases/AE-000001`)).status, 200);
  assert.equal((await postJson(`${client.url}/api/cases/AE-000001/review`, { decision: 'approve' })).status, 200);
  const bearer = `Bearer ${lastIssued(client).access_token}`;
  assert.deepEqual(
    cases.received.map((entry) => [entry.method, entry.path, entry.authorization]),
    [
      ['GET', '/cases', bearer],
      ['GET', '/cases/AE-000001', bearer],
      ['POST', '/cases/AE-000001/review', bearer],
    ],
  );

  assert.equal((await getJson(`${client.url}/api/status`)).status, 200);
  assert.deepEqual(pings(cases).map((entry) => entry.authorization), [undefined]);
  assert.deepEqual(pings(agent).map((entry) => entry.authorization), [undefined]);
});

test('C9. a review goes out under the signed-in reviewer; a body naming a reviewer is 400; a non-reviewer is 403', async (t) => {
  const cases = await startCaseSystem(t);
  const reviewer = await startClient(t, { agents: [], caseReviewUrl: cases.url, webRoot: tempDir(t), user: RILEY });
  const review = `${reviewer.url}/api/cases/AE-000001/review`;

  assert.equal((await postJson(review, { decision: 'reject', note: 'Not an adverse event.' })).status, 200);
  assert.deepEqual(cases.received.map((entry) => entry.body), [
    { decision: 'reject', note: 'Not an adverse event.', reviewer: 'Riley Reviewer' },
  ]);

  const named = await postJson(review, { decision: 'approve', reviewer: 'Someone Else' });
  assert.equal(named.status, 400);
  assert.equal(prop(named.body, 'error'), 'bad_request');
  assert.equal(cases.received.length, 1, 'a review naming its own reviewer was forwarded');

  const desk = await startClient(t, { agents: [], caseReviewUrl: cases.url, webRoot: tempDir(t), user: DANA });
  const refused = await postJson(`${desk.url}/api/cases/AE-000001/review`, { decision: 'approve' });
  assert.equal(refused.status, 403);
  assert.equal(prop(refused.body, 'error'), 'not_a_reviewer');
  assert.equal(cases.received.length, 1, "a non-reviewer's decision was forwarded");
});

test('C10. sign-out ends the session, clears the cookie, revokes the refresh token, and returns an end-session URL with no token', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t) });
  const cookie = cookieFor(client.url) ?? '';
  const issued = lastIssued(client);

  const response = await fetch(`${client.url}/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), 'desk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  const text = await response.text();
  const signOut = new URL(String(prop(JSON.parse(text), 'sign_out_url')));
  assert.equal(`${signOut.origin}${signOut.pathname}`, `${client.issuer.url}/logout`);
  assert.deepEqual([...signOut.searchParams.keys()].sort(), ['client_id', 'post_logout_redirect_uri']);
  assert.equal(signOut.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(signOut.searchParams.get('post_logout_redirect_uri'), POST_LOGOUT_REDIRECT_URI);
  for (const token of [issued.access_token, issued.refresh_token, issued.id_token]) {
    assert.ok(!text.includes(token), 'the sign-out answer carries a token');
  }

  // The stand-in's discovery document names an unreachable revocation endpoint, as Keycloak's does; the
  // revocation arrived, so the client used the configured endpoint and not the discovery value.
  const revocations = client.issuer.received.filter((request) => request.path === '/revoke');
  assert.equal(revocations.length, 1);
  assert.equal(revocations[0]?.form.token, issued.refresh_token);
  assert.equal(revocations[0]?.form.client_secret, CLIENT_SECRET);
  const refresh = await fetch(`${client.issuer.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: issued.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  });
  assert.equal(refresh.status, 400, 'the revoked refresh token still works at the provider');
  await refresh.body?.cancel();

  const after = await fetch(`${client.url}/api/session`, { headers: { cookie } });
  assert.equal(after.status, 401);
  await after.body?.cancel();

  // A revocation endpoint that refuses, or does not answer, does not keep anyone signed in.
  for (const misbehaviour of ['refuse_revocation', 'no_answer'] as const) {
    const other = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t) });
    const otherCookie = cookieFor(other.url) ?? '';
    other.issuer.misbehave(misbehaviour);
    const signedOut = await fetch(`${other.url}/auth/logout`, { method: 'POST', headers: { cookie: otherCookie } });
    assert.equal(signedOut.status, 200, misbehaviour);
    assert.equal(signedOut.headers.get('set-cookie'), 'desk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', misbehaviour);
    assert.match(String(prop(await signedOut.json(), 'sign_out_url')), /\/logout\?/, misbehaviour);
    assert.ok(other.issuer.received.some((request) => request.path === '/revoke'), `${misbehaviour}: no revocation was tried`);
    const gone = await fetch(`${other.url}/api/session`, { headers: { cookie: otherCookie } });
    assert.equal(gone.status, 401, misbehaviour);
    await gone.body?.cancel();
  }

  // With the setting none, no revocation is tried and sign-out still ends the session.
  const without = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t), revocationEndpoint: null });
  const withoutCookie = cookieFor(without.url) ?? '';
  const plain = await fetch(`${without.url}/auth/logout`, { method: 'POST', headers: { cookie: withoutCookie } });
  assert.equal(plain.status, 200);
  await plain.body?.cancel();
  assert.ok(!without.issuer.received.some((request) => request.path === '/revoke'), 'a revocation was tried with the setting none');
  const ended = await fetch(`${without.url}/api/session`, { headers: { cookie: withoutCookie } });
  assert.equal(ended.status, 401);
  await ended.body?.cancel();
});

test('C11. a POST from another origin is refused with 403 and does nothing; from the app origin or with no Origin it works', async (t) => {
  const { agent, client } = await withAgent(t);
  const foreign = await postJson(`${client.url}/api/inquiries`, INQUIRY, { origin: 'http://elsewhere.example.org' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.body, { error: 'cross_site_request', detail: 'This request came from another site and was refused.' });
  assert.equal(client.store.listInquiries().inquiries.length, 0);

  assert.equal((await postJson(`${client.url}/api/inquiries`, INQUIRY, { origin: APP_ORIGIN })).status, 202);
  assert.equal((await postJson(`${client.url}/api/inquiries`, INQUIRY)).status, 202);
  await eventually(
    async () => invocations(agent).length,
    (count) => count === 2,
  );
  assert.equal(client.store.listInquiries().inquiries.length, 2);
});

test('C12. a provider naming another issuer, or not answering, makes sign-in 502; /ping and the app shell still answer', async (t) => {
  const mismatch = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: webRootWithApp(t), user: null });
  mismatch.issuer.misbehave('wrong_discovery_issuer');
  const named = await fetch(`${mismatch.url}/auth/login`, { redirect: 'manual' });
  assert.equal(named.status, 502);
  const page = await named.text();
  assert.match(page, /identity_unreachable/);
  assert.match(page, /names the issuer &quot;http:\/\/localhost:8090\/realms\/lab-other&quot;, not &quot;http:\/\/localhost:8090\/realms\/lab&quot;/);
  await assertShellAndPing(mismatch.url);

  const silent = await startClient(t, {
    agents: [],
    caseReviewUrl: await deadUrl(t),
    webRoot: webRootWithApp(t),
    user: null,
    discoveryUrl: `${await deadUrl(t)}/realms/lab/.well-known/openid-configuration`,
  });
  const unreachable = await fetch(`${silent.url}/auth/login`, { redirect: 'manual' });
  assert.equal(unreachable.status, 502);
  assert.match(await unreachable.text(), /identity_unreachable: Could not reach the identity provider/);
  await assertShellAndPing(silent.url);
});

test('C15. no response body, and no header but Set-Cookie, carries the access, refresh or ID token', async (t) => {
  const agent = await startAgent(t);
  const cases = await startCaseSystem(t);
  const client = await startClient(t, {
    agents: [{ id: 'stand-in', name: 'Stand-in', description: '', url: agent.url }],
    caseReviewUrl: cases.url,
    webRoot: tempDir(t),
    user: null,
  });
  const seen: string[] = [];
  async function keep(response: Response): Promise<void> {
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') seen.push(`${name}: ${value}`);
    }
    // signInSteps has already drained the redirect from /auth/login, which has no body.
    seen.push(response.bodyUsed ? '' : await response.text());
  }

  const { login, callback } = await signInSteps(client.url, client.issuer, RILEY);
  await keep(login);
  const cookie = cookiePair(setCookie(callback, 'desk_session'));
  await keep(callback);
  const asUser = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${client.url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
  await keep(await asUser('/api/inquiries', { method: 'POST', body: JSON.stringify(INQUIRY) }));
  await eventually(
    async () => invocations(agent).length,
    (count) => count === 1,
  );
  await keep(await asUser('/api/inquiries/id-1'));
  await keep(await asUser('/api/cases/AE-000001/review', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }));
  await keep(await asUser('/api/session'));
  await keep(await asUser('/auth/logout', { method: 'POST' }));

  const tokens = client.issuer.issued.flatMap((issued) => [issued.access_token, issued.refresh_token, issued.id_token]);
  assert.ok(tokens.length >= 3);
  for (const token of tokens) {
    assert.ok(!seen.some((text) => text.includes(token)), 'a token reached the browser');
  }
});

test('C16. status lists the identity provider: up with the expected issuer, down with the reason otherwise', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t) });
  const identityPiece = async (): Promise<unknown> => {
    const pieces = prop((await getJson(`${client.url}/api/status`)).body, 'pieces');
    assert.ok(Array.isArray(pieces));
    return pieces.find((piece) => prop(piece, 'id') === 'identity');
  };

  assert.deepEqual(await identityPiece(), {
    id: 'identity',
    name: 'Identity provider',
    role: 'Signs desk staff in and issues the tokens sent to agents and the case system.',
    state: 'up',
    detail: 'Answered the health check.',
  });

  client.issuer.misbehave('wrong_discovery_issuer');
  const differs = await identityPiece();
  assert.equal(prop(differs, 'state'), 'down');
  assert.match(String(prop(differs, 'detail')), /names the issuer "http:\/\/localhost:8090\/realms\/lab-other"/);

  client.issuer.misbehave('no_answer');
  const silent = await identityPiece();
  assert.equal(prop(silent, 'state'), 'down');
  assert.match(String(prop(silent, 'detail')), /^Could not reach the identity provider: /);
});

test('C17. a callback completes a sign-in only in the browser that started it, by its sign-in cookie', async (t) => {
  const client = await startClient(t, { agents: [], caseReviewUrl: await deadUrl(t), webRoot: tempDir(t), user: null });
  client.issuer.signInAs(RILEY);

  async function started(): Promise<{ query: string; cookie: string }> {
    const login = await fetch(`${client.url}/auth/login`, { redirect: 'manual' });
    await login.body?.cancel();
    const { callbackQuery } = await authorizeAt(login);
    return { query: callbackQuery, cookie: cookiePair(setCookie(login, 'desk_signin')) };
  }
  const callback = (query: string, cookie: string | undefined): Promise<Response> =>
    fetch(`${client.url}/auth/callback${query}`, { redirect: 'manual', headers: cookie === undefined ? {} : { cookie } });

  const withoutCookie = await started();
  const noCookie = await callback(withoutCookie.query, undefined);
  assert.equal(noCookie.status, 400);
  assert.match(await assertNoSession(client, noCookie, 'no sign-in cookie'), /not valid or has expired/);
  const consumed = await callback(withoutCookie.query, withoutCookie.cookie);
  assert.equal(consumed.status, 400, 'a sign-in refused for a missing cookie was not consumed');
  await consumed.body?.cancel();

  const victim = await started();
  const attacker = await started();
  const crossed = await callback(victim.query, attacker.cookie);
  assert.equal(crossed.status, 400);
  assert.match(await assertNoSession(client, crossed, "another sign-in's cookie"), /not valid or has expired/);

  const own = await started();
  const completed = await callback(own.query, own.cookie);
  assert.equal(completed.status, 302);
  await completed.body?.cancel();
  assert.match(cookiePair(setCookie(completed, 'desk_session')), /^desk_session=.+/);
  assert.equal(setCookie(completed, 'desk_signin'), 'desk_signin=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0');
});
