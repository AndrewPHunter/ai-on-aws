// Two HTTP servers over one store.
//   The agent server speaks MCP at POST /mcp and answers GET /ping. It is what agents are given.
//   The review server is for people: list cases, read one with its history, and record a decision.

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { CASE_STATUSES, REVIEW_DECISIONS } from '../../../shared/case-contract.ts';
import { buildMcpServer } from './mcp.ts';
import type { CallContext, CaseStatus, CaseStore, ReviewDecision } from './store.ts';

// Headers the calling agent's code sets on every MCP request that changes anything.
export const CONTEXT_HEADERS = {
  messageId: 'x-message-id',
  receivedAt: 'x-received-at',
  agentId: 'x-agent-id',
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
// is a mistake by the caller and is refused.
export function contextFrom(headers: IncomingHttpHeaders, now: () => Date): CallContext | undefined {
  const messageId = single(headers, CONTEXT_HEADERS.messageId);
  const receivedAt = single(headers, CONTEXT_HEADERS.receivedAt);
  const agentId = single(headers, CONTEXT_HEADERS.agentId);
  const encodedSender = single(headers, CONTEXT_HEADERS.sender);
  if (messageId === undefined && receivedAt === undefined && agentId === undefined && encodedSender === undefined) {
    return undefined;
  }
  if (messageId === undefined || receivedAt === undefined || agentId === undefined || encodedSender === undefined) {
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
  return { messageId, receivedAt: received.toISOString(), agentId, sender };
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

export function createAgentServer(store: CaseStore, now: () => Date): Server {
  return createServer(
    listener(async (request, response) => {
      const { pathname } = pathOf(request);

      if (pathname === '/ping' && request.method === 'GET') {
        sendJson(response, 200, { status: 'Healthy' });
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

      const context = contextFrom(request.headers, now);
      const body = await readJson(request);
      const mcp = buildMcpServer(store, context);
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

export function createReviewServer(store: CaseStore): Server {
  return createServer(
    listener(async (request, response) => {
      const url = pathOf(request);

      if (url.pathname === '/ping' && request.method === 'GET') {
        sendJson(response, 200, { status: 'Healthy' });
        return;
      }

      if (url.pathname === '/cases' && request.method === 'GET') {
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

      const match = /^\/cases\/([^/]+)(\/review)?$/.exec(url.pathname);
      const caseId = match?.[1];
      if (match === null || caseId === undefined) {
        sendJson(response, 404, { error: 'not_found' });
        return;
      }
      const isReview = match[2] !== undefined;

      if (!isReview && request.method === 'GET') {
        const found = store.getCase(caseId);
        if (found === undefined) {
          sendJson(response, 404, { error: 'case_not_found' });
          return;
        }
        sendJson(response, 200, { case: found, versions: store.versions(caseId), audit: store.auditTrail(caseId) });
        return;
      }

      if (isReview && request.method === 'POST') {
        const body = await readJson(request);
        const reviewer = requiredString(body, 'reviewer');
        const wanted = requiredString(body, 'decision');
        const decision = DECISIONS.find((candidate) => candidate === wanted);
        if (decision === undefined) {
          throw new BadRequest(`"decision" must be one of ${DECISIONS.join(', ')}`);
        }
        const result = store.review(caseId, reviewer, decision, optionalString(body, 'note'));
        switch (result.outcome) {
          case 'done':
            sendJson(response, 200, result);
            return;
          case 'not_found':
            sendJson(response, 404, { error: 'case_not_found' });
            return;
          case 'note_required':
            sendJson(response, 400, { error: 'note_required', detail: 'Say what information is needed.' });
            return;
          case 'not_allowed':
            sendJson(response, 409, {
              error: 'not_allowed',
              detail: `A case that is ${result.status} cannot be given the decision ${decision}.`,
            });
            return;
        }
      }

      sendJson(response, 405, { error: 'method_not_allowed' });
    }),
  );
}
