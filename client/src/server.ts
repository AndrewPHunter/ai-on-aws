// The client's server. Under /auth it signs desk staff in and out through the identity provider. Under
// /api, for a signed-in user only, it receives inquiries, sends them to agents, keeps every inquiry and
// run, forwards case review to the case system and reports the state of each piece; every call to an
// agent or the case system carries the user's access token. /ping and the built web app need no session.
//
// Tokens stay here: the browser holds only a session cookie.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

import type { InvocationRequest } from '../../shared/agent-contract.ts';
import type {
  AgentList,
  ApiError,
  InquiryResponse,
  PieceStatus,
  Run,
  RunResponse,
  SampleList,
  SessionView,
  SignOutResponse,
  SystemStatus,
} from '../shared/api.ts';
import { invokeAgent, ping, pingAgent } from './agents.ts';
import type { PingResult } from './agents.ts';
import { getCase, listCases, postReview } from './cases.ts';
import type { Forwarded } from './cases.ts';
import type { AgentConfig, Config } from './config.ts';
import { IdentityUnreachable, SignInRefused } from './identity.ts';
import type { IdentityProvider, TokenSet } from './identity.ts';
import { SAMPLES } from './samples.ts';
import type { Session, SessionStore } from './sessions.ts';
import type { Actor, InquiryStore } from './store.ts';

export type ClientDeps = {
  config: Config;
  store: InquiryStore;
  // The clock records are stamped with. Sessions and the identity provider have their own.
  now: () => Date;
  newId: () => string;
  agentTimeoutMs: number;
  identity: IdentityProvider;
  sessions: SessionStore;
};

// How long a user's access token must still live when it is sent: the time the client waits for an
// agent, so the token outlives the run; and a margin over the case system's 10-second timeout.
export const AGENT_TOKEN_MIN_LIFE_MS = 180_000;
export const CASE_TOKEN_MIN_LIFE_MS = 30_000;
export const SESSION_COOKIE = 'desk_session';

export const MAX_TEXT_LENGTH = 10_000;
export const PING_TIMEOUT_MS = 2_000;
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// Pieces of the system that are designed but do not exist yet. Reported so the status page says so.
const NOT_BUILT: readonly PieceStatus[] = [
  {
    id: 'knowledge',
    name: 'Label search',
    role: 'Finds the passages of the approved label that answer a question.',
    state: 'not_built',
    detail: 'Not built yet.',
  },
  {
    id: 'evaluation',
    name: 'Evaluation',
    role: 'Scores the agents against a set of prepared inquiries.',
    state: 'not_built',
    detail: 'Not built yet.',
  },
];

const NO_AGENT: PieceStatus = {
  id: 'agents',
  name: 'Agents',
  role: 'Handle inquiries: answer from the label and open adverse event cases.',
  state: 'not_built',
  detail: 'No agent is configured.',
};

// A failure the caller caused or can act on, answered with its status and an ApiError body.
class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function badRequest(detail: string): ApiFailure {
  return new ApiFailure(400, 'bad_request', detail);
}

function notSignedIn(detail: string): ApiFailure {
  return new ApiFailure(401, 'not_signed_in', detail);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

// A short page for the browser, for the sign-in routes. Every piece of text is escaped.
function sendPage(response: ServerResponse, status: number, title: string, sentence: string, signInAgain: boolean): void {
  const link = signInAgain ? '<p><a href="/auth/login">Sign in again</a></p>' : '<p><a href="/">Back to the desk</a></p>';
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
      `<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(sentence)}</p>${link}</body></html>`,
  );
}

function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/`;
}

const CLEARED_COOKIE = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// The browser that started a sign-in, named by a random value only the callback reads.
export const SIGN_IN_COOKIE = 'desk_signin';

function signInCookie(binding: string): string {
  return `${SIGN_IN_COOKIE}=${binding}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`;
}

const CLEARED_SIGN_IN_COOKIE = `${SIGN_IN_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0`;

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function sendError(response: ServerResponse, status: number, error: string, detail: string): void {
  const payload: ApiError = { error, detail };
  sendJson(response, status, payload);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function listener(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ApiFailure) {
        sendError(response, error.status, error.code, error.message);
        return;
      }
      console.error('Request failed:', error);
      sendError(response, 500, 'internal_error', 'The client failed while handling the request. The cause is in its log.');
    });
  };
}

// Reads the whole body even past the limit, so the caller is still sent the 400. Stopping early
// would destroy the socket and the caller would see a reset connection instead of the reason.
function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('The request body is larger than 1 MB.'));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed);
      } catch {
        reject(badRequest('The request body is not JSON.'));
      }
    });
  });
}

function field(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('The request body is not a JSON object.');
  }
  const entries: Record<string, unknown> = { ...body };
  return entries[name];
}

function requiredString(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${name}" is required and must be text.`);
  }
  return value.trim();
}

function pieceFrom(id: string, name: string, role: string, result: PingResult): PieceStatus {
  return result.outcome === 'up'
    ? { id, name, role, state: 'up', detail: 'Answered the health check.' }
    : { id, name, role, state: 'down', detail: result.reason };
}

function sendForwarded(response: ServerResponse, forwarded: Forwarded): void {
  if (forwarded.outcome === 'unreachable') {
    sendError(response, 502, 'case_system_unreachable', forwarded.reason);
    return;
  }
  sendJson(response, forwarded.status, forwarded.body);
}

// A path segment as the caller meant it. One that cannot be decoded names nothing that exists.
function segment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function createClientServer(deps: ClientDeps): Server {
  const { config, store, now, newId, agentTimeoutMs, identity, sessions } = deps;

  function sessionOf(request: IncomingMessage): Session | undefined {
    const id = cookieValue(request, SESSION_COOKIE);
    return id === undefined ? undefined : sessions.get(id);
  }

  function actorOf(session: Session): Actor {
    return { sub: session.user.sub, name: session.user.name };
  }

  // The session's access token, renewed first if it has less than minLifeMs left. If it cannot be
  // renewed, the session is ended and the request answers 401: nothing is sent with a token that would
  // expire on the way.
  async function accessToken(session: Session, minLifeMs: number): Promise<string> {
    if (sessions.remainingMs(session) >= minLifeMs) {
      return session.tokens.accessToken;
    }
    session.renewing ??= identity.refresh(session.tokens).finally(() => {
      session.renewing = null;
    });
    let renewed: TokenSet;
    try {
      renewed = await session.renewing;
    } catch (error) {
      sessions.remove(session.id);
      if (error instanceof IdentityUnreachable || error instanceof SignInRefused) {
        throw notSignedIn(`Your sign-in could not be renewed: ${error.message} Sign in again.`);
      }
      throw error;
    }
    session.tokens = renewed;
    if (sessions.remainingMs(session) < minLifeMs) {
      sessions.remove(session.id);
      throw notSignedIn(
        `The identity provider issued an access token that lives less than the ${minLifeMs / 1000} seconds this request needs. Sign in again.`,
      );
    }
    return renewed.accessToken;
  }

  function agentNamed(id: string): AgentConfig {
    const agent = config.agents.find((candidate) => candidate.id === id);
    if (agent === undefined) {
      throw new ApiFailure(400, 'unknown_agent', `No agent with the id "${id}" is configured.`);
    }
    return agent;
  }

  // Runs in the background after the 202 has been sent. Everything that can throw is inside the try,
  // so a failure here is logged and never becomes an unhandled rejection.
  async function settleRun(runId: string, agent: AgentConfig, request: InvocationRequest, token: string): Promise<void> {
    try {
      const result = await invokeAgent(agent.url, request, agentTimeoutMs, token);
      if (result.outcome === 'ok') {
        store.completeRun(runId, result.response);
      } else {
        store.failRun(runId, result.reason);
      }
    } catch (error) {
      console.error(`Could not record the result of run ${runId}:`, error);
    }
  }

  // Sends the stored message, with the id and receipt time it was given when it was received, and the
  // access token of the user who started the run.
  function startRun(inquiryId: string, agent: AgentConfig, startedBy: Actor, token: string): Run {
    const inquiry = store.getInquiry(inquiryId);
    if (inquiry === undefined) {
      throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
    }
    const run = store.startRun(newId(), inquiry.id, agent.id, startedBy);
    if (run === undefined) {
      throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
    }
    const request: InvocationRequest = {
      message: { id: inquiry.id, received_at: inquiry.received_at, sender: inquiry.sender, text: inquiry.text },
    };
    void settleRun(run.id, agent, request, token);
    return run;
  }

  function inquiryResponse(inquiryId: string): InquiryResponse {
    const inquiry = store.getInquiry(inquiryId);
    if (inquiry === undefined) {
      throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
    }
    return { inquiry };
  }

  async function status(): Promise<SystemStatus> {
    const checkedAt = now().toISOString();
    const caseSystem = ping(`${config.caseReviewUrl}/ping`, PING_TIMEOUT_MS).then((result) =>
      pieceFrom('case-system', 'Case system', "Holds adverse event cases and records reviewers' decisions.", result),
    );
    const agents = config.agents.map((agent) =>
      pingAgent(agent.url, PING_TIMEOUT_MS).then((result) => pieceFrom(agent.id, agent.name, agent.description, result)),
    );
    const identityPiece = identity
      .check(PING_TIMEOUT_MS)
      .then((result) =>
        pieceFrom('identity', 'Identity provider', 'Signs desk staff in and issues the tokens sent to agents and the case system.', result),
      );
    const [pinged, identityState] = await Promise.all([Promise.all([caseSystem, ...agents]), identityPiece]);
    const noAgent = config.agents.length === 0 ? [NO_AGENT] : [];
    return { checked_at: checkedAt, pieces: [...pinged, ...noAgent, identityState, ...NOT_BUILT] };
  }

  // Every API route is given the signed-in user's session.
  type Handler = (request: IncomingMessage, response: ServerResponse, url: URL, session: Session) => Promise<void>;
  type Route = Partial<Record<'GET' | 'POST', Handler>>;

  function sessionView(session: Session): SessionView {
    const { name, username, roles, isReviewer } = session.user;
    return { user: { name, username, roles: [...roles], is_reviewer: isReviewer } };
  }

  const routes = {
    session: {
      GET: async (_request, response, _url, session) => {
        sendJson(response, 200, sessionView(session));
      },
    },
    status: {
      GET: async (_request, response) => {
        sendJson(response, 200, await status());
      },
    },
    agents: {
      GET: async (_request, response) => {
        const payload: AgentList = {
          agents: config.agents.map((agent) => ({ id: agent.id, name: agent.name, description: agent.description })),
        };
        sendJson(response, 200, payload);
      },
    },
    samples: {
      GET: async (_request, response) => {
        const payload: SampleList = { samples: [...SAMPLES] };
        sendJson(response, 200, payload);
      },
    },
    inquiries: {
      GET: async (_request, response) => {
        sendJson(response, 200, store.listInquiries());
      },
      POST: async (request, response, _url, session) => {
        const body = await readJson(request);
        const sender = requiredString(body, 'sender');
        const text = requiredString(body, 'text');
        if (text.length > MAX_TEXT_LENGTH) {
          throw badRequest(`"text" is longer than ${MAX_TEXT_LENGTH} characters.`);
        }
        const agent = agentNamed(requiredString(body, 'agent_id'));
        const token = await accessToken(session, AGENT_TOKEN_MIN_LIFE_MS);
        const id = newId();
        store.createInquiry({ id, receivedAt: now().toISOString(), sender, text, enteredBy: actorOf(session) });
        startRun(id, agent, actorOf(session), token);
        sendJson(response, 202, inquiryResponse(id));
      },
    },
  } satisfies Record<string, Route>;

  function inquiryRoute(inquiryId: string): Route {
    return {
      GET: async (_request, response) => {
        sendJson(response, 200, inquiryResponse(inquiryId));
      },
    };
  }

  function runsRoute(inquiryId: string): Route {
    return {
      POST: async (request, response, _url, session) => {
        const body = await readJson(request);
        const agentId = requiredString(body, 'agent_id');
        if (store.getInquiry(inquiryId) === undefined) {
          throw new ApiFailure(404, 'inquiry_not_found', `No inquiry has the id "${inquiryId}".`);
        }
        const agent = agentNamed(agentId);
        const token = await accessToken(session, AGENT_TOKEN_MIN_LIFE_MS);
        const payload: RunResponse = { run: startRun(inquiryId, agent, actorOf(session), token) };
        sendJson(response, 202, payload);
      },
    };
  }

  const casesRoute: Route = {
    GET: async (_request, response, url, session) => {
      const token = await accessToken(session, CASE_TOKEN_MIN_LIFE_MS);
      sendForwarded(response, await listCases(config.caseReviewUrl, url.searchParams.get('status'), token));
    },
  };

  function caseRoute(caseId: string): Route {
    return {
      GET: async (_request, response, _url, session) => {
        const token = await accessToken(session, CASE_TOKEN_MIN_LIFE_MS);
        sendForwarded(response, await getCase(config.caseReviewUrl, caseId, token));
      },
    };
  }

  // The reviewer is whoever is signed in, never a name the browser sends: the case system takes it from
  // the access token. A non-reviewer is stopped here, and behind this by the case system.
  function reviewRoute(caseId: string): Route {
    return {
      POST: async (request, response, _url, session) => {
        if (!session.user.isReviewer) {
          throw new ApiFailure(403, 'not_a_reviewer', `Only a member of staff with the ${config.reviewerRole} role can decide a case.`);
        }
        const body = await readJson(request);
        if (field(body, 'reviewer') !== undefined) {
          throw badRequest('"reviewer" is set by the server to whoever is signed in. Do not send it.');
        }
        const decision = field(body, 'decision');
        const note = field(body, 'note');
        const review: Record<string, unknown> = note === undefined ? { decision } : { decision, note };
        const token = await accessToken(session, CASE_TOKEN_MIN_LIFE_MS);
        sendForwarded(response, await postReview(config.caseReviewUrl, caseId, review, token));
      },
    };
  }

  function apiRoute(pathname: string): Route | undefined {
    switch (pathname) {
      case '/api/session':
        return routes.session;
      case '/api/status':
        return routes.status;
      case '/api/agents':
        return routes.agents;
      case '/api/samples':
        return routes.samples;
      case '/api/inquiries':
        return routes.inquiries;
      case '/api/cases':
        return casesRoute;
    }
    const inquiry = /^\/api\/inquiries\/([^/]+)(\/runs)?$/.exec(pathname);
    const inquiryId = inquiry?.[1] === undefined ? undefined : segment(inquiry[1]);
    if (inquiry !== null && inquiryId !== undefined) {
      return inquiry[2] === undefined ? inquiryRoute(inquiryId) : runsRoute(inquiryId);
    }
    const found = /^\/api\/cases\/([^/]+)(\/review)?$/.exec(pathname);
    const caseId = found?.[1] === undefined ? undefined : segment(found[1]);
    if (found !== null && caseId !== undefined) {
      return found[2] === undefined ? caseRoute(caseId) : reviewRoute(caseId);
    }
    return undefined;
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const session = sessionOf(request);
    if (session === undefined) {
      sendError(response, 401, 'not_signed_in', 'Nobody is signed in. Sign in to use the desk.');
      return;
    }
    const route = apiRoute(url.pathname);
    if (route === undefined) {
      sendError(response, 404, 'not_found', `There is no API route ${url.pathname}.`);
      return;
    }
    const handler = request.method === 'GET' ? route.GET : request.method === 'POST' ? route.POST : undefined;
    if (handler === undefined) {
      const allowed = Object.keys(route).join(', ');
      response.setHeader('allow', allowed);
      sendError(response, 405, 'method_not_allowed', `${url.pathname} accepts ${allowed}.`);
      return;
    }
    await handler(request, response, url, session);
  }

  // --- Signing in and out ---------------------------------------------------------------------------

  function sendUnreachablePage(response: ServerResponse, error: IdentityUnreachable): void {
    sendPage(
      response,
      502,
      error.issuerMismatch ? 'The identity provider is not the one expected' : 'The identity provider cannot be reached',
      `identity_unreachable: ${error.message}`,
      false,
    );
  }

  async function login(response: ServerResponse): Promise<void> {
    const { pending, binding } = sessions.beginSignIn();
    let target: string;
    try {
      target = await identity.authorizationUrl(pending);
    } catch (error) {
      // A provider that cannot be reached leaves no sign-in waiting.
      sessions.dropPending(pending.state);
      if (error instanceof IdentityUnreachable) {
        sendUnreachablePage(response, error);
        return;
      }
      throw error;
    }
    response.writeHead(302, { location: target, 'set-cookie': signInCookie(binding), 'cache-control': 'no-store' });
    response.end();
  }

  // The sign-in cookie is cleared whatever the answer. A callback without it, or with another sign-in's,
  // gets the same answer as an unknown state: only the browser that started a sign-in can complete it.
  async function callback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.setHeader('set-cookie', CLEARED_SIGN_IN_COOKIE);
    const state = url.searchParams.get('state');
    const pending = state === null ? undefined : sessions.takePending(state, cookieValue(request, SIGN_IN_COOKIE));
    const providerError = url.searchParams.get('error');
    if (providerError !== null) {
      sendPage(response, 400, 'Sign-in did not complete', `The identity provider answered with the error ${providerError}.`, true);
      return;
    }
    if (pending === undefined) {
      sendPage(response, 400, 'This sign-in is not valid', 'The sign-in was not valid or has expired.', true);
      return;
    }
    let signedIn: Awaited<ReturnType<IdentityProvider['completeSignIn']>>;
    try {
      signedIn = await identity.completeSignIn(url.searchParams, pending);
    } catch (error) {
      if (error instanceof IdentityUnreachable) {
        sendUnreachablePage(response, error);
        return;
      }
      if (error instanceof SignInRefused) {
        sendPage(response, 502, 'Sign-in could not be completed', error.message, true);
        return;
      }
      throw error;
    }
    const session = sessions.create(signedIn.user, signedIn.tokens);
    response.writeHead(302, {
      location: '/',
      'set-cookie': [sessionCookie(session.id), CLEARED_SIGN_IN_COOKIE],
      'cache-control': 'no-store',
    });
    response.end();
  }

  async function logout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = sessionOf(request);
    if (session === undefined) {
      sendError(response, 401, 'not_signed_in', 'Nobody is signed in.');
      return;
    }
    sessions.remove(session.id);
    response.setHeader('set-cookie', CLEARED_COOKIE);
    // The refresh token is revoked at the provider, so it cannot be used again. If that fails the local
    // session is still gone; the failure is logged and the browser is still sent to sign out there.
    if (session.tokens.refreshToken !== null) {
      const revoked = await identity.revoke(session.tokens.refreshToken);
      if (revoked.outcome === 'failed') {
        console.error(`Sign-out: revoking the refresh token at the identity provider failed: ${revoked.reason}`);
      }
    }
    let signOutUrl: string;
    try {
      signOutUrl = await identity.signOutUrl();
    } catch (error) {
      if (error instanceof IdentityUnreachable) {
        sendError(response, 502, 'identity_unreachable', error.message);
        return;
      }
      throw error;
    }
    const payload: SignOutResponse = { sign_out_url: signOutUrl };
    sendJson(response, 200, payload);
  }

  async function handleAuth(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? '';
    if (url.pathname === '/auth/login' && method === 'GET') return login(response);
    if (url.pathname === '/auth/callback' && method === 'GET') return callback(request, response, url);
    if (url.pathname === '/auth/logout' && method === 'POST') return logout(request, response);
    sendText(response, 404, 'Not found.');
  }

  const webRoot = resolve(config.webRoot);

  async function isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  // Where under the web root a URL path points.
  // A path that resolves outside the root names nothing, and does not fall back to the app.
  function fileFor(pathname: string): { inside: true; path: string } | { inside: false } {
    const decoded = segment(pathname);
    if (decoded === undefined || decoded.includes('\0')) {
      return { inside: false };
    }
    const path = resolve(webRoot, `.${decoded}`);
    if (path !== webRoot && !path.startsWith(webRoot + sep)) {
      return { inside: false };
    }
    return { inside: true, path };
  }

  async function sendFile(response: ServerResponse, path: string, headOnly: boolean, cacheControl: string | undefined): Promise<void> {
    const content = await readFile(path);
    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(content.length),
    };
    if (cacheControl !== undefined) {
      headers['cache-control'] = cacheControl;
    }
    response.writeHead(200, headers);
    response.end(headOnly ? undefined : content);
  }

  async function handleWeb(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendText(response, 405, 'Method not allowed.');
      return;
    }
    const headOnly = request.method === 'HEAD';
    const target = fileFor(url.pathname);
    if (!target.inside) {
      sendText(response, 404, 'Not found.');
      return;
    }
    const index = resolve(webRoot, 'index.html');
    if (target.path !== index && (await isFile(target.path))) {
      const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : undefined;
      await sendFile(response, target.path, headOnly, cache);
      return;
    }
    // The app does its own routing, so any other path is the app's page.
    if (!(await isFile(index))) {
      sendText(response, 503, 'The web app has not been built.');
      return;
    }
    await sendFile(response, index, headOnly, 'no-cache');
  }

  return createServer(
    listener(async (request, response) => {
      // URL parsing collapses literal ".." segments but leaves encoded ones; fileFor decodes the path
      // and checks the result against the web root, so neither form can leave it.
      const url = new URL(request.url ?? '/', 'http://client');
      // A POST sent by a page on another site, which the browser would send with the session cookie.
      const origin = request.headers.origin;
      if (request.method === 'POST' && origin !== undefined && origin !== config.appOrigin) {
        sendError(response, 403, 'cross_site_request', 'This request came from another site and was refused.');
        return;
      }
      if (url.pathname === '/ping') {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET');
          sendError(response, 405, 'method_not_allowed', '/ping accepts GET.');
          return;
        }
        sendJson(response, 200, { status: 'Healthy' });
        return;
      }
      if (url.pathname.startsWith('/auth/')) {
        await handleAuth(request, response, url);
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      await handleWeb(request, response, url);
    }),
  );
}
