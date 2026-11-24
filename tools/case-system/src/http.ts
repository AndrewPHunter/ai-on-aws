// Two HTTP servers over one store.
//   The agent server speaks MCP at POST /mcp and answers GET /ping. It is what agents are given.
//   The review server is for people: list cases, read one with its history, and record a decision.
// Every route on both but GET /ping requires a valid access token, checked before the body is read, and
// each server has its own check. On the agent server the token's client is the agent and its user the
// user the agent acted for; on the review server the token's user is the reviewer. Each tool and route
// needs its own scope (scopes.ts). Each tool call is a case.tool span (mcp.ts) and each review decision a
// case.review span, each a child of the request's traceparent when it carries a usable one.

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { refusalAnswer } from '../../../shared/access-token.ts';
import type { AccessTokenCheck, Caller, Refusal } from '../../../shared/access-token.ts';
import { CASE_STATUSES, REVIEW_DECISIONS } from '../../../shared/case-contract.ts';
import type { Telemetry } from '../../../shared/telemetry.ts';
import { buildMcpServer } from './mcp.ts';
import { routeRefusal } from './scopes.ts';
import type { Route } from './scopes.ts';
import type { CallContext, CaseStatus, CaseStore, Person, ReviewDecision } from './store.ts';

// Headers the calling agent's code sets on every MCP request that changes anything. Which agent is
// calling is not among them: it is the client the access token was issued to.
export const CONTEXT_HEADERS = {
  messageId: 'x-message-id',
  receivedAt: 'x-received-at',
  // Percent-encoded, because a header cannot carry every character a name can contain.
  sender: 'x-sender',
} as const;

// How far ahead of this server's clock a receipt time may be, to allow for clocks that disagree.
export const RECEIPT_ALLOWANCE_MS = 5 * 60 * 1000;

const MAX_BODY_BYTES = 1_000_000;
const STATUSES: readonly CaseStatus[] = CASE_STATUSES;
const DECISIONS: readonly ReviewDecision[] = REVIEW_DECISIONS;

class BadRequest extends Error {}

function single(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    throw new BadRequest(`Header ${name} was sent more than once`);
  }
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

// No context headers at all is allowed: listing tools and plain lookups need none.
// Some but not all, a receipt time that is not a time, or one that is still in the future,
// is a mistake by the caller and is refused. The agent is the client the accepted access token was issued
// to, and the user it acted for is the token's user.
export function contextFrom(headers: IncomingHttpHeaders, now: () => Date, caller: Caller): CallContext | undefined {
  const messageId = single(headers, CONTEXT_HEADERS.messageId);
  const receivedAt = single(headers, CONTEXT_HEADERS.receivedAt);
  const encodedSender = single(headers, CONTEXT_HEADERS.sender);
  if (messageId === undefined && receivedAt === undefined && encodedSender === undefined) {
    return undefined;
  }
  if (messageId === undefined || receivedAt === undefined || encodedSender === undefined) {
    throw new BadRequest(`Send all of ${Object.values(CONTEXT_HEADERS).join(', ')}, or none`);
  }
  let sender: string;
  try {
    sender = decodeURIComponent(encodedSender).trim();
  } catch {
    throw new BadRequest(`Header ${CONTEXT_HEADERS.sender} is not percent-encoded text`);
  }
  if (sender === '') {
    throw new BadRequest(`Header ${CONTEXT_HEADERS.sender} is empty`);
  }
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) {
    throw new BadRequest(`Header ${CONTEXT_HEADERS.receivedAt} is not a date and time`);
  }
  if (received.getTime() > now().getTime() + RECEIPT_ALLOWANCE_MS) {
    throw new BadRequest(`Header ${CONTEXT_HEADERS.receivedAt} is in the future`);
  }
  return { messageId, receivedAt: received.toISOString(), agentId: caller.clientId, actingFor: personOf(caller), sender };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) {
      throw new BadRequest('The request body is not bytes');
    }
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new BadRequest('The request body is too large');
    }
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new BadRequest('The request body is not JSON');
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function listener(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof BadRequest) {
        sendJson(response, 400, { error: 'bad_request', detail: error.message });
        return;
      }
      console.error('Request failed:', error);
      sendJson(response, 500, { error: 'internal_error' });
    });
  };
}

function pathOf(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://case-system');
}

function sendRefusal(response: ServerResponse, refusal: Refusal): void {
  const answer = refusalAnswer(refusal);
  response.writeHead(answer.status, { 'content-type': 'application/json', 'www-authenticate': answer.wwwAuthenticate });
  response.end(JSON.stringify(answer.body));
}

// The caller of an accepted token, or undefined once a refusal (403 for a missing scope, 401 otherwise) or an
// unavailable check (503) has been answered. Nothing of the request's body has been read either way.
async function callerOf(request: IncomingMessage, response: ServerResponse, checkToken: AccessTokenCheck): Promise<Caller | undefined> {
  const checked = await checkToken(request.headers.authorization);
  if (checked.kind === 'caller') {
    return checked.caller;
  }
  if (checked.kind === 'refused') {
    sendRefusal(response, checked);
  } else {
    sendJson(response, 503, { error: 'identity_unavailable', detail: checked.detail });
  }
  request.resume();
  return undefined;
}

function personOf(caller: Caller): Person {
  return { name: caller.name, subject: caller.subject };
}

export function createAgentServer(store: CaseStore, now: () => Date, checkToken: AccessTokenCheck, telemetry: Telemetry): Server {
  return createServer(
    listener(async (request, response) => {
      const { pathname } = pathOf(request);

      if (pathname === '/ping' && request.method === 'GET') {
        sendJson(response, 200, { status: 'Healthy' });
        return;
      }
      const caller = await callerOf(request, response, checkToken);
      if (caller === undefined) {
        return;
      }
      if (pathname !== '/mcp') {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      if (request.method !== 'POST') {
        // Stateless: there is no stream to open with GET and no session to end with DELETE.
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }

      const context = contextFrom(request.headers, now, caller);
      const body = await readJson(request);
      const trace = { telemetry, parent: telemetry.extract(request.headers), agentId: caller.clientId };
      const mcp = buildMcpServer(store, context, caller.scopes, trace);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    }),
  );
}

function field(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequest('The request body is not a JSON object');
  }
  const entries: Record<string, unknown> = { ...body };
  return entries[name];
}

function requiredString(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequest(`"${name}" is required`);
  }
  return value.trim();
}

function optionalString(body: unknown, name: string): string | undefined {
  const value = field(body, name);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequest(`"${name}" must be text`);
  }
  return value;
}

type Target = { route: 'GET /cases' } | { route: Exclude<Route, 'GET /cases'>; caseId: string };

// Which review route a request is for.
function targetOf(pathname: string, method: string | undefined): Target | 'not_found' | 'method_not_allowed' {
  if (pathname === '/cases' && method === 'GET') {
    return { route: 'GET /cases' };
  }
  const match = /^\/cases\/([^/]+)(\/review)?$/.exec(pathname);
  const caseId = match?.[1];
  if (match === null || caseId === undefined) {
    return 'not_found';
  }
  const isReview = match[2] !== undefined;
  if (!isReview && method === 'GET') {
    return { route: 'GET /cases/<id>', caseId };
  }
  if (isReview && method === 'POST') {
    return { route: 'POST /cases/<id>/review', caseId };
  }
  return 'method_not_allowed';
}

// Records one decision on a case, answering the request. Executed when the store recorded it, refused when the
// case or its status does not allow it. A body that is not a decision throws BadRequest, also a refusal.
async function decide(request: IncomingMessage, response: ServerResponse, store: CaseStore, caller: Caller, caseId: string): Promise<'executed' | 'refused'> {
  const body = await readJson(request);
  if (field(body, 'reviewer') !== undefined) {
    throw new BadRequest('"reviewer" is not accepted: the reviewer is whoever the access token names');
  }
  const reviewer = personOf(caller);
  const wanted = requiredString(body, 'decision');
  const decision = DECISIONS.find((candidate) => candidate === wanted);
  if (decision === undefined) {
    throw new BadRequest(`"decision" must be one of ${DECISIONS.join(', ')}`);
  }
  const result = store.review(caseId, reviewer, decision, optionalString(body, 'note'));
  switch (result.outcome) {
    case 'done':
      sendJson(response, 200, result);
      return 'executed';
    case 'not_found':
      sendJson(response, 404, { error: 'case_not_found' });
      return 'refused';
    case 'note_required':
      sendJson(response, 400, { error: 'note_required', detail: 'Say what information is needed.' });
      return 'refused';
    case 'not_allowed':
      sendJson(response, 409, {
        error: 'not_allowed',
        detail: `A case that is ${result.status} cannot be given the decision ${decision}.`,
      });
      return 'refused';
  }
}

export function createReviewServer(store: CaseStore, checkToken: AccessTokenCheck, telemetry: Telemetry): Server {
  return createServer(
    listener(async (request, response) => {
      const url = pathOf(request);

      if (url.pathname === '/ping' && request.method === 'GET') {
        sendJson(response, 200, { status: 'Healthy' });
        return;
      }
      const caller = await callerOf(request, response, checkToken);
      if (caller === undefined) {
        return;
      }

      const target = targetOf(url.pathname, request.method);
      if (target === 'not_found' || target === 'method_not_allowed') {
        sendJson(response, target === 'not_found' ? 404 : 405, { error: target });
        return;
      }

      if (target.route === 'POST /cases/<id>/review') {
        const { caseId } = target;
        // One span for the decision: its outcome only, never the reviewer or the note.
        await telemetry.span('case.review', { kind: 'server', parent: telemetry.extract(request.headers) }, async (span) => {
          // Decided before the case is looked up or the body read, so a caller without the scope learns nothing.
          const refusal = routeRefusal(target.route, caller.scopes);
          if (refusal !== undefined) {
            request.resume();
            sendRefusal(response, refusal);
            span.set({ 'lab.outcome': 'refused' });
            return;
          }
          try {
            span.set({ 'lab.outcome': await decide(request, response, store, caller, caseId) });
          } catch (error) {
            if (error instanceof BadRequest) span.set({ 'lab.outcome': 'refused' });
            throw error;
          }
        });
        return;
      }

      // Decided before a case is looked up, so a caller without the scope learns nothing.
      const refusal = routeRefusal(target.route, caller.scopes);
      if (refusal !== undefined) {
        request.resume();
        sendRefusal(response, refusal);
        return;
      }

      if (target.route === 'GET /cases') {
        const wanted = url.searchParams.get('status');
        if (wanted === null) {
          sendJson(response, 200, store.find({}));
          return;
        }
        const status = STATUSES.find((candidate) => candidate === wanted);
        if (status === undefined) {
          throw new BadRequest(`"status" must be one of ${STATUSES.join(', ')}`);
        }
        sendJson(response, 200, store.find({ status }));
        return;
      }
      const { caseId } = target;
      const found = store.getCase(caseId);
      if (found === undefined) {
        sendJson(response, 404, { error: 'case_not_found' });
        return;
      }
      sendJson(response, 200, { case: found, versions: store.versions(caseId), audit: store.auditTrail(caseId) });
    }),
  );
}
