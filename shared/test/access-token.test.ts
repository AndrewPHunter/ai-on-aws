// The token check's invariants 1 to 4 ("Always true" in shared/README.md), one test each. Invariant 1 is about
// verifying a signature, so the tokens are really signed, by the stand-in issuer in test-support/.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { MintOptions } from '../../test-support/issuer.ts';
import { createAccessTokenCheck } from '../access-token.ts';

const START = new Date('2026-03-01T10:00:00.000Z').getTime();
const ISSUER = 'http://localhost:8090/realms/lab';
const MIN_LIFE = 150;
const WAIT = 30_000;
const CLAIMS = { aud: ['lab-agents', 'lab-case-system'], client_id: 'desk', sub: 'subject-riley', preferred_username: 'riley', name: 'Riley Reviewer', roles: ['reviewer'] };

async function rig(t: TestContext) {
  let at = START;
  const now = (): Date => new Date(at);
  const issuer = await startStandInIssuer({ clientId: 'desk', clientSecret: 'stand-in', redirectUri: 'http://localhost:3000/cb', postLogoutRedirectUri: 'http://localhost:3000/', now, issuer: ISSUER });
  t.after(() => issuer.close());
  const settings = { discoveryUrl: issuer.discoveryUrl, issuer: ISSUER, audience: 'lab-agents', allowedClients: ['desk'], rolesClaim: 'roles', minRemainingSeconds: MIN_LIFE };
  return {
    issuer,
    advance: (ms: number) => (at += ms),
    check: () => createAccessTokenCheck(settings, { now, keyRefetchWaitMs: WAIT, timeoutMs: 2000 }),
    mint: (options: Partial<MintOptions> = {}) => issuer.mintAccessToken({ lifetimeSeconds: 600, ...options, claims: { ...CLAIMS, ...options.claims } }),
    fetches: (path: string) => issuer.received.filter((request) => request.path === path).length,
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const bearer = async (token: Promise<string>): Promise<string> => `Bearer ${await token}`;

// One row per condition of invariant 1, each failing in that way only.
const REFUSALS: { name: string; header: (r: Rig) => Promise<string | undefined>; reason: string }[] = [
  { name: 'no token', header: () => Promise.resolve(undefined), reason: 'missing' },
  { name: 'not a JWT', header: () => Promise.resolve('Bearer not-a-jwt'), reason: 'malformed' },
  { name: 'a key the provider does not publish', header: (r) => bearer(r.mint({ signedBy: 'other_key' })), reason: 'bad_signature' },
  { name: 'not RS256', header: (r) => bearer(r.mint({ signedBy: 'hs256' })), reason: 'bad_signature' },
  { name: 'another issuer', header: (r) => bearer(r.mint({ claims: { iss: 'http://elsewhere.example/realms/lab' } })), reason: 'wrong_issuer' },
  { name: 'another audience', header: (r) => bearer(r.mint({ claims: { aud: ['lab-case-system'] } })), reason: 'wrong_audience' },
  { name: 'a client not allowed', header: (r) => bearer(r.mint({ claims: { client_id: 'other' } })), reason: 'wrong_client' },
  { name: 'expired', header: (r) => bearer(r.mint({ lifetimeSeconds: -1 })), reason: 'expired' },
  { name: 'too little life left', header: (r) => bearer(r.mint({ lifetimeSeconds: MIN_LIFE - 1 })), reason: 'expires_too_soon' },
];

test('shared 1. a caller only for a token that passes every condition; each failure names which', async (t) => {
  const r = await rig(t);
  const check = r.check();
  const token = await r.mint();
  assert.deepEqual(await check(`Bearer ${token}`), {
    kind: 'caller',
    caller: { subject: 'subject-riley', username: 'riley', name: 'Riley Reviewer', clientId: 'desk', roles: ['reviewer'], expiresAt: new Date(START + 600_000), token },
  });
  for (const row of REFUSALS) {
    const result = await check(await row.header(r));
    assert.equal(result.kind === 'refused' ? result.reason : result.kind, row.reason, row.name);
  }
});

test('shared 2. a provider that cannot be reached or cannot be used is unavailable, never a refusal, and the check recovers', async (t) => {
  const r = await rig(t);
  const header = await bearer(r.mint());
  for (const misbehaviour of ['no_answer', 'wrong_discovery_issuer', 'jwks_not_json', 'jwks_without_keys', 'jwks_with_bad_key'] as const) {
    const check = r.check();
    r.issuer.misbehave(misbehaviour);
    assert.equal((await check(header)).kind, 'unavailable', misbehaviour);
    r.issuer.misbehave('none');
    assert.equal((await check(header)).kind, 'caller', `${misbehaviour}, recovered`);
  }
});

test('shared 3. keys are fetched once, and again only for an unknown key, at most once per wait', async (t) => {
  const r = await rig(t);
  const check = r.check();
  const header = await bearer(r.mint());
  for (let n = 0; n < 3; n++) assert.equal((await check(header)).kind, 'caller');
  assert.deepEqual([r.fetches('/.well-known/openid-configuration'), r.fetches('/jwks')], [1, 1]);

  await r.issuer.rotateKey();
  const second = await bearer(r.mint());
  r.advance(WAIT - 1);
  assert.equal((await check(second)).kind, 'refused', 'an unknown key before the wait');
  assert.equal(r.fetches('/jwks'), 1);
  r.advance(1);
  assert.equal((await check(second)).kind, 'caller', 'an unknown key after the wait');
  assert.equal(r.fetches('/jwks'), 2);

  await r.issuer.rotateKey();
  assert.equal((await check(await bearer(r.mint()))).kind, 'refused', 'another unknown key inside the next wait');
  assert.deepEqual([r.fetches('/.well-known/openid-configuration'), r.fetches('/jwks')], [1, 2]);
});

test('shared 4. no refusal sentence contains the token', async (t) => {
  const r = await rig(t);
  const check = r.check();
  for (const row of REFUSALS) {
    const header = await row.header(r);
    const result = await check(header);
    const token = header?.split(' ')[1];
    assert.ok(result.kind === 'refused' && token !== undefined ? !result.detail.includes(token) : result.kind === 'refused', row.name);
  }
});
