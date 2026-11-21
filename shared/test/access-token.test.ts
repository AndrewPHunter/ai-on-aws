// The shared access-token check, against the stand-in issuer in test-support/ minting real signed tokens.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { MintOptions, StandInIssuer } from '../../test-support/issuer.ts';
import { createAccessTokenCheck } from '../access-token.ts';
import type { AccessTokenCheck, AccessTokenSettings, TokenCheck } from '../access-token.ts';

const START = '2026-03-01T10:00:00.000Z';
const ISSUER = 'http://localhost:8090/realms/lab';
const MIN_REMAINING = 150;

const CLAIMS = {
  aud: ['lab-agents', 'lab-case-system'],
  client_id: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01',
  preferred_username: 'riley.reviewer',
  name: 'Riley Reviewer',
  roles: ['default-roles-lab', 'reviewer'],
};

type Clock = { now: () => Date; advance: (ms: number) => void };

function clock(): Clock {
  let at = new Date(START).getTime();
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

type Rig = { issuer: StandInIssuer; clock: Clock; check: AccessTokenCheck; mint: (options?: Partial<MintOptions>) => Promise<string> };

async function rig(t: TestContext, overrides: Partial<AccessTokenSettings> = {}, keyRefetchWaitMs = 0): Promise<Rig> {
  const time = clock();
  const issuer = await startStandInIssuer({
    clientId: 'desk',
    clientSecret: 'stand-in-secret',
    redirectUri: 'http://localhost:3000/auth/callback',
    postLogoutRedirectUri: 'http://localhost:3000/',
    now: time.now,
    issuer: ISSUER,
  });
  t.after(() => issuer.close());
  const check = createAccessTokenCheck(
    {
      discoveryUrl: issuer.discoveryUrl,
      issuer: ISSUER,
      audience: 'lab-agents',
      allowedClients: ['desk'],
      rolesClaim: 'roles',
      minRemainingSeconds: MIN_REMAINING,
      ...overrides,
    },
    { now: time.now, keyRefetchWaitMs, timeoutMs: 2000 },
  );
  const mint = (options: Partial<MintOptions> = {}): Promise<string> =>
    issuer.mintAccessToken({ lifetimeSeconds: 600, ...options, claims: { ...CLAIMS, ...options.claims } });
  return { issuer, clock: time, check, mint };
}

function refusal(result: TokenCheck): { reason: string; detail: string } {
  assert.equal(result.kind, 'refused', `expected a refusal, got ${result.kind}`);
  return result.kind === 'refused' ? { reason: result.reason, detail: result.detail } : { reason: '', detail: '' };
}

const discoveryFetches = (issuer: StandInIssuer): number =>
  issuer.received.filter((request) => request.path === '/.well-known/openid-configuration').length;
const keyFetches = (issuer: StandInIssuer): number => issuer.received.filter((request) => request.path === '/jwks').length;

test('K1. a valid token gives the caller: subject, username, name, client id, roles, expiry, and the token', async (t) => {
  const r = await rig(t);
  const token = await r.mint();
  assert.deepEqual(await r.check(`Bearer ${token}`), {
    kind: 'caller',
    caller: {
      subject: CLAIMS.sub,
      username: 'riley.reviewer',
      name: 'Riley Reviewer',
      clientId: 'desk',
      roles: ['default-roles-lab', 'reviewer'],
      expiresAt: new Date(new Date(START).getTime() + 600_000),
      token,
    },
  });
});

test('K2. each refusal is named, with a sentence that does not contain the token; exactly the minimum life is accepted', async (t) => {
  const r = await rig(t);
  const { client_id: _client, ...withoutClient } = CLAIMS;
  const rows: { name: string; header: (r: Rig) => Promise<string | undefined>; reason: string }[] = [
    { name: 'no header', header: () => Promise.resolve(undefined), reason: 'missing' },
    { name: 'not Bearer', header: async (rr) => `Basic ${await rr.mint()}`, reason: 'missing' },
    { name: 'not a JWT', header: () => Promise.resolve('Bearer not-a-jwt'), reason: 'malformed' },
    { name: 'another key', header: async (rr) => `Bearer ${await rr.mint({ signedBy: 'other_key' })}`, reason: 'bad_signature' },
    { name: 'wrong issuer', header: async (rr) => `Bearer ${await rr.mint({ claims: { iss: 'http://elsewhere.example.org/realms/lab' } })}`, reason: 'wrong_issuer' },
    { name: 'audience lacking lab-agents', header: async (rr) => `Bearer ${await rr.mint({ claims: { aud: ['lab-case-system'] } })}`, reason: 'wrong_audience' },
    { name: 'client_id not allowed', header: async (rr) => `Bearer ${await rr.mint({ claims: { client_id: 'other-client' } })}`, reason: 'wrong_client' },
    {
      name: 'client_id missing',
      header: async (rr) => `Bearer ${await rr.issuer.mintAccessToken({ lifetimeSeconds: 600, claims: withoutClient })}`,
      reason: 'wrong_client',
    },
    { name: 'expired', header: async (rr) => `Bearer ${await rr.mint({ lifetimeSeconds: -1 })}`, reason: 'expired' },
    { name: 'less than the minimum left', header: async (rr) => `Bearer ${await rr.mint({ lifetimeSeconds: MIN_REMAINING - 1 })}`, reason: 'expires_too_soon' },
  ];
  for (const row of rows) {
    const header = await row.header(r);
    const { reason, detail } = refusal(await r.check(header));
    assert.equal(reason, row.reason, row.name);
    assert.ok(detail.length > 0, row.name);
    const token = header?.split(' ')[1];
    if (token !== undefined) {
      assert.ok(!detail.includes(token), `${row.name}: the sentence contains the token`);
    }
  }
  const exactly = await r.mint({ lifetimeSeconds: MIN_REMAINING });
  assert.equal((await r.check(`Bearer ${exactly}`)).kind, 'caller');
});

test('K3. a token signed with any algorithm but RS256, none included, is refused', async (t) => {
  const r = await rig(t);
  for (const signedBy of ['hs256', 'none'] as const) {
    const { reason } = refusal(await r.check(`Bearer ${await r.mint({ signedBy })}`));
    assert.equal(reason, 'bad_signature', signedBy);
  }
});

test('K4. a provider that is down, or names another issuer, makes the check unavailable, and it recovers', async (t) => {
  const r = await rig(t);
  const token = await r.mint();

  r.issuer.misbehave('no_answer');
  const down = await r.check(`Bearer ${token}`);
  assert.equal(down.kind, 'unavailable');

  r.issuer.misbehave('wrong_discovery_issuer');
  const other = await r.check(`Bearer ${token}`);
  assert.equal(other.kind, 'unavailable');
  assert.match(other.kind === 'unavailable' ? other.detail : '', /names the issuer/);

  r.issuer.misbehave('none');
  assert.equal((await r.check(`Bearer ${token}`)).kind, 'caller');
});

test('K5. after the issuer replaces its key, a token with the new key is accepted and one with the old key is refused', async (t) => {
  const r = await rig(t, {}, 30_000);
  const before = await r.mint();
  assert.equal((await r.check(`Bearer ${before}`)).kind, 'caller');

  await r.issuer.rotateKey();
  r.clock.advance(30_000);
  const after = await r.mint();
  assert.equal((await r.check(`Bearer ${after}`)).kind, 'caller');
  assert.equal(refusal(await r.check(`Bearer ${before}`)).reason, 'bad_signature');
});

test('K6. the discovery document and the keys are fetched once for many checks', async (t) => {
  const r = await rig(t, {}, 30_000);
  const token = await r.mint();
  for (let n = 0; n < 5; n++) {
    assert.equal((await r.check(`Bearer ${token}`)).kind, 'caller');
  }
  assert.equal(discoveryFetches(r.issuer), 1);
  assert.equal(keyFetches(r.issuer), 1);
});

test('K7. a correctly signed token lacking sub, preferred_username or name is refused as malformed', async (t) => {
  const r = await rig(t);
  for (const missing of ['sub', 'preferred_username', 'name'] as const) {
    const claims: Record<string, unknown> = { ...CLAIMS };
    delete claims[missing];
    const token = await r.issuer.mintAccessToken({ lifetimeSeconds: 600, claims });
    const { reason, detail } = refusal(await r.check(`Bearer ${token}`));
    assert.equal(reason, 'malformed', missing);
    assert.ok(!detail.includes(token), missing);
  }
});

test('K8. a key set the provider serves that cannot be used makes the check unavailable, and it recovers', async (t) => {
  for (const misbehaviour of ['jwks_not_json', 'jwks_without_keys', 'jwks_with_bad_key'] as const) {
    const r = await rig(t);
    const token = await r.mint();
    r.issuer.misbehave(misbehaviour);
    const broken = await r.check(`Bearer ${token}`);
    assert.equal(broken.kind, 'unavailable', misbehaviour);
    r.issuer.misbehave('none');
    assert.equal((await r.check(`Bearer ${token}`)).kind, 'caller', misbehaviour);
  }
});

test('K9. a token signed with a key not yet seen, before the refetch wait, fetches nothing and is refused; after the wait it is accepted', async (t) => {
  const r = await rig(t, {}, 30_000);
  assert.equal((await r.check(`Bearer ${await r.mint()}`)).kind, 'caller');
  assert.equal(keyFetches(r.issuer), 1);

  await r.issuer.rotateKey();
  const newKey = await r.mint();
  r.clock.advance(29_000);
  assert.equal(refusal(await r.check(`Bearer ${newKey}`)).reason, 'bad_signature');
  assert.equal(keyFetches(r.issuer), 1, 'the keys were fetched again before the wait had passed');

  r.clock.advance(1_000);
  assert.equal((await r.check(`Bearer ${newKey}`)).kind, 'caller');
  assert.equal(keyFetches(r.issuer), 2);
});
