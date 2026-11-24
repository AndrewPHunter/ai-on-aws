// What the client's tests share. An agent and the case system are, to the client, HTTP servers that answer, so
// each is a scripted server on loopback that records what it was sent. The client runs with an in-memory store, a
// clock that moves only when a test moves it, and seeded randomness. Outside auth.test.ts the identity provider is
// an IdentityProvider whose refresh is a function of the refresh token and the scope: no token is signed, nothing is
// fetched. A machine client's token is a function too (machineTokens), and the search engine, the retrieval service and
// the trace store are values a test passes in (none unless given). Telemetry is off unless a test passes in a handle.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';

import type { InvocationResponse } from '../../shared/agent-contract.ts';
import { LAB_QUEUE, startTelemetry } from '../../shared/telemetry.ts';
import type { Telemetry } from '../../shared/telemetry.ts';
import type { AgentConfig, AgentScope, Config, MachineClient } from '../src/config.ts';
import type { TraceStore } from '../src/evidence.ts';
import { IdentityProvider, SignInRefused } from '../src/identity.ts';
import type { KnowledgeServices } from '../src/knowledge.ts';
import type { MachineTokenResult, Refreshed, SignedInUser } from '../src/identity.ts';
import { SESSION_COOKIE, createClientServer } from '../src/server.ts';
import { SessionStore } from '../src/sessions.ts';
import { InquiryStore } from '../src/store.ts';

export const APP_ORIGIN = 'http://localhost:3000';

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The server has no port');
  return `http://127.0.0.1:${address.port}`;
}

// What a test registers teardown with: its TestContext, or node:test's file-level hooks.
export type Hooks = { after: (fn: () => void) => void };

export type Received = { method: string; path: string; authorization: string | undefined; traceparent: string | undefined; body: unknown };
// What a scripted server answers: a status and a body (JSON unless it is a string), or 'close' to drop the connection.
export type Answer = { status: number; body: unknown } | 'close';

export type Scripted = { url: string; received: Received[]; waitFor: (match: (r: Received) => boolean) => Promise<Received> };

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

export async function scripted(t: Hooks, answer: (r: Received) => Answer | Promise<Answer>): Promise<Scripted> {
  const received: Received[] = [];
  const waiting: { match: (r: Received) => boolean; resolve: (r: Received) => void }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const { authorization, traceparent } = request.headers;
      const r: Received = { method: request.method ?? '', path: request.url ?? '', authorization, traceparent: typeof traceparent === 'string' ? traceparent : undefined, body: await bodyOf(request) };
      received.push(r);
      for (const w of waiting.filter((candidate) => candidate.match(r))) w.resolve(r);
      const a = await answer(r);
      if (a === 'close') return response.destroy();
      const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
      response.writeHead(a.status, { 'content-type': 'application/json' }).end(text);
    })();
  });
  const url = await listen(server);
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const waitFor = (match: (r: Received) => boolean): Promise<Received> => {
    const found = received.find(match);
    return found !== undefined ? Promise.resolve(found) : new Promise((resolve) => waiting.push({ match, resolve }));
  };
  return { url, received, waitFor };
}

export const EXAMPLE_RESPONSE: InvocationResponse = {
  agent: { id: 'stand-in', implementation: 'scripted' },
  outcome: 'completed',
  stop_reason: null,
  reply: 'A synthetic reply.',
  citations: [],
  case_actions: [],
  steps: [],
};

export type Clock = { now: () => Date; advance: (ms: number) => void };

export function clock(start = '2026-03-01T09:00:00.000Z'): Clock {
  let at = new Date(start).getTime();
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

export function seeded(seed: string): (size: number) => Uint8Array {
  let n = 0;
  return (size) => createHash('sha256').update(`${seed}:${n++}`).digest().subarray(0, size);
}

// Refreshes a refresh token r for a scope s to the access token "s for r", holding s, with ten minutes to live, and
// returns no new refresh token; refuses the refresh token "refuse" as the provider would. Records each refresh token
// it was given.
export class ScriptedRenewal extends IdentityProvider {
  readonly renewed: string[] = [];
  private readonly clockNow: () => Date;

  constructor(config: Config, now: () => Date) {
    super(config.oidc, config.rolesClaim, now);
    this.clockNow = now;
  }

  override refresh(refreshToken: string, scope: string): Promise<Refreshed> {
    this.renewed.push(refreshToken);
    if (refreshToken === 'refuse') return Promise.reject(new SignInRefused('The provider refused to renew.'));
    return Promise.resolve({ accessToken: `${scope} for ${refreshToken}`, accessExpiresAt: this.clockNow().getTime() + 600_000, granted: ['openid', scope], refreshToken: null });
  }
}

// A machine client c's token for a scope s is "c for s", with ten minutes to live, unless `refuse` says the token
// endpoint refuses it now.
export type MachineTokens = { get: (client: MachineClient, scope: string) => Promise<MachineTokenResult>; refuse: boolean };

export function machineTokens(now: () => Date): MachineTokens {
  const tokens: MachineTokens = {
    refuse: false,
    get: (client, scope) =>
      Promise.resolve(
        tokens.refuse
          ? { outcome: 'failed', reason: `the token endpoint answered 401, unauthorized_client to client ${client}` }
          : { outcome: 'token', token: `${client} for ${scope}`, expiresAt: now().getTime() + 600_000 },
      ),
  };
  return tokens;
}

// An agent for deskConfig; its scope is agents:intake and its wait 180 s unless given.
export type TestAgent = Omit<AgentConfig, 'scope' | 'wait_seconds'> & { scope?: AgentScope; wait_seconds?: number };

export function deskConfig(options: { agents: TestAgent[]; caseReviewUrl: string; webRoot?: string; discoveryUrl?: string; issuer?: string; revocationEndpoint?: string; evaluationDataDir?: string }): Config {
  const unused = 'http://127.0.0.1:1/not-used';
  return {
    dbPath: ':memory:',
    caseReviewUrl: options.caseReviewUrl,
    agents: options.agents.map((agent) => ({ ...agent, scope: agent.scope ?? 'agents:intake', wait_seconds: agent.wait_seconds ?? 180 })),
    webRoot: options.webRoot ?? '/nonexistent-web-root',
    oidc: {
      discoveryUrl: options.discoveryUrl ?? unused,
      issuer: options.issuer ?? unused,
      clientId: 'desk',
      clientSecret: 'stand-in-desk-secret',
      redirectUri: `${APP_ORIGIN}/auth/callback`,
      postLogoutRedirectUri: `${APP_ORIGIN}/`,
      revocationEndpoint: options.revocationEndpoint ?? null,
    },
    machineSecrets: { 'contact-form': 'stand-in-contact-form-secret', 'lab-explorer': 'stand-in-lab-explorer-secret' },
    appOrigin: APP_ORIGIN,
    rolesClaim: 'roles',
    evaluationDataDir: options.evaluationDataDir ?? null,
    telemetryEndpoint: null,
  };
}

export type Desk = { url: string; store: InquiryStore; sessions: SessionStore; clock: Clock };

export type Evidence = { telemetry?: Telemetry; traceStore?: TraceStore };

export async function startDesk(t: Hooks, config: Config, time: Clock, identity?: IdentityProvider, machine?: MachineTokens, knowledge?: KnowledgeServices, evidence?: Evidence): Promise<Desk> {
  const store = new InquiryStore(':memory:', time.now);
  const sessions = new SessionStore(time.now, seeded('desk'));
  let n = 0;
  const server = createClientServer({
    config,
    store,
    now: time.now,
    newId: () => `id-${++n}`,
    identity: identity ?? new ScriptedRenewal(config, time.now),
    sessions,
    machineToken: (machine ?? machineTokens(time.now)).get,
    knowledge: knowledge ?? { engine: null, retrieval: null },
    telemetry: evidence?.telemetry ?? startTelemetry({ service: 'client', endpoint: null, queue: LAB_QUEUE }, { now: () => time.now().getTime(), log: () => undefined }),
    traceStore: evidence?.traceStore ?? null,
  });
  const url = await listen(server);
  t.after(() => {
    server.close();
    server.closeAllConnections();
    store.close();
  });
  return { url, store, sessions, clock: time };
}

// A person and the scopes their sign-in was granted.
export type Person = SignedInUser & { granted: string[] };

export const RILEY: Person = { sub: 'sub-riley', name: 'Riley Reviewer', username: 'riley.reviewer', roles: ['reviewer'], granted: ['openid', 'agents:intake', 'cases:read', 'cases:review'] };
export const DANA: Person = { sub: 'sub-dana', name: 'Dana Desk', username: 'dana.desk', roles: [], granted: ['openid', 'agents:intake', 'cases:read'] };

// A session made directly in the store, as a completed sign-in makes one, that has already got an access token for
// each scope it was granted, "<access>:<scope>", with lifeMs to live. Returns the cookie a browser would send.
export function signedIn(desk: Desk, person: Person, access: string, lifeMs: number, refresh: string): string {
  const { granted, ...user } = person;
  const session = desk.sessions.create({ user, granted, refreshToken: refresh });
  for (const scope of granted) session.tokens.set(scope, { accessToken: `${access}:${scope}`, expiresAt: desk.clock.now().getTime() + lifeMs });
  return `${SESSION_COOKIE}=${session.id}`;
}

export type Reply = { status: number; body: unknown };

export async function call(url: string, options: { cookie?: string; method?: string; body?: unknown; origin?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  const response = await fetch(url, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

// Reads a path of fields from a JSON value the test does not otherwise type.
export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

// The inquiry once none of its runs is still running, read through the API a bounded number of times.
export async function settled(desk: Desk, inquiryId: string, cookie: string): Promise<unknown> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const { body } = await call(`${desk.url}/api/inquiries/${inquiryId}`, { cookie });
    const runs = at(body, 'inquiry', 'runs');
    if (Array.isArray(runs) && runs.every((run) => at(run, 'state') !== 'running')) return at(body, 'inquiry');
  }
  throw new Error(`Inquiry ${inquiryId} still has a run in progress`);
}
