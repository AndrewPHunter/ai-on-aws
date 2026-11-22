import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet } from 'jose';

import { startStandInIssuer } from '../issuer.ts';

const CLIENT = { clientId: 'desk', clientSecret: 'stand-in-secret', redirectUri: 'http://localhost:3000/auth/callback' };
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');

test('S1. the stand-in refuses a wrong client secret and a wrong verifier, and its signatures verify only with its own key', async (t) => {
  const issuer = await startStandInIssuer({
    ...CLIENT,
    postLogoutRedirectUri: 'http://localhost:3000/',
    now: () => new Date('2026-03-01T09:00:00Z'),
  });
  t.after(() => issuer.close());
  issuer.signInAs({ sub: 'u-1', preferred_username: 'riley.reviewer', name: 'Riley Reviewer', roles: ['reviewer'] });

  async function code(): Promise<string> {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: CLIENT.redirectUri,
      state: 's',
      nonce: 'n',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    const response = await fetch(`${issuer.url}/authorize?${query.toString()}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const found = new URL(response.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(found !== null);
    return found;
  }

  async function exchange(secret: string, verifier: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${issuer.url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: await code(),
        redirect_uri: CLIENT.redirectUri,
        code_verifier: verifier,
        client_id: CLIENT.clientId,
        client_secret: secret,
      }).toString(),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const wrongSecret = await exchange('not-the-secret', VERIFIER);
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.error, 'invalid_client');

  const wrongVerifier = await exchange(CLIENT.clientSecret, `${VERIFIER.slice(0, -1)}A`);
  assert.equal(wrongVerifier.status, 400);
  assert.equal(wrongVerifier.body.error, 'invalid_grant');

  const granted = await exchange(CLIENT.clientSecret, VERIFIER);
  assert.equal(granted.status, 200);
  const keys = createLocalJWKSet((await (await fetch(`${issuer.url}/jwks`)).json()) as JSONWebKeySet);
  const currentDate = new Date('2026-03-01T09:00:00Z');
  const idToken = granted.body.id_token;
  assert.ok(typeof idToken === 'string');
  const verified = await jwtVerify(idToken, keys, { issuer: issuer.issuer, audience: CLIENT.clientId, currentDate });
  assert.equal(verified.payload.nonce, 'n');

  const own = await issuer.mintAccessToken({ claims: { sub: 'u-1' }, lifetimeSeconds: 60 });
  await jwtVerify(own, keys, { currentDate });
  const foreign = await issuer.mintAccessToken({ claims: { sub: 'u-1' }, lifetimeSeconds: 60, signedBy: 'other_key' });
  await assert.rejects(jwtVerify(foreign, keys, { currentDate }), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
});

const NOW = new Date('2026-03-01T09:00:00Z');

async function verifiedClaims(issuerUrl: string, token: string): Promise<Record<string, unknown>> {
  const keys = createLocalJWKSet((await (await fetch(`${issuerUrl}/jwks`)).json()) as JSONWebKeySet);
  return { ...(await jwtVerify(token, keys, { currentDate: NOW })).payload };
}

async function postToken(issuerUrl: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${issuerUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test('S2. code and refresh tokens carry openid and the scopes granted; a refresh scope narrows to those granted and leaves the rest out with 200', async (t) => {
  const issuer = await startStandInIssuer({ ...CLIENT, postLogoutRedirectUri: 'http://localhost:3000/', now: () => NOW });
  t.after(() => issuer.close());

  async function signIn(scopes: readonly string[] | undefined): Promise<Record<string, unknown>> {
    issuer.signInAs({ sub: 'u-1', preferred_username: 'riley.reviewer', name: 'Riley Reviewer', roles: ['safety-reviewer'], ...(scopes === undefined ? {} : { scopes }) });
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: CLIENT.redirectUri,
      scope: 'openid',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    const authorize = await fetch(`${issuer.url}/authorize?${query.toString()}`, { redirect: 'manual' });
    const code = new URL(authorize.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const granted = await postToken(issuer.url, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CLIENT.redirectUri,
      code_verifier: VERIFIER,
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });
    assert.equal(granted.status, 200);
    return granted.body;
  }
  async function refresh(token: unknown, scope?: string): Promise<Record<string, unknown>> {
    const answer = await postToken(issuer.url, {
      grant_type: 'refresh_token',
      refresh_token: String(token),
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      ...(scope === undefined ? {} : { scope }),
    });
    assert.equal(answer.status, 200);
    return answer.body;
  }
  async function scopeClaim(body: Record<string, unknown>): Promise<unknown> {
    const claims = await verifiedClaims(issuer.url, String(body.access_token));
    assert.equal(claims.scope, body.scope, "the token's scope differs from the answer's");
    return claims.scope;
  }

  const signedIn = await signIn(['cases:read', 'cases:review']);
  assert.equal(await scopeClaim(signedIn), 'openid cases:read cases:review');

  const whole = await refresh(signedIn.refresh_token);
  assert.equal(await scopeClaim(whole), 'openid cases:read cases:review');

  const narrowed = await refresh(whole.refresh_token, 'openid cases:read agents:intake');
  assert.equal(await scopeClaim(narrowed), 'openid cases:read');
  assert.equal(issuer.received.filter((request) => request.path === '/token').at(-1)?.form.scope, 'openid cases:read agents:intake');

  // The refresh token from a narrowed refresh keeps the whole grant.
  assert.equal(await scopeClaim(await refresh(narrowed.refresh_token)), 'openid cases:read cases:review');

  assert.equal(await scopeClaim(await signIn(undefined)), 'openid');

  const minted = await issuer.mintAccessToken({ claims: { sub: 'u-1' }, lifetimeSeconds: 60, scopes: ['agents:intake', 'agents:expert'] });
  assert.equal((await verifiedClaims(issuer.url, minted)).scope, 'agents:intake agents:expert');
});

test('S3. the token exchange: client secret enforced; answers as scripted; a granted token is signed, for the audience, the requesting client and the subject, expiring with it', async (t) => {
  const issuer = await startStandInIssuer({
    clientId: 'intake-handwritten',
    clientSecret: 'agent-secret',
    redirectUri: CLIENT.redirectUri,
    postLogoutRedirectUri: 'http://localhost:3000/',
    now: () => NOW,
    exchangeClients: [{ clientId: 'expert', clientSecret: 'expert-secret' }],
  });
  t.after(() => issuer.close());
  const subject = await issuer.mintAccessToken({
    lifetimeSeconds: 300,
    scopes: ['agents:intake'],
    claims: { aud: ['intake-handwritten'], client_id: 'desk', sub: 'u-2', preferred_username: 'dana.desk', name: 'Dana Desk', roles: ['desk'] },
  });
  const form = (clientId: string, secret: string, audience = 'case-system'): Record<string, string> => ({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subject,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience,
    scope: 'cases:write cases:lookup',
    client_id: clientId,
    client_secret: secret,
  });

  issuer.scriptExchange({ kind: 'grant', scopes: ['cases:write', 'cases:lookup'] });
  const wrongSecret = await postToken(issuer.url, form('intake-handwritten', 'not-the-secret'));
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.body.error, 'invalid_client');

  const granted = await postToken(issuer.url, form('intake-handwritten', 'agent-secret'));
  assert.equal(granted.status, 200);
  assert.equal(granted.body.token_type, 'Bearer');
  assert.equal(granted.body.scope, 'cases:write cases:lookup');
  assert.equal(granted.body.expires_in, 300);
  assert.equal(granted.body.access_token, issuer.exchanged.at(-1));
  const claims = await verifiedClaims(issuer.url, String(granted.body.access_token));
  assert.deepEqual(
    { aud: claims.aud, client_id: claims.client_id, azp: claims.azp, sub: claims.sub, preferred_username: claims.preferred_username, name: claims.name, roles: claims.roles, scope: claims.scope },
    { aud: 'case-system', client_id: 'intake-handwritten', azp: 'intake-handwritten', sub: 'u-2', preferred_username: 'dana.desk', name: 'Dana Desk', roles: ['desk'], scope: 'cases:write cases:lookup' },
  );
  assert.equal(claims.exp, Math.floor(NOW.getTime() / 1000) + 300);

  issuer.scriptExchange({ kind: 'grant', scopes: ['labels:search'], audience: 'knowledge' });
  const other = await postToken(issuer.url, form('expert', 'expert-secret', 'expert'));
  const otherClaims = await verifiedClaims(issuer.url, String(other.body.access_token));
  assert.equal(otherClaims.aud, 'knowledge');
  assert.equal(otherClaims.client_id, 'expert');

  issuer.scriptExchange({ kind: 'error', status: 403, error: 'access_denied', description: 'Client is not within the token audience' });
  assert.deepEqual(await postToken(issuer.url, form('intake-handwritten', 'agent-secret')), {
    status: 403,
    body: { error: 'access_denied', error_description: 'Client is not within the token audience' },
  });

  issuer.scriptExchange({ kind: 'raw', status: 502, contentType: 'text/plain', body: 'Bad gateway' });
  const rawAnswer = await fetch(`${issuer.url}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form('intake-handwritten', 'agent-secret')).toString(),
  });
  assert.equal(rawAnswer.status, 502);
  assert.equal(rawAnswer.headers.get('content-type'), 'text/plain');
  assert.equal(await rawAnswer.text(), 'Bad gateway');

  const foreign = await issuer.mintAccessToken({ lifetimeSeconds: 300, signedBy: 'other_key', claims: { sub: 'u-2' } });
  const notOurs = await postToken(issuer.url, { ...form('intake-handwritten', 'agent-secret'), subject_token: foreign });
  assert.equal(notOurs.status, 400);
});

test('S4. a held path records the request and never answers it, while other paths answer', async (t) => {
  const issuer = await startStandInIssuer({ ...CLIENT, postLogoutRedirectUri: 'http://localhost:3000/', now: () => NOW });
  t.after(() => issuer.close());
  const paths = { hold_discovery: '/.well-known/openid-configuration', hold_keys: '/jwks', hold_token: '/token' } as const;
  for (const [hold, path] of Object.entries(paths)) {
    issuer.misbehave(hold as keyof typeof paths);
    const init: RequestInit = path === '/token' ? { method: 'POST', body: 'grant_type=refresh_token' } : {};
    await assert.rejects(fetch(`${issuer.url}${path}`, { ...init, signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' }, hold);
    assert.equal(issuer.received.at(-1)?.path, path, hold);
    const elsewhere = path === '/jwks' ? '/.well-known/openid-configuration' : '/jwks';
    const answered = await fetch(`${issuer.url}${elsewhere}`);
    assert.equal(answered.status, 200, hold);
    await answered.body?.cancel();
  }
});
