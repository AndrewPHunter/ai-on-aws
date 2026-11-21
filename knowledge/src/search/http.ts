// The retrieval service's HTTP server: MCP at POST /mcp, and GET /ping. Every request but GET /ping requires a
// valid access token, checked before anything else of the request is read: the target, then the body.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { AccessTokenCheck } from '../../../shared/access-token.ts';
import type { Engine } from './engine.ts';
import { buildMcpServer } from './mcp.ts';

const MAX_BODY_BYTES = 100_000;

class BadRequest extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new BadRequest('The request body is not bytes');
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('The request body is too large');
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

export function createRetrievalServer(engine: Engine, index: string, checkToken: AccessTokenCheck): Server {
  return createServer((request: IncomingMessage, response: ServerResponse): void => {
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
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A target that cannot be parsed is answered only after the token is judged; it is never GET /ping.
    let pathname: string | undefined;
    try {
      pathname = new URL(request.url ?? '/', 'http://knowledge').pathname;
    } catch {
      pathname = undefined;
    }
    if (pathname === '/ping' && request.method === 'GET') {
      sendJson(response, 200, { status: 'Healthy' });
      return;
    }

    // The token is judged before anything else of the request is read: the target, then the body.
    const checked = await checkToken(request.headers.authorization);
    if (checked.kind !== 'caller') {
      if (checked.kind === 'refused') {
        response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' });
        response.end(JSON.stringify({ error: 'unauthorized', reason: checked.reason, detail: checked.detail }));
      } else {
        sendJson(response, 503, { error: 'identity_unavailable', detail: checked.detail });
      }
      request.resume();
      return;
    }

    if (pathname === undefined) {
      request.resume();
      sendJson(response, 400, { error: 'bad_request', detail: 'The request target is not a path this service can read.' });
      return;
    }
    if (pathname !== '/mcp') {
      request.resume();
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'POST') {
      // Stateless: there is no stream to open with GET and no session to end with DELETE.
      request.resume();
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const body = await readJson(request);
    const mcp = buildMcpServer(engine, index);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }
}
