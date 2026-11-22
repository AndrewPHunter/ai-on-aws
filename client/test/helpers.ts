// What the client's tests share: servers on loopback, a temporary directory, deterministic clocks and
// randomness, an example agent answer, a bounded wait for background runs, and signing in through the
// stand-in OpenID Connect issuer (test-support/issuer.ts) with a browser-like cookie jar.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createAccessTokenCheck } from '../../shared/access-token.ts';
import type { AccessTokenCheck } from '../../shared/access-token.ts';
import type { InvocationResponse } from '../../shared/agent-contract.ts';
import { startStandInIssuer } from '../../test-support/issuer.ts';
import type { ScriptedUser, StandInIssuer } from '../../test-support/issuer.ts';
import type { AgentConfig, Config, OidcConfig } from '../src/config.ts';
import { IdentityProvider } from '../src/identity.ts';
import { createClientServer } from '../src/server.ts';
import { SessionStore } from '../src/sessions.ts';
import { InquiryStore } from '../src/store.ts';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

export function stop(server: Server): void {
  server.close();
  server.closeAllConnections();
}

// A URL that cannot be reached: it accepts each connection and closes it at once. It is held until the
// test ends, so no other test can be given its port in the meantime.
export async function deadUrl(t: TestContext): Promise<string> {
  const server = createNetServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no port');
  }
  return `http://127.0.0.1:${address.port}`;
}

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'client-test-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// Starts at a fixed instant and moves one second forward each time it is read.
export function steppingClock(start: string): () => Date {
  let seconds = 0;
  const base = new Date(start).getTime();
  return () => new Date(base + 1000 * seconds++);
}

export function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// Reads a field of a JSON value the test does not otherwise need to type.
export function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entries: Record<string, unknown> = { ...value };
  return entries[key];
}

export type Answer = { status: number; headers: Headers; body: unknown };

// --- A browser's cookie jar -------------------------------------------------------------------------
// One session cookie per origin, set by signIn. getJson, postJson and fetchAs send it, as a browser would.

const jar = new Map<string, string>();

export function cookieFor(url: string): string | undefined {
  return jar.get(new URL(url).origin);
}

export function fetchAs(url: string, init: RequestInit = {}): Promise<Response> {
  const cookie = cookieFor(url);
  const headers = new Headers(init.headers);
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  return fetch(url, { ...init, headers });
}

export async function getJson(url: string, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetchAs(url, { headers });
  const body: unknown = await response.json();
  return { status: response.status, headers: response.headers, body };
}

export async function postJson(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetchAs(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, headers: response.headers, body };
}

// Polls until the check passes, a few milliseconds apart, and fails the test if it never does.
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    await delay(10);
  }
  assert.fail('The condition was not met within the time allowed');
}

// An answer that keeps to the agent contract and names one case.
export const EXAMPLE_RESPONSE: InvocationResponse = {
  agent: { id: 'stand-in', implementation: 'test stand-in' },
  outcome: 'completed',
  stop_reason: null,
  reply: 'The maximum dose is in section 2 of the label.',
  citations: [
    {
      drug: 'atorvastatin',
      section: '2 Dosage',
      quote: 'Do not exceed 20 mg.',
      set_id: '00000000-0000-4000-8000-0000000000c1',
      version: 1,
      effective_date: '20260101',
      source: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00000000-0000-4000-8000-0000000000c1&version=1',
      passage: '00000000-0000-4000-8000-0000000000c1/1/sec-2/body/1',
    },
  ],
  case_actions: [{ kind: 'case_opened', case_id: 'AE-000001', status: 'awaiting_review' }],
  steps: [{ kind: 'error', started_at: '2026-01-01T00:00:00Z', duration_ms: 1, message: 'example step' }],
};

// --- Signing in -------------------------------------------------------------------------------------

export const APP_ORIGIN = 'http://localhost:3000';
export const REDIRECT_URI = 'http://localhost:3000/auth/callback';
// With its trailing slash, byte for byte as registered at the provider.
export const POST_LOGOUT_REDIRECT_URI = 'http://localhost:3000/';
// The issuer the stand-in names, as Keycloak does in the lab: not the address it is fetched at.
export const ISSUER = 'http://localhost:8090/realms/lab';
export const CLIENT_ID = 'desk';
export const CLIENT_SECRET = 'stand-in-desk-secret';

export const RILEY: ScriptedUser = {
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f01',
  preferred_username: 'riley.reviewer',
  name: 'Riley Reviewer',
  roles: ['default-roles-lab', 'reviewer'],
  scopes: ['cases:read', 'cases:review'],
};
export const DANA: ScriptedUser = {
  sub: '6b1f0c2e-5a3d-4e8f-9b71-2c4d8e0a1f02',
  preferred_username: 'dana.desk',
  name: 'Dana Desk',
  roles: ['default-roles-lab'],
  scopes: ['cases:read'],
};

// The scopes the case system requires, as its compose file sets them.
export const CASE_SYSTEM_SCOPES = ['cases:write', 'cases:lookup', 'cases:read', 'cases:review'];

// The clock sessions, tokens and the stand-in issuer go by. It moves only when a test moves it.
export type SettableClock = { now: () => Date; advance: (ms: number) => void };

export function settableClock(start: string): SettableClock {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms;
    },
  };
}

// Deterministic bytes: SHA-256 of the seed and a counter, as many as asked for.
export function seededRandom(seed: string): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    const out = Buffer.alloc(size);
    for (let filled = 0; filled < size; filled += 32) {
      createHash('sha256').update(`${seed}:${counter++}`).digest().copy(out, filled);
    }
    return out;
  };
}

// As Keycloak does in the lab, the stand-in's discovery document names a revocation endpoint the client
// cannot reach; the client is configured with the real one.
export async function startIssuer(t: TestContext, clock: SettableClock, issuer: string = ISSUER): Promise<StandInIssuer> {
  const standIn = await startStandInIssuer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT_URI,
    now: clock.now,
    issuer,
    discoveryRevocationEndpoint: `${await deadUrl(t)}/revoke`,
  });
  t.after(() => standIn.close());
  return standIn;
}

// The check the case system makes, configured as in the lab (audience lab-case-system, client desk), trusting
// the given stand-in issuer.
export function caseSystemCheck(issuer: StandInIssuer, clock: SettableClock): AccessTokenCheck {
  return createAccessTokenCheck(
    {
      discoveryUrl: issuer.discoveryUrl,
      issuer: issuer.issuer,
      audience: 'lab-case-system',
      allowedClients: [CLIENT_ID],
      requiredScopes: CASE_SYSTEM_SCOPES,
      rolesClaim: 'roles',
      minRemainingSeconds: 0,
    },
    { now: clock.now, keyRefetchWaitMs: 30_000, timeoutMs: 2000 },
  );
}

// An access token for a user, minted directly by the stand-in, with the lab's claims.
export function tokenFor(issuer: StandInIssuer, user: ScriptedUser): Promise<string> {
  return issuer.mintAccessToken({
    lifetimeSeconds: 600,
    scopes: user.scopes ?? [],
    claims: {
      aud: ['lab-agents', 'lab-case-system'],
      client_id: CLIENT_ID,
      sub: user.sub,
      preferred_username: user.preferred_username,
      name: user.name,
      roles: user.roles,
    },
  });
}

export function oidcConfig(discoveryUrl: string, revocationEndpoint: string | null): OidcConfig {
  return {
    discoveryUrl,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: POST_LOGOUT_REDIRECT_URI,
    revocationEndpoint,
  };
}

// The name=value part of the Set-Cookie header for one cookie, or undefined if the response sets none.
export function setCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

export function cookiePair(line: string | undefined): string {
  return (line ?? '').split(';')[0] ?? '';
}

export type SignInSteps = {
  login: Response;
  authorize: Response;
  callback: Response;
  // The sign-in cookie /auth/login set (desk_signin=...), which the browser sent back with the callback.
  signInCookie: string;
  // The callback's query, as the provider sent it.
  callbackQuery: string;
};

// The provider's part of a sign-in already started: follows /auth/login's redirect and reads where the
// provider sends the browser back.
export async function authorizeAt(login: Response): Promise<{ authorize: Response; callbackQuery: string }> {
  const authorize = await fetch(login.headers.get('location') ?? '', { redirect: 'manual' });
  await authorize.body?.cancel();
  assert.equal(authorize.status, 302, 'the provider did not redirect back');
  const back = new URL(authorize.headers.get('location') ?? '');
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT_URI);
  return { authorize, callbackQuery: back.search };
}

// The browser's part: /auth/login, the provider's authorization endpoint, then the callback, which the
// provider points at REDIRECT_URI and the browser sends to the client under test with the sign-in cookie.
export async function signInSteps(clientUrl: string, issuer: StandInIssuer, user: ScriptedUser): Promise<SignInSteps> {
  issuer.signInAs(user);
  const login = await fetch(`${clientUrl}/auth/login`, { redirect: 'manual' });
  await login.body?.cancel();
  assert.equal(login.status, 302, 'the client did not redirect to the provider');
  const signInCookie = cookiePair(setCookie(login, 'desk_signin'));
  const { authorize, callbackQuery } = await authorizeAt(login);
  const callback = await fetch(`${clientUrl}/auth/callback${callbackQuery}`, {
    redirect: 'manual',
    headers: { cookie: signInCookie },
  });
  return { login, authorize, callback, signInCookie, callbackQuery };
}

// Signs in and keeps the session cookie in the jar for the client's origin. Returns the cookie.
export async function signIn(clientUrl: string, issuer: StandInIssuer, user: ScriptedUser): Promise<string> {
  const { callback } = await signInSteps(clientUrl, issuer, user);
  await callback.body?.cancel();
  assert.equal(callback.status, 302, 'the callback did not complete the sign-in');
  const cookie = cookiePair(setCookie(callback, 'desk_session'));
  assert.match(cookie, /^desk_session=.+/);
  jar.set(new URL(clientUrl).origin, cookie);
  return cookie;
}

// --- The client under test ------------------------------------------------------------------------

export const CLIENT_START = '2026-03-01T09:00:00.000Z';

export function clientConfig(options: {
  agents: AgentConfig[];
  caseReviewUrl: string;
  webRoot: string;
  dbPath?: string;
  discoveryUrl: string;
  revocationEndpoint: string | null;
}): Config {
  return {
    dbPath: options.dbPath ?? ':memory:',
    caseReviewUrl: options.caseReviewUrl,
    agents: options.agents,
    webRoot: options.webRoot,
    oidc: oidcConfig(options.discoveryUrl, options.revocationEndpoint),
    appOrigin: APP_ORIGIN,
    rolesClaim: 'roles',
    reviewerRole: 'reviewer',
  };
}

export type ClientOptions = {
  agents: AgentConfig[];
  caseReviewUrl: string;
  webRoot: string;
  agentTimeoutMs?: number;
  dbPath?: string;
  // Who is signed in when the client is handed to the test. Default: Riley, a reviewer. Null: nobody.
  user?: ScriptedUser | null;
  // Where the client fetches the discovery document. Default: the stand-in's.
  discoveryUrl?: string;
  // Where the client revokes refresh tokens. Default: the stand-in's real revocation endpoint.
  revocationEndpoint?: string | null;
  // A stand-in issuer and its clock to use, when another server in the test must trust the same issuer.
  // Default: a new one.
  identity?: { issuer: StandInIssuer; clock: SettableClock };
};

export type RunningClient = { url: string; store: InquiryStore; issuer: StandInIssuer; clock: SettableClock };

// Record timestamps come from a stepping clock, as before sign-in existed; sessions, tokens and the
// stand-in go by a separate settable clock, so signing in and renewing never shift a record's time.
export async function startClient(t: TestContext, options: ClientOptions): Promise<RunningClient> {
  const now = steppingClock(CLIENT_START);
  const clock = options.identity?.clock ?? settableClock(CLIENT_START);
  const issuer = options.identity?.issuer ?? (await startIssuer(t, clock));
  const store = new InquiryStore(options.dbPath ?? ':memory:', now);
  const config = clientConfig({
    ...options,
    discoveryUrl: options.discoveryUrl ?? issuer.discoveryUrl,
    revocationEndpoint: options.revocationEndpoint === undefined ? issuer.revocationUrl : options.revocationEndpoint,
  });
  const server = createClientServer({
    config,
    store,
    now,
    newId: sequentialIds('id'),
    agentTimeoutMs: options.agentTimeoutMs ?? 5_000,
    identity: new IdentityProvider(config.oidc, { claim: config.rolesClaim, reviewerRole: config.reviewerRole }, clock.now),
    sessions: new SessionStore(clock.now, seededRandom('client-under-test')),
  });
  const url = await listen(server);
  t.after(() => {
    stop(server);
    store.close();
  });
  const user = options.user === undefined ? RILEY : options.user;
  if (user !== null) {
    await signIn(url, issuer, user);
  }
  return { url, store, issuer, clock };
}
