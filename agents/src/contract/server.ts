// The HTTP contract an agent serves. This is all that Amazon Bedrock AgentCore Runtime asks of a
// container: POST /invocations and GET /ping on port 8080. It is written by hand here, with nothing
// from an SDK, so that what the platform requires and what the agent adds are easy to tell apart.
//
// POST /invocations requires a valid access token, checked before the body is read: the same check
// AgentCore Runtime's JWT authorizer makes in front of the container, kept here as a second check so one
// behaviour holds everywhere. A token lacking the agent's scope is 403, any other refusal 401. GET /ping
// needs none.
//
// Each accepted request is one agent.run span, a child of the request's traceparent when it has a usable one, and
// the handler runs inside it, so the spans it makes are the run's children. The span ends with the response's
// outcome; a handler that throws, or answers outside the contract, ends it failed. The answer is the same with
// telemetry on or off.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { refusalAnswer } from '../../../shared/access-token.ts';
import type { AccessTokenCheck, Caller } from '../../../shared/access-token.ts';
import { invocationRequestSchema, invocationResponseSchema } from '../../../shared/agent-contract.ts';
import type { InboundMessage, InvocationResponse } from '../../../shared/agent-contract.ts';
import type { Telemetry } from '../../../shared/telemetry.ts';
import { attributeText } from '../run/spans.ts';

export type AgentIdentity = { id: string; implementation: string };

// Handles one message for the caller whose token was accepted. It reports its own failures inside the
// response; it is not expected to throw.
export type Handler = (message: InboundMessage, caller: Caller) => Promise<InvocationResponse>;

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

// The handler's answer, or the failed answer when it throws.
async function answerOf(identity: AgentIdentity, handler: Handler, message: InboundMessage, caller: Caller): Promise<InvocationResponse> {
  try {
    return await handler(message, caller);
  } catch (error) {
    console.error('The handler threw:', error);
    return {
      agent: identity,
      outcome: 'failed',
      stop_reason: 'The agent failed unexpectedly.',
      reply: '',
      citations: [],
      case_actions: [],
      steps: [],
    };
  }
}

async function invoke(
  identity: AgentIdentity,
  handler: Handler,
  checkToken: AccessTokenCheck,
  telemetry: Telemetry,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // The token first: a request that is not allowed is answered without its body being read.
  const checked = await checkToken(request.headers.authorization);
  if (checked.kind === 'refused') {
    const answer = refusalAnswer(checked);
    response.writeHead(answer.status, { 'content-type': 'application/json', 'www-authenticate': answer.wwwAuthenticate });
    response.end(JSON.stringify(answer.body));
    request.resume();
    return;
  }
  if (checked.kind === 'unavailable') {
    sendJson(response, 503, { error: 'identity_unavailable', detail: checked.detail });
    request.resume();
    return;
  }
  const caller = checked.caller;

  const parsed = invocationRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || 'the top level'}: ${issue.message}`;
    throw new BadRequest(`The request does not match the agent contract${where}.`);
  }

  // From here the request is valid, so the answer is always inside the contract: a caller that sent
  // a good request gets an outcome and whatever steps were taken, never a bare error status.
  const message = parsed.data.message;
  const run = {
    kind: 'server',
    parent: telemetry.extract(request.headers),
    attributes: { 'gen_ai.agent.id': attributeText(identity.id), 'lab.inquiry.id': attributeText(message.id) },
  } as const;
  const valid = await telemetry.span('agent.run', run, async (span) => {
    const checked = invocationResponseSchema.safeParse(await answerOf(identity, handler, message, caller));
    span.set({ 'lab.outcome': checked.success ? checked.data.outcome : 'failed' });
    return checked;
  });
  if (!valid.success) {
    // The agent's own answer is outside the contract. That is a defect here, not a property of the request.
    console.error('The agent produced a response outside the contract:', valid.error.issues[0]);
    sendJson(response, 500, { error: 'internal_error', detail: 'The agent produced a response outside its contract.' });
    return;
  }
  sendJson(response, 200, valid.data);
}

export function createContractServer(identity: AgentIdentity, handler: Handler, checkToken: AccessTokenCheck, telemetry: Telemetry): Server {
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

    invoke(identity, handler, checkToken, telemetry, request, response).catch((error: unknown) => {
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
