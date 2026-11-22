// LOCAL STAND-IN for AgentCore Runtime's front door. Not part of AgentCore, and not used on AWS.
//
// On AWS a request passes through AgentCore Runtime before it reaches the container: the JWT authorizer checks
// the access token, Runtime gives the request a session id (the caller's own, or one AWS's client made), and
// only an allowlist of headers is forwarded. Locally nothing does that, so this listener does, in the agent's
// own process, in front of the SDK app (./sdk-app.ts), which then listens on loopback only.
//
//   POST /invocations  the token first, with the shared check, body unread: 401 or 503 exactly as
//                      contract/server.ts answers them. Then the session id: the caller's when it is 33 to 256
//                      characters, a new UUID when there is none, 400 otherwise. Then the body, read here, up to
//                      1,000,000 bytes (400 beyond, as contract/server.ts answers). Then the request goes to the
//                      SDK app with the whole body, a content length, and only these headers: content type,
//                      accept, Authorization, any X-Amzn-Bedrock-AgentCore-Runtime-Custom- header, the session
//                      id, and a request id made here. The SDK app's answer comes back unchanged.
//   GET /ping          passed to the SDK app.
//   anything else      404, or 405 for another method on /invocations, as contract/server.ts answers.
//
// The SDK app not answering is 502. The edge sets no time limit of its own on the SDK app's answer.

import { createServer, Agent, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from 'node:http';

import type { AccessTokenCheck } from '../../../shared/access-token.ts';
import { CUSTOM_HEADER_PREFIX, REQUEST_ID_HEADER, SESSION_ID_HEADER } from './runtime-contract.ts';
import type { Address } from './runtime-contract.ts';

export type EdgeOptions = {
  // Where the SDK app listens.
  upstream: Address;
  checkToken: AccessTokenCheck;
  // Makes a session id when the caller gives none, and every request id. Each must be unique.
  newId: () => string;
  // Where the edge writes a line about a failure. A line never carries a token or a message's text.
  log: (line: string) => void;
};

export const MAX_BODY_BYTES = 1_000_000;
export const SESSION_ID_MIN = 33;
export const SESSION_ID_MAX = 256;
export const UPSTREAM_SILENT = "The agent's server did not answer.";

// Headers that describe one connection, not the answer. Node sets its own for the caller's connection.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

// The body, or undefined when it is larger than the limit. A larger body is still read to its end, so the
// caller is answered after it has finished sending, never part way.
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size <= MAX_BODY_BYTES) {
      chunks.push(bytes);
    }
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks);
}

// Only the headers AgentCore Runtime would let through, and the ones it sets.
export function forwardedHeaders(incoming: IncomingHttpHeaders, sessionId: string, requestId: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const name of ['content-type', 'accept', 'authorization']) {
    const value = single(incoming[name]);
    if (value !== undefined) {
      out[name] = value;
    }
  }
  for (const [name, value] of Object.entries(incoming)) {
    const text = single(value);
    if (name.startsWith(CUSTOM_HEADER_PREFIX) && text !== undefined) {
      out[name] = text;
    }
  }
  out[SESSION_ID_HEADER] = sessionId;
  out[REQUEST_ID_HEADER] = requestId;
  return out;
}

export function createLocalEdge(options: EdgeOptions): Server {
  // One connection per request to the SDK app, and no socket time limit: a run takes as long as it takes.
  const agent = new Agent({ keepAlive: false });

  function pass(
    method: string,
    path: string,
    headers: OutgoingHttpHeaders,
    body: Buffer | undefined,
    response: ServerResponse,
  ): void {
    const outgoing = httpRequest(
      { host: options.upstream.host, port: options.upstream.port, method, path, headers, agent },
      (answer) => {
        const back: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (!HOP_BY_HOP.has(name) && value !== undefined) {
            back[name] = value;
          }
        }
        response.writeHead(answer.statusCode ?? 502, back);
        answer.pipe(response);
        answer.on('error', () => {
          response.destroy();
        });
      },
    );
    outgoing.on('error', (error: NodeJS.ErrnoException) => {
      options.log(`Local edge: the agent's server did not answer (${error.code ?? error.name}).`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 502, { error: 'bad_gateway', detail: UPSTREAM_SILENT });
    });
    response.on('close', () => {
      if (!response.writableFinished) {
        outgoing.destroy();
      }
    });
    if (body === undefined) {
      outgoing.end();
    } else {
      outgoing.setHeader('content-length', body.length);
      outgoing.end(body);
    }
  }

  async function invoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The token first: a request that is not allowed is answered without its body being read.
    const checked = await options.checkToken(request.headers.authorization);
    if (checked.kind === 'refused') {
      sendJson(response, 401, { error: 'unauthorized', reason: checked.reason, detail: checked.detail }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      request.resume();
      return;
    }
    if (checked.kind === 'unavailable') {
      sendJson(response, 503, { error: 'identity_unavailable', detail: checked.detail });
      request.resume();
      return;
    }

    const given = single(request.headers[SESSION_ID_HEADER]);
    if (given !== undefined && (given.length < SESSION_ID_MIN || given.length > SESSION_ID_MAX)) {
      sendJson(response, 400, {
        error: 'bad_request',
        detail: `The session id must be ${SESSION_ID_MIN} to ${SESSION_ID_MAX} characters; this one has ${given.length}.`,
      });
      request.resume();
      return;
    }
    const sessionId = given ?? options.newId();

    const body = await readBody(request);
    if (body === undefined) {
      sendJson(response, 400, { error: 'bad_request', detail: 'The request body is too large.' });
      return;
    }
    pass('POST', '/invocations', forwardedHeaders(request.headers, sessionId, options.newId()), body, response);
  }

  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://agent').pathname;

    if (path === '/ping' && request.method === 'GET') {
      request.resume();
      pass('GET', '/ping', {}, undefined, response);
      return;
    }
    if (path !== '/invocations') {
      sendJson(response, 404, { error: 'not_found', detail: `There is no ${path} here.` });
      request.resume();
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed', detail: '/invocations accepts POST.' }, { allow: 'POST' });
      request.resume();
      return;
    }

    invoke(request, response).catch(() => {
      options.log('Local edge: a request could not be handled.');
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { error: 'internal_error', detail: 'The request could not be handled.' });
    });
  });
}
