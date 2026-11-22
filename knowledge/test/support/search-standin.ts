// STAND-IN for the search engine, for tests only. It is not OpenSearch and ranks nothing: it records every request
// it receives and answers with what the test gives it. It proves the service's and the index command's wiring
// (what is sent, and what happens with each kind of answer), not search quality.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';

// headers: every header the request arrived with, so a test can show what was (and was not) sent to the engine.
export type SearchRequest = { method: string; path: string; body: unknown; raw: string; headers: Record<string, string | string[] | undefined> };

export type SearchReply =
  // delayMs: answer only after this long.
  | { status: number; body?: unknown; delayMs?: number }
  // Answer nothing until the test lets go (the test aborts the client's deadline meanwhile).
  | 'hold'
  // Close the connection without answering.
  | 'drop'
  // Send the status, the headers and the start of a body, then close the connection part way through it.
  | 'cut';

export type SearchStandIn = {
  url: string;
  received: SearchRequest[];
  // The handler answers every request; set it before the requests are made.
  answer: (handler: (request: SearchRequest) => SearchReply) => void;
  // Called each time a request is held, so a test can end its deadline then.
  onHold: (listener: () => void) => void;
};

function parse(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startSearchStandIn(t: TestContext): Promise<SearchStandIn> {
  const received: SearchRequest[] = [];
  let handler: (request: SearchRequest) => SearchReply = () => ({ status: 404, body: { error: { type: 'not_registered' } } });
  let holdListener: () => void = () => {};
  const held: ServerResponse[] = [];

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      const recorded = { method: request.method ?? '', path: request.url ?? '', body: parse(raw), raw, headers: { ...request.headers } };
      received.push(recorded);
      const reply = handler(recorded);
      if (reply === 'drop') {
        request.socket.destroy();
        return;
      }
      if (reply === 'cut') {
        // A length promised and not delivered: the client sees the body end early.
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000', 'x-stand-in': 'test' });
        response.write('{"count":', () => {
          setImmediate(() => request.socket.destroy());
        });
        return;
      }
      if (reply === 'hold') {
        held.push(response);
        holdListener();
        return;
      }
      const body = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      const send = (): void => {
        if (response.destroyed) return;
        response.writeHead(reply.status, { 'content-type': 'application/json', 'x-stand-in': 'test' });
        response.end(body);
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stand-in has no port');
  t.after(() => {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    answer: (next) => {
      handler = next;
    },
    onHold: (listener) => {
      holdListener = listener;
    },
  };
}

// An engine search answer holding these sources, scored from the top down.
export function hits(sources: readonly Record<string, unknown>[]): { status: number; body: unknown } {
  return { status: 200, body: { hits: { total: { value: sources.length }, hits: sources.map((source, i) => ({ _score: 10 - i, _source: source })) } } };
}

export const indexNotFound = { status: 404, body: { error: { type: 'index_not_found_exception', reason: 'no such index [labels]' }, status: 404 } };
