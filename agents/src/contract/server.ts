// The HTTP contract an agent serves. This is all that Amazon Bedrock AgentCore Runtime asks of a
// container: POST /invocations and GET /ping on port 8080. It is written by hand here, with nothing
// from an SDK, so that what the platform requires and what the agent adds are easy to tell apart.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { invocationRequestSchema, invocationResponseSchema } from '../../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';

export type AgentIdentity = { id: string; implementation: string };

// Handles one message. It reports its own failures inside the response; it is not expected to throw.
export type Handler = (message: InboundMessage) => Promise<InvocationResponse>;

const MAX_BODY_BYTES = 1_000_000;

class BadRequest extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) {
      throw new BadRequest('The request body is not bytes.');
    }
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) {
      chunks.push(chunk);
    }
  }
  if (size > MAX_BODY_BYTES) {
    throw new BadRequest('The request body is too large.');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new BadRequest('The request body is not JSON.');
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function invoke(
  identity: AgentIdentity,
  handler: Handler,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const parsed = invocationRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || 'the top level'}: ${issue.message}`;
    throw new BadRequest(`The request does not match the agent contract${where}.`);
  }

  // From here the request is valid, so the answer is always inside the contract: a caller that sent
  // a good request gets an outcome and whatever steps were taken, never a bare error status.
  let result: InvocationResponse;
  try {
    result = await handler(parsed.data.message);
  } catch (error) {
    console.error('The handler threw:', error);
    result = {
      agent: identity,
      outcome: 'failed',
      stop_reason: 'The agent failed unexpectedly.',
      reply: '',
      citations: [],
      case_actions: [],
      steps: [],
    };
  }

  const checked = invocationResponseSchema.safeParse(result);
  if (!checked.success) {
    // The agent's own answer is outside the contract. That is a defect here, not a property of the request.
    console.error('The agent produced a response outside the contract:', checked.error.issues[0]);
    sendJson(response, 500, { error: 'internal_error', detail: 'The agent produced a response outside its contract.' });
    return;
  }
  sendJson(response, 200, checked.data);
}

export function createContractServer(identity: AgentIdentity, handler: Handler): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://agent').pathname;

    if (path === '/ping' && request.method === 'GET') {
      sendJson(response, 200, { status: 'Healthy' });
      return;
    }
    if (path !== '/invocations') {
      sendJson(response, 404, { error: 'not_found', detail: `There is no ${path} here.` });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      sendJson(response, 405, { error: 'method_not_allowed', detail: '/invocations accepts POST.' });
      return;
    }

    invoke(identity, handler, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof BadRequest) {
        sendJson(response, 400, { error: 'bad_request', detail: error.message });
        return;
      }
      console.error('The request failed:', error);
      sendJson(response, 500, { error: 'internal_error', detail: 'The request could not be handled.' });
    });
  });
}
