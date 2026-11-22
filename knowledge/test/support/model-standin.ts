// STAND-IN for the embedding server and the reranker, for tests only. NOT a model. An HTTP server that speaks the
// routes the embedding stage and the retrieval service use, records every request with its headers, and answers:
//   GET  /v1/models       the model names it is told
//   POST /v1/embeddings   a deterministic vector per input, made from its words (each word adds 1 at a position
//                         chosen by hashing it), scaled to unit length and returned as base64 of float32
//   POST /v1/rerank       a score per document: the share of the query's words the document holds
// A test can put any reply in place of the next ones (a status, no answer, a closed connection), refuse inputs over a
// length as the real server refuses them, and return vectors of another length.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';

import { encodeVector } from '../../src/vectors/recipe.ts';

export type ModelRequest = { method: string; path: string; body: unknown; authorization: string | undefined };

// delayMs: answer only after this long; with no status, the stand-in's own answer.
export type ModelReply = { status: number; body?: unknown } | { delayMs: number } | 'hold' | 'drop';

export type ModelStandIn = {
  baseUrl: string;
  received: ModelRequest[];
  // The next replies, in order, for requests to this path, in place of the stand-in's own answer.
  queue: (path: '/v1/embeddings' | '/v1/rerank' | '/v1/models', ...replies: ModelReply[]) => void;
  // Called each time a request is held, so a test can end its deadline then.
  onHold: (listener: () => void) => void;
};

export type ModelStandInOptions = {
  models?: string[];
  dimensions?: number;
  // An input longer than this many characters makes the whole request refused as over-length.
  maxInputCharacters?: number;
  // Return vectors of this length instead (a server misconfigured, say).
  returnedDimensions?: number;
};

export const OVER_LENGTH = {
  status: 400,
  body: {
    error: {
      message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens in the input for embedding generation. Please reduce the length of the input.",
      type: 'BadRequestError',
      param: null,
      code: 400,
    },
  },
};

export const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');

// The stand-in's vector for a text: deterministic, of unit length (all zeros for a text with no word).
export function standInVector(text: string, dimensions: number): number[] {
  const values = new Array<number>(dimensions).fill(0);
  for (const word of words(text)) {
    const at = createHash('sha256').update(word).digest().readUInt32BE(0) % dimensions;
    values[at] = (values[at] ?? 0) + 1;
  }
  const length = Math.hypot(...values);
  return length === 0 ? values : values.map((value) => Math.fround(value / length));
}

// The stand-in reranker's score: the share of the query's distinct words that the document holds.
export function standInRelevance(query: string, document: string): number {
  const asked = new Set(words(query));
  if (asked.size === 0) return 0;
  const held = new Set(words(document));
  return [...asked].filter((word) => held.has(word)).length / asked.size;
}

export async function startModelStandIn(t: TestContext, options: ModelStandInOptions = {}): Promise<ModelStandIn> {
  const models = options.models ?? ['test-embedding', 'test-reranker'];
  const dimensions = options.dimensions ?? 8;
  const received: ModelRequest[] = [];
  const queues = new Map<string, ModelReply[]>();
  const held: ServerResponse[] = [];
  let holdListener: () => void = () => {};

  function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'x-stand-in': 'test' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  function own(path: string, body: unknown): { status: number; body: unknown } {
    if (path === '/v1/models') return { status: 200, body: { object: 'list', data: models.map((id) => ({ id, object: 'model' })) } };
    if (path === '/v1/embeddings') {
      const input: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'input') : undefined;
      const inputs = Array.isArray(input) ? input.map(String) : [];
      if (options.maxInputCharacters !== undefined && inputs.some((text) => text.length > options.maxInputCharacters!)) return OVER_LENGTH;
      const length = options.returnedDimensions ?? dimensions;
      return {
        status: 200,
        body: {
          object: 'list',
          data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: encodeVector(standInVector(text, length)) })),
          usage: { prompt_tokens: inputs.reduce((sum, text) => sum + words(text).length, 0), total_tokens: inputs.reduce((sum, text) => sum + words(text).length, 0) },
        },
      };
    }
    if (path === '/v1/rerank') {
      const query: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'query') : undefined;
      const documents: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'documents') : undefined;
      const scored = (Array.isArray(documents) ? documents.map(String) : []).map((document, index) => ({
        index,
        relevance_score: standInRelevance(String(query), document),
      }));
      return { status: 200, body: { results: [...scored].sort((a, b) => b.relevance_score - a.relevance_score) } };
    }
    return { status: 404, body: { error: 'not found' } };
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const authorization = request.headers.authorization;
      received.push({ method: request.method ?? '', path, body, authorization: typeof authorization === 'string' ? authorization : undefined });
      const reply = queues.get(path)?.shift();
      if (reply === 'drop') {
        request.socket.destroy();
        return;
      }
      if (reply === 'hold') {
        held.push(response);
        holdListener();
        return;
      }
      if (reply !== undefined && 'delayMs' in reply) {
        const later = own(path, body);
        setTimeout(() => {
          if (!response.destroyed) send(response, later.status, later.body);
        }, reply.delayMs);
        return;
      }
      const answer = reply ?? own(path, body);
      send(response, answer.status, answer.body);
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    received,
    queue: (path, ...replies) => {
      queues.set(path, [...(queues.get(path) ?? []), ...replies]);
    },
    onHold: (listener) => {
      holdListener = listener;
    },
  };
}
