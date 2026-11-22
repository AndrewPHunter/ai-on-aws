// Real signed access tokens for the case system's tests, from the stand-in issuer in test-support/,
// checked by the real shared check configured as the case system is: audience lab-case-system, client
// desk, no minimum remaining life.

import type { TestContext } from 'node:test';

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import type { AccessTokenCheck } from '../../../shared/access-token.ts';
import { startStandInIssuer } from '../../../test-support/issuer.ts';
import type { MintOptions, StandInIssuer } from '../../../test-support/issuer.ts';

export const ISSUER = 'http://localhost:8090/realms/lab';
export const REVIEWER_ROLE = 'reviewer';
// The scopes the case system requires, as its compose file sets them.
export const CASE_SYSTEM_SCOPES = ['cases:write', 'cases:lookup', 'cases:read', 'cases:review'];

export const RILEY = {
  aud: ['lab-agents', 'lab-case-system'],
  client_id: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01',
  preferred_username: 'riley.reviewer',
  name: 'Riley Reviewer',
  roles: ['default-roles-lab', 'reviewer'],
  scope: CASE_SYSTEM_SCOPES.join(' '),
};

export const DANA = {
  ...RILEY,
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
  roles: ['default-roles-lab'],
};

export type Tokens = {
  issuer: StandInIssuer;
  check: AccessTokenCheck;
  // A token for Riley (a reviewer), 600 s to live, overridden as asked.
  mint: (options?: Partial<MintOptions>) => Promise<string>;
};

export async function startTokens(t: TestContext, now: () => Date): Promise<Tokens> {
  const issuer = await startStandInIssuer({
    clientId: 'desk',
    clientSecret: 'stand-in-secret',
    redirectUri: 'http://localhost:3000/auth/callback',
    postLogoutRedirectUri: 'http://localhost:3000/',
    now,
    issuer: ISSUER,
  });
  t.after(() => issuer.close());
  const check = createAccessTokenCheck(
    {
      discoveryUrl: issuer.discoveryUrl,
      issuer: ISSUER,
      audience: 'lab-case-system',
      allowedClients: ['desk'],
      requiredScopes: CASE_SYSTEM_SCOPES,
      rolesClaim: 'roles',
      minRemainingSeconds: 0,
    },
    { now, keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
  );
  const mint = (options: Partial<MintOptions> = {}): Promise<string> =>
    issuer.mintAccessToken({ lifetimeSeconds: 600, ...options, claims: { ...RILEY, ...options.claims } });
  return { issuer, check, mint };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
