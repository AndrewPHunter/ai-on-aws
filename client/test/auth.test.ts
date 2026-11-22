// Invariants 4, 7 and 8 of client/README.md ("Always true"): signing in, what the browser is given, signing out.
// Invariant 4 is about a provider vouching for a sign-in, so the provider here is the stand-in issuer
// (test-support/issuer.ts), which signs real ID tokens, enforces PKCE and records every request. It is started once
// for the file; invariants 7 and 8 use it too, since the tokens to look for and the revocation are its. Agents and
// the case system are scripted servers.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { Misbehaviour, ScriptedUser } from '../../test-support/issuer.ts';
import { IdentityProvider } from '../src/identity.ts';
import { APP_ORIGIN, EXAMPLE_RESPONSE, clock, deskConfig, scripted, settled, startDesk } from './support.ts';

const time = clock();
const issuer = await startStandInIssuer({
  clientId: 'desk',
  clientSecret: 'stand-in-desk-secret',
  redirectUri: `${APP_ORIGIN}/auth/callback`,
  postLogoutRedirectUri: `${APP_ORIGIN}/`,
  now: time.now,
});
after(() => issuer.close());
const agent = await scripted({ after }, () => ({ status: 200, body: EXAMPLE_RESPONSE }));
const cases = await scripted({ after }, () => ({ status: 200, body: { answered: 'by the case system' } }));
const config = deskConfig({
  agents: [{ id: 'first', name: 'First', description: 'scripted', url: agent.url }],
  caseReviewUrl: cases.url,
  discoveryUrl: issuer.discoveryUrl,
  issuer: issuer.issuer,
  revocationEndpoint: issuer.revocationUrl,
});
const identity = new IdentityProvider(config.oidc, { claim: config.rolesClaim, reviewerRole: config.reviewerRole }, time.now);
const desk = await startDesk({ after }, config, time, identity);

const RILEY: ScriptedUser = { sub: 'sub-riley', preferred_username: 'riley.reviewer', name: 'Riley Reviewer', roles: ['reviewer'] };
const DANA: ScriptedUser = { sub: 'sub-dana', preferred_username: 'dana.desk', name: 'Dana Desk', roles: [] };

// Every response the client gives in this file, headers and body, for invariant 7.
const responses: string[] = [];

async function client(path: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`${desk.url}${path}`, { redirect: 'manual', ...init });
  const text = await response.text();
  responses.push(`${[...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${text}`);
  return { status: response.status, headers: response.headers, text };
}

function cookie(headers: Headers, name: string): string | undefined {
  return headers.getSetCookie().find((line) => line.startsWith(`${name}=`) && !line.startsWith(`${name}=;`))?.split(';')[0];
}

// The browser's /auth/login: the sign-in cookie it is given, and where it is sent to sign in.
async function begin(): Promise<{ signIn: string | undefined; authorize: string }> {
  const login = await client('/auth/login');
  return { signIn: cookie(login.headers, 'desk_signin'), authorize: login.headers.get('location') ?? '' };
}

// The provider's part: signs the scripted user in and gives the callback's query.
async function callbackQuery(authorize: string): Promise<string> {
  const response = await fetch(authorize, { redirect: 'manual' });
  await response.body?.cancel();
  return new URL(response.headers.get('location') ?? '').search;
}

// The callback, with the cookie the browser holds. Returns the session cookie it sets, if any.
async function complete(query: string, signIn: string | undefined): Promise<string | undefined> {
  const response = await client(`/auth/callback${query}`, signIn === undefined ? {} : { headers: { cookie: signIn } });
  return cookie(response.headers, 'desk_session');
}

async function accepted(session: string | undefined): Promise<boolean> {
  return session !== undefined && (await client('/api/session', { headers: { cookie: session } })).status === 200;
}

async function signIn(user: ScriptedUser): Promise<string> {
  issuer.signInAs(user);
  const started = await begin();
  const session = await complete(await callbackQuery(started.authorize), started.signIn);
  assert.ok(session !== undefined && (await accepted(session)), 'the sign-in did not create a session');
  return session;
}

test('invariant 4: only a sign-in the provider vouched for, completed by the browser that started it, creates a session', async (t) => {
  issuer.signInAs(DANA);
  const whole = async (): Promise<string | undefined> => {
    const started = await begin();
    return complete(await callbackQuery(started.authorize), started.signIn);
  };
  const rows: { name: string; misbehave?: Misbehaviour; vouched: boolean; session: () => Promise<string | undefined> }[] = [
    {
      name: 'a whole sign-in, by the browser that started it (state and PKCE verifier carried)',
      vouched: true,
      session: whole,
    },
    {
      name: 'the ID token names another nonce than this sign-in sent',
      misbehave: 'wrong_nonce',
      vouched: false,
      session: whole,
    },
    {
      name: 'the ID token is signed with a key the provider does not publish',
      misbehave: 'other_key',
      vouched: false,
      session: whole,
    },
    {
      name: 'a second callback for a sign-in already completed, with a fresh code',
      vouched: false,
      session: async () => {
        const started = await begin();
        const [first, second] = [await callbackQuery(started.authorize), await callbackQuery(started.authorize)];
        assert.ok(await accepted(await complete(first, started.signIn)));
        return complete(second, started.signIn);
      },
    },
    {
      name: 'the callback without the sign-in cookie',
      vouched: false,
      session: async () => complete(await callbackQuery((await begin()).authorize), undefined),
    },
    {
      name: "the callback with another sign-in's cookie",
      vouched: false,
      session: async () => {
        const [mine, other] = [await begin(), await begin()];
        return complete(await callbackQuery(mine.authorize), other.signIn);
      },
    },
  ];
  for (const row of rows) {
    await t.test(row.name, async () => {
      issuer.misbehave(row.misbehave ?? 'none');
      try {
        assert.equal(await accepted(await row.session()), row.vouched);
      } finally {
        issuer.misbehave('none');
      }
    });
  }
});

test('invariant 7: no token reaches the browser', async () => {
  const issuedBefore = issuer.issued.length;
  const session = await signIn(RILEY);
  const headers = { cookie: session, 'content-type': 'application/json' };
  for (const path of ['/api/session', '/api/agents', '/api/samples', '/api/status', '/api/cases', '/api/cases/AE-71']) {
    assert.equal((await client(path, { headers })).status, 200, path);
  }
  const post = (path: string, body: unknown) => client(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const id = String((JSON.parse((await post('/api/inquiries', { sender: 'A clinician', text: 'synthetic', agent_id: 'first' })).text) as { inquiry: { id: string } }).inquiry.id);
  await settled(desk, id, session);
  await client('/api/inquiries', { headers });
  await client(`/api/inquiries/${id}`, { headers });
  await post('/api/cases/AE-71/review', { decision: 'approve' });
  // Short of an agent run's 180 s, so the token is renewed and the renewed tokens are looked for too.
  time.advance(500_000);
  assert.equal((await post(`/api/inquiries/${id}/runs`, { agent_id: 'first' })).status, 202);
  await settled(desk, id, session);
  assert.equal((await post('/auth/logout', {})).status, 200);
  const tokens = issuer.issued.flatMap((set) => [set.access_token, set.refresh_token, set.id_token]);
  assert.ok(issuer.issued.length - issuedBefore >= 2, 'this test was not issued tokens and renewed ones, so it looked for nothing');
  for (const token of tokens) {
    assert.equal(responses.find((response) => response.includes(token)), undefined, 'a response carries a token');
  }
});

test('invariant 8: signing out removes the session and revokes the refresh token, even when the revocation fails', async (t) => {
  for (const misbehaviour of ['none', 'refuse_revocation'] as const) {
    await t.test(misbehaviour === 'none' ? 'revocation accepted' : 'revocation refused', async () => {
      const before = issuer.issued.length;
      const session = await signIn(DANA);
      const mine = issuer.issued.slice(before);
      assert.equal(mine.length, 1);
      issuer.misbehave(misbehaviour);
      try {
        assert.equal((await client('/auth/logout', { method: 'POST', headers: { cookie: session } })).status, 200);
      } finally {
        issuer.misbehave('none');
      }
      assert.equal(await accepted(session), false);
      const revoked = issuer.received.some((r) => r.method === 'POST' && r.path === '/revoke' && r.form.token === mine[0]?.refresh_token);
      assert.ok(revoked, 'the refresh token was not sent for revocation');
    });
  }
});
