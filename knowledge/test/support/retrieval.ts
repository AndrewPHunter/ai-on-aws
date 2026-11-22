// The retrieval service's test rig: real signed tokens from the stand-in issuer in test-support/, checked by the
// real shared check configured as the service is (audience lab-knowledge, client desk, no minimum remaining life),
// and an engine client pointed at the search stand-in.

import type { Server } from 'node:http';
import type { TestContext } from 'node:test';

import { createAccessTokenCheck } from '../../../shared/access-token.ts';
import type { AccessTokenCheck } from '../../../shared/access-token.ts';
import { startStandInIssuer } from '../../../test-support/issuer.ts';
import type { MintOptions, StandInIssuer } from '../../../test-support/issuer.ts';
import { createEngine } from '../../src/search/engine.ts';
import type { Engine } from '../../src/search/engine.ts';

export const ISSUER = 'http://localhost:8090/realms/lab';
export const NOW = new Date('2026-01-01T00:00:00Z');

export const DANA = {
  aud: ['lab-agents', 'lab-case-system', 'lab-knowledge'],
  client_id: 'desk',
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
  roles: ['default-roles-lab'],
};

export type Tokens = { issuer: StandInIssuer; check: AccessTokenCheck; mint: (options?: Partial<MintOptions>) => Promise<string> };

export async function startTokens(t: TestContext): Promise<Tokens> {
  const now = (): Date => NOW;
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
    { discoveryUrl: issuer.discoveryUrl, issuer: ISSUER, audience: 'lab-knowledge', allowedClients: ['desk'], rolesClaim: 'roles', minRemainingSeconds: 0 },
    { now, keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
  );
  const mint = (options: Partial<MintOptions> = {}): Promise<string> =>
    issuer.mintAccessToken({ lifetimeSeconds: 600, ...options, claims: { ...DANA, ...options.claims } });
  return { issuer, check, mint };
}

// An engine client for the stand-in. Its deadline is a signal the test controls, so no test waits on a clock.
export function testEngine(url: string): { engine: Engine; expire: () => void } {
  let controller = new AbortController();
  return {
    engine: createEngine({
      baseUrl: url,
      fetch: globalThis.fetch,
      deadline: () => {
        controller = new AbortController();
        return controller.signal;
      },
    }),
    expire: () => controller.abort(),
  };
}

export async function listen(server: Server, t: TestContext): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  return `http://127.0.0.1:${address.port}`;
}

export const SET_ID = '00000000-0000-4000-8000-0000000000a1';

// A chunk as the index holds it, with invented text.
export function indexedChunk(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `${SET_ID}/3/sec-${n}/body/1`,
    setId: SET_ID,
    version: 3,
    effectiveTime: '20240102',
    kind: 'prescription',
    format: 'new',
    documentTypeCode: '34391-3',
    drug: ['Examplamab'],
    section: { id: `sec-${n}`, code: '34068-7', number: `2.${n}`, title: `2.${n} Invented dosing`, path: ['2 DOSAGE', `2.${n} Invented dosing`] },
    part: 'body',
    type: 'text',
    position: { ordinal: n },
    text: `Invented passage ${n}.`,
    repeated: [],
    context: 'Examplamab: 2 DOSAGE',
    words: 3,
    source: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${SET_ID}&version=3`,
    ...overrides,
  };
}
