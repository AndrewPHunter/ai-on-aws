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
